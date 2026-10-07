import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { Runtime } from "../src/runtime.js";
import { Telegram } from "../src/telegram.js";
import { Store } from "../src/store.js";
const gateway = {
  call: async () => ({ content: [{ type: "text", text: "context" }] }),
};
async function temp() {
  return mkdtemp(join(tmpdir(), "pi-agent-test-"));
}
function model(responses: FauxResponseStep[]) {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}
async function wait(app: Runtime, id: string) {
  await (await app.conversation(id)).waitForIdle(context);
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("concurrent web/Telegram inputs serialize and same requestId deduplicates across reopen", async () => {
  const dir = await temp();
  const { models, faux } = model(
    Array.from({ length: 8 }, (_, i) => fauxAssistantMessage(`answer-${i}`)),
  );
  let app = await Runtime.open({ dir, gateway, models });
  try {
    const id = await app.create();
    const replies = await Promise.all([
      app.submit(id, "one", "first"),
      app.submit(id, "two", "second", "telegram", "123"),
      app.submit(id, "one", "first"),
    ]);
    assert.equal(replies[0].submissionId, replies[2].submissionId);
    await wait(app, id);
    assert.equal(faux.state.callCount, 2);
    await assert.rejects(
      app.submit(id, "one", "changed"),
      /conteúdo diferente/,
    );
    const before = await app.snapshot(id);
    assert.equal(
      before.view.entries.filter((e) => e.kind === "pi.user").length,
      2,
    );
    await app.close();
    app = await Runtime.open({ dir, gateway, models });
    const retried = await app.submit(id, "one", "first");
    assert.equal(retried.submissionId, replies[0].submissionId);
    assert.equal(
      (await app.snapshot(id)).view.entries.filter((e) => e.kind === "pi.user")
        .length,
      2,
    );
    assert.equal(app.store.all("SELECT * FROM deliveries").length, 1);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Durable tools wire MCP reads and proposals; confirmation runs external effect once", async () => {
  const dir = await temp();
  let writes = 0;
  const gateway = {
    call: async (
      _server: string,
      _tool: string,
      _args: Record<string, unknown>,
      kind: "read" | "action",
    ) => {
      if (kind === "action") writes++;
      return {
        content: [
          { type: "text", text: kind === "read" ? "preview" : "saved" },
        ],
      };
    },
  };
  const { models } = model([
    fauxAssistantMessage(
      {
        type: "toolCall",
        id: "read-1",
        name: "mcp_read",
        arguments: {
          server: "mock",
          tool: "lookup",
          arguments: { name: "event" },
        },
      },
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      {
        type: "toolCall",
        id: "propose-1",
        name: "propose_action",
        arguments: {
          server: "mock",
          tool: "create",
          arguments: { name: "event" },
        },
      },
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Please confirm in the app"),
    fauxAssistantMessage("Action confirmed"),
  ]);
  let app = await Runtime.open({ dir, gateway, models });
  try {
    const id = await app.create();
    await app.submit(id, "tools", "Create event");
    await wait(app, id);
    const action = app.store.actions(id)[0];
    assert.equal(action.state, "pending");
    assert.equal(writes, 0);
    await app.close();
    app = await Runtime.open({ dir, gateway, models });
    const results = await Promise.all([
      app.actions.decide(id, action.id, "approve"),
      app.actions.decide(id, action.id, "approve"),
      app.actions.decide(id, action.id, "deny"),
    ]);
    assert.equal(writes, 1);
    assert.ok(results.every((r) => ["running", "done"].includes(r.state)));
    assert.equal(app.store.actions(id)[0].state, "done");
    await app.recordAction(app.store.actions(id)[0]);
    await wait(app, id);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("uncertain effects require reconciliation and never replay after restart", async () => {
  const dir = await temp();
  let writes = 0;
  const gateway = {
    call: async (
      _s: string,
      _t: string,
      _a: Record<string, unknown>,
      kind: "read" | "action",
    ) => {
      if (kind === "action") {
        writes++;
        throw new Error("connection lost after write");
      }
      return { content: [] };
    },
  };
  let app = await Runtime.open({ dir, gateway });
  try {
    const id = await app.create();
    assert.throws(
      () => app.actions.propose(id, 1, "mock", "write", {}),
      /Leia/,
    );
    await app.actions.read(id, "mock", "read", {});
    const action = app.actions.propose(id, 2, "mock", "write", {});
    assert.equal(
      (await app.actions.decide(id, action.id, "approve")).state,
      "uncertain",
    );
    assert.equal(writes, 1);
    await app.close();
    app = await Runtime.open({ dir, gateway });
    assert.equal(
      (await app.actions.decide(id, action.id, "approve")).state,
      "uncertain",
    );
    assert.equal(writes, 1);
    assert.equal(
      app.actions.reconcile(id, action.id, "Verified write exists").state,
      "reconciled",
    );
    assert.equal(writes, 1);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Telegram allowlist, one-use linking, duplicate updates and uncertain send ledger", async () => {
  const dir = await temp();
  let sends = 0;
  let app = await Runtime.open({ dir, gateway });
  const transport = {
    send: async () => {
      sends++;
      throw new Error("ack lost");
    },
  };
  try {
    const id = await app.create();
    let tg = new Telegram(app, transport, ["42"], ["100"]);
    const code = app.store.link(id);
    const update = (
      update_id: number,
      text: string,
      user = 42,
      chat = 100,
    ) => ({
      update_id,
      message: {
        message_id: update_id,
        text,
        from: { id: user },
        chat: { id: chat, type: "private" },
      },
    });
    assert.deepEqual(await tg.receive(update(1, `/link ${code}`, 7)), {
      ignored: true,
    });
    assert.deepEqual(await tg.receive(update(1, `/link ${code}`, 42, 101)), {
      ignored: true,
    });
    assert.deepEqual(await tg.receive(update(1, `/link ${code}`)), {
      linked: id,
    });
    assert.deepEqual(await tg.receive(update(1, `/link ${code}`)), {
      linked: id,
    });
    await assert.rejects(tg.receive(update(2, `/link ${code}`)), /inválido/);
    const replies = await Promise.all([
      tg.receive(update(3, "Hello")),
      tg.receive(update(3, "Hello")),
    ]);
    assert.deepEqual(replies[0], replies[1]);
    await wait(app, id);
    await tg.flush();
    await tg.flush();
    assert.equal(sends, 1);
    assert.equal(
      app.store.get<{ state: string }>("SELECT state FROM deliveries")?.state,
      "uncertain",
    );
    await app.close();
    app = await Runtime.open({ dir, gateway });
    tg = new Telegram(app, transport, ["42"], ["100"]);
    await tg.receive(update(3, "Hello"));
    await tg.flush();
    assert.equal(sends, 1);
    assert.equal(
      (await app.snapshot(id)).view.entries.filter((e) => e.kind === "pi.user")
        .length,
      1,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("persisted in-flight actions and deliveries become uncertain, owner lock rejects second process", async () => {
  const dir = await temp();
  const app = await Runtime.open({ dir, gateway });
  try {
    await assert.rejects(Runtime.open({ dir, gateway }), /already being held/);
    app.store.run(
      "INSERT INTO actions(id,conversationId,server,tool,args,state) VALUES ('a','1','mock','write','{}','running')",
    );
    app.store.run(
      "INSERT INTO deliveries(id,chat,text,state) VALUES ('a','100','hello','sending')",
    );
    await app.close();
    const store = new Store(dir);
    try {
      assert.equal(
        store.get<{ state: string }>("SELECT state FROM actions")?.state,
        "uncertain",
      );
      assert.equal(
        store.get<{ state: string }>("SELECT state FROM deliveries")?.state,
        "uncertain",
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read evidence is scoped to current input and server, replayed proposal stays idempotent", async () => {
  const dir = await temp();
  const app = await Runtime.open({ dir, gateway });
  try {
    const id = await app.create();
    await app.actions.read(id, "mock", "read", {}, "input1");
    assert.throws(
      () => app.actions.propose(id, 50, "mock", "write", {}, "input2"),
      /Leia/,
    );
    assert.throws(
      () => app.actions.propose(id, 50, "different", "write", {}, "input1"),
      /Leia/,
    );
    const first = app.actions.propose(id, 50, "mock", "write", {}, "input1");
    app.store.run("DELETE FROM reads");
    assert.equal(
      app.actions.propose(id, 50, "mock", "write", {}, "input1").id,
      first.id,
    );
    assert.throws(
      () => app.actions.propose(id, 50, "mock", "changed", {}, "input1"),
      /outro conteúdo/,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Telegram duplicate approvals persist outcome and send exactly one command acknowledgement", async () => {
  const dir = await temp();
  let writes = 0,
    sends = 0;
  const gateway = {
    call: async (
      _s: string,
      _t: string,
      _a: Record<string, unknown>,
      kind: "read" | "action",
    ) => {
      if (kind === "action") {
        writes++;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { content: [] };
    },
  };
  const app = await Runtime.open({ dir, gateway });
  try {
    const id = await app.create();
    const tg = new Telegram(
      app,
      {
        send: async () => {
          sends++;
          return { ok: true };
        },
      },
      ["42"],
      ["100"],
    );
    const update = (n: number, text: string) => ({
      update_id: n,
      message: {
        message_id: n,
        text,
        from: { id: 42 },
        chat: { id: 100, type: "private" },
      },
    });
    await tg.receive(update(10, `/link ${app.store.link(id)}`));
    await app.actions.read(id, "mock", "read", {});
    const action = app.actions.propose(id, 666, "mock", "write", {});
    await Promise.all([
      tg.receive(update(11, `/approve ${action.id}`)),
      tg.receive(update(11, `/approve ${action.id}`)),
    ]);
    await tg.receive(update(11, `/approve ${action.id}`));
    await wait(app, id);
    await tg.flush();
    await tg.flush();
    assert.equal(writes, 1);
    assert.equal(sends, 1);
    assert.equal(
      app.store.get<{ status: string }>(
        "SELECT status FROM requests WHERE requestId=?",
        `action:${action.id}:done`,
      )?.status,
      "done",
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
