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
  entries: {
    id?: number;
    kind?: string;
    model?: { role: string; content?: string }[];
  }[],
  page?: number,
) => {
  messages: { role: string; content?: string }[];
  page: number;
  pages: number;
  total: number;
  keys: (string | null)[];
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

test("passive CUA control metadata stays in the source history without appearing as a human message or consuming pages", () => {
  const entries = Array.from({ length: 81 }, (_, index) => ({
    id: index,
    kind: "pi.user",
    model: [{ role: "user", content: `Human message ${index}` }],
  }));
  const feedback = {
    id: 1000,
    kind: "app.cua-control",
    model: [{ role: "user", content: "Internal CUA control update" }],
  };
  const source = [...entries.slice(0, 40), feedback, ...entries.slice(40)];
  const first = historyWindow(source);
  assert.equal(first.total, 81);
  assert.equal(first.pages, 2);
  assert.equal(first.messages.length, 80);
  assert.equal(first.messages[0].content, "Human message 1");
  assert.equal(first.messages.at(-1)?.content, "Human message 80");
  assert.ok(
    !first.messages.some(
      (message) => message.content === feedback.model[0].content,
    ),
  );
  assert.ok(!first.keys.includes("1000:0"));
  const older = historyWindow(source, 1);
  assert.equal(older.messages.length, 1);
  assert.equal(older.messages[0].content, "Human message 0");
  assert.equal(older.keys[0], "0:0");
  assert.equal(
    source[40],
    feedback,
    "presentation must preserve the stored/model entry",
  );
  const onlyFeedback = historyWindow([feedback]);
  assert.equal(onlyFeedback.total, 0);
  assert.equal(onlyFeedback.pages, 1);
  assert.equal(onlyFeedback.messages.length, 0);
});
