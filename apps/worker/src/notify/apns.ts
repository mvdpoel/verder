// Token-based APNs over node:http2, with an ES256 provider token made by
// node:crypto. No dependency: the whole protocol is one POST per alert.
//
// THE TRAP this module exists to get right: a development-signed app's device
// token is only valid on the SANDBOX host, and sending it to the production
// host answers `400 BadDeviceToken` — the classic silent push failure. So the
// host is chosen PER SEND from the device row's environment, never from a
// global setting.
//
// Nothing is built at module scope: importing this file opens no socket and
// reads no key. The `.p8` is read only by `loadApnsConfig`, and its contents
// are never logged, printed or put in an error message.
import http2 from "node:http2";
import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

export type ApnsEnvironment = "development" | "production";

export const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  development: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

export interface ApnsConfig { keyPem: string; keyId: string; teamId: string; topic: string }

const DEFAULT_TOPIC = "pro.vanderpoel.verder";

/** null when APNS_KEY_ID / APNS_TEAM_ID (falls back to APPLE_TEAM_ID) / APNS_KEY_PATH are unset or the file is unreadable — never throws. */
export async function loadApnsConfig(env: NodeJS.ProcessEnv = process.env): Promise<ApnsConfig | null> {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = (env.APNS_TEAM_ID ?? env.APPLE_TEAM_ID)?.trim();
  const keyPath = env.APNS_KEY_PATH?.trim();
  if (!keyId || !teamId || !keyPath) return null;
  try {
    const keyPem = await readFile(keyPath, "utf8");
    // A file that is present but is not a usable EC key would otherwise make
    // every later providerToken() throw; treat it exactly like a missing key.
    if (createPrivateKey(keyPem).asymmetricKeyType !== "ec") return null;
    return { keyPem, keyId, teamId, topic: env.APNS_TOPIC?.trim() || DEFAULT_TOPIC };
  } catch {
    return null;
  }
}

const b64url = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** ES256 JWT, header {alg:"ES256",kid}, claims {iss:teamId,iat}; crypto.sign("sha256", …, {dsaEncoding:"ieee-p1363"}). */
export function providerToken(cfg: Pick<ApnsConfig, "keyPem" | "keyId" | "teamId">, nowSec: number): string {
  const input = `${b64url({ alg: "ES256", kid: cfg.keyId })}.${b64url({ iss: cfg.teamId, iat: nowSec })}`;
  // JWS wants the raw r||s form, not DER — hence ieee-p1363.
  const sig = sign("sha256", Buffer.from(input), { key: cfg.keyPem, dsaEncoding: "ieee-p1363" });
  return `${input}.${sig.toString("base64url")}`;
}

/** Apple refuses a token older than 60 minutes and throttles (429 TooManyProviderTokenUpdates) a key minted more often than every 20. */
export const TOKEN_REUSE_MS = 50 * 60_000;

/** Reuses a token for 50 minutes: Apple refuses tokens older than 60 and throttles keys minted more often than every 20. */
export class TokenCache {
  private token: string | null = null;
  private mintedAt = 0;
  constructor(private readonly cfg: ApnsConfig, private readonly now: () => number = Date.now) {}
  get(): string {
    const t = this.now();
    if (this.token === null || t - this.mintedAt >= TOKEN_REUSE_MS) {
      this.token = providerToken(this.cfg, Math.floor(t / 1000));
      this.mintedAt = t;
    }
    return this.token;
  }
}

export interface ApnsAlert {
  title: string; body: string; level: "time-sensitive" | "active" | "passive";
  category: string; threadId?: string; collapseId?: string; link?: string;
}

export interface ApnsResult { statusCode: number; apnsId: string | null; reason: string | null }

export interface ApnsSender {
  send(env: ApnsEnvironment, deviceToken: string, alert: ApnsAlert): Promise<ApnsResult>;
  close(): void;
}

export function apnsPayload(a: ApnsAlert): object {
  const aps: Record<string, unknown> = {
    alert: { title: a.title, body: a.body },
    "interruption-level": a.level,
    category: a.category,
  };
  // Passive means "no sound, no light-up": the level alone already keeps the
  // screen dark, and omitting sound keeps it silent on every iOS version.
  if (a.level !== "passive") aps.sound = "default";
  if (a.threadId) aps["thread-id"] = a.threadId;
  const payload: Record<string, unknown> = { aps };
  if (a.link) payload.link = a.link;
  return payload;
}

/** APNs device tokens are hex. Anything else is refused before it reaches the request path. */
const DEVICE_TOKEN_RE = /^[0-9a-fA-F]{32,200}$/;
const EXPIRATION_SEC = 24 * 3600;

/**
 * The one call this module makes to open a session. Narrower than
 * `typeof http2.connect` on purpose: that type is overloaded (its first
 * overload takes a listener in the options slot), so a test's
 * `(_, o) => http2.connect(url, o)` cannot satisfy it.
 */
export type ApnsConnect = (authority: string, options: http2.SecureClientSessionOptions) => http2.ClientHttp2Session;

export function http2ApnsSender(
  cfg: ApnsConfig,
  opts: { connect?: ApnsConnect; timeoutMs?: number; now?: () => number } = {},
): ApnsSender {
  const connect: ApnsConnect = opts.connect ?? ((authority, options) => http2.connect(authority, options));
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const now = opts.now ?? Date.now;
  const tokens = new TokenCache(cfg, now);
  const sessions = new Map<ApnsEnvironment, http2.ClientHttp2Session>();

  function session(env: ApnsEnvironment): http2.ClientHttp2Session {
    const existing = sessions.get(env);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = connect(APNS_HOSTS[env], {});
    const forget = () => { if (sessions.get(env) === s) sessions.delete(env); };
    // A session-level error (DNS, TLS, GOAWAY) must not crash the worker; the
    // stream that was in flight rejects on its own, and the next send reconnects.
    s.on("error", forget);
    s.on("close", forget);
    s.on("goaway", forget);
    sessions.set(env, s);
    return s;
  }

  return {
    send(env, deviceToken, alert) {
      return new Promise<ApnsResult>((resolve, reject) => {
        if (!DEVICE_TOKEN_RE.test(deviceToken)) {
          reject(new Error("APNs: device token is not hex"));
          return;
        }
        const headers: http2.OutgoingHttpHeaders = {
          ":method": "POST",
          ":path": `/3/device/${deviceToken}`,
          authorization: `bearer ${tokens.get()}`,
          "apns-topic": cfg.topic,
          "apns-push-type": "alert",
          "apns-priority": alert.level === "passive" ? "5" : "10",
          "apns-expiration": String(Math.floor(now() / 1000) + EXPIRATION_SEC),
        };
        if (alert.collapseId) headers["apns-collapse-id"] = alert.collapseId;

        let settled = false;
        const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
        let stream: http2.ClientHttp2Stream;
        try {
          stream = session(env).request(headers);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        let statusCode = 0;
        let apnsId: string | null = null;
        const chunks: Buffer[] = [];
        stream.setTimeout(timeoutMs, () => {
          done(() => reject(new Error(`APNs request timed out after ${timeoutMs} ms`)));
          stream.close(http2.constants.NGHTTP2_CANCEL);
        });
        stream.on("response", (h) => {
          statusCode = Number(h[":status"] ?? 0);
          const id = h["apns-id"];
          apnsId = typeof id === "string" ? id : null;
        });
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => done(() => {
          let reason: string | null = null;
          const text = Buffer.concat(chunks).toString("utf8");
          if (text) {
            try {
              const r = (JSON.parse(text) as { reason?: unknown }).reason;
              reason = typeof r === "string" ? r : null;
            } catch { reason = null; }
          }
          resolve({ statusCode, apnsId, reason });
        }));
        stream.on("error", (err) => done(() => reject(err)));
        stream.on("close", () => done(() => reject(new Error("APNs stream closed without an answer"))));
        stream.end(JSON.stringify(apnsPayload(alert)));
      });
    },
    close() {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  };
}
