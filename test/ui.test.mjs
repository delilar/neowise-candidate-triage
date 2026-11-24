import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

// Execute the page's actual event handler with a small DOM/fetch substitute.
// No duplicated application logic and no browser/dependency installation needed.
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
function page(fetch) {
  let submit;
  let deadline;
  const nodes = {
    form: { addEventListener(type, handler) { assert.equal(type, "submit"); submit = handler; } },
    "#message": { value: "hello", focus() { this.focused = true; } },
    "#result": { textContent: "" }, button: { disabled: false },
  };
  runInNewContext(script, {
    document: { querySelector: selector => nodes[selector] }, fetch, AbortController,
    setTimeout(callback, ms) { assert.equal(ms, 5000); deadline = callback; return 1; },
    clearTimeout() { deadline = undefined; },
  });
  return { nodes, submit: () => submit({ preventDefault() {} }), expire: () => deadline() };
}
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const ready = { status: "ready", topic: "delivery", draft: "Старый черновик" };

for (const [name, failure] of [
  ["manual review", async () => reply({ status: "manual_review", topic: null, draft: null })],
  ["network error", async () => { throw new Error("offline"); }],
  ["HTTP error", async () => reply(ready, 500)],
  ["broken JSON", async () => ({ json: async () => { throw new SyntaxError(); } })],
  ["unexpected shape", async () => reply(null)],
  ["invalid ready", async () => reply({ ...ready, topic: "refund" })],
]) {
  test(`success followed by ${name} removes old draft`, async () => {
    let calls = 0;
    const ui = page(async () => ++calls === 1 ? reply(ready) : failure());
    await ui.submit();
    assert.match(ui.nodes["#result"].textContent, /Доставка/);
    assert.match(ui.nodes["#result"].textContent, /Старый черновик/);
    const pending = ui.submit();
    assert.doesNotMatch(ui.nodes["#result"].textContent, /Старый черновик/);
    await pending;
    assert.match(ui.nodes["#result"].textContent, /Нужен ручной разбор/);
    assert.doesNotMatch(ui.nodes["#result"].textContent, /Старый черновик/);
    assert.equal(ui.nodes.button.disabled, false);
  });
}
test("empty input clears previous draft without calling API", async () => {
  const ui = page(() => { assert.fail("must not send empty input"); });
  ui.nodes["#result"].textContent = "Старый черновик";
  ui.nodes["#message"].value = " \n ";
  await ui.submit();
  assert.equal(ui.nodes["#result"].textContent, "Введите текст заявки.");
  assert.equal(ui.nodes["#message"].focused, true);
});
test("pending request blocks repeat submits, network timeout allows retry", async () => {
  let calls = 0;
  const ui = page((_, { signal }) => {
    calls++;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("timeout"))));
  });
  const pending = ui.submit();
  assert.equal(ui.nodes.button.disabled, true);
  await ui.submit();
  assert.equal(calls, 1);
  ui.expire();
  await pending;
  assert.match(ui.nodes["#result"].textContent, /Нужен ручной разбор/);
  assert.equal(ui.nodes.button.disabled, false);
});
test("API input rejection is shown as an input error", async () => {
  const ui = page(async () => reply({ status: "invalid_input" }, 400));
  await ui.submit();
  assert.equal(ui.nodes["#result"].textContent, "Введите текст заявки.");
});
