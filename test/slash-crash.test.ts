import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { CompactionResult, TaskId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Runtime } from "../src/runtime.js";

test(
  "SIGKILL after compact admission leaves an uncertain receipt and never admits a second compaction",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-slash-crash-"));
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "test/slash-crash-child.ts", dir],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let app: Runtime | undefined;
    let errors = "";
    let output = "";
    const childClosed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveClose) => {
      child.once("close", (code, signal) => resolveClose({ code, signal }));
    });

    try {
      const compact = await new Promise<{
        taskId: number;
        conversationId: string;
        command: string;
      }>((resolveMarker, reject) => {
        let matched = false;
        const timeout = setTimeout(
          () => reject(new Error(`Child timed out: ${errors}`)),
          10000,
        );
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
          const match = /COMPACT_ADMITTED (.+)\n/.exec(output);
          if (match && !matched) {
            matched = true;
            clearTimeout(timeout);
            resolveMarker(
              JSON.parse(match[1]) as {
                taskId: number;
                conversationId: string;
                command: string;
              },
            );
          }
        });
        child.stderr.on("data", (chunk) => {
          errors += String(chunk);
        });
        child.once("close", (code, signal) => {
          if (!matched) {
            clearTimeout(timeout);
            reject(
              new Error(
                `Child exited before compaction admission (${signal ?? code}): ${errors}`,
              ),
            );
          }
        });
      });

      const exit = await childClosed;
      assert.equal(exit.signal, "SIGKILL");
      assert.equal(compact.command, "compact");
      assert.ok(compact.taskId);
      // Runtime.open uses a 30-second owner lease. Wait for its dead process lease
      // to expire before reopening the same durable directory.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 31000));

      const faux = fauxProvider({ models: [{ id: "one", reasoning: true }] });
      faux.setResponses(
        Array.from({ length: 4 }, () =>
          fauxAssistantMessage("A compacted context summary"),
        ),
      );
      const models = createModels();
      models.setProvider(faux.provider);
      app = await Runtime.open({
        dir,
        gateway: { call: async () => ({}) },
        models,
        modelId: "one",
      });

      const receiptRow = app.store.get<{
        state: string;
        result: string | null;
      }>(
        "SELECT state,result FROM command_receipts WHERE conversationId=? AND requestId=?",
        compact.conversationId,
        "compact-crash",
      );
      assert.equal(receiptRow?.state, "uncertain");
      assert.equal(receiptRow?.result, null);

      const task = await app.harness.getTask(
        compact.taskId as TaskId<CompactionResult>,
        context,
      );
      assert.equal(task?.kind, "pi.compaction");
      assert.equal(String(task?.conversationId), compact.conversationId);

      let duplicateAdmissions = 0;
      const openConversation = app.conversation.bind(app);
      app.conversation = async (id) => {
        const conversation = await openConversation(id);
        const compactConversation = conversation.compact.bind(conversation);
        conversation.compact = (...args) => {
          duplicateAdmissions++;
          return compactConversation(...args);
        };
        return conversation;
      };
      const retry = await app.admit(
        compact.conversationId,
        "compact-crash",
        "/compact Preserve the crash fixture",
        { source: "web" },
      );
      assert.equal(retry.kind, "command");
      assert.equal(retry.command, "compact");
      assert.equal(retry.status, "uncertain");
      assert.equal(retry.taskId, undefined);
      assert.equal(duplicateAdmissions, 0);
      const retryReceipt = await app.commands.receipt(
        compact.conversationId,
        "compact-crash",
        { source: "web" },
      );
      assert.equal(retryReceipt?.status, "uncertain");
      assert.equal(retryReceipt?.taskId, undefined);
    } finally {
      child.kill("SIGKILL");
      await app?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
