import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Runtime } from "./runtime.js";
import { McpGateway, type McpConfig } from "./mcp.js";
import { Telegram, TelegramHttp } from "./telegram.js";
import { createAppServer } from "./server.js";
process.umask(0o077);
const secret = (name: string) =>
  process.env[`${name}_FILE`]
    ? readFileSync(process.env[`${name}_FILE`]!, "utf8").trim()
    : process.env[name];
const password = secret("WEB_PASSWORD");
if (!password || password.length < 12)
  throw new Error(
    "Configure WEB_PASSWORD_FILE ou WEB_PASSWORD com pelo menos 12 caracteres",
  );
const port = Number(process.env.PORT ?? 3000);
const origin = process.env.APP_ORIGIN ?? `http://127.0.0.1:${port}`;
if (new URL(origin).origin !== origin)
  throw new Error("APP_ORIGIN deve conter apenas scheme, host e porta");
const mode = process.env.APP_MODE ?? "demo";
if (mode !== "demo" && mode !== "live")
  throw new Error("APP_MODE deve ser demo ou live");
const gateway = new McpGateway(
  process.env.MCP_CONFIG_FILE
    ? (JSON.parse(
        readFileSync(process.env.MCP_CONFIG_FILE, "utf8"),
      ) as McpConfig[])
    : [],
);
const runtimeOptions = {
  dir: resolve(process.env.DATA_DIR ?? "data"),
  gateway,
  mode,
  modelId:
    mode === "live" ? (process.env.MODEL_ID ?? "gpt-6.1-sol") : undefined,
} as const;
const token = secret("TELEGRAM_BOT_TOKEN"),
  telegramSecret = secret("TELEGRAM_WEBHOOK_SECRET");
const users = (process.env.TELEGRAM_ALLOWED_USERS ?? "")
    .split(",")
    .filter(Boolean),
  chats = (process.env.TELEGRAM_ALLOWED_CHATS ?? "").split(",").filter(Boolean);
if (token && (!telegramSecret || !users.length || !chats.length))
  throw new Error("Telegram exige segredo webhook e allowlists de user e chat");
const app = await Runtime.open(runtimeOptions);
const telegram = token
  ? new Telegram(app, new TelegramHttp(token), users, chats)
  : undefined;
const web = createAppServer(app, {
  password,
  origin,
  secureCookie: process.env.COOKIE_SECURE === "true",
  telegram,
  telegramSecret,
});
web.server.on("error", () => {
  console.error("Não foi possível iniciar o servidor HTTP");
  void close()
    .catch(() => {})
    .finally(() => {
      process.exitCode = 1;
    });
});
web.server.listen(
  port,
  process.env.HOST ??
    (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"),
  () => console.info(`Pi Agent ${mode} em ${origin}`),
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try {
    await web.close();
  } finally {
    await app.close();
    await gateway.close();
  }
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
