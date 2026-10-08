import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import type {
  Credential,
  CredentialStore,
  AuthOperationOptions,
} from "@earendil-works/pi-ai";

export interface Action {
  id: string;
  conversationId: string;
  server: string;
  tool: string;
  args: string;
  state: string;
  result: string | null;
  evidence: string;
}
export interface RequestRow {
  conversationId: string;
  requestId: string;
  text: string;
  submissionId: number | null;
  source: string;
  chat: string | null;
  status: string;
}
export interface Delivery {
  id: string;
  chat: string;
  text: string;
  state: string;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(`${dir}/app.sqlite`);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(conversationId TEXT, requestId TEXT, text TEXT, submissionId INTEGER, source TEXT, chat TEXT, status TEXT DEFAULT 'pending', PRIMARY KEY(conversationId,requestId));
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, conversationId TEXT, server TEXT, tool TEXT, args TEXT, state TEXT DEFAULT 'pending', result TEXT, evidence TEXT DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS reads(conversationId TEXT PRIMARY KEY, result TEXT);
      CREATE TABLE IF NOT EXISTS links(code TEXT PRIMARY KEY, conversationId TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS telegram(chat TEXT PRIMARY KEY, conversationId TEXT, user TEXT);
      CREATE TABLE IF NOT EXISTS telegram_grants(chat TEXT, user TEXT, conversationId TEXT, PRIMARY KEY(chat,user,conversationId));
      CREATE TABLE IF NOT EXISTS telegram_updates(id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL);
      INSERT OR IGNORE INTO telegram_grants SELECT chat,user,conversationId FROM telegram;
      CREATE TABLE IF NOT EXISTS command_receipts(key TEXT PRIMARY KEY, conversationId TEXT NOT NULL, requestId TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS command_request ON command_receipts(conversationId,requestId);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, chat TEXT, text TEXT, state TEXT DEFAULT 'pending', result TEXT);
      CREATE TABLE IF NOT EXISTS credentials(provider TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, expires INTEGER);`);
    if (
      !this.all<{ name: string }>("PRAGMA table_info(actions)").some(
        (c) => c.name === "evidence",
      )
    )
      this.db.exec("ALTER TABLE actions ADD COLUMN evidence TEXT DEFAULT '{}'");
    this.db.exec(
      "UPDATE actions SET state='uncertain' WHERE state='running'; UPDATE deliveries SET state='uncertain' WHERE state='sending'; UPDATE command_receipts SET state='uncertain' WHERE state='pending';",
    );
  }
  all<T>(sql: string, ...args: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...args) as unknown as T[];
  }
  get<T>(sql: string, ...args: (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...args) as unknown as T | undefined;
  }
  run(sql: string, ...args: (string | number | null)[]) {
    return this.db.prepare(sql).run(...args);
  }
  actions(conversationId: string) {
    return this.all<Action>(
      "SELECT * FROM actions WHERE conversationId=? ORDER BY rowid",
      conversationId,
    );
  }
  link(conversationId: string) {
    const code = randomBytes(16).toString("hex");
    this.run(
      "INSERT INTO links VALUES (?,?,?)",
      hash(code),
      conversationId,
      Date.now() + 600000,
    );
    return code;
  }
  consumeLink(code: string, chat: string, user: string, updateKey?: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const link = this.get<{ conversationId: string }>(
        "SELECT conversationId FROM links WHERE code=? AND expires>?",
        hash(code),
        Date.now(),
      );
      if (!link) throw new Error("Código de vínculo inválido ou expirado");
      this.run(
        "INSERT INTO telegram VALUES (?,?,?) ON CONFLICT(chat) DO UPDATE SET conversationId=excluded.conversationId,user=excluded.user",
        chat,
        link.conversationId,
        user,
      );
      this.run("DELETE FROM links WHERE code=?", hash(code));
      this.run(
        "INSERT OR IGNORE INTO telegram_grants VALUES (?,?,?)",
        chat,
        user,
        link.conversationId,
      );
      if (updateKey)
        this.run(
          "INSERT OR IGNORE INTO meta VALUES (?,?)",
          updateKey,
          JSON.stringify({ linked: link.conversationId }),
        );
      this.db.exec("COMMIT");
      return link.conversationId;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Pi owns OAuth/login/refresh. This app persists only credentials it issues via that API. */
export class SqlCredentials implements CredentialStore {
  private tails = new Map<string, Promise<unknown>>();
  constructor(private store: Store) {}
  async read(providerId: string, options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    const row = this.store.get<{ value: string }>(
      "SELECT value FROM credentials WHERE provider=?",
      providerId,
    );
    return row ? (JSON.parse(row.value) as Credential) : undefined;
  }
  async list(options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    return this.store
      .all<{ provider: string; value: string }>("SELECT * FROM credentials")
      .map((row) => ({
        providerId: row.provider,
        type: (JSON.parse(row.value) as Credential).type,
      }));
  }
  async modify(
    providerId: string,
    fn: (value: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ) {
    const operation = (this.tails.get(providerId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        options?.signal?.throwIfAborted();
        const current = await this.read(providerId);
        const next = await fn(current);
        options?.signal?.throwIfAborted();
        if (next)
          this.store.run(
            "INSERT INTO credentials VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value",
            providerId,
            JSON.stringify(next),
          );
        return next ?? current;
      });
    this.tails.set(providerId, operation);
    return operation;
  }
  async delete(providerId: string, options?: AuthOperationOptions) {
    const operation = (this.tails.get(providerId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        options?.signal?.throwIfAborted();
        this.store.run("DELETE FROM credentials WHERE provider=?", providerId);
      });
    this.tails.set(providerId, operation);
    return operation;
  }
}
