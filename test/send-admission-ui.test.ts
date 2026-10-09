import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const source = readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const start = source.includes("async function refreshAfterMessage")
    ? source.indexOf("async function refreshAfterMessage")
    : source.indexOf('$("message-form").onsubmit');
  const code = source.slice(
    start,
    source.indexOf("async function connectProvider", start),
  );
  const elements = new Map<
    string,
    {
      value: string;
      disabled: boolean;
      attributes: Map<string, string>;
      setAttribute: (key: string, value: string) => void;
      removeAttribute: (key: string) => void;
      onsubmit?: (event: { preventDefault(): void }) => Promise<void>;
    }
  >();
  for (const id of ["message-form", "message", "send", "error"]) {
    const attributes = new Map<string, string>();
    elements.set(id, {
      value: "first",
      disabled: false,
      attributes,
      setAttribute: (key, value) => {
        attributes.set(key, value);
      },
      removeAttribute: (key) => {
        attributes.delete(key);
      },
    });
  }
  const posts: Array<{
    data: { requestId: string; text: string };
    gate: ReturnType<typeof deferred<unknown>>;
  }> = [];
  const reads: Array<ReturnType<typeof deferred<unknown>>> = [];
  const lists: Array<ReturnType<typeof deferred<unknown>>> = [];
  const errors: Error[] = [];
  const renders: unknown[] = [];
  const storage = new Map<string, string>();
  let uuid = 0;
  const context = {
    $: (id: string) => elements.get(id)!,
    sessionStorage: {
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    crypto: { randomUUID: () => `request-${++uuid}` },
    t: (source: string, values: string[] = []) =>
      source.replace(/\{(\d+)\}/g, (_match, key) => values[Number(key)] ?? ""),
    attr: (
      element: typeof elements extends Map<string, infer E> ? E : never,
      key: string,
      render: () => string,
    ) => element.setAttribute(key, render()),
    plain: () => {},
    errorText: (value: string) => value,
    updateRunStatus: () => {},
    handleCommandResult: async () => {},
    report: (error: Error) => errors.push(error),
    guard:
      (fn: (event: { preventDefault(): void }) => Promise<void>) =>
      async (event: { preventDefault(): void }) => {
        try {
          await fn(event);
        } catch (error) {
          errors.push(error as Error);
        }
      },
    api: (path: string, method = "GET", data: unknown) => {
      const gate = deferred<unknown>();
      if (method === "POST")
        posts.push({ data: data as { requestId: string; text: string }, gate });
      else reads.push(gate);
      return gate.promise;
    },
    loadConversations: () => {
      const gate = deferred<unknown>();
      lists.push(gate);
      return gate.promise;
    },
    recordRender: (snapshot: unknown) => renders.push(snapshot),
  };
  const controller = runInNewContext(
    `let conversationId="2", pendingMessage=null, sendingMessage=null, sendRefreshVersion=0, rendered=null;
    function render(snapshot) { rendered=snapshot; recordRender(snapshot); }
    ${code}
    ({ select(id) { conversationId=id; sendRefreshVersion++; }, stream(snapshot) { render(snapshot); } })`,
    context,
  ) as { select: (id: string) => void; stream: (snapshot: unknown) => void };
  return {
    elements,
    posts,
    reads,
    lists,
    errors,
    renders,
    storage,
    controller,
    send: () =>
      elements.get("message-form")!.onsubmit!({ preventDefault() {} }),
  };
}
const flush = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

test("ACK frees composer while snapshot/list reads remain pending; previous refresh cannot unlock next POST", async () => {
  const f = fixture();
  const first = f.send();
  assert.equal(f.elements.get("send")!.disabled, true);
  await f.send();
  assert.equal(f.posts.length, 1);
  f.posts[0].gate.resolve({ kind: "message" });
  await flush();
  assert.equal(f.elements.get("send")!.disabled, false);
  assert.equal(f.elements.get("message")!.value, "");
  assert.equal(f.storage.size, 0);
  f.elements.get("message")!.value = "second";
  const second = f.send();
  assert.equal(f.posts.length, 2);
  f.reads[0].resolve({ old: true });
  f.lists[0].resolve([]);
  await flush();
  assert.equal(f.elements.get("send")!.disabled, true);
  assert.equal(f.renders.length, 0);
  f.posts[1].gate.resolve({ kind: "message" });
  await flush();
  assert.equal(f.elements.get("send")!.disabled, false);
  f.reads[1].resolve({ latest: true });
  f.lists[1].resolve([]);
  await Promise.all([first, second]);
  await flush();
  assert.equal(JSON.stringify(f.renders), JSON.stringify([{ latest: true }]));
});

test("pre-ACK failure retains exact request identity and edited draft for retry", async () => {
  const f = fixture();
  const first = f.send();
  f.posts[0].gate.reject(new Error("offline"));
  await first;
  assert.equal(f.elements.get("message")!.value, "first");
  const stored = f.storage.get("pending:2");
  assert.ok(stored);
  const second = f.send();
  assert.equal(f.posts[1].data.requestId, f.posts[0].data.requestId);
  f.elements.get("message")!.value = "new draft";
  f.posts[1].gate.resolve({ kind: "message" });
  await flush();
  assert.equal(f.elements.get("message")!.value, "new draft");
  f.reads[0].resolve({});
  f.lists[0].resolve([]);
  await second;
});

test("late snapshot cannot overwrite SSE or a newly selected conversation; refresh error stays visible without disabling send", async () => {
  const f = fixture();
  const sending = f.send();
  f.posts[0].gate.resolve({ kind: "message" });
  await flush();
  f.controller.stream({ stream: true });
  f.reads[0].resolve({ stale: true });
  f.lists[0].resolve([]);
  await sending;
  await flush();
  assert.equal(JSON.stringify(f.renders), JSON.stringify([{ stream: true }]));
  f.elements.get("message")!.value = "again";
  const next = f.send();
  f.posts[1].gate.resolve({ kind: "message" });
  await flush();
  f.reads[1].reject(new Error("read failed"));
  f.lists[1].resolve([]);
  await next;
  await flush();
  assert.equal(f.elements.get("send")!.disabled, false);
  assert.equal(f.errors.length, 1);
  assert.match(
    (f.errors[0] as Error & { uiMessage: () => string }).uiMessage(),
    /Mensagem recebida.*read failed/,
  );
  f.elements.get("message")!.value = "other";
  const last = f.send();
  f.posts[2].gate.resolve({ kind: "message" });
  await flush();
  f.controller.select("3");
  f.reads[2].resolve({ other: true });
  f.lists[2].resolve([]);
  await last;
  await flush();
  assert.equal(f.renders.length, 1);
});

test("overlapping navigation reads never replace the latest list with an older response", async () => {
  const source = readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function loadConversations()");
  const code = source.slice(
    start,
    source.indexOf("async function refreshStatus", start),
  );
  const gates: Array<ReturnType<typeof deferred<unknown>>> = [];
  const titles: string[] = [];
  const lists: unknown[] = [];
  const loader = runInNewContext(
    `let conversationsCache=[], conversationsLoadVersion=0, conversationId="2";
    ${code}
    loadConversations`,
    {
      api: () => {
        const gate = deferred<unknown>();
        gates.push(gate);
        return gate.promise;
      },
      $: () => ({}),
      plain: (_element: unknown, title: string) => titles.push(title),
      renderConversations: () => lists.push(true),
    },
  ) as () => Promise<unknown>;
  const older = loader(),
    latest = loader();
  gates[1].resolve([{ id: "2", title: "Latest" }]);
  await latest;
  gates[0].resolve([{ id: "2", title: "Old" }]);
  const retained = await older;
  assert.equal(
    JSON.stringify(retained),
    JSON.stringify([{ id: "2", title: "Latest" }]),
  );
  assert.deepEqual(titles, ["Latest"]);
  assert.equal(lists.length, 1);
});
