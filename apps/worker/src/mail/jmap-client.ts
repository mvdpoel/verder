export interface JmapSession { apiUrl: string; downloadUrl: string; accountId: string }

const MAIL = "urn:ietf:params:jmap:mail";

/**
 * The Authorization header value, built in exactly ONE place.
 *
 * SETTLED: Stalwart is authenticated with HTTP Basic and an APP PASSWORD, which
 * is what `basic` builds and what the poll call site passes. OAuth was rejected
 * on lifetime — Stalwart's default access token lives 1 h, and raising that
 * server-wide to 90 d only moves a silent ingestion death to day 91, whereas an
 * app password does not expire and is individually revocable.
 *
 * The header stays injectable anyway, because that is what kept this a
 * one-factory change rather than an edit in three functions. `bearer` survives
 * for the same reason, and a plain string still means a bearer token, so no
 * existing caller changes.
 *
 * NOTHING here reads an env var: this module takes a credential, it never
 * sources one. JMAP_USER / JMAP_APP_PASSWORD are read at the call site.
 */
export interface JmapAuth { readonly authorization: string }
export type JmapCredential = string | JmapAuth;

export function bearer(token: string): JmapAuth {
  return { authorization: `Bearer ${token}` };
}

/**
 * RFC 7617: `Basic ` + base64 of `user:password`, over UTF-8.
 *
 * Two encoding traps, both tested:
 *  - Only the FIRST colon separates, so a colon inside the app password is
 *    legal and must survive verbatim — no escaping, no splitting.
 *  - The credentials are UTF-8 bytes. A latin1 encode spends one byte on `ë`
 *    and the server reads a different password, which surfaces as a 401 that
 *    looks like a wrong password rather than a wrong encoder.
 *
 * A colon in the USERID is not encodable at all — the server splits at the
 * first one, so `who:ami` + `pw` authenticates as `who` with password `ami:pw`.
 * That is refused here rather than sent, and the refusal names neither value:
 * this message can reach worker_runs.detail like every other throw below.
 */
export function basic(user: string, appPassword: string): JmapAuth {
  if (user.includes(":")) {
    throw new Error("JMAP basic auth userid must not contain a colon (RFC 7617)");
  }
  const encoded = Buffer.from(`${user}:${appPassword}`, "utf8").toString("base64");
  return { authorization: `Basic ${encoded}` };
}

function authHeader(auth: JmapCredential): string {
  return typeof auth === "string" ? bearer(auth).authorization : auth.authorization;
}

/**
 * A method call that the server refused.
 *
 * RFC 8620 §3.6.1: a failed method call comes back INSIDE a 200 OK as
 * `["error", {type}, callId]`. The `type` is the diagnosis — invalidArguments,
 * unknownCapability, overQuota, cannotCalculateChanges — so it is carried as
 * DATA, not only in the message: the poll layer has to branch on
 * `cannotCalculateChanges` (drop the cursor, resync) and must never do that by
 * matching a string. The message repeats both, because worker_runs.detail
 * stores `String(err)` and that is where a human reads it.
 */
export class JmapMethodError extends Error {
  constructor(
    readonly jmapType: string,
    readonly callId: string,
    readonly description?: string,
  ) {
    super(`JMAP method call ${callId} failed: ${jmapType}`
      + (description ? ` — ${description}` : ""));
    this.name = "JmapMethodError";
  }
}

/** A response the client cannot line up with the request it sent. */
export class JmapProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JmapProtocolError";
  }
}

/** Narrow an unknown caught value, optionally to one JMAP error type. */
export function isJmapMethodError(err: unknown, type?: string): err is JmapMethodError {
  return err instanceof JmapMethodError && (type === undefined || err.jmapType === type);
}

/**
 * Status only. NEVER interpolate the credential, the Authorization header or
 * the whole RequestInit into a message here or in the two error classes above:
 * every throw in this file ends up in `worker_runs.detail`, which the dashboard
 * renders and the nightly dump writes off-box — and an app password does not
 * expire, so one persisted run row is a permanent leak.
 */
async function ok(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`JMAP ${what} failed: ${res.status} ${res.statusText}`);
  return res;
}

export async function openSession(
  base: string, auth: JmapCredential, fetchFn: typeof fetch = fetch,
): Promise<JmapSession> {
  const res = await ok(await fetchFn(`${base}/.well-known/jmap`, {
    headers: { Authorization: authHeader(auth) },
  }), "session");
  const s = await res.json() as {
    apiUrl: string; downloadUrl: string; primaryAccounts: Record<string, string> };
  const accountId = s.primaryAccounts[MAIL];
  if (!accountId) throw new Error("JMAP session has no primary mail account");
  return { apiUrl: s.apiUrl, downloadUrl: s.downloadUrl, accountId };
}

/**
 * One HTTP round trip for N method calls. Back-references (`#ids`) are what make
 * Email/query + Email/get a single request; callers build them.
 *
 * A 200 OK is NOT success: the response name must be read. Returning
 * `body.methodResponses.map(([, args]) => args)` hands a caller
 * `{type:"invalidArguments"}` typed as the success payload, which then dies as
 * an unrelated TypeError somewhere else entirely — every diagnosable fault
 * turned into a mystery.
 */
export async function call<T>(
  s: JmapSession, auth: JmapCredential, using: string[], calls: unknown[][],
  fetchFn: typeof fetch = fetch,
): Promise<T[]> {
  const res = await ok(await fetchFn(s.apiUrl, {
    method: "POST",
    headers: { Authorization: authHeader(auth), "content-type": "application/json" },
    body: JSON.stringify({ using, methodCalls: calls }),
  }), "api");
  const body = await res.json() as { methodResponses: [string, T, string][] };
  const responses = body.methodResponses ?? [];

  // EVERY response, not only the first: Email/query + Email/get travel in one
  // request, so a failure on the second call is the ordinary shape of a fault.
  for (const [name, args, callId] of responses) {
    if (name !== "error") continue;
    const e = (args ?? {}) as { type?: string; description?: string };
    throw new JmapMethodError(e.type ?? "unknown", callId ?? "?", e.description);
  }

  // `const [r] = []` is undefined and dies as a TypeError with no bearing on
  // the cause. A short response array is a protocol fault and says so here.
  if (responses.length < calls.length) {
    throw new JmapProtocolError(
      `JMAP api returned ${responses.length} method responses for ${calls.length} method calls`);
  }
  return responses.map(([, args]) => args);
}

/**
 * downloadUrl is a URI template; every placeholder must be substituted, and a
 * placeholder may appear MORE THAN ONCE — RFC 8620 puts no once-only constraint
 * on it, and `String.replace` with a string pattern replaces the first
 * occurrence only, leaving a URL that 404s as if the message were missing.
 *
 * Every value goes through encodeURIComponent, which is also what keeps the
 * `$&`/`$'` replacement patterns out of reach (`$` encodes to `%24`). Do not
 * remove the encoding: replaceAll would then interpret a `$` in a filename.
 */
export async function download(
  s: JmapSession, auth: JmapCredential, blobId: string, name: string, type: string,
  fetchFn: typeof fetch = fetch,
): Promise<Buffer> {
  const url = s.downloadUrl
    .replaceAll("{accountId}", encodeURIComponent(s.accountId))
    .replaceAll("{blobId}", encodeURIComponent(blobId))
    .replaceAll("{name}", encodeURIComponent(name))
    .replaceAll("{type}", encodeURIComponent(type));
  const res = await ok(await fetchFn(url, {
    headers: { Authorization: authHeader(auth) },
  }), "download");
  return Buffer.from(await res.arrayBuffer());
}
