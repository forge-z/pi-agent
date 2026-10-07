import { randomUUID } from "node:crypto";
import type { AuthPrompt, AuthEvent } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { Store } from "./store.js";
interface Flow {
  owner: string;
  state: string;
  events: AuthEvent[];
  prompt?: { id: string; message: string; type: string; options?: unknown };
  answer?: (value: string) => void;
  abort: AbortController;
  timer: NodeJS.Timeout;
}
/** Interaction bridge adapted from Pi Pocket's Providers (MIT; see vendor/pi-pocket-LICENSE). */
export class ProviderLogin {
  private flows = new Map<string, Flow>();
  constructor(
    private models: MutableModels,
    private store: Store,
  ) {}
  start(owner: string) {
    if (this.flows.size > 0) throw new Error("Já existe um login em andamento");
    const id = randomUUID();
    const abort = new AbortController();
    const flow: Flow = {
      owner,
      state: "working",
      events: [],
      abort,
      timer: setTimeout(() => this.cancel(owner, id), 600000),
    };
    flow.timer.unref();
    this.flows.set(id, flow);
    let device = this.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key='device-id'",
    )?.value;
    if (!device) {
      device = randomUUID();
      this.store.run("INSERT INTO meta VALUES ('device-id',?)", device);
    }
    void this.models
      .login(
        "openai",
        "oauth",
        {
          signal: abort.signal,
          notify: (event) => {
            flow.events.push(event);
            flow.events = flow.events.slice(-20);
          },
          prompt: (prompt: AuthPrompt) =>
            new Promise<string>((resolve, reject) => {
              const promptId = randomUUID();
              flow.prompt = {
                id: promptId,
                type: prompt.type,
                message: prompt.message,
                ...(prompt.type === "select"
                  ? { options: prompt.options }
                  : {}),
              };
              flow.answer = resolve;
              const cancel = () => {
                delete flow.prompt;
                delete flow.answer;
                reject(new Error("Login cancelado"));
              };
              if (prompt.signal?.aborted || abort.signal.aborted) {
                cancel();
                return;
              }
              prompt.signal?.addEventListener("abort", cancel, { once: true });
              abort.signal.addEventListener("abort", cancel, { once: true });
            }),
        },
        { getDeviceId: () => device! },
      )
      .then(
        () => {
          flow.state = "done";
        },
        () => {
          flow.state = "failed";
        },
      )
      .finally(() => {
        clearTimeout(flow.timer);
        delete flow.prompt;
        delete flow.answer;
        flow.timer = setTimeout(() => this.flows.delete(id), 60000);
        flow.timer.unref();
      });
    return id;
  }
  get(owner: string, id: string) {
    const flow = this.flows.get(id);
    if (!flow || flow.owner !== owner) throw new Error("Login não encontrado");
    return { state: flow.state, events: flow.events, prompt: flow.prompt };
  }
  answer(owner: string, id: string, promptId: string, value: string) {
    const flow = this.flows.get(id);
    if (
      !flow ||
      flow.owner !== owner ||
      flow.prompt?.id !== promptId ||
      !flow.answer
    )
      throw new Error("Pergunta de login não encontrada");
    const resolve = flow.answer;
    delete flow.prompt;
    delete flow.answer;
    resolve(value);
  }
  cancel(owner: string, id: string) {
    const flow = this.flows.get(id);
    if (flow?.owner === owner) {
      flow.abort.abort();
      clearTimeout(flow.timer);
      this.flows.delete(id);
    }
  }
  close() {
    for (const [id, flow] of this.flows) this.cancel(flow.owner, id);
  }
}
