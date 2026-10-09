import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { CuaViewerClient, CuaViewerError } from "../src/cua-viewer.js";

const origin = "https://desktop.example";
const token = "mock-root-private-never-log";
const now = 1791518400000;
const principal = "pi-handoff-11111111-1111-4111-8111-111111111111";
const grant = {
  p: 3,
  c: false,
  u: false,
  i: `viewer:${principal}`,
  n: "Pi human handoff",
};
function varint(value: number) {
  const bytes: number[] = [];
  let remaining = BigInt(value);
  do {
    bytes.push(Number(remaining & 127n) | (remaining >= 128n ? 128 : 0));
    remaining >>= 7n;
  } while (remaining);
  return Buffer.from(bytes);
}
function field(id: number, value: string | Buffer) {
  const bytes = Buffer.from(value);
  return Buffer.concat([varint(id * 8 + 2), varint(bytes.length), bytes]);
}
function frame(data: Buffer, flags = 0) {
  const prefix = Buffer.alloc(5);
  prefix[0] = flags;
  prefix.writeUInt32BE(data.length, 1);
  return Buffer.concat([prefix, data]);
}
function fixture(
  options: {
    grant?: Record<string, unknown>;
    claims?: Record<string, unknown>;
    expiresAt?: number;
    signingToken?: string;
    path?: (ticket: string) => string;
    filesRoot?: string;
    status?: string;
  } = {},
) {
  const expiresAt = options.expiresAt ?? now + 1800000;
  const claims = {
    s: "viewer",
    r: JSON.stringify(options.grant ?? grant),
    p: `viewer:${principal}`,
    e: expiresAt,
    n: "mock-nonce",
    ...options.claims,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const key = createHmac("sha256", options.signingToken ?? token)
    .update("cua-spacesd/ticket-v1")
    .digest();
  const ticket = `v1.${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
  const timestamp = Buffer.concat([
    Buffer.from([8]),
    varint(Math.floor(expiresAt / 1000)),
    Buffer.from([16]),
    varint((expiresAt % 1000) * 1000000),
  ]);
  const message = Buffer.concat([
    field(1, ticket),
    field(2, timestamp),
    field(3, options.path?.(ticket) ?? `/viewer/#ticket=${ticket}&clipboard=0`),
    field(4, options.filesRoot ?? ""),
  ]);
  const wire = Buffer.concat([
    frame(message),
    frame(Buffer.from(`grpc-status: ${options.status ?? "0"}\r\n`), 128),
  ]);
  return { ticket, wire };
}
const response = (wire: Buffer, headers: Record<string, string> = {}) =>
  new Response(Uint8Array.from(wire), {
    headers: { "content-type": "application/grpc-web+proto", ...headers },
  });
function client(transport: typeof fetch) {
  return new CuaViewerClient({
    origin,
    token,
    fetch: transport,
    clock: () => now,
  });
}

test("only the pinned HTTPS SystemService call requests 30-minute human access with no clipboard, files or microphone", async () => {
  const f = fixture();
  let calls = 0;
  const api = client(async (input, options) => {
    calls++;
    assert.equal(
      input,
      `${origin}/cua.env.v1.SystemService/CreateViewerTicket`,
    );
    assert.equal(options?.method, "POST");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.cache, "no-store");
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(headers.get("content-type"), "application/grpc-web+proto");
    assert.equal(headers.get("grpc-timeout"), "10S");
    const body = Buffer.from(options?.body as Uint8Array);
    // Fixed schema from system.proto/common.proto; no RPC, policy, scope or TTL arguments.
    const expected = Buffer.concat([
      Buffer.from("0a0308880e10031800220028003245", "hex"),
      Buffer.from([10, 47]),
      Buffer.from(principal),
      Buffer.from([18, 16]),
      Buffer.from("Pi human handoff"),
      Buffer.from([32, 1]),
    ]);
    assert.equal(body[0], 0);
    assert.equal(body.readUInt32BE(1), expected.length);
    assert.deepEqual(body.subarray(5), expected);
    assert.ok(options?.signal);
    return response(f.wire);
  });
  assert.doesNotMatch(JSON.stringify(api), /mock-root/);
  const ticket = await api.createTicket(principal);
  assert.equal(calls, 1);
  assert.equal(ticket.principalId, `viewer:${principal}`);
  assert.equal(ticket.expiresAt, now + 1800000);
  const link = new URL(ticket.url);
  assert.equal(link.origin, origin);
  assert.equal(link.pathname, "/viewer/");
  assert.equal(link.search, "");
  assert.equal(new URLSearchParams(link.hash.slice(1)).get("ticket"), f.ticket);
  assert.doesNotMatch(ticket.url, /mock-root/);
});

test("signed viewer grants must prove every restriction, exact principal and response expiry before any link is exposed", async () => {
  const cases = [
    { signingToken: "wrong-mock-signing-key" },
    { claims: { s: "media" } },
    { claims: { p: "viewer:another-human" } },
    { claims: { e: now + 1200000 } },
    { grant: { ...grant, p: 1 } },
    { grant: { ...grant, c: true } },
    { grant: { ...grant, u: true } },
    { grant: { ...grant, f: "/home/user" } },
    { grant: { ...grant, f: "" } },
    { grant: { ...grant, i: "viewer:another-human" } },
    { grant: { ...grant, n: "unexpected-display-name" } },
    { filesRoot: "/home/user" },
    { expiresAt: now - 1000 },
    { expiresAt: now + 3600000 },
    { expiresAt: now + 1700000 },
  ];
  for (const options of cases) {
    const f = fixture(options);
    let calls = 0;
    await assert.rejects(
      client(async () => {
        calls++;
        return response(f.wire);
      }).createTicket(principal),
      (error) => {
        assert.ok(error instanceof CuaViewerError);
        assert.equal(error.dispatched, true);
        assert.doesNotMatch(
          error.message,
          /mock-root|wrong-mock|v1\.|\/home\/user/,
        );
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("a ticket link cannot leave the pinned origin, contain credentials, put a secret in query, or widen viewer grants", async () => {
  const paths: Array<(ticket: string) => string> = [
    (t) => `https://evil.example/viewer/#ticket=${t}&clipboard=0`,
    (t) => `//evil.example/viewer/#ticket=${t}&clipboard=0`,
    (t) => `/viewer/?ticket=${t}#clipboard=0`,
    (t) => `/viewer/#ticket=${t}&clipboard=1`,
    (t) => `/viewer/#ticket=${t}&clipboard=0&files=~`,
    (t) => `/viewer/#ticket=${t}&ticket=${t}&clipboard=0`,
    (t) => `/viewer/#ticket=${t}&clipboard=0&clipboard=0`,
    (t) => `/viewer/#ticket=wrong&clipboard=0&other=${t}`,
    (t) => `/viewer/#ticket=${t}\n&clipboard=0`,
  ];
  for (const path of paths) {
    const f = fixture({ path });
    await assert.rejects(
      client(async () => response(f.wire)).createTicket(principal),
      CuaViewerError,
    );
  }
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    throw new Error("not reached");
  };
  for (const unsafe of [
    "http://desktop.example",
    "https://user:password@desktop.example",
    "https://desktop.example/other",
    "https://desktop.example?query=1",
    "invalid",
  ])
    assert.throws(
      () => new CuaViewerClient({ origin: unsafe, token, fetch: transport }),
      CuaViewerError,
    );
  await assert.rejects(
    client(transport).createTicket("other-principal"),
    (error) => error instanceof CuaViewerError && !error.dispatched,
  );
  assert.equal(calls, 0);
});

test("transport faults, bad trailers, malformed protobuf and oversized replies never repeat ticket creation or reflect secrets", async () => {
  const f = fixture();
  const responses = [
    () => {
      throw new Error(`upstream-private-${token}`);
    },
    () => new Response(`upstream-private-${token}`, { status: 401 }),
    () => response(f.wire, { "grpc-status": "7" }),
    () => response(fixture({ status: "7" }).wire),
    () => response(f.wire.subarray(0, f.wire.length - 1)),
    () =>
      response(
        Buffer.concat([
          frame(Buffer.from([10, 255])),
          frame(Buffer.from("grpc-status: 0\r\n"), 128),
        ]),
      ),
    () => response(Buffer.concat([f.wire, f.wire])),
    () => response(Buffer.alloc(65537)),
    () => response(f.wire, { "content-length": "65537" }),
    () => response(f.wire, { "content-type": "text/html" }),
  ];
  for (const make of responses) {
    let calls = 0;
    await assert.rejects(
      client(async () => {
        calls++;
        return make();
      }).createTicket(principal),
      (error) => {
        assert.ok(error instanceof CuaViewerError);
        assert.equal(error.dispatched, true);
        assert.doesNotMatch(error.message, /mock-root|upstream-private|v1\./);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("explicit clipboard consent changes only the exact request grant and normalizes the native true viewer path", async () => {
  const f = fixture({
    grant: { ...grant, c: true },
    path: (t) => `/viewer/#ticket=${t}`,
  });
  let calls = 0;
  const api = client(async (_input, options) => {
    calls++;
    const body = Buffer.from(options?.body as Uint8Array);
    const expected = Buffer.concat([
      Buffer.from("0a0308880e10031801220028003245", "hex"),
      Buffer.from([10, 47]),
      Buffer.from(principal),
      Buffer.from([18, 16]),
      Buffer.from("Pi human handoff"),
      Buffer.from([32, 1]),
    ]);
    assert.equal(body[0], 0);
    assert.equal(body.readUInt32BE(1), expected.length);
    assert.deepEqual(body.subarray(5), expected);
    return response(f.wire);
  });
  const result = await api.createTicket(principal, true);
  const params = new URLSearchParams(new URL(result.url).hash.slice(1));
  assert.equal(params.get("clipboard"), "1");
  assert.equal(params.get("ticket"), f.ticket);
  assert.equal(params.getAll("clipboard").length, 1);
  assert.equal(calls, 1);
});

test("signed clipboard grants must match the chosen Boolean exactly while all other restrictions remain fixed", async () => {
  for (const choice of [false, true]) {
    for (const changed of [
      { c: !choice },
      { c: choice ? 1 : 0 },
      { c: String(choice) },
      { p: 1 },
      { u: true },
      { f: "/home/user" },
      { i: "viewer:other" },
    ]) {
      const f = fixture({
        grant: { ...grant, c: choice, ...changed },
        path: (t) => `/viewer/#ticket=${t}${choice ? "" : "&clipboard=0"}`,
      });
      await assert.rejects(
        client(async () => response(f.wire)).createTicket(principal, choice),
        CuaViewerError,
      );
    }
  }
});

test("clipboard-enabled viewer URLs accept only the native absent flag or exact1 and reject scope injection", async () => {
  for (const path of [
    (t: string) => `/viewer/#ticket=${t}`,
    (t: string) => `/viewer/#ticket=${t}&clipboard=1`,
  ]) {
    const f = fixture({ grant: { ...grant, c: true }, path });
    const result = await client(async () => response(f.wire)).createTicket(
      principal,
      true,
    );
    assert.equal(
      new URLSearchParams(new URL(result.url).hash.slice(1)).get("clipboard"),
      "1",
    );
  }
  for (const path of [
    (t: string) => `/viewer/#ticket=${t}&clipboard=0`,
    (t: string) => `/viewer/#ticket=${t}&clipboard=true`,
    (t: string) => `/viewer/#ticket=${t}&clipboard=1&clipboard=1`,
    (t: string) => `/viewer/#ticket=${t}&ticket=${t}`,
    (t: string) => `/viewer/#ticket=${t}&files=~`,
    (t: string) => `/viewer/#ticket=${t}&audio=1`,
    (t: string) => `/viewer/?clipboard=1#ticket=${t}`,
    (t: string) => `https://evil.example/viewer/#ticket=${t}&clipboard=1`,
    (t: string) => `//evil.example/viewer/#ticket=${t}&clipboard=1`,
    (t: string) => `/viewer/#ticket=${t}\n`,
  ]) {
    const f = fixture({ grant: { ...grant, c: true }, path });
    await assert.rejects(
      client(async () => response(f.wire)).createTicket(principal, true),
      CuaViewerError,
    );
  }
});

test("malformed clipboard choices reject before ticket dispatch", async () => {
  let calls = 0;
  const api = client(async () => {
    calls++;
    return response(fixture().wire);
  });
  for (const choice of ["true", 1, 0, null, {}, []])
    await assert.rejects(
      api.createTicket(principal, choice as boolean),
      (error) => error instanceof CuaViewerError && !error.dispatched,
    );
  assert.equal(calls, 0);
});
