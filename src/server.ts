import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConversationError, type Runtime } from "./runtime.js";
import { hash } from "./store.js";
import { ProviderLogin } from "./provider-login.js";
import type { Telegram, TelegramUpdate } from "./telegram.js";
import { TaskError } from "./tasks.js";
import { SettingsError } from "./settings.js";
import { webCommandCatalog, CommandError } from "./commands.js";
import { PolicyError, McpError } from "./mcp.js";
import { CuaHandoffError } from "./cua-handoffs.js";
import { chatSnapshot } from "./chat-snapshot.js";
import {
  TelegramConnection,
  TelegramSetupError,
} from "./telegram-connection.js";
export interface ServerOptions {
  password: string;
  origin: string;
  secureCookie: boolean;
  telegram?: Telegram;
  telegramSecret?: string;
  telegramConnection?: TelegramConnection;
  publicDir?: string;
}
const equal = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function body(request: IncomingMessage) {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new HttpError(415, "Use application/json");
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65536) throw new HttpError(413, "Requisição muito grande");
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
}
const text = (value: unknown) => {
  if (typeof value !== "string")
    throw new HttpError(400, "Campo de texto inválido");
  return value;
};
const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
};
export function createAppServer(app: Runtime, options: ServerOptions) {
  const telegramConnection =
    options.telegramConnection ?? new TelegramConnection(app);
  void telegramConnection
    .restore()
    .catch(() =>
      console.error("Não foi possível restaurar a conexão Telegram"),
    );
  const login = new ProviderLogin(app.models, app.store, async () => {
    const active = await app.harness.inspect(context);
    if (
      active.tasks.length ||
      app.store.providerAdmissions ||
      app.store.get("SELECT 1 FROM requests WHERE status='pending'")
    )
      throw new SettingsError(
        "Aguarde as conversas e tarefas concluírem antes de alterar credenciais",
      );
  });
  const tasks = app.tasks;
  tasks.start();
  const streams = new Set<ServerResponse>();
  const conversationListVersion = () =>
    hash(
      JSON.stringify([app.listConversations(), app.listConversations(true)]),
    );
  const attempts = new Map<string, { count: number; until: number }>();
  const timer = options.telegram
    ? setInterval(
        () =>
          void options
            .telegram!.flush()
            .catch(() => console.error("Falha ao processar fila Telegram")),
        1000,
      )
    : undefined;
  timer?.unref();
  const server = createServer((request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    response.setHeader("cache-control", "no-store");
    void (async () => {
      const url = new URL(request.url ?? "/", options.origin);
      const path = url.pathname;
      const method = request.method ?? "GET";
      if (path === "/healthz" && method === "GET")
        return json(response, 200, { ok: true });
      if (path === "/api/telegram/webhook" && method === "POST") {
        if (
          !options.telegram ||
          !options.telegramSecret ||
          !equal(
            String(request.headers["x-telegram-bot-api-secret-token"] ?? ""),
            options.telegramSecret,
          )
        )
          throw new HttpError(403, "Webhook não autorizado");
        await options.telegram.receive(
          (await body(request)) as unknown as TelegramUpdate,
        );
        return json(response, 200, { ok: true });
      }
      const token = /pi_session=([a-f0-9]{64})/.exec(
        request.headers.cookie ?? "",
      )?.[1];
      const owner = token ? hash(token) : "";
      const authenticated =
        owner &&
        app.store.get(
          "SELECT token FROM sessions WHERE token=? AND expires>?",
          owner,
          Date.now(),
        );
      if (method !== "GET" && method !== "HEAD") {
        if (request.headers.origin !== options.origin)
          throw new HttpError(403, "Origem inválida");
      }
      if (path === "/api/login" && method === "POST") {
        const ip = request.socket.remoteAddress ?? "unknown";
        const prior = attempts.get(ip);
        const attempt =
          prior && prior.until > Date.now()
            ? prior
            : { count: 0, until: Date.now() + 60000 };
        if (attempt.count >= 10)
          throw new HttpError(
            429,
            "Aguarde um minuto antes de tentar novamente",
          );
        attempt.count++;
        attempts.set(ip, attempt);
        if (attempts.size > 1000)
          for (const [key, value] of attempts)
            if (value.until < Date.now()) attempts.delete(key);
        const input = await body(request);
        if (!equal(text(input.password), options.password))
          throw new HttpError(401, "Senha inválida");
        const session = randomBytes(32).toString("hex");
        app.store.run("DELETE FROM sessions WHERE expires<=?", Date.now());
        app.store.run(
          "INSERT INTO sessions VALUES (?,?)",
          hash(session),
          Date.now() + 86400000,
        );
        response.setHeader(
          "set-cookie",
          `pi_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${options.secureCookie ? "; Secure" : ""}`,
        );
        return json(response, 200, { ok: true });
      }
      if (path.startsWith("/api/")) {
        if (!authenticated) throw new HttpError(401, "Faça login na interface");
        if (path === "/api/conversations/events" && method === "GET") {
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          streams.add(response);
          response.write("retry: 1500\n\n");
          let closed = false;
          let previousVersion: string | undefined;
          const send = () => {
            if (closed) return;
            try {
              if (
                !app.store.get(
                  "SELECT token FROM sessions WHERE token=? AND expires>?",
                  owner,
                  Date.now(),
                )
              ) {
                response.end();
                return;
              }
              if (
                response.writableNeedDrain ||
                response.writableLength > 262144
              )
                return;
              // Only list metadata is polled. A chat created on another transport
              // must not depend on a change to the selected transcript watcher.
              const version = conversationListVersion();
              if (version !== previousVersion) {
                response.write(
                  `event: conversations\ndata: ${JSON.stringify({ version })}\n\n`,
                );
                previousVersion = version;
              }
            } catch {
              response.end();
            }
          };
          const poll = setInterval(send, 1000);
          const ping = setInterval(() => {
            if (response.writableLength > 1048576) response.end();
            else if (!response.writableNeedDrain) response.write(": ping\n\n");
          }, 15000);
          response.on("close", () => {
            closed = true;
            clearInterval(poll);
            clearInterval(ping);
            streams.delete(response);
          });
          send();
          return;
        }
        if (path === "/api/telegram" && method === "GET")
          return json(response, 200, telegramConnection.snapshot());
        if (path === "/api/telegram/connect" && method === "POST")
          return json(
            response,
            200,
            await telegramConnection.connect(await body(request)),
          );
        if (path === "/api/telegram/disconnect" && method === "POST")
          return json(
            response,
            200,
            await telegramConnection.disconnect(await body(request)),
          );
        if (path === "/api/logout" && method === "POST") {
          app.store.run("DELETE FROM sessions WHERE token=?", owner);
          response.setHeader(
            "set-cookie",
            "pi_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
          );
          return json(response, 200, { ok: true });
        }
        if (path === "/api/status" && method === "GET")
          return json(response, 200, {
            mode: app.options.mode ?? "demo",
            provider: app.settings.provider,
            model: app.settings.defaults().modelId,
            effort: app.settings.defaults().effort,
            credentials:
              app.settings
                .providers()
                .find((provider) => provider.id === app.settings.provider)
                ?.credentialType ?? null,
            providers: app.settings.providers(),
          });
        if (path === "/api/settings") {
          if (method === "GET")
            return json(response, 200, app.settings.snapshot());
          if (method === "PUT")
            return json(
              response,
              200,
              app.settings.saveDefaults(await body(request)),
            );
        }
        if (path === "/api/mcp") {
          if (method === "GET") return json(response, 200, app.settings.mcp());
          if (method === "PUT")
            return json(
              response,
              200,
              await app.settings.saveMcp((await body(request)).servers),
            );
        }
        const mcp = /^\/api\/mcp\/([\w-]+)\/tools$/.exec(path);
        if (mcp && method === "GET")
          return json(response, 200, await app.settings.discover(mcp[1]));
        if (path === "/api/tasks") {
          if (method === "GET") return json(response, 200, tasks.list());
          if (method === "POST")
            return json(response, 201, await tasks.create(await body(request)));
        }
        if (path === "/api/tasks/telegram-availability" && method === "GET") {
          const conversationId = url.searchParams.get("conversationId");
          if (!conversationId)
            throw new HttpError(400, "Informe a conversa da tarefa");
          return json(response, 200, {
            available: tasks.telegramAvailability(conversationId),
          });
        }
        const taskRoute = /^\/api\/tasks\/([a-f0-9-]+)(?:\/(run|runs))?$/.exec(
          path,
        );
        if (taskRoute) {
          const [, id, resource] = taskRoute;
          if (!tasks.get(id)) throw new HttpError(404, "Tarefa não encontrada");
          if (resource === "runs" && method === "GET")
            return json(response, 200, tasks.runs(id));
          if (resource === "run" && method === "POST") {
            const input = await body(request);
            return json(
              response,
              202,
              await tasks.runNow(id, text(input.requestId)),
            );
          }
          if (!resource && method === "PUT") {
            const input = await body(request);
            return json(response, 200, tasks.update(id, input));
          }
          if (!resource && method === "DELETE") {
            tasks.remove(id);
            return json(response, 200, { ok: true });
          }
        }
        if (path === "/api/conversations") {
          if (method === "GET")
            return json(
              response,
              200,
              app.listConversations(url.searchParams.get("deleted") === "1"),
            );
          if (method === "POST") {
            const input = await body(request);
            return json(response, 201, {
              id: await app.create(
                input.title === undefined ? "Nova conversa" : text(input.title),
              ),
            });
          }
        }
        if (path === "/api/provider/connections" && method === "GET")
          return json(response, 200, app.providerConnections.list());
        if (
          (path === "/api/provider/connections" ||
            path === "/api/provider/connections/models") &&
          method === "POST"
        ) {
          if (app.options.mode !== "live")
            throw new HttpError(
              409,
              "Ative APP_MODE=live para conectar o provider",
            );
          const input = await body(request);
          return path.endsWith("/models")
            ? json(response, 200, await app.providerConnections.discover(input))
            : json(response, 201, {
                connection: await app.providerConnections.create(input),
              });
        }
        if (path === "/api/provider/login" && method === "POST") {
          if (app.options.mode !== "live")
            throw new HttpError(
              409,
              "Ative APP_MODE=live para conectar o provider",
            );
          const input = request.headers["content-type"]?.startsWith(
            "application/json",
          )
            ? await body(request)
            : {};
          const provider =
            input.provider === undefined ? "openai" : text(input.provider);
          if (input.type !== undefined && input.type !== "oauth")
            throw new SettingsError(
              "Use o formulário de chave de API para este método",
            );
          return json(response, 202, {
            id: login.start(owner, provider, "oauth", input.replace === true),
          });
        }
        const apiKeyRoute = /^\/api\/provider\/([\w-]+)\/api-key$/.exec(path);
        if (apiKeyRoute && method === "PUT") {
          if (app.options.mode !== "live")
            throw new HttpError(
              409,
              "Ative APP_MODE=live para conectar o provider",
            );
          const input = await body(request);
          return json(
            response,
            200,
            await login.saveApiKey(
              apiKeyRoute[1],
              input.apiKey,
              input.replace === true,
            ),
          );
        }
        const flow = /^\/api\/provider\/login\/([\w-]+)$/.exec(path);
        if (flow) {
          if (method === "GET")
            return json(response, 200, login.get(owner, flow[1]));
          if (method === "POST") {
            const input = await body(request);
            login.answer(
              owner,
              flow[1],
              text(input.promptId),
              text(input.value),
            );
            return json(response, 200, { ok: true });
          }
          if (method === "DELETE") {
            login.cancel(owner, flow[1]);
            return json(response, 200, { ok: true });
          }
        }
        const handoffRoute =
          /^\/api\/conversations\/([0-9]+)\/cua-handoffs\/([a-f0-9-]+)\/(create|end)$/.exec(
            path,
          );
        if (handoffRoute && method === "POST") {
          const [, id, handoffId, operation] = handoffRoute;
          await app.conversation(id);
          if (!app.cuaHandoffs)
            throw new HttpError(400, "Viewer CUA indisponível neste ambiente.");
          const input = await body(request);
          return json(
            response,
            200,
            operation === "create"
              ? await app.cuaHandoffs.create(id, handoffId, input)
              : app.cuaHandoffs.end(id, handoffId, input),
          );
        }
        const interactionRoute =
          /^\/api\/conversations\/([0-9]+)\/mcp-interactions\/([a-f0-9-]+)$/.exec(
            path,
          );
        if (interactionRoute && method === "POST") {
          const [, id, interactionId] = interactionRoute;
          await app.conversation(id);
          const input = await body(request);
          const decision = text(input.action);
          if (!["accept", "decline", "cancel"].includes(decision))
            throw new HttpError(400, "Decisão MCP inválida");
          if (
            input.content !== undefined &&
            (!input.content ||
              typeof input.content !== "object" ||
              Array.isArray(input.content))
          )
            throw new HttpError(400, "Resposta MCP inválida");
          const interaction = await app.mcpCalls.decide(
            id,
            interactionId,
            decision as "accept" | "decline" | "cancel",
            input.content as Record<string, unknown> | undefined,
          );
          if (interaction.kind === "resume") {
            const call = app.mcpCalls
              .list(id)
              .find((c) => c.id === interaction.callId);
            if (call) await app.recordMcpOutcome(call);
          }
          return json(response, 200, interaction);
        }
        const reconcileMcp =
          /^\/api\/conversations\/([0-9]+)\/mcp-calls\/([a-f0-9]{24})\/reconcile$/.exec(
            path,
          );
        if (reconcileMcp && method === "POST") {
          await app.conversation(reconcileMcp[1]);
          const call = app.mcpCalls.reconcile(
            reconcileMcp[1],
            reconcileMcp[2],
            text((await body(request)).note),
          );
          if (call) await app.recordMcpOutcome(call);
          return json(response, 200, call);
        }
        if (path === "/api/commands" && method === "GET")
          return json(response, 200, { commands: webCommandCatalog });
        if (path === "/api/commands/tasks" && method === "GET")
          return json(
            response,
            200,
            await app.commands.active({ source: "web" }),
          );
        const commandStatus =
          /^\/api\/conversations\/([0-9]+)\/commands\/([\w:.-]{1,160})$/.exec(
            path,
          );
        if (commandStatus && method === "GET") {
          const receipt = await app.commands.receipt(
            commandStatus[1],
            commandStatus[2],
            { source: "web" },
          );
          if (!receipt)
            throw new HttpError(404, "Recibo de comando não encontrado");
          return json(response, 200, receipt);
        }
        const purgeRoute = /^\/api\/conversations\/([0-9]+)\/purge$/.exec(path);
        if (purgeRoute && method === "POST") {
          const input = await body(request);
          return json(
            response,
            200,
            await app.purgeConversation(
              purgeRoute[1],
              input.confirm,
              input.expectedDeletedAt,
            ),
          );
        }
        const restoreRoute = /^\/api\/conversations\/([0-9]+)\/restore$/.exec(
          path,
        );
        if (restoreRoute && method === "POST")
          return json(response, 200, app.restoreConversation(restoreRoute[1]));
        const messageRoute =
          /^\/api\/conversations\/([0-9]+)\/history\/([1-9][0-9]{0,15})\/([0-9]{1,6})$/.exec(
            path,
          );
        if (messageRoute && method === "GET") {
          const [, id, entryId, index] = messageRoute;
          const number = Number(entryId);
          if (!Number.isSafeInteger(number))
            throw new HttpError(400, "Mensagem inválida");
          return json(
            response,
            200,
            await app.historyMessage(id, number, Number(index)),
          );
        }
        const route =
          /^\/api\/conversations\/([0-9]+)(?:\/(messages|events|link|actions|settings)(?:\/([a-f0-9]{24}))?)?$/.exec(
            path,
          );
        if (route) {
          const [, id, resource, actionId] = route;
          const compact = url.searchParams.get("view") === "chat";
          const rawPage = url.searchParams.get("page") ?? "0";
          if (compact && !/^\d{1,9}$/.test(rawPage))
            throw new HttpError(400, "Página inválida");
          const page = Number(rawPage);
          const snapshot = async () => {
            const value = await app.snapshot(id, compact);
            return compact ? chatSnapshot(value, page) : value;
          };
          if (!resource && method === "PUT")
            return json(
              response,
              200,
              app.renameConversation(id, (await body(request)).title),
            );
          if (!resource && method === "DELETE") {
            if ((await body(request)).confirm !== true)
              throw new HttpError(
                400,
                "Confirme explicitamente a exclusão da conversa.",
              );
            return json(response, 200, await app.deleteConversation(id));
          }
          await app.conversation(id);
          if (!resource && method === "GET")
            return json(response, 200, await snapshot());
          if (resource === "settings" && method === "PUT")
            return json(
              response,
              200,
              await app.settings.saveConversation(id, await body(request)),
            );
          if (resource === "messages" && method === "POST") {
            const input = await body(request);
            return json(
              response,
              202,
              await app.admit(id, text(input.requestId), text(input.text), {
                source: "web",
              }),
            );
          }
          if (resource === "link" && method === "POST") {
            app.commands.authorize(id, { source: "web" });
            const code = app.store.link(id);
            return json(response, 201, {
              code,
              command: `/link ${code}`,
              expiresIn: 600,
              ...(options.telegram?.botUsername
                ? {
                    url: `https://t.me/${options.telegram.botUsername}?start=${code}`,
                  }
                : {}),
            });
          }
          if (resource === "actions" && method === "POST" && actionId) {
            const input = await body(request);
            const decision = text(input.decision);
            if (!["approve", "deny", "reconcile"].includes(decision))
              throw new HttpError(400, "Decisão inválida");
            const action =
              decision === "reconcile"
                ? app.actions.reconcile(id, actionId, text(input.note))
                : await app.actions.decide(
                    id,
                    actionId,
                    decision as "approve" | "deny",
                  );
            await app.recordAction(action);
            return json(response, 200, action);
          }
          if (resource === "actions" && method === "GET" && actionId) {
            const action = app.store.get(
              "SELECT * FROM actions WHERE id=? AND conversationId=?",
              actionId,
              id,
            );
            if (!action) throw new HttpError(404, "Ação não encontrada");
            return json(response, 200, action);
          }
          if (resource === "events" && method === "GET") {
            response.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache, no-transform",
              connection: "keep-alive",
              "x-accel-buffering": "no",
            });
            streams.add(response);
            response.write("retry: 1500\n\n");
            let dirty = true;
            let sending = false;
            let closed = false;
            let lastSnapshotHash: string | undefined;
            let lastHistoryVersion: string | undefined;
            let lastListVersion: string | undefined;
            let detach: (() => void) | undefined;
            let poll: ReturnType<typeof setInterval> | undefined;
            let ping: ReturnType<typeof setInterval> | undefined;
            const cleanup = () => {
              if (closed) return;
              closed = true;
              if (poll) clearInterval(poll);
              poll = undefined;
              if (ping) clearInterval(ping);
              ping = undefined;
              const attached = detach;
              detach = undefined;
              streams.delete(response);
              attached?.();
            };
            // A client can leave while Durable is still attaching the watcher.
            // Install cleanup before that await and release a late subscription.
            response.once("close", cleanup);
            if (response.destroyed) {
              cleanup();
              return;
            }
            const attached = await app.watch(id, () => {
              dirty = true;
            });
            if (closed || response.destroyed) {
              cleanup();
              attached();
              return;
            }
            detach = attached;
            const send = async () => {
              if (
                !closed &&
                !response.writableNeedDrain &&
                response.writableLength <= 262144
              ) {
                try {
                  if (
                    !app.store.get(
                      "SELECT token FROM sessions WHERE token=? AND expires>?",
                      owner,
                      Date.now(),
                    )
                  ) {
                    response.end();
                    return;
                  }
                  const version = conversationListVersion();
                  if (version !== lastListVersion) {
                    response.write(
                      `event: conversations\ndata: ${JSON.stringify({ version })}\n\n`,
                    );
                    lastListVersion = version;
                  }
                } catch {
                  response.end();
                  return;
                }
              }
              if (
                !dirty ||
                sending ||
                closed ||
                response.writableNeedDrain ||
                response.writableLength > 262144
              )
                return;
              sending = true;
              dirty = false;
              try {
                if (
                  !app.store.get(
                    "SELECT token FROM sessions WHERE token=? AND expires>?",
                    owner,
                    Date.now(),
                  )
                ) {
                  response.end();
                  return;
                }
                const current = await snapshot();
                const history =
                  "history" in current ? current.history : undefined;
                const state = history
                  ? {
                      ...current,
                      history: undefined,
                      historyVersion: history.version,
                    }
                  : current;
                const encodedState = JSON.stringify(state);
                const snapshotHash = hash(encodedState);
                // Keep polling for SQLite-only transitions (approvals, MCP,
                // deliveries). Deduplicate before the browser parses SSE/JSON,
                // and keep only a digest rather than another history in memory.
                if (!closed && snapshotHash !== lastSnapshotHash) {
                  // Existing clients still receive full snapshots. Compact
                  // streams send a page only when its immutable message keys
                  // change; live/control transitions carry no history bodies.
                  const includeHistory =
                    !history || history.version !== lastHistoryVersion;
                  const encoded = includeHistory
                    ? JSON.stringify(current)
                    : encodedState;
                  response.write(
                    `event: ${includeHistory ? "snapshot" : "state"}\ndata: ${encoded}\n\n`,
                  );
                  // A false write result is already queued by Node. Do not
                  // retransmit it; resume with the latest state after drain.
                  lastSnapshotHash = snapshotHash;
                  lastHistoryVersion = history?.version;
                }
              } catch {
                response.end();
              } finally {
                sending = false;
              }
            };
            poll = setInterval(() => {
              dirty = true;
              void send();
            }, 500);
            ping = setInterval(() => {
              if (response.writableLength > 1048576) response.end();
              else if (!response.writableNeedDrain)
                response.write(": ping\n\n");
            }, 15000);
            await send();
            return;
          }
        }
        throw new HttpError(404, "Endpoint não encontrado");
      }
      if (method !== "GET") throw new HttpError(405, "Método não permitido");
      const assets: Record<string, [string, string]> = {
        "/": ["index.html", "text/html"],
        "/app.js": ["app.js", "text/javascript"],
        "/commands.js": ["commands.js", "text/javascript"],
        "/conversations.js": ["conversations.js", "text/javascript"],
        "/conversation-events.js": [
          "conversation-events.js",
          "text/javascript",
        ],
        "/markdown.js": ["markdown.js", "text/javascript"],
        "/marked.js": [
          fileURLToPath(import.meta.resolve("marked")),
          "text/javascript",
        ],
        "/settings.js": ["settings.js", "text/javascript"],
        "/provider-connections.js": [
          "provider-connections.js",
          "text/javascript",
        ],
        "/telegram.js": ["telegram.js", "text/javascript"],
        "/tools.js": ["tools.js", "text/javascript"],
        "/cua-handoffs.js": ["cua-handoffs.js", "text/javascript"],
        "/history.js": ["history.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
        "/manifest.webmanifest": [
          "manifest.webmanifest",
          "application/manifest+json",
        ],
        "/sw.js": ["sw.js", "text/javascript"],
        "/icon.svg": ["icon.svg", "image/svg+xml"],
        "/theme.js": ["theme.js", "text/javascript"],
        "/i18n.js": ["i18n.js", "text/javascript"],
        "/i18n-catalog.js": ["i18n-catalog.js", "text/javascript"],
        "/icons.svg": ["icons.svg", "image/svg+xml"],
        "/pi-logo.svg": ["pi-logo.svg", "image/svg+xml"],
        "/fonts/dm-sans-400-normal.ttf": [
          "fonts/dm-sans-400-normal.ttf",
          "font/ttf",
        ],
        "/fonts/dm-sans-500-normal.ttf": [
          "fonts/dm-sans-500-normal.ttf",
          "font/ttf",
        ],
        "/fonts/dm-sans-600-normal.ttf": [
          "fonts/dm-sans-600-normal.ttf",
          "font/ttf",
        ],
        "/fonts/instrument-serif-400-italic.ttf": [
          "fonts/instrument-serif-400-italic.ttf",
          "font/ttf",
        ],
        "/fonts/instrument-serif-400-normal.ttf": [
          "fonts/instrument-serif-400-normal.ttf",
          "font/ttf",
        ],
      };
      const asset = assets[path];
      if (!asset) throw new HttpError(404, "Página não encontrada");
      const bytes = await readFile(
        path === "/marked.js"
          ? asset[0]
          : resolve(options.publicDir ?? "public", asset[0]),
      );
      response.writeHead(200, { "content-type": `${asset[1]}; charset=utf-8` });
      response.end(bytes);
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status =
        error instanceof HttpError || error instanceof ConversationError
          ? error.status
          : 400;
      json(response, status, {
        error:
          error instanceof HttpError ||
          error instanceof SettingsError ||
          error instanceof CommandError ||
          error instanceof TaskError ||
          error instanceof ConversationError ||
          error instanceof PolicyError ||
          error instanceof McpError ||
          error instanceof CuaHandoffError ||
          error instanceof TelegramSetupError
            ? error.message
            : "Não foi possível processar a operação",
      });
    });
  });
  const close = async () => {
    await tasks.close();
    if (timer) clearInterval(timer);
    login.close();
    await options.telegram?.drain();
    await telegramConnection.close();
    for (const stream of streams) stream.end();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  };
  return { server, close };
}
