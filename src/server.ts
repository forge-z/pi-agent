import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Runtime } from "./runtime.js";
import { hash, SqlCredentials } from "./store.js";
import { ProviderLogin } from "./provider-login.js";
import type { Telegram, TelegramUpdate } from "./telegram.js";
import { TaskError } from "./tasks.js";
import { SettingsError } from "./settings.js";
import { commandCatalog, CommandError } from "./commands.js";
import { PolicyError, McpError } from "./mcp.js";
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
  const login = new ProviderLogin(app.models, app.store);
  const tasks = app.tasks;
  tasks.start();
  const streams = new Set<ServerResponse>();
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
            provider: app.options.mode === "live" ? "openai" : "faux",
            model: app.settings.defaults().modelId,
            effort: app.settings.defaults().effort,
            credentials:
              (await new SqlCredentials(app.store).read("openai"))?.type ??
              null,
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
            if (typeof input.enabled !== "boolean")
              throw new HttpError(400, "Informe se a tarefa está ativa");
            return json(response, 200, tasks.setEnabled(id, input.enabled));
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
              app.store.all("SELECT * FROM conversations ORDER BY rowid DESC"),
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
        if (path === "/api/provider/login" && method === "POST") {
          if (app.options.mode !== "live")
            throw new HttpError(
              409,
              "Ative APP_MODE=live para conectar o provider",
            );
          return json(response, 202, { id: login.start(owner) });
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
          return json(
            response,
            200,
            app.mcpCalls.reconcile(
              reconcileMcp[1],
              reconcileMcp[2],
              text((await body(request)).note),
            ),
          );
        }
        if (path === "/api/commands" && method === "GET")
          return json(response, 200, { commands: commandCatalog });
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
        const route =
          /^\/api\/conversations\/([0-9]+)(?:\/(messages|events|link|actions|settings)(?:\/([a-f0-9]{24}))?)?$/.exec(
            path,
          );
        if (route) {
          const [, id, resource, actionId] = route;
          await app.conversation(id);
          if (!resource && method === "GET")
            return json(response, 200, await app.snapshot(id));
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
            const detach = await app.watch(id, () => {
              dirty = true;
            });
            const send = async () => {
              if (
                !dirty ||
                sending ||
                closed ||
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
                const snapshot = await app.snapshot(id);
                if (!closed)
                  response.write(
                    `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
                  );
              } catch {
                response.end();
              } finally {
                sending = false;
              }
            };
            await send();
            const poll = setInterval(() => {
              dirty = true;
              void send();
            }, 500);
            const ping = setInterval(() => {
              if (response.writableLength > 1048576) response.end();
              else response.write(": ping\n\n");
            }, 15000);
            response.on("close", () => {
              closed = true;
              clearInterval(poll);
              clearInterval(ping);
              detach();
              streams.delete(response);
            });
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
        "/markdown.js": ["markdown.js", "text/javascript"],
        "/marked.js": [
          fileURLToPath(import.meta.resolve("marked")),
          "text/javascript",
        ],
        "/settings.js": ["settings.js", "text/javascript"],
        "/telegram.js": ["telegram.js", "text/javascript"],
        "/tools.js": ["tools.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
        "/manifest.webmanifest": [
          "manifest.webmanifest",
          "application/manifest+json",
        ],
        "/sw.js": ["sw.js", "text/javascript"],
        "/icon.svg": ["icon.svg", "image/svg+xml"],
        "/theme.js": ["theme.js", "text/javascript"],
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
      const status = error instanceof HttpError ? error.status : 400;
      json(response, status, {
        error:
          error instanceof HttpError ||
          error instanceof SettingsError ||
          error instanceof CommandError ||
          error instanceof TaskError ||
          error instanceof PolicyError ||
          error instanceof McpError ||
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
