import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
}
const apiSource = source.slice(
  source.indexOf("async function api("),
  source.indexOf("function showLogin()"),
);
test("chat reads always negotiate bounded pages; POST and lazy full-content reads keep their contracts", async () => {
  const paths: string[] = [];
  const api = runInNewContext(
    `let historyPage=7, conversationSelectionVersion=1, renderVersion=0; ${apiSource}; api`,
    {
      fetch: async (path: string) => {
        paths.push(path);
        return { ok: true, status: 200, json: async () => ({}) };
      },
    },
  ) as (path: string, method?: string, data?: unknown) => Promise<unknown>;
  await api("/api/conversations/2");
  await api("/api/conversations/2/messages", "POST", { text: "harmless" });
  await api("/api/conversations/2/history/100/0");
  await api("/api/conversations/2/actions/" + "a".repeat(24));
  assert.deepEqual(paths, [
    "/api/conversations/2?view=chat&page=7",
    "/api/conversations/2/messages",
    "/api/conversations/2/history/100/0",
    "/api/conversations/2/actions/" + "a".repeat(24),
  ]);
});

test("overlapping page reads apply only the latest page and a failed read restores its stream without touching the draft", async () => {
  const reads: ReturnType<typeof deferred>[] = [];
  const renders: unknown[] = [];
  const pages: number[] = [];
  const scroll = { scrollTop: 80 };
  const paginationSource = source.slice(
    source.indexOf("async function changeHistoryPage("),
    source.indexOf("function fullContentButton("),
  );
  const controller = runInNewContext(
    `
    let conversationId="2", conversationSelectionVersion=0, sendRefreshVersion=0, historyPage=0;
    ${paginationSource}
    ({ changeHistoryPage, state:()=>({historyPage, sendRefreshVersion}) });
  `,
    {
      events: { close() {} },
      conversationEvents: { stop() {} },
      document: { querySelector: () => scroll },
      api: () => {
        const gate = deferred();
        reads.push(gate);
        return gate.promise;
      },
      render: (snapshot: unknown) => renders.push(snapshot),
      subscribeConversation: (_id: string, _version: number, page: number) =>
        pages.push(page),
    },
  ) as {
    changeHistoryPage(page: number): Promise<void>;
    state(): { historyPage: number; sendRefreshVersion: number };
  };
  const first = controller.changeHistoryPage(1);
  const second = controller.changeHistoryPage(2);
  reads[1].resolve({ page: 2 });
  await second;
  reads[0].resolve({ page: 1 });
  await first;
  assert.equal(JSON.stringify(renders), JSON.stringify([{ page: 2 }]));
  assert.deepEqual(pages, [2]);
  assert.equal(scroll.scrollTop, 0);
  const failed = controller.changeHistoryPage(3);
  reads[2].reject(new Error("offline"));
  await assert.rejects(failed, /offline/);
  assert.equal(controller.state().historyPage, 2);
  assert.equal(controller.state().sendRefreshVersion, 3);
  assert.deepEqual(pages, [2, 2]);
});

test("late approval/command refreshes cannot replace a newer page or its live state", async () => {
  const gate = deferred();
  const renderPrefix = source.slice(
    source.indexOf("function render(snapshot)"),
    source.indexOf("  if (snapshot === rendered) return;"),
  );
  const controller = runInNewContext(
    `
    let historyPage=0, conversationSelectionVersion=1, renderVersion=0;
    const renders=[];
    ${apiSource}
    ${renderPrefix} renderVersion++; renders.push(snapshot); }
    ({ api, render, changePage(){historyPage=1;conversationSelectionVersion++;}, stream(){renderVersion++;renders.push({history:{page:1}});}, renders });
  `,
    {
      fetch: async () => {
        await gate.promise;
        return {
          ok: true,
          status: 200,
          json: async () => ({ history: { page: 0 } }),
        };
      },
    },
  ) as {
    api(path: string): Promise<{ uiSelectionVersion?: number }>;
    render(value: unknown): void;
    changePage(): void;
    stream(): void;
    renders: unknown[];
  };
  const stale = controller.api("/api/conversations/2");
  controller.changePage();
  gate.resolve({});
  const old = await stale;
  controller.render(old);
  assert.equal(controller.renders.length, 0);
  assert.equal(old.uiSelectionVersion, 1);
  assert.ok(!JSON.stringify(old).includes("uiSelectionVersion"));
  const current = await controller.api("/api/conversations/2");
  controller.render(current);
  assert.equal(controller.renders.length, 1);
  const samePage = await controller.api("/api/conversations/2");
  controller.stream();
  controller.render(samePage);
  assert.equal(
    controller.renders.length,
    2,
    "a newer SSE render invalidates same-page HTTP responses",
  );
});
