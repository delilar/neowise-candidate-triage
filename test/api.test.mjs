import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createApp, triage } from "../server.mjs";

let server;
let base;
before(async () => {
  server = createApp();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function post(body) {
  const response = await fetch(`${base}/api/triage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });
  assert.match(response.headers.get("content-type"), /application\/json/);
  return { status: response.status, body: await response.json() };
}
const manual = { status: "manual_review", topic: null, draft: null };

for (const body of ["", "{", "null", "[]", '"text"', "42", "{}",
  ...[null, 42, true, [], {}, "", " \n\t"].map(text => JSON.stringify({ text }))]) {
  test(`invalid input: ${JSON.stringify(body)}`, async () => {
    assert.deepEqual(await post(body), { status: 400, body: { status: "invalid_input" } });
  });
}
for (const [text, topic] of [["Когда доставка?", "delivery"], ["Какая стоимость?", "pricing"], ["Здравствуйте", "other"]]) {
  test(`ready: ${topic}`, async () => {
    assert.deepEqual(await post(JSON.stringify({ text })), {
      status: 200,
      body: { status: "ready", topic, draft: "Спасибо за обращение. Уточним детали заявки." },
    });
  });
}
for (const marker of ["timeout", "error", "bad-json", "bad-topic", "empty-draft"]) {
  test(`provider failure: ${marker}`, { timeout: 2000 }, async () => {
    const start = performance.now();
    assert.deepEqual(await post(JSON.stringify({ text: `[${marker}]` })), { status: 200, body: manual });
    if (marker === "timeout") {
      // Wide scheduling allowance, still far below the mock's 1200 ms delay.
      assert.ok(performance.now() - start < 1000, "must not wait for the mock's full delay");
    }
  });
}
for (const output of ["null", "[]", "true", "{}",
  ...[null, 1, {}, []].map(draft => JSON.stringify({ topic: "other", draft }))]) {
  test(`reject malformed model shape: ${output}`, async () => {
    assert.deepEqual(await triage("hello", async () => output), manual);
  });
}
test("model cannot overwrite the response status or inject extra fields", async () => {
  assert.deepEqual(await triage("hello", async () => JSON.stringify({
    status: "manual_review", topic: "other", draft: " reply ", extra: "unexpected",
  })), { status: "ready", topic: "other", draft: "reply" });
});
test("deadline also bounds a provider that ignores cancellation", { timeout: 2000 }, async () => {
  let signal;
  assert.deepEqual(await triage("hello", (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }), manual);
  assert.equal(signal.aborted, true);
});
test("server remains usable after provider failure", async () => {
  await post(JSON.stringify({ text: "[error]" }));
  assert.equal((await post(JSON.stringify({ text: "hello" }))).body.status, "ready");
});
test("page and unknown routes", async () => {
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Входящие заявки/);
  const missing = await fetch(`${base}/missing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { status: "not_found" });
});
test("catalog mode is opt-in and preserves the API response shape", async () => {
  const result = await post(JSON.stringify({ text: "Цена K1", mode: "catalog" }));
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "ready");
  assert.match(result.body.draft, /4900 ₽/);
  assert.deepEqual(Object.keys(result.body).sort(), ["draft", "status", "topic"]);
  assert.equal((await post(JSON.stringify({ text: "Цена K1" }))).body.draft, "Спасибо за обращение. Уточним детали заявки.");
});
test("unknown mode is rejected", async () => {
  assert.deepEqual(await post(JSON.stringify({ text: "Цена K1", mode: "live-llm" })), {
    status: 400, body: { status: "invalid_input" },
  });
});
test("catalog endpoint exposes labeled educational data", async () => {
  const response = await fetch(`${base}/api/catalog`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.products.length, 4);
  assert.match(data.notice, /Вымышленный каталог/);
});
