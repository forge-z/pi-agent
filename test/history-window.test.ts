import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
const historyWindow = runInNewContext(
  readFileSync(
    new URL("../public/history.js", import.meta.url),
    "utf8",
  ).replaceAll("export ", "") + "\nhistoryWindow",
) as (
  entries: { model?: { role: string; content?: string }[] }[],
  page?: number,
) => {
  messages: { role: string; content?: string }[];
  page: number;
  pages: number;
  total: number;
};
test("long histories have a bounded DOM page and every older message remains accessible", () => {
  const entries = Array.from({ length: 10001 }, (_, index) => ({
    model: [
      { role: index % 2 ? "assistant" : "toolResult", content: String(index) },
    ],
  }));
  const first = historyWindow(entries);
  assert.equal(first.messages.length, 80);
  assert.equal(first.messages.at(-1)?.content, "10000");
  const seen = new Set<string>();
  for (let page = 0; page < first.pages; page++) {
    const window = historyWindow(entries, page);
    assert.ok(window.messages.length <= 80);
    for (const message of window.messages) {
      assert.ok(!seen.has(message.content!));
      seen.add(message.content!);
    }
  }
  assert.equal(seen.size, 10001);
  assert.equal(historyWindow(entries, 999).page, first.pages - 1);
  assert.equal(historyWindow(entries, -1).page, 0);
});
test("bookkeeping entries do not create blank pages and an empty conversation stays empty", () => {
  assert.equal(historyWindow([{ model: [{ role: "system" }] }, {}]).total, 0);
  assert.equal(historyWindow([]).messages.length, 0);
  assert.equal(historyWindow([]).pages, 1);
});
