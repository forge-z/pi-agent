import { randomUUID } from "node:crypto";
import type { AuthPrompt, AuthEvent, AuthType } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { Store } from "./store.js";
import { SettingsError } from "./settings.js";
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
    private checkIdle: () => Promise<void> = async () => {},
  ) {}
  private reserve(provider: string, type: AuthType, replace: boolean) {
    const registered = this.models.getProvider(provider);
    const method =
      type === "oauth" ? registered?.auth.oauth : registered?.auth.apiKey;
    if (!method?.login)
      throw new SettingsError(
        "Método de conexão não disponível para este provider",
      );
    if (this.store.credentialMutation)
      throw new SettingsError("Já existe uma conexão em andamento");
    if (
      this.store.providerAdmissions ||
      this.store.get("SELECT 1 FROM requests WHERE status='pending'")
    )
      throw new SettingsError(
        "Aguarde as conversas e tarefas concluírem antes de alterar credenciais",
      );
    if (
      !replace &&
      this.store.get("SELECT 1 FROM credentials WHERE provider=?", provider)
    )
      throw new SettingsError(
        "Confirme explicitamente a substituição da credencial existente",
      );
    this.store.credentialMutation = true;
  }
  async saveApiKey(provider: string, value: unknown, replace = false) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > 16000 ||
      /[\s\u0000-\u001f\u007f-\u009f]/.test(value) ||
      (provider === "anthropic" && value.includes("sk-ant-oat"))
    )
      throw new SettingsError(
        "Chave de API inválida; informe uma chave de API padrão",
      );
    this.reserve(provider, "api_key", replace);
    try {
      await this.checkIdle();
      await this.models.login(provider, "api_key", {
        prompt: async (prompt) => {
          if (prompt.type !== "secret")
            throw new SettingsError("Método de conexão não compatível");
          return value;
        },
        notify: () => {},
      });
      return { provider, credentialType: "api_key" };
    } catch {
      throw new SettingsError("Não foi possível salvar a conexão do provider");
    } finally {
      this.store.credentialMutation = false;
    }
  }
  start(
    owner: string,
    provider = "openai",
    type: AuthType = "oauth",
    replace = false,
  ) {
    if (type !== "oauth") throw new SettingsError("Método de conexão inválido");
    let device = this.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key='device-id'",
    )?.value;
    if (!device) {
      device = randomUUID();
      this.store.run("INSERT INTO meta VALUES ('device-id',?)", device);
    }
    this.reserve(provider, type, replace);
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
    void this.checkIdle()
      .then(() =>
        this.models.login(
          provider,
          type,
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
                prompt.signal?.addEventListener("abort", cancel, {
                  once: true,
                });
                abort.signal.addEventListener("abort", cancel, { once: true });
              }),
          },
          { getDeviceId: () => device! },
        ),
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
        this.store.credentialMutation = false;
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
    if (
      flow.prompt.type === "secret" &&
      (!value.trim() ||
        value.length > 16000 ||
        /[\s\u0000-\u001f\u007f-\u009f]/.test(value))
    )
      throw new SettingsError("Chave de API inválida");
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
