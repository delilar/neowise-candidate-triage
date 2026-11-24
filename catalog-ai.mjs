import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";

export const knowledge = JSON.parse(await readFile(new URL("./knowledge.json", import.meta.url), "utf8"));
const normalize = text => text.toLowerCase().replaceAll("ё", "е");
const words = text => normalize(text).match(/[\p{L}\p{N}]+/gu) || [];

// Small lexical retriever: only explicit names, SKUs and category aliases match.
// No fuzzy matching that might silently select the wrong product.
export function retrieve(text) {
  const tokens = words(text);
  const modelCodes = tokens.filter(token => /^[a-z]+\d+$/.test(token));
  const products = knowledge.products.filter(product => (!modelCodes.length || modelCodes.some(code => product.aliases.includes(code))) && product.aliases.some(alias => {
    const parts = words(alias);
    return tokens.some((_, start) => parts.every((part, offset) => {
      const token = tokens[start + offset];
      // Long category stems support Russian endings; short SKUs must match exactly.
      return token === part || (part.length >= 4 && token?.startsWith(part));
    }));
  }));
  const lower = normalize(text);
  const delivery = /достав|самовывоз|привез|привоз|отгруз|мкад/.test(lower);
  const pricing = /цен|стоим|сколько|почем/.test(lower);
  const payment = /оплат|счет|скид|юрлиц|реквизит/.test(lower);
  return { products, delivery, pricing, payment };
}

export function compose(text) {
  const context = retrieve(text);
  const sources = [...context.products];
  if (context.delivery) sources.push(knowledge.delivery);
  if (context.payment) sources.push(knowledge.payment);
  const lines = ["Здравствуйте!"];
  for (const product of context.products) {
    lines.push(`${product.name}: ${product.priceRub} ₽. ${product.stock > 0 ? `В наличии: ${product.stock} шт.` : "Нет в наличии; дата поступления неизвестна."}`);
    lines.push(product.facts.join(". ") + ".");
  }
  if (context.delivery) lines.push(...knowledge.delivery.facts);
  if (context.payment) lines.push(...knowledge.payment.facts);
  if (!context.products.length) {
    lines.push("Уточните название или артикул товара: KeyOne K1, Swift M2, Clear H3 или Dock D4. Без этого не можем назвать цену и наличие нужного товара.");
  }
  // Questions not covered by selected records remain explicitly unanswered.
  lines.push("Ответ составлен только по учебной базе. Сведения, которых нет в ней, включая совместимость с конкретной моделью устройства, скидки и точные даты, должен уточнить менеджер.");
  return {
    topic: context.pricing ? "pricing" : context.delivery ? "delivery" : "other",
    draft: lines.join("\n\n"),
    sources: sources.map(({ id, name }) => ({ id, name })),
  };
}

// Demo generator, not a live LLM. The original mock still controls all failure markers.
export async function classifyCatalog(text, options) {
  const raw = await classify(text, options);
  const result = JSON.parse(raw);
  if (!["delivery", "pricing", "other"].includes(result.topic) || !result.draft.trim()) return raw;
  const answer = compose(text);
  // Sources are rendered inside the validated draft to preserve the API contract.
  if (answer.sources.length) {
    answer.draft += "\n\nИсточники: " + answer.sources.map(source => `${source.name} [${source.id}]`).join(", ");
  }
  return JSON.stringify({ topic: answer.topic, draft: answer.draft });
}
