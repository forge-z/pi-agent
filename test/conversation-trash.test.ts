import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Runtime } from "../src/runtime.js";
import { createAppServer } from "../src/server.js";
import { CONVERSATION_RETENTION_MS } from "../src/conversation-trash.js";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  AgentDoc,
  defineDoc,
  defineTask,
  type ConversationId,
} from "@earendil-works/pi-durable";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-trash-"));
  let now = 1_800_000_000_000;
  const options = { dir, gateway: { call: async () => ({}) }, now: () => now };
  let app = await Runtime.open(options);
  const db = new DatabaseSync(join(dir, "durable.sqlite"));
  return {
    dir,
    db,
    get app() {
      return app;
    },
    get now() {
      return now;
    },
    set now(value: number) {
      now = value;
    },
    async restart() {
      await app.close();
      app = await Runtime.open(options);
    },
    async close() {
      db.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function history(app: Runtime, id: string) {
  return app.harness.commit(
    (tx) =>
      tx.appendEntry(Number(id) as ConversationId, {
        kind: "fixture.secret",
        data: { text: "synthetic private history" },
      }),
    context,
  );
}

test("retention expires at exactly seven days, persists restarts and never recovers purged IDs", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create("Temporary");
    await history(f.app, id);
    const archived = await f.app.deleteConversation(id);
    assert.equal(archived.purgeAt, f.now + CONVERSATION_RETENTION_MS);
    assert.equal(f.app.listConversations(true)[0].purgeAt, archived.purgeAt);
    f.now = archived.purgeAt - 1;
    await f.app.sweepConversationTrash();
    assert.equal(f.app.listConversations(true).length, 1);
    await f.restart();
    assert.equal(f.app.listConversations(true)[0].purgeAt, archived.purgeAt);
    f.now++;
    await f.app.sweepConversationTrash();
    assert.equal(f.app.listConversations(true).length, 0);
    assert.equal(f.app.store.conversationDeleted(id), true);
    assert.equal(
      f.db.prepare("SELECT 1 FROM conversations WHERE id=?").get(Number(id)),
      undefined,
    );
    assert.throws(() => f.app.restoreConversation(id), /permanente/);
    await f.restart();
    assert.equal(f.app.listConversations().length, 0);
    assert.equal(f.app.listConversations(true).length, 0);
    assert.equal(f.app.store.conversationDeleted(id), true);
    const next = await f.app.create("New identity");
    assert.ok(Number(next) > Number(id));
  } finally {
    await f.close();
  }
});

test("legacy archives get one persistent activation grace period; restore and rearchive reset it safely", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create("Legacy");
    f.app.store.run("INSERT INTO conversation_lifecycle VALUES (?,?)", id, 1);
    await f.restart();
    const deadline = f.app.listConversations(true)[0].purgeAt;
    assert.equal(deadline, f.now + CONVERSATION_RETENTION_MS);
    f.now += 10_000;
    await f.restart();
    assert.equal(f.app.listConversations(true)[0].purgeAt, deadline);
    f.app.restoreConversation(id);
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM conversation_retention WHERE conversationId=?",
        id,
      ),
      undefined,
    );
    const first = await f.app.deleteConversation(id);
    f.app.restoreConversation(id);
    const second = await f.app.deleteConversation(id);
    assert.ok(
      second.deletedAt > first.deletedAt,
      "same-clock ABA uses monotonic archive version",
    );
    assert.equal(second.purgeAt, second.deletedAt + CONVERSATION_RETENTION_MS);
    await assert.rejects(
      f.app.purgeConversation(id, true, first.deletedAt),
      /mudou/,
    );
    assert.equal(f.app.listConversations(true).length, 1);
  } finally {
    await f.close();
  }
});

test("explicit immediate purge removes only owned app and Durable history and preserves global data", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create("Remove");
    const other = await f.app.create("Keep");
    const entry = await history(f.app, id);
    await history(f.app, other);
    const taskDoc = defineDoc({
      kind: "fixture.task-doc",
      version: 1,
      scope: "task",
      initial: () => ({ secret: "synthetic" }),
    });
    const sessionDoc = defineDoc({
      kind: "fixture.session-doc",
      version: 1,
      scope: "session",
      initial: () => ({ global: "keep" }),
    });
    const task = defineTask({
      name: "fixture.unregistered",
      version: 1,
      initial: () => ({ phase: "start" as const }),
      phases: { start: async () => {} },
      abort: async () => {},
    });
    const ownedTask = await f.app.harness.commit(async (tx) => {
      const taskId = await tx.createTask(
        task,
        {},
        {
          ownership: { kind: "conversation" },
          conversationId: Number(id) as ConversationId,
        },
      );
      await tx.doc(taskDoc, taskId);
      await tx.doc(sessionDoc);
      await tx.createSubmission({
        type: "write",
        conversationId: Number(id) as ConversationId,
        status: "done",
        entry: entry.id,
        requestId: "fixture-submission",
      });
      return taskId;
    }, context);
    assert.deepEqual(
      await f.app.harness.snapshot(taskDoc, ownedTask, context),
      { secret: "synthetic" },
    );
    await f.app.harness.abortTask(ownedTask, context);
    await f.app.harness.waitForTask(ownedTask, context);
    const taskDocs = f.db
      .prepare(
        "SELECT id FROM documents WHERE scope_kind='task' AND owner_id=?",
      )
      .all(ownedTask) as { id: number }[];
    assert.ok(taskDocs.length);
    assert.ok(
      await f.app.harness.snapshot(
        AgentDoc,
        Number(id) as ConversationId,
        context,
      ),
    );
    const ownDocs = f.db
      .prepare(
        "SELECT id FROM documents WHERE scope_kind='conversation' AND owner_id=?",
      )
      .all(Number(id)) as { id: number }[];
    assert.ok(ownDocs.length > 0);
    f.app.store.run("INSERT INTO credentials VALUES ('fixture','synthetic')");
    f.app.store.run("INSERT INTO sessions VALUES ('fixture',123)");
    f.app.store.run("INSERT INTO meta VALUES ('mcp-config','synthetic')");
    f.app.store.run(
      "INSERT INTO telegram_updates VALUES (123,'fingerprint-only')",
    );
    for (const conversation of [id, other]) {
      f.app.store.run(
        "INSERT INTO actions(id,conversationId,state,args,result) VALUES (?,?,'done','private','private')",
        `action-${conversation}`,
        conversation,
      );
      f.app.store.run(
        "INSERT INTO requests VALUES (?,'request','private',NULL,'web',NULL,'done')",
        conversation,
      );
      f.app.store.run(
        "INSERT INTO tasks(id,title,prompt,conversationId,kind,schedule,timezone,enabled) VALUES (?,'private','private',?,'once','2099-01-01T00:00:00Z','Etc/UTC',0)",
        `task-${conversation}`,
        conversation,
      );
      f.app.store.run(
        "INSERT INTO task_runs(id,taskId,scheduledAt,state,requestId) VALUES (?,?,1,'done',?)",
        `run-${conversation}`,
        `task-${conversation}`,
        `task-request-${conversation}`,
      );
      f.app.store.run(
        "INSERT INTO task_run_keys VALUES (?,?)",
        `task-request-${conversation}`,
        `run-${conversation}`,
      );
      f.app.store.run(
        "INSERT INTO task_creations VALUES (?,?, 'private')",
        `create-${conversation}`,
        `task-${conversation}`,
      );
      f.app.store.run(
        "INSERT INTO task_delivery_changes VALUES (?,?,'web','private')",
        `change-${conversation}`,
        `task-${conversation}`,
      );
      f.app.store.run(
        "INSERT INTO command_receipts VALUES (?,?,?,'private','done','private')",
        `cmd-${conversation}`,
        conversation,
        `command-request-${conversation}`,
      );
      f.app.store.queueTelegram(
        `command:command-request-${conversation}`,
        "42",
        "private",
        4000,
        conversation,
      );
    }
    f.app.store.run(
      "INSERT INTO meta VALUES ('telegram:update:123',?)",
      JSON.stringify({ conversationId: id, text: "private" }),
    );
    f.app.store.run(
      "INSERT INTO deliveries(id,chat,text,state) VALUES ('decision:123','42','private','sent'),('unknown-legacy','42','keep','sent')",
    );
    const archived = await f.app.deleteConversation(id);
    await assert.rejects(
      f.app.purgeConversation(id, false, archived.deletedAt),
      /Confirme/,
    );
    await assert.rejects(
      f.app.purgeConversation(id, true, undefined),
      /versão/,
    );
    await f.app.purgeConversation(id, true, archived.deletedAt);
    assert.equal(f.app.store.actions(id).length, 0);
    assert.equal(
      f.app.store.get("SELECT 1 FROM tasks WHERE conversationId=?", id),
      undefined,
    );
    assert.equal(
      f.app.store.get("SELECT 1 FROM task_run_keys WHERE runId=?", `run-${id}`),
      undefined,
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM deliveries WHERE id=?",
        `command:command-request-${id}:0`,
      ),
      undefined,
    );
    assert.equal(
      f.app.store.get("SELECT 1 FROM deliveries WHERE id='decision:123'"),
      undefined,
    );
    assert.ok(
      f.app.store.get("SELECT 1 FROM deliveries WHERE id='unknown-legacy'"),
    );
    assert.ok(
      f.app.store.get(
        "SELECT 1 FROM deliveries WHERE id=?",
        `command:command-request-${other}:0`,
      ),
    );
    assert.equal(
      f.app.store.get("SELECT 1 FROM meta WHERE key='telegram:update:123'"),
      undefined,
    );
    assert.ok(f.app.store.get("SELECT 1 FROM telegram_updates WHERE id=123"));
    for (const table of ["credentials", "sessions"])
      assert.equal(f.app.store.all(`SELECT * FROM ${table}`).length, 1);
    assert.ok(f.app.store.get("SELECT 1 FROM meta WHERE key='mcp-config'"));
    assert.equal(f.app.store.actions(other).length, 1);
    assert.ok(
      f.app.store.get("SELECT 1 FROM tasks WHERE conversationId=?", other),
    );
    for (const table of ["conversations", "entries", "tasks", "submissions"])
      assert.equal(
        f.db
          .prepare(
            `SELECT 1 FROM ${table} WHERE ${table === "conversations" ? "id" : "conversation_id"}=?`,
          )
          .get(Number(id)),
        undefined,
      );
    assert.equal(
      f.db.prepare("SELECT 1 FROM record_ids WHERE id=?").get(entry.id),
      undefined,
    );
    for (const doc of [...ownDocs, ...taskDocs]) {
      assert.equal(
        f.db.prepare("SELECT 1 FROM documents WHERE id=?").get(doc.id),
        undefined,
      );
      assert.equal(
        f.db
          .prepare("SELECT 1 FROM document_revisions WHERE document_id=?")
          .get(doc.id),
        undefined,
      );
      assert.equal(
        f.db.prepare("SELECT 1 FROM record_ids WHERE id=?").get(doc.id),
        undefined,
      );
    }
    assert.equal(
      await f.app.harness.snapshot(taskDoc, ownedTask, context),
      undefined,
    );
    assert.equal(
      await f.app.harness.snapshot(
        AgentDoc,
        Number(id) as ConversationId,
        context,
      ),
      undefined,
      "cached conversation document evicted",
    );
    assert.deepEqual(await f.app.harness.snapshot(sessionDoc, context), {
      global: "keep",
    });
    assert.equal(
      f.db.prepare("SELECT 1 FROM record_ids WHERE id=?").get(ownedTask),
      undefined,
    );
    assert.ok(
      (await f.app.snapshot(other)).view.entries.some(
        (e) => e.kind === "fixture.secret",
      ),
    );
  } finally {
    await f.close();
  }
});

test("HTTP purge requires auth, origin, explicit confirmation and current deletedAt", async () => {
  const f = await fixture();
  const origin = "http://127.0.0.1:3000";
  const web = createAppServer(f.app, {
    password: "synthetic-password",
    origin,
    secureCookie: false,
  });
  await new Promise<void>((resolve) =>
    web.server.listen(0, "127.0.0.1", resolve),
  );
  const address = web.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = "";
  const post = (path: string, data: unknown, requestOrigin = origin) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        cookie,
        origin: requestOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
    });
  try {
    const id = await f.app.create("HTTP");
    const archived = await f.app.deleteConversation(id);
    const path = `/api/conversations/${id}/purge`;
    assert.equal(
      (
        await post(path, {
          confirm: true,
          expectedDeletedAt: archived.deletedAt,
        })
      ).status,
      401,
    );
    const login = await post("/api/login", { password: "synthetic-password" });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (
        await post(
          path,
          { confirm: true, expectedDeletedAt: archived.deletedAt },
          "https://evil.test",
        )
      ).status,
      403,
    );
    assert.equal(
      (await post(path, { expectedDeletedAt: archived.deletedAt })).status,
      400,
    );
    assert.equal((await post(path, { confirm: true })).status, 400);
    assert.equal(
      (
        await post(path, {
          confirm: true,
          expectedDeletedAt: archived.deletedAt - 1,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await post(path, {
          confirm: true,
          expectedDeletedAt: archived.deletedAt,
        })
      ).status,
      200,
    );
    assert.equal(
      (await post(`/api/conversations/${id}/restore`, {})).status,
      409,
    );
  } finally {
    await web.close();
    await f.close();
  }
});

test("fault after claim rolls back Durable removal, forbids restoration and resumes after restart", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create("Interrupted");
    await history(f.app, id);
    const archived = await f.app.deleteConversation(id);
    f.db.exec(
      "CREATE TRIGGER fail_purge BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT,'synthetic after-claim failure'); END",
    );
    await assert.rejects(
      f.app.purgeConversation(id, true, archived.deletedAt),
      /after-claim/,
    );
    assert.ok(
      f.app.store.get(
        "SELECT 1 FROM conversation_purges WHERE conversationId=? AND completedAt IS NULL",
        id,
      ),
    );
    assert.ok(
      f.db
        .prepare("SELECT 1 FROM entries WHERE conversation_id=?")
        .get(Number(id)),
    );
    assert.throws(() => f.app.restoreConversation(id), /permanente/);
    await f.restart();
    assert.equal(f.app.listConversations().length, 0);
    assert.equal(f.app.listConversations(true).length, 0);
    f.db.exec("DROP TRIGGER fail_purge");
    await f.app.sweepConversationTrash();
    assert.ok(
      f.app.store.get(
        "SELECT 1 FROM conversation_purges WHERE conversationId=? AND completedAt IS NOT NULL",
        id,
      ),
    );
    assert.equal(
      f.db
        .prepare("SELECT 1 FROM entries WHERE conversation_id=?")
        .get(Number(id)),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("app cleanup interruption resumes after Durable removal and cannot resurrect the chat", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create("Interrupted app");
    const archived = await f.app.deleteConversation(id);
    f.app.store.db.exec(
      "CREATE TRIGGER fail_app_purge BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT,'synthetic app cleanup failure'); END",
    );
    await assert.rejects(
      f.app.purgeConversation(id, true, archived.deletedAt),
      /cleanup/,
    );
    assert.equal(
      f.db.prepare("SELECT 1 FROM conversations WHERE id=?").get(Number(id)),
      undefined,
    );
    assert.throws(() => f.app.restoreConversation(id), /permanente/);
    await f.restart();
    assert.equal(f.app.listConversations().length, 0);
    f.app.store.db.exec("DROP TRIGGER fail_app_purge");
    await f.app.sweepConversationTrash();
    assert.equal(
      f.app.store.get("SELECT 1 FROM conversations WHERE id=?", id),
      undefined,
    );
    assert.equal(f.app.store.conversationDeleted(id), true);
  } finally {
    await f.close();
  }
});

test("purge reserves the conversation against restore and competing purges before awaits", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create("Raced");
    const archived = await f.app.deleteConversation(id);
    const commit = f.app.harness.commit.bind(f.app.harness);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.app.harness.commit = async (...args) => {
      await gate;
      return commit(...args);
    };
    const purge = f.app.purgeConversation(id, true, archived.deletedAt);
    assert.throws(() => f.app.restoreConversation(id), /atualização/);
    await assert.rejects(
      f.app.purgeConversation(id, true, archived.deletedAt),
      /atualização/,
    );
    release();
    await purge;
  } finally {
    await f.close();
  }
});

test("unsupported schemas and protected root fail closed before purge claim", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create("Version");
    const archived = await f.app.deleteConversation(id);
    f.db.exec("UPDATE durable_schema SET version=2");
    await assert.rejects(
      f.app.purgeConversation(id, true, archived.deletedAt),
      /incompatível/,
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM conversation_purges WHERE conversationId=?",
        id,
      ),
      undefined,
    );
    assert.ok(
      f.db.prepare("SELECT 1 FROM conversations WHERE id=?").get(Number(id)),
    );
    f.db.exec("UPDATE durable_schema SET version=1");
    await assert.rejects(
      f.app.purgeConversation("1", true, archived.deletedAt),
      /raiz/,
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM conversation_purges WHERE conversationId='1'",
      ),
      undefined,
    );
    f.app.restoreConversation(id);
  } finally {
    await f.close();
  }
});

test("surviving forks block purge and remain readable", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create("Parent");
    const entry = await history(f.app, id);
    const fork = await f.app.harness.commit(
      (tx) =>
        tx.forkConversation(Number(id) as ConversationId, entry.id, {
          ownership: { kind: "ownerless" },
        }),
      context,
    );
    f.app.store.run(
      "INSERT INTO conversations VALUES (?,'Fork')",
      String(fork.id),
    );
    const archived = await f.app.deleteConversation(id);
    await assert.rejects(
      f.app.purgeConversation(id, true, archived.deletedAt),
      /depende/,
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM conversation_purges WHERE conversationId=?",
        id,
      ),
      undefined,
    );
    assert.ok(
      (await f.app.snapshot(String(fork.id))).view.entries.some(
        (e) => e.kind === "fixture.secret",
      ),
    );
    f.app.restoreConversation(id);
  } finally {
    await f.close();
  }
});

test("pending and uncertain app operations block purge; per-conversation sweeps keep making progress", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create("Blocked");
    const other = await f.app.create("Expires");
    const archived = await f.app.deleteConversation(id);
    await f.app.deleteConversation(other);
    f.app.store.run(
      "INSERT INTO actions(id,conversationId,state) VALUES ('pending',?,'uncertain')",
      id,
    );
    await assert.rejects(
      f.app.purgeConversation(id, true, archived.deletedAt),
      /pendente/,
    );
    f.now = archived.purgeAt;
    await f.app.sweepConversationTrash();
    assert.equal(f.app.listConversations(true).length, 1);
    assert.equal(
      f.app.store.get("SELECT 1 FROM conversations WHERE id=?", other),
      undefined,
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM conversation_purges WHERE conversationId=?",
        id,
      ),
      undefined,
    );
    f.app.store.run("DELETE FROM actions WHERE id='pending'");
    await f.app.sweepConversationTrash();
    assert.equal(f.app.listConversations(true).length, 0);
  } finally {
    await f.close();
  }
});

test("surviving tasks waiting on an owned terminal task block permanent removal", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create("Task owner");
    const other = await f.app.create("Waiting owner");
    const insertTask = f.db.prepare(
      "INSERT INTO tasks VALUES (?,?,?, ?,0,0,?)",
    );
    const own = {
      id: 10001,
      conversationId: Number(id),
      kind: "fixture",
      version: 1,
      input: {},
      background: false,
      abortRequested: false,
      state: {
        status: "terminal",
        outcome: { status: "completed", result: {} },
      },
    };
    const waiting = {
      ...own,
      id: 10002,
      conversationId: Number(other),
      state: {
        status: "waiting",
        checkpoint: {},
        on: [own.id],
        policy: "allSettled",
      },
    };
    insertTask.run(
      own.id,
      Number(id),
      JSON.stringify("fixture"),
      "terminal",
      JSON.stringify(own),
    );
    insertTask.run(
      waiting.id,
      Number(other),
      JSON.stringify("fixture"),
      "waiting",
      JSON.stringify(waiting),
    );
    f.db.prepare("INSERT INTO record_ids VALUES (?,'task')").run(own.id);
    f.db.prepare("INSERT INTO record_ids VALUES (?,'task')").run(waiting.id);
    const archived = await f.app.deleteConversation(id);
    await assert.rejects(
      f.app.purgeConversation(id, true, archived.deletedAt),
      /depende/,
    );
    assert.ok(f.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(own.id));
    assert.ok(f.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(waiting.id));
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM conversation_purges WHERE conversationId=?",
        id,
      ),
      undefined,
    );
    f.db.prepare("DELETE FROM tasks WHERE id IN (?,?)").run(own.id, waiting.id);
    f.db
      .prepare("DELETE FROM record_ids WHERE id IN (?,?)")
      .run(own.id, waiting.id);
  } finally {
    await f.close();
  }
});

test("denormalized record ownership mismatches fail closed before any purge claim", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create("Malformed");
    const other = await f.app.create("Keep");
    const entry = await history(f.app, other);
    const archived = await f.app.deleteConversation(id);
    const original = f.db
      .prepare("SELECT record FROM conversations WHERE id=?")
      .get(Number(id)) as { record: string };
    for (const owner of [
      null,
      [],
      {},
      { conversationId: Number(other), taskId: "bad" },
    ]) {
      f.db
        .prepare(
          "UPDATE conversations SET record=json_set(record,'$.owner',json(?)) WHERE id=?",
        )
        .run(JSON.stringify(owner), Number(id));
      await assert.rejects(
        f.app.purgeConversation(id, true, archived.deletedAt),
        /inconsistentes/,
      );
      assert.equal(
        f.app.store.get(
          "SELECT 1 FROM conversation_purges WHERE conversationId=?",
          id,
        ),
        undefined,
      );
      f.db
        .prepare("UPDATE conversations SET record=? WHERE id=?")
        .run(original.record, Number(id));
    }
    f.db
      .prepare("UPDATE entries SET conversation_id=? WHERE id=?")
      .run(Number(id), entry.id);
    await assert.rejects(
      f.app.purgeConversation(id, true, archived.deletedAt),
      /inconsistentes/,
    );
    assert.ok(f.db.prepare("SELECT 1 FROM entries WHERE id=?").get(entry.id));
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM conversation_purges WHERE conversationId=?",
        id,
      ),
      undefined,
    );
    f.db
      .prepare("UPDATE entries SET conversation_id=? WHERE id=?")
      .run(Number(other), entry.id);
    const doc = f.db
      .prepare(
        "SELECT id FROM documents WHERE scope_kind='conversation' AND owner_id=? LIMIT 1",
      )
      .get(Number(other)) as { id: number };
    f.db
      .prepare("UPDATE documents SET owner_id=? WHERE id=?")
      .run(Number(id), doc.id);
    await assert.rejects(
      f.app.purgeConversation(id, true, archived.deletedAt),
      /inconsistentes/,
    );
    assert.ok(f.db.prepare("SELECT 1 FROM documents WHERE id=?").get(doc.id));
    f.db
      .prepare("UPDATE documents SET owner_id=? WHERE id=?")
      .run(Number(other), doc.id);
    await f.app.purgeConversation(id, true, archived.deletedAt);
    assert.ok(
      (await f.app.snapshot(other)).view.entries.some(
        (e) => e.kind === "fixture.secret",
      ),
    );
  } finally {
    await f.close();
  }
});

test("explicit delivery owners override matching prefixes and colliding command aliases", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create("Remove");
    const other = await f.app.create("Keep");
    for (const conversation of [id, other])
      f.app.store.run(
        "INSERT INTO command_receipts VALUES (?,?, 'same-request','private','done','private')",
        `cmd-${conversation}`,
        conversation,
      );
    f.app.store.queueTelegram(
      "command:same-request",
      "42",
      "other command",
      4000,
      other,
    );
    f.app.store.queueTelegram(
      `${id}:misleading-prefix`,
      "42",
      "other reply",
      4000,
      other,
    );
    f.app.store.run(
      "INSERT INTO deliveries(id,chat,text,state) VALUES ('command:same-request:legacy','42','ambiguous','sent')",
    );
    const archived = await f.app.deleteConversation(id);
    for (const deliveryId of [
      "command:same-request:0",
      `${id}:misleading-prefix:0`,
    ])
      assert.equal(
        f.app.store.get<{ state: string }>(
          "SELECT state FROM deliveries WHERE id=?",
          deliveryId,
        )?.state,
        "pending",
      );
    await f.app.purgeConversation(id, true, archived.deletedAt);
    for (const deliveryId of [
      "command:same-request:0",
      `${id}:misleading-prefix:0`,
      "command:same-request:legacy",
    ])
      assert.ok(
        f.app.store.get("SELECT 1 FROM deliveries WHERE id=?", deliveryId),
      );
    assert.ok(
      f.app.store.get(
        "SELECT 1 FROM command_receipts WHERE conversationId=?",
        other,
      ),
    );
  } finally {
    await f.close();
  }
});

test("all unresolved ledgers and Durable admissions fail closed before purge claim", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create("Protected operations");
    f.app.store.run(
      "INSERT INTO tasks(id,title,prompt,conversationId,kind,schedule,timezone,enabled) VALUES ('guard','synthetic','synthetic',?,'once','2099-01-01T00:00:00Z','Etc/UTC',0)",
      id,
    );
    const archived = await f.app.deleteConversation(id);
    f.app.store.db.exec(
      "CREATE TABLE mcp_calls(id TEXT,conversationId TEXT,state TEXT); CREATE TABLE mcp_interactions(id TEXT,conversationId TEXT,state TEXT); CREATE TABLE cua_handoffs(id TEXT,conversationId TEXT,state TEXT)",
    );
    const fixtures = [
      {
        insert:
          "INSERT INTO requests VALUES (?,'guard','synthetic',NULL,'web',NULL,'pending')",
        remove: "DELETE FROM requests WHERE requestId='guard'",
      },
      {
        insert:
          "INSERT INTO actions(id,conversationId,state) VALUES ('guard',?,'running')",
        remove: "DELETE FROM actions WHERE id='guard'",
      },
      {
        insert:
          "INSERT INTO command_receipts VALUES ('guard',?,'guard','synthetic','uncertain',NULL)",
        remove: "DELETE FROM command_receipts WHERE key='guard'",
      },
      {
        insert: "INSERT INTO mcp_calls VALUES ('guard',?,'paused')",
        remove: "DELETE FROM mcp_calls",
      },
      {
        insert: "INSERT INTO mcp_interactions VALUES ('guard',?,'pending')",
        remove: "DELETE FROM mcp_interactions",
      },
      {
        insert: "INSERT INTO cua_handoffs VALUES ('guard',?,'uncertain')",
        remove: "DELETE FROM cua_handoffs",
      },
    ];
    for (const guard of fixtures) {
      f.app.store.run(guard.insert, id);
      await assert.rejects(
        f.app.purgeConversation(id, true, archived.deletedAt),
        /pendente/,
      );
      assert.equal(
        f.app.store.get(
          "SELECT 1 FROM conversation_purges WHERE conversationId=?",
          id,
        ),
        undefined,
      );
      f.app.store.db.exec(guard.remove);
    }
    f.app.store.run(
      "INSERT INTO task_runs(id,taskId,scheduledAt,state,requestId) VALUES ('guard','guard',1,'pending','guard')",
    );
    await assert.rejects(
      f.app.purgeConversation(id, true, archived.deletedAt),
      /pendente/,
    );
    f.app.store.run("DELETE FROM task_runs WHERE id='guard'");
    for (const state of ["sending", "uncertain"]) {
      f.app.store.run(
        "INSERT INTO deliveries(id,text,state) VALUES ('guard','synthetic',?)",
        state,
      );
      f.app.store.run(
        "INSERT INTO delivery_conversations VALUES ('guard',?)",
        id,
      );
      await assert.rejects(
        f.app.purgeConversation(id, true, archived.deletedAt),
        /entrega/,
      );
      f.app.store.run("DELETE FROM deliveries WHERE id='guard'");
      f.app.store.run(
        "DELETE FROM delivery_conversations WHERE deliveryId='guard'",
      );
    }
    const submission = await f.app.harness.commit(
      (tx) =>
        tx.createSubmission({
          type: "write",
          conversationId: Number(id) as ConversationId,
          status: "queued",
          requestId: "guard",
        }),
      context,
    );
    await assert.rejects(
      f.app.purgeConversation(id, true, archived.deletedAt),
      /execução/,
    );
    await f.app.harness.commit(
      (tx) =>
        tx.settleSubmission(submission.id, {
          status: "unanswered",
          reason: "synthetic cleanup",
        }),
      context,
    );
    const task = defineTask({
      name: "fixture.blocked",
      version: 1,
      initial: () => ({ phase: "start" as const }),
      phases: { start: async () => {} },
      abort: async () => {},
    });
    const taskId = await f.app.harness.commit(
      (tx) =>
        tx.createTask(
          task,
          {},
          {
            ownership: { kind: "conversation" },
            conversationId: Number(id) as ConversationId,
          },
        ),
      context,
    );
    await assert.rejects(
      f.app.purgeConversation(id, true, archived.deletedAt),
      /execução/,
    );
    await f.app.harness.abortTask(taskId, context);
    await f.app.harness.waitForTask(taskId, context);
    await f.app.purgeConversation(id, true, archived.deletedAt);
  } finally {
    await f.close();
  }
});

test(
  "purge removes 1,600 synthetic history entries over 5 MB while preserving another chat",
  { timeout: 30_000 },
  async () => {
    const f = await fixture();
    try {
      const id = await f.app.create("Large history");
      const other = await f.app.create("Preserved history");
      f.app.renameConversation(id, "Large renamed history");
      await history(f.app, other);
      const payload = "synthetic payload ".repeat(210);
      await f.app.harness.commit(async (tx) => {
        for (let index = 0; index < 1600; index++)
          await tx.appendEntry(Number(id) as ConversationId, {
            kind: "fixture.secret",
            data: { index, payload },
          });
      }, context);
      const bytes = f.db
        .prepare(
          "SELECT SUM(length(record)) AS bytes FROM entries WHERE conversation_id=?",
        )
        .get(Number(id)) as { bytes: number };
      assert.ok(bytes.bytes > 5_500_000);
      const metadataBefore = f.db
        .prepare("SELECT * FROM durable_metadata")
        .get();
      const archived = await f.app.deleteConversation(id);
      await f.app.purgeConversation(id, true, archived.deletedAt);
      assert.equal(
        f.db
          .prepare(
            "SELECT COUNT(*) AS count FROM entries WHERE conversation_id=?",
          )
          .get(Number(id))?.count,
        0,
      );
      assert.equal(
        f.app.store.get("SELECT 1 FROM conversations WHERE id=?", id),
        undefined,
      );
      assert.equal(
        f.app.store.get(
          "SELECT 1 FROM conversation_titles WHERE conversationId=?",
          id,
        ),
        undefined,
      );
      assert.deepEqual(
        f.db.prepare("SELECT * FROM durable_metadata").get(),
        metadataBefore,
      );
      assert.ok(
        (await f.app.snapshot(other)).view.entries.some(
          (entry) => entry.kind === "fixture.secret",
        ),
      );
    } finally {
      await f.close();
    }
  },
);
