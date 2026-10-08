import { writeSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";

const faux = fauxProvider({ models: [{ id: "one", reasoning: true }] });
faux.setResponses([fauxAssistantMessage("A compacted context summary")]);
const models = createModels();
models.setProvider(faux.provider);
const app = await Runtime.open({
  dir: process.argv[2],
  gateway: { call: async () => ({}) },
  models,
  modelId: "one",
});
const id = await app.create("Compact crash fixture");
const run = app.store.run.bind(app.store);
app.store.run = ((sql: string, ...args: (string | number | null)[]) => {
  if (sql.startsWith("UPDATE command_receipts SET state='done',result=?")) {
    // The compaction task was committed by compact(); kill the owner before its
    // command receipt can be acknowledged, leaving only pending admission.
    writeSync(
      1,
      `COMPACT_ADMITTED ${JSON.stringify(JSON.parse(String(args[0])))}\n`,
    );
    process.kill(process.pid, "SIGKILL");
  }
  return run(sql, ...args);
}) as typeof app.store.run;

await app.admit(id, "compact-crash", "/compact Preserve the crash fixture", {
  source: "web",
});
setInterval(() => {}, 1000);
