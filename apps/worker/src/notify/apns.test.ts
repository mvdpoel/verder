import { afterEach, describe, expect, it } from "vitest";
import http2 from "node:http2";
import { generateKeyPairSync, verify } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  APNS_HOSTS, TokenCache, apnsPayload, http2ApnsSender, loadApnsConfig, providerToken,
  type ApnsAlert, type ApnsConfig,
} from "./apns";

// A throwaway P-256 key made for this test run. Never a real APNs key.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const CFG: ApnsConfig = {
  keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  keyId: "TESTKEY123", teamId: "TESTTEAM12", topic: "pro.vanderpoel.verder",
};
const TOKEN = "ab".repeat(32);
const ALERT: ApnsAlert = { title: "Titel", body: "Tekst", level: "active", category: "proposal" };

const b64 = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

const servers: http2.Http2Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function listen(handler: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void) {
  const server = http2.createServer();
  server.on("stream", handler);
  servers.push(server);
  return new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

describe("providerToken", () => {
  it("provider token verifies with the public key", () => {
    const jwt = providerToken(CFG, 1_800_000_000);
    const [h, c, s] = jwt.split(".");
    expect(b64(h)).toEqual({ alg: "ES256", kid: "TESTKEY123" });
    expect(b64(c)).toEqual({ iss: "TESTTEAM12", iat: 1_800_000_000 });
    const sig = Buffer.from(s, "base64url");
    expect(sig.length).toBe(64);
    expect(verify("sha256", Buffer.from(`${h}.${c}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  });

  it("token cache reuses for 50 minutes and renews after", () => {
    let now = 1_800_000_000_000;
    const cache = new TokenCache(CFG, () => now);
    const first = cache.get();
    now += 49 * 60_000;
    expect(cache.get()).toBe(first);
    now += 60_000; // 50 minutes exactly
    const second = cache.get();
    expect(second).not.toBe(first);
    expect(b64(second.split(".")[1]).iat).toBe(Math.floor(now / 1000));
    now += 10 * 60_000;
    expect(cache.get()).toBe(second);
  });
});

describe("apnsPayload", () => {
  it("passive alert has no sound and priority 5", async () => {
    const p = apnsPayload({ ...ALERT, level: "passive", threadId: "t1", link: "verder://x" }) as {
      aps: Record<string, unknown>; link: string };
    expect(p.aps.sound).toBeUndefined();
    expect(p.aps["interruption-level"]).toBe("passive");
    expect(p.aps["thread-id"]).toBe("t1");
    expect(p.link).toBe("verder://x");
    const active = apnsPayload(ALERT) as { aps: Record<string, unknown> };
    expect(active.aps.sound).toBe("default");

    const seen: http2.IncomingHttpHeaders[] = [];
    const port = await listen((stream, headers) => {
      seen.push(headers);
      stream.respond({ ":status": 200, "apns-id": "id-1" });
      stream.end();
    });
    const sender = http2ApnsSender(CFG, {
      connect: (_a, o) => http2.connect(`http://127.0.0.1:${port}`, o) });
    try {
      await sender.send("development", TOKEN, { ...ALERT, level: "passive" });
      await sender.send("development", TOKEN, { ...ALERT, level: "time-sensitive", collapseId: "c1" });
    } finally { sender.close(); }
    expect(seen[0]["apns-priority"]).toBe("5");
    expect(seen[0]["apns-collapse-id"]).toBeUndefined();
    expect(seen[1]["apns-priority"]).toBe("10");
    expect(seen[1]["apns-collapse-id"]).toBe("c1");
    expect(seen[0][":path"]).toBe(`/3/device/${TOKEN}`);
    expect(seen[0]["apns-topic"]).toBe("pro.vanderpoel.verder");
    expect(seen[0]["apns-push-type"]).toBe("alert");
    expect(String(seen[0].authorization)).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const exp = Number(seen[0]["apns-expiration"]);
    expect(exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(24 * 3600 - 60);
  });
});

describe("http2ApnsSender", () => {
  it("development device goes to the sandbox host", async () => {
    const port = await listen((stream) => { stream.respond({ ":status": 200 }); stream.end(); });
    const authorities: string[] = [];
    const sender = http2ApnsSender(CFG, { connect: (authority, o) => {
      authorities.push(String(authority));
      return http2.connect(`http://127.0.0.1:${port}`, o);
    } });
    try {
      await sender.send("development", TOKEN, ALERT);
      await sender.send("development", TOKEN, ALERT); // one session per host, reused
      await sender.send("production", TOKEN, ALERT);
    } finally { sender.close(); }
    expect(authorities).toEqual([APNS_HOSTS.development, APNS_HOSTS.production]);
    expect(APNS_HOSTS.development).toBe("https://api.sandbox.push.apple.com");
  });

  it("parses reason and apns-id from a 400 answer", async () => {
    const port = await listen((stream) => {
      stream.respond({ ":status": 400, "apns-id": "11111111-2222-3333-4444-555555555555" });
      stream.end(JSON.stringify({ reason: "BadDeviceToken" }));
    });
    const sender = http2ApnsSender(CFG, {
      connect: (_a, o) => http2.connect(`http://127.0.0.1:${port}`, o) });
    try {
      expect(await sender.send("production", TOKEN, ALERT)).toEqual({
        statusCode: 400, apnsId: "11111111-2222-3333-4444-555555555555", reason: "BadDeviceToken" });
    } finally { sender.close(); }
  });

  it("times out a silent server", async () => {
    const port = await listen(() => { /* never answers */ });
    const sender = http2ApnsSender(CFG, {
      timeoutMs: 200, connect: (_a, o) => http2.connect(`http://127.0.0.1:${port}`, o) });
    const started = Date.now();
    try {
      await expect(sender.send("development", TOKEN, ALERT)).rejects.toThrow(/timed out/);
    } finally { sender.close(); }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses a device token that is not hex", async () => {
    const sender = http2ApnsSender(CFG, { connect: () => { throw new Error("must not connect"); } });
    try {
      await expect(sender.send("development", "../../x", ALERT)).rejects.toThrow(/device token/);
    } finally { sender.close(); }
  });
});

describe("loadApnsConfig", () => {
  it("loadApnsConfig returns null when the key path is missing", async () => {
    const base = { APNS_KEY_ID: "K", APNS_TEAM_ID: "T" };
    expect(await loadApnsConfig({ ...base })).toBeNull();
    expect(await loadApnsConfig({ ...base,
      APNS_KEY_PATH: `/nonexistent/${crypto.randomUUID()}.p8` })).toBeNull();
    expect(await loadApnsConfig({ APNS_KEY_PATH: "/x" })).toBeNull();
  });

  it("loads a readable key, falling back to APPLE_TEAM_ID", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "apns-test-"));
    try {
      const path = join(dir, "k.p8");
      await writeFile(path, CFG.keyPem, { mode: 0o600 });
      expect(await loadApnsConfig({ APNS_KEY_ID: "K", APPLE_TEAM_ID: "T", APNS_KEY_PATH: path }))
        .toEqual({ keyPem: CFG.keyPem, keyId: "K", teamId: "T", topic: "pro.vanderpoel.verder" });
      await writeFile(path, "not a key");
      expect(await loadApnsConfig({ APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_KEY_PATH: path })).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
