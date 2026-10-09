import { createHmac, timingSafeEqual } from "node:crypto";

// Restricted gRPC-Web client for the existing cua-spacesd SystemService.
// Wire/grant contract: trycua/cua 5a364bbe, system.proto and server/src/auth.rs.
export const CUA_VIEWER_TTL_SECONDS = 1800;
export class CuaViewerError extends Error {
  constructor(
    message: string,
    readonly dispatched = false,
  ) {
    super(message);
  }
}
export interface CuaViewerTicket {
  url: string;
  expiresAt: number;
  principalId: string;
}
const invalid = (dispatched = false) =>
  new CuaViewerError(
    "Resposta CUA inválida; o acesso permanece pausado. Nenhum link foi disponibilizado.",
    dispatched,
  );
const bytes = (field: number, value: Uint8Array | string) => {
  const body =
    typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  return Buffer.concat([
    integer(0, field * 8 + 2),
    integer(0, body.length),
    body,
  ]);
};
function integer(field: number, value: number) {
  const output: number[] = [];
  if (field) output.push(...integer(0, field * 8));
  let rest = BigInt(value);
  do {
    output.push(Number(rest & 127n) | (rest > 127n ? 128 : 0));
    rest >>= 7n;
  } while (rest);
  return Buffer.from(output);
}
function fields(value: Buffer) {
  const result = new Map<number, Buffer | number>();
  let position = 0;
  const varint = () => {
    let number = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (position >= value.length) throw invalid();
      const byte = value[position++];
      number |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) {
        if (number > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
        return Number(number);
      }
    }
    throw invalid();
  };
  while (position < value.length) {
    const key = varint(),
      field = Math.floor(key / 8),
      wire = key % 8;
    if (!field || result.has(field)) throw invalid();
    if (wire === 0) result.set(field, varint());
    else if (wire === 2) {
      const size = varint();
      if (size > value.length - position) throw invalid();
      result.set(field, value.subarray(position, position + size));
      position += size;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (size > value.length - position) throw invalid();
      result.set(field, value.subarray(position, position + size));
      position += size;
    } else throw invalid();
  }
  return result;
}
const buffer = (value: Buffer | number | undefined) => {
  if (!Buffer.isBuffer(value)) throw invalid();
  return value;
};
const number = (value: Buffer | number | undefined, fallback = 0) => {
  if (value === undefined) return fallback;
  if (typeof value !== "number") throw invalid();
  return value;
};
const utf8 = new TextDecoder("utf-8", { fatal: true });
const string = (value: Buffer | number | undefined) =>
  utf8.decode(buffer(value));
function frame(message: Buffer) {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(message.length, 1);
  return Buffer.concat([header, message]);
}
function unary(value: Buffer, statusHeader: string | null) {
  let message: Buffer | undefined;
  let status = statusHeader;
  let trailers = false;
  for (let offset = 0; offset < value.length;) {
    if (value.length - offset < 5 || trailers) throw invalid();
    const flag = value[offset],
      size = value.readUInt32BE(offset + 1);
    offset += 5;
    if (size > value.length - offset) throw invalid();
    const data = value.subarray(offset, offset + size);
    offset += size;
    if (flag === 0 && !message) message = data;
    else if (flag === 128) {
      trailers = true;
      const rows = utf8.decode(data).split("\r\n").filter(Boolean);
      const statuses = rows.filter((row) => /^grpc-status:/i.test(row));
      if (statuses.length !== 1) throw invalid();
      const terminal = statuses[0].slice(statuses[0].indexOf(":") + 1).trim();
      if (status !== null && status !== terminal) throw invalid();
      status = terminal;
    } else throw invalid();
  }
  if (status !== "0" || !message) throw invalid();
  return message;
}

export class CuaViewerClient {
  readonly origin: string;
  readonly #token: string;
  private readonly transport: typeof fetch;
  private readonly clock: () => number;
  constructor(options: {
    origin: string;
    token: string;
    fetch?: typeof fetch;
    clock?: () => number;
  }) {
    let address: URL;
    try {
      address = new URL(options.origin);
    } catch {
      throw invalid();
    }
    if (
      address.protocol !== "https:" ||
      address.origin !== options.origin ||
      address.username ||
      address.password ||
      !options.token ||
      options.token.length > 8192 ||
      /[\u0000-\u0020\u007f]/.test(options.token)
    )
      throw new CuaViewerError(
        "Acesso CUA exige origem HTTPS e a credencial existente no servidor.",
      );
    this.origin = address.origin;
    this.#token = options.token;
    this.transport = options.fetch ?? fetch;
    this.clock = options.clock ?? Date.now;
  }
  async createTicket(
    principalId: string,
    clipboard = false,
  ): Promise<CuaViewerTicket> {
    if (typeof clipboard !== "boolean")
      throw new CuaViewerError("Opção de clipboard CUA inválida.");
    if (!/^pi-handoff-[a-f0-9-]{36}$/.test(principalId)) throw invalid();
    const started = this.clock();
    const request = Buffer.concat([
      bytes(1, integer(1, CUA_VIEWER_TTL_SECONDS)),
      integer(2, 3), // SESSION_POLICY_ALLOW_ACTIVATION: mouse/keyboard in this desktop.
      integer(3, clipboard ? 1 : 0),
      bytes(4, ""),
      integer(5, 0),
      bytes(
        6,
        Buffer.concat([
          bytes(1, principalId),
          bytes(2, "Pi human handoff"),
          integer(4, 1),
        ]),
      ),
    ]);
    try {
      const value = fields(await this.rpc("CreateViewerTicket", request));
      const ticket = string(value.get(1));
      const timestamp = fields(buffer(value.get(2)));
      const nanos = number(timestamp.get(2));
      if (nanos < 0 || nanos >= 1e9) throw invalid();
      const expiresAt =
        number(timestamp.get(1)) * 1000 + Math.floor(nanos / 1e6);
      if (
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= this.clock() ||
        expiresAt < started + (CUA_VIEWER_TTL_SECONDS - 30) * 1000 ||
        expiresAt > started + (CUA_VIEWER_TTL_SECONDS + 30) * 1000
      )
        throw invalid();
      if (value.has(4) && string(value.get(4)) !== "") throw invalid();
      this.verifyTicket(ticket, expiresAt, principalId, clipboard);
      const path = string(value.get(3));
      if (!path.startsWith("/viewer/#") || /[\u0000-\u0020\u007f]/.test(path))
        throw invalid();
      const url = new URL(path, this.origin);
      const fragment = new URLSearchParams(url.hash.slice(1));
      if (
        url.origin !== this.origin ||
        url.pathname !== "/viewer/" ||
        url.search ||
        url.username ||
        url.password ||
        fragment.getAll("ticket").length !== 1 ||
        fragment.get("ticket") !== ticket ||
        (clipboard
          ? fragment.getAll("clipboard").length > 1 ||
            (fragment.has("clipboard") && fragment.get("clipboard") !== "1")
          : fragment.getAll("clipboard").length !== 1 ||
            fragment.get("clipboard") !== "0") ||
        [...fragment.keys()].some(
          (key) => !["ticket", "clipboard"].includes(key),
        ) ||
        url.href.includes(this.#token)
      )
        throw invalid();
      fragment.set("clipboard", clipboard ? "1" : "0");
      url.hash = fragment.toString();
      return { url: url.href, expiresAt, principalId: `viewer:${principalId}` };
    } catch {
      throw invalid(true);
    }
  }
  private verifyTicket(
    ticket: string,
    expiresAt: number,
    principalId: string,
    clipboard: boolean,
  ) {
    if (
      ticket.length > 8192 ||
      !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket)
    )
      throw invalid();
    const [, body, signature] = ticket.split(".");
    const key = createHmac("sha256", this.#token)
      .update("cua-spacesd/ticket-v1")
      .digest();
    const expected = createHmac("sha256", key).update(body).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw invalid();
    const claims = JSON.parse(utf8.decode(Buffer.from(body, "base64url")));
    if (
      claims.s !== "viewer" ||
      claims.e !== expiresAt ||
      claims.e <= this.clock() ||
      claims.p !== `viewer:${principalId}` ||
      typeof claims.r !== "string"
    )
      throw invalid();
    const grant = JSON.parse(claims.r);
    if (
      grant.p !== 3 ||
      grant.c !== clipboard ||
      grant.u !== false ||
      grant.f != null ||
      grant.i !== `viewer:${principalId}` ||
      grant.n !== "Pi human handoff"
    )
      throw invalid();
  }
  private async rpc(method: "CreateViewerTicket", message: Buffer) {
    const response = await this.transport(
      `${this.origin}/cua.env.v1.SystemService/${method}`,
      {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/grpc-web+proto",
          accept: "application/grpc-web+proto",
          "x-grpc-web": "1",
          "grpc-timeout": "10S",
        },
        body: frame(message),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (
      !response.ok ||
      !/^application\/grpc-web(?:\+proto)?(?:;|$)/i.test(
        response.headers.get("content-type") ?? "",
      ) ||
      !response.body ||
      Number(response.headers.get("content-length") ?? 0) > 65536
    )
      throw invalid();
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 65536) throw invalid();
        chunks.push(Buffer.from(chunk.value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return unary(Buffer.concat(chunks), response.headers.get("grpc-status"));
  }
}
