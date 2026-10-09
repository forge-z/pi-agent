import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { PassThrough, Readable } from "node:stream";
import type { LookupFunction } from "node:net";
import { SettingsError } from "./settings.js";

export type ApiProtocol = "openai-compatible" | "anthropic";
export interface ProviderEndpoint {
  protocol: ApiProtocol;
  endpoint: string;
  allowLocal: boolean;
}
type AddressKind = "public" | "private" | "blocked";
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 120_000;
const transportError = () => new Error("Falha na conexão de API");
const blockedError = () => new SettingsError("Conexão de API bloqueada");
const endpointError = () => new SettingsError("Endpoint de API inválido");
const abortError = () =>
  new DOMException("Requisição de API cancelada", "AbortError");

function ipv4Number(address: string): bigint {
  return address
    .split(".")
    .reduce((result, part) => (result << 8n) | BigInt(part), 0n);
}

function ipv6Number(address: string): bigint {
  let value = address.toLowerCase();
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const v4 = ipv4Number(value.slice(lastColon + 1));
    value =
      value.slice(0, lastColon + 1) +
      (v4 >> 16n).toString(16) +
      ":" +
      (v4 & 0xffffn).toString(16);
  }
  const halves = value.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups =
    halves.length === 1
      ? left
      : [
          ...left,
          ...Array<string>(8 - left.length - right.length).fill("0"),
          ...right,
        ];
  return groups.reduce(
    (result, part) => (result << 16n) | BigInt(`0x${part}`),
    0n,
  );
}

function inRange(
  value: bigint,
  base: bigint,
  bits: number,
  width: number,
): boolean {
  const shift = BigInt(width - bits);
  return value >> shift === base >> shift;
}

// IANA special-purpose registries (2025-10-09). Translation/tunnel prefixes
// stay blocked so embedded destinations cannot bypass the IPv4 policy.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const blockedV4: [string, number][] = [
  ["0.0.0.0", 8],
  ["100.64.0.0", 10],
  ["169.254.0.0", 16],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
  ["168.63.129.16", 32],
];
const privateV4: [string, number][] = [
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];

function classifyAddress(address: string): AddressKind {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    if (
      blockedV4.some(([base, bits]) =>
        inRange(value, ipv4Number(base), bits, 32),
      )
    )
      return "blocked";
    return privateV4.some(([base, bits]) =>
      inRange(value, ipv4Number(base), bits, 32),
    )
      ? "private"
      : "public";
  }
  if (family !== 6 || address.includes("%")) return "blocked";
  const value = ipv6Number(address);
  if (value >> 32n === 0xffffn) {
    const v4 = value & 0xffffffffn;
    return classifyAddress(
      [24n, 16n, 8n, 0n]
        .map((shift) => Number((v4 >> shift) & 0xffn))
        .join("."),
    );
  }
  if (value === 1n) return "private";
  // Known cloud metadata services use otherwise private IPv6 addresses.
  if (
    value === ipv6Number("fd00:ec2::254") ||
    value === ipv6Number("fd20:ce::254")
  )
    return "blocked";
  if (inRange(value, ipv6Number("fc00::"), 7, 128)) return "private";
  if (!inRange(value, ipv6Number("2000::"), 3, 128)) return "blocked";
  if (
    [
      ["2001::", 23],
      ["2001:db8::", 32],
      ["2002::", 16],
      ["3fff::", 20],
    ].some(([base, bits]) =>
      inRange(value, ipv6Number(base as string), bits as number, 128),
    )
  )
    return "blocked";
  return "public";
}

function hostname(url: URL): string {
  return url.hostname.startsWith("[")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function safeUrl(value: string): URL {
  if (value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value))
    throw endpointError();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw endpointError();
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.includes("?") ||
    value.includes("#") ||
    !url.hostname ||
    url.port === "0"
  )
    throw endpointError();
  // Keep percent-encoded separators/control characters out of gateway paths.
  if (/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(url.pathname))
    throw endpointError();
  return url;
}

function validateEndpoint(input: Record<string, unknown>): {
  protocol: ApiProtocol;
  url: URL;
  allowLocal: boolean;
} {
  if (
    (input.protocol !== "openai-compatible" &&
      input.protocol !== "anthropic") ||
    typeof input.endpoint !== "string" ||
    (input.allowLocal !== undefined && typeof input.allowLocal !== "boolean")
  )
    throw endpointError();
  const allowLocal = input.allowLocal === true;
  const url = safeUrl(input.endpoint);
  if (url.protocol !== "https:" && !allowLocal) throw endpointError();
  const host = hostname(url);
  if (isIP(host)) {
    const kind = classifyAddress(host);
    if (
      kind === "blocked" ||
      (kind === "private" && !allowLocal) ||
      (url.protocol === "http:" && kind !== "private")
    )
      throw endpointError();
  }
  return { protocol: input.protocol, url, allowLocal };
}

export function parseProviderEndpoint(
  input: Record<string, unknown>,
): ProviderEndpoint {
  const { protocol, url, allowLocal } = validateEndpoint(input);
  let path = url.pathname.replace(/\/+$/, "");
  if (protocol === "openai-compatible" && !path) path = "/v1";
  if (protocol === "anthropic" && path.endsWith("/v1"))
    path = path.slice(0, -3);
  return { protocol, endpoint: url.origin + path, allowLocal };
}

export function providerModelsUrl(config: ProviderEndpoint): string {
  return `${config.endpoint}${config.protocol === "anthropic" ? "/v1/models" : "/models"}`;
}

async function withCancellation<T>(
  operation: Promise<T>,
  signal?: AbortSignal | null,
): Promise<T> {
  if (signal?.aborted) {
    // The operation may already have started (Blob or injected DNS). Observe
    // rejection even when cancellation wins before handlers are installed.
    void operation.catch(() => {});
    throw abortError();
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(transportError());
    }, CONNECT_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    signal?.addEventListener("abort", abort, { once: true });
    operation.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      () => {
        cleanup();
        reject(transportError());
      },
    );
  });
}

async function requestBody(
  body: BodyInit | null | undefined,
  signal?: AbortSignal | null,
): Promise<Buffer | undefined> {
  if (body == null) return undefined;
  let buffer: Buffer;
  if (typeof body === "string") {
    if (Buffer.byteLength(body) > MAX_BODY_BYTES)
      throw new SettingsError("Requisição de API muito grande");
    buffer = Buffer.from(body);
  } else if (body instanceof URLSearchParams) {
    buffer = Buffer.from(body.toString());
  } else if (body instanceof ArrayBuffer) {
    buffer = Buffer.from(body);
  } else if (ArrayBuffer.isView(body)) {
    buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  } else if (body instanceof Blob) {
    if (body.size > MAX_BODY_BYTES)
      throw new SettingsError("Requisição de API muito grande");
    buffer = Buffer.from(await withCancellation(body.arrayBuffer(), signal));
  } else throw new SettingsError("Upload de API não suportado");
  if (buffer.length > MAX_BODY_BYTES)
    throw new SettingsError("Requisição de API muito grande");
  return buffer;
}

function genericResponse(status: number): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "api_error", message: "Falha na conexão de API" },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

export function providerFetch(
  config: ProviderEndpoint,
  options?: {
    keyless?: boolean;
    lookup?: (
      hostname: string,
      options: { all: true; verbatim: true },
    ) => Promise<{ address: string; family: number }[]>;
  },
): typeof globalThis.fetch {
  // Capture validated values, so later edits cannot broaden this fetch's scope.
  const validated = validateEndpoint({ ...config });
  const captured = {
    protocol: validated.protocol,
    endpoint: validated.url.origin + validated.url.pathname.replace(/\/+$/, ""),
    allowLocal: validated.allowLocal,
  };
  const base = new URL(captured.endpoint);
  const lookup =
    options?.lookup ??
    ((host: string, lookupOptions: { all: true; verbatim: true }) =>
      dnsLookup(host, lookupOptions));
  const keyless = options?.keyless === true;
  if (keyless && !captured.allowLocal) throw blockedError();
  const messagePath =
    base.pathname.replace(/\/$/, "") +
    (captured.protocol === "anthropic" ? "/v1/messages" : "/chat/completions");
  const modelsPath = new URL(providerModelsUrl(captured)).pathname;

  return async (input, init) => {
    const original = input instanceof Request ? input : undefined;
    const signal = init?.signal ?? original?.signal;
    if (signal?.aborted) throw abortError();
    let url: URL;
    try {
      const raw =
        original?.url ?? (input instanceof URL ? input.href : String(input));
      if (/[\u0000-\u0020\u007f\\]/u.test(raw) || raw.length > 4096)
        throw blockedError();
      url = new URL(raw);
      if (
        url.origin !== base.origin ||
        url.username ||
        url.password ||
        url.hash ||
        raw.includes("#")
      )
        throw blockedError();
    } catch {
      throw blockedError();
    }
    const method = (init?.method ?? original?.method ?? "GET").toUpperCase();
    if (!(
      (url.pathname === messagePath && method === "POST") ||
      (url.pathname === modelsPath && method === "GET")
    ))
      throw blockedError();
    if (
      url.search &&
      !(
        captured.protocol === "anthropic" &&
        url.pathname === messagePath &&
        url.search === "?beta=true"
      )
    )
      throw blockedError();
    if (original?.body && init?.body === undefined)
      throw new SettingsError("Upload de API não suportado");
    const body = await requestBody(init?.body, signal);
    if (signal?.aborted) throw abortError();
    if (method === "GET" && body) throw blockedError();
    let headers: Headers;
    try {
      headers = new Headers(init?.headers ?? original?.headers);
    } catch {
      throw blockedError();
    }
    for (const header of [
      "host",
      "connection",
      "content-length",
      "transfer-encoding",
      "proxy-authorization",
      "proxy-connection",
      "upgrade",
      "trailer",
      "te",
      "expect",
    ])
      headers.delete(header);
    headers.set("accept-encoding", "identity");
    if (keyless) {
      headers.delete("authorization");
      headers.delete("x-api-key");
    }
    if (body) headers.set("content-length", String(body.length));

    const host = hostname(url);
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await withCancellation(
          lookup(host, { all: true, verbatim: true }),
          signal,
        );
    if (
      !addresses.length ||
      addresses.some((entry) => {
        const kind = classifyAddress(entry.address);
        return (
          isIP(entry.address) !== entry.family ||
          kind === "blocked" ||
          (kind === "private" && !captured.allowLocal) ||
          ((url.protocol === "http:" || keyless) && kind !== "private")
        );
      })
    )
      throw blockedError();
    if (signal?.aborted) throw abortError();
    const address = addresses[0];
    const pinnedLookup: LookupFunction = (_host, lookupOptions, callback) => {
      if (lookupOptions.all)
        callback(null, [{ address: address.address, family: address.family }]);
      else callback(null, address.address, address.family);
    };

    return new Promise<Response>((resolve, reject) => {
      let output: PassThrough | undefined;
      let responseStarted = false;
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method,
          headers: Object.fromEntries(headers),
          agent: false,
          lookup: pinnedLookup,
          // Keep the hostname for certificate verification and SNI; no custom TLS options.
          ...(url.protocol === "https:" && !isIP(host)
            ? { servername: host }
            : {}),
        },
      );
      const cleanup = () => {
        clearTimeout(connectTimer);
        signal?.removeEventListener("abort", abort);
      };
      const fail = (error: Error) => {
        output?.destroy(error);
        req.destroy(error);
        if (!responseStarted) {
          cleanup();
          reject(error);
        }
      };
      const abort = () => fail(abortError());
      const connectTimer = setTimeout(
        () => fail(transportError()),
        CONNECT_TIMEOUT_MS,
      );
      signal?.addEventListener("abort", abort, { once: true });
      req.setTimeout(IDLE_TIMEOUT_MS, () => fail(transportError()));
      req.once("error", () => {
        const error = signal?.aborted ? abortError() : transportError();
        output?.destroy(error);
        if (!responseStarted) {
          cleanup();
          reject(error);
        }
      });
      req.once("response", (incoming) => {
        clearTimeout(connectTimer);
        const status = incoming.statusCode ?? 502;
        const encoding = incoming.headers["content-encoding"];
        if (
          status >= 300 ||
          status < 200 ||
          (encoding && encoding !== "identity")
        ) {
          responseStarted = true;
          incoming.destroy();
          cleanup();
          resolve(
            genericResponse(status >= 400 && status <= 599 ? status : 502),
          );
          return;
        }
        const responseHeaders = new Headers();
        // Only metadata needed by SDK parsers is returned. Upstream error headers
        // and bodies never become SDK exception messages or reflected secrets.
        if (incoming.headers["content-type"])
          responseHeaders.set("content-type", incoming.headers["content-type"]);
        if ([204, 205].includes(status)) {
          responseStarted = true;
          incoming.destroy();
          cleanup();
          resolve(new Response(null, { status, headers: responseHeaders }));
          return;
        }
        output = new PassThrough();
        output.once("close", () => {
          cleanup();
          incoming.destroy();
          req.destroy();
        });
        incoming.once("error", () =>
          output?.destroy(signal?.aborted ? abortError() : transportError()),
        );
        incoming.pipe(output);
        responseStarted = true;
        resolve(
          new Response(Readable.toWeb(output) as ReadableStream<Uint8Array>, {
            status,
            headers: responseHeaders,
          }),
        );
      });
      req.end(body);
    }).catch(() => {
      throw signal?.aborted ? abortError() : transportError();
    });
  };
}
