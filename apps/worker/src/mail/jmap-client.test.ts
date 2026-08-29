import { describe, expect, it, vi } from "vitest";
import { call, download, openSession } from "./jmap-client";
// A NAMESPACE import on purpose, for the two symbols added by the fix below.
// A missing NAMED export is a load-time SyntaxError that fails every test in
// the file at once, so the red says nothing about which behaviour is absent.
// Through the namespace the symbol is merely undefined and exactly the one test
// that needs it goes red — which is how these tests were watched to fail first.
import * as client from "./jmap-client";

const MAIL = "urn:ietf:params:jmap:mail";

const SESSION = {
  apiUrl: "https://mail.example.nl/jmap/api",
  downloadUrl: "https://mail.example.nl/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-1" },
};

// The parameters are declared, unused, purely so `mock.calls` is typed as the
// fetch argument tuple: `vi.fn(async () => …)` infers a zero-length tuple and
// every `mock.calls[0][0]` assertion below then fails `tsc --noEmit`, which is
// this package's `build`.
function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status, headers: { "content-type": "application/json" } }));
}

describe("JMAP client", () => {
  it("discovers the api url and the mail account from the session", async () => {
    const f = fakeFetch(SESSION);
    const s = await openSession("https://mail.example.nl", "tok", f as never);
    expect(s.apiUrl).toBe("https://mail.example.nl/jmap/api");
    expect(s.accountId).toBe("acct-1");
    expect(f.mock.calls[0][0]).toBe("https://mail.example.nl/.well-known/jmap");
  });

  it("sends the bearer token and returns method responses in order", async () => {
    const f = fakeFetch({ methodResponses: [["Email/changes", { newState: "s2" }, "c0"]] });
    const s = { apiUrl: "https://x/api", downloadUrl: "", accountId: "a" };
    const [r] = await call<{ newState: string }>(
      s, "tok", ["urn:ietf:params:jmap:mail"], [["Email/changes", {}, "c0"]], f as never);
    expect(r.newState).toBe("s2");
    const init = f.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  // The download URL is a TEMPLATE. Substituting it wrong yields a 404 that
  // looks like a missing message rather than a client bug.
  it("substitutes every placeholder in the download template", async () => {
    const f = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(Buffer.from("raw-bytes"), { status: 200 }));
    const s = { apiUrl: "", downloadUrl: SESSION.downloadUrl, accountId: "acct-1" };
    const b = await download(s, "tok", "blob-9", "raw.eml", "message/rfc822", f as never);
    expect(b.toString()).toBe("raw-bytes");
    expect(f.mock.calls[0][0]).toBe(
      "https://mail.example.nl/jmap/download/acct-1/blob-9/raw.eml?accept=message%2Frfc822");
  });

  it("throws with the status on a failed call rather than returning undefined", async () => {
    const f = fakeFetch("nope", 401);
    const s = { apiUrl: "https://x/api", downloadUrl: "", accountId: "a" };
    await expect(call(s, "bad", [], [], f as never)).rejects.toThrow(/401/);
  });

  // RFC 8620 §3.6.1: a FAILED method call comes back INSIDE a 200 OK as
  // ["error", {type}, callId]. Mapping every response to its args without
  // reading the name hands that error object to the caller typed as success,
  // which dies later as an unrelated TypeError ("r.created is not iterable")
  // and turns every diagnosable fault — bad token scope, unknown capability,
  // over quota — into a mystery.
  it("throws on a JMAP-level error response rather than returning it as success", async () => {
    const f = fakeFetch({ methodResponses: [
      ["error", { type: "invalidArguments", description: "sinceState is not valid" }, "c0"],
    ] });
    const s = { apiUrl: "https://x/api", downloadUrl: "", accountId: "a" };
    await expect(call(s, "tok", [MAIL], [["Email/changes", {}, "c0"]], f as never))
      .rejects.toThrow(/invalidArguments/);
  });

  // The poll layer has to recognise cannotCalculateChanges SPECIFICALLY (it
  // means: drop the cursor and resync), so the type must be readable as data,
  // never scraped out of a message string.
  it("carries the JMAP error type and call id as data, and in the message", async () => {
    const f = fakeFetch({ methodResponses: [
      ["error", { type: "cannotCalculateChanges" }, "c1"],
    ] });
    const s = { apiUrl: "https://x/api", downloadUrl: "", accountId: "a" };
    const err = await call(s, "tok", [MAIL], [["Email/changes", {}, "c1"]], f as never)
      .then(() => null, (e: unknown) => e) as { jmapType?: string; callId?: string };
    expect(err).toBeTruthy();
    expect(err.jmapType).toBe("cannotCalculateChanges");
    expect(err.callId).toBe("c1");
    // worker_runs.detail stores String(err); the type and the call id must be
    // legible there without a debugger.
    expect(String(err)).toMatch(/cannotCalculateChanges/);
    expect(String(err)).toMatch(/c1/);
    expect(client.isJmapMethodError(err, "cannotCalculateChanges")).toBe(true);
    expect(client.isJmapMethodError(err, "invalidArguments")).toBe(false);
    expect(client.isJmapMethodError(new Error("nope"))).toBe(false);
  });

  // Email/query + Email/get travel in ONE request: an error on the second call
  // is the normal shape of a failure, so checking only the first response is
  // the same bug with an extra step.
  it("checks every method response, not only the first", async () => {
    const f = fakeFetch({ methodResponses: [
      ["Email/query", { ids: ["m1"] }, "c0"],
      ["error", { type: "requestTooLarge" }, "c1"],
    ] });
    const s = { apiUrl: "https://x/api", downloadUrl: "", accountId: "a" };
    await expect(call(s, "tok", [MAIL], [
      ["Email/query", {}, "c0"], ["Email/get", {}, "c1"],
    ], f as never)).rejects.toThrow(/requestTooLarge/);
  });

  // `const [r] = []` is undefined and dies as a TypeError somewhere else
  // entirely. A short response array is a protocol fault and must say so here.
  it("throws when the server returns fewer responses than method calls", async () => {
    const f = fakeFetch({ methodResponses: [["Email/query", { ids: [] }, "c0"]] });
    const s = { apiUrl: "https://x/api", downloadUrl: "", accountId: "a" };
    await expect(call(s, "tok", [MAIL], [
      ["Email/query", {}, "c0"], ["Email/get", {}, "c1"],
    ], f as never)).rejects.toThrow(/2 method call/);
  });

  // String.replace with a string pattern replaces the FIRST occurrence only.
  // RFC 8620 puts no once-only constraint on downloadUrl, and a half-substituted
  // URL 404s in a way that reads as a missing message.
  it("substitutes a placeholder that appears more than once", async () => {
    const f = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(Buffer.from("raw-bytes"), { status: 200 }));
    const s = {
      apiUrl: "",
      downloadUrl: "https://h/{accountId}/{blobId}?a={accountId}&n={name}&n2={name}",
      accountId: "acct-1",
    };
    await download(s, "tok", "blob-9", "raw.eml", "message/rfc822", f as never);
    expect(f.mock.calls[0][0]).toBe(
      "https://h/acct-1/blob-9?a=acct-1&n=raw.eml&n2=raw.eml");
  });

  // The header value is ONE injectable thing, which is what let the settled
  // scheme (Basic, below) land as a new factory rather than an edit in three
  // functions. A bare token string still means Bearer, so no caller changed.
  it("takes the authorization header value as one injectable thing", async () => {
    const s = { apiUrl: "https://x/api", downloadUrl: "https://h/{blobId}", accountId: "a" };
    expect(client.bearer("tok").authorization).toBe("Bearer tok");

    const f = fakeFetch({ methodResponses: [["Email/get", { list: [] }, "c0"]] });
    await call(s, { authorization: "Scheme-Under-Discussion abc" }, [MAIL],
      [["Email/get", {}, "c0"]], f as never);
    expect(((f.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Authorization)
      .toBe("Scheme-Under-Discussion abc");

    const g = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(Buffer.from("x"), { status: 200 }));
    await download(s, { authorization: "Scheme-Under-Discussion abc" },
      "b1", "raw.eml", "message/rfc822", g as never);
    expect(((g.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Authorization)
      .toBe("Scheme-Under-Discussion abc");

    const h = fakeFetch(SESSION);
    await openSession("https://mail.example.nl",
      { authorization: "Scheme-Under-Discussion abc" }, h as never);
    expect(((h.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Authorization)
      .toBe("Scheme-Under-Discussion abc");
  });

  // SETTLED: the scheme is HTTP Basic with a Stalwart APP PASSWORD, not OAuth.
  // Stalwart's default access-token lifetime is 1 h, and raising it server-wide
  // to 90 d only moves a silent ingestion death to day 91; an app password does
  // not expire and is individually revocable.
  it("builds an RFC 7617 Basic credential and sends it on every request", async () => {
    // RFC 7617 §2's own worked example, so the expectation is the spec's and
    // not a second copy of the implementation.
    expect(client.basic("Aladdin", "open sesame").authorization)
      .toBe("Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==");

    const cred = client.basic("verder@vanderpoel.pro", "app-password");
    const s = { apiUrl: "https://x/api", downloadUrl: "https://h/{blobId}", accountId: "a" };

    const f = fakeFetch({ methodResponses: [["Email/get", { list: [] }, "c0"]] });
    await call(s, cred, [MAIL], [["Email/get", {}, "c0"]], f as never);
    expect(((f.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Authorization)
      .toBe(cred.authorization);

    const g = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(Buffer.from("x"), { status: 200 }));
    await download(s, cred, "b1", "raw.eml", "message/rfc822", g as never);
    expect(((g.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Authorization)
      .toBe(cred.authorization);

    const h = fakeFetch(SESSION);
    await openSession("https://mail.example.nl", cred, h as never);
    expect(((h.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Authorization)
      .toBe(cred.authorization);

    // A bare string still means Bearer, so no existing call site changes.
    expect(client.bearer("tok").authorization).toBe("Bearer tok");
  });

  // RFC 7617: only the FIRST colon separates, so a colon inside the app password
  // is legal and must survive verbatim — and the credentials are UTF-8, so a
  // latin1 encode would mangle a non-ASCII password into a 401 nobody can read.
  it("keeps a colon in the app password and encodes the credentials as UTF-8", () => {
    const user = "verder@vanderpoel.pro";
    const pass = "pa:ss:woord-ë-ü-☂";
    const header = client.basic(user, pass).authorization;
    const bytes = Buffer.from(header.slice("Basic ".length), "base64");

    expect(bytes.toString("utf8")).toBe(`${user}:${pass}`);
    // Everything after the first colon is the password, colons included.
    const decoded = bytes.toString("utf8");
    expect(decoded.slice(decoded.indexOf(":") + 1)).toBe(pass);
    // latin1 would spend ONE byte on ë; the utf8 decode above would then read
    // back U+FFFD and this length check is what names the cause.
    expect(bytes.length).toBe(Buffer.byteLength(`${user}:${pass}`, "utf8"));
  });

  // A colon in the USERID is not encodable: the server splits at the first one
  // and would authenticate as a different (shorter) user with a longer password.
  // Refuse it at the factory rather than send a credential that cannot be parsed.
  it("refuses a userid containing a colon instead of sending an ambiguous credential", () => {
    expect(() => client.basic("who:ami", "app-password")).toThrow(/colon/i);
    // The refusal itself must not carry the secret.
    const err = ((): unknown => { try { client.basic("who:ami", "app-password"); }
      catch (e) { return e; } return null; })();
    expect(String(err)).not.toContain("app-password");
  });

  // Every message thrown here lands in worker_runs.detail, which the dashboard
  // renders and the nightly dump writes to the NAS. An app password reaching a
  // persisted run row is a real leak, and app passwords do not expire.
  it("never leaks the credential into an error message", async () => {
    const pass = "s3cr3t:app-wachtwoord-ë";
    const cred = client.basic("verder@vanderpoel.pro", pass);
    const encoded = cred.authorization.slice("Basic ".length);
    const s = { apiUrl: "https://x/api", downloadUrl: "https://h/{blobId}", accountId: "a" };

    const errors = await Promise.all([
      // transport failure on the api endpoint
      call(s, cred, [], [], fakeFetch("nope", 401) as never),
      // transport failure on the session endpoint
      openSession("https://mail.example.nl", cred, fakeFetch("nope", 403) as never),
      // transport failure on a blob download
      download(s, cred, "b1", "raw.eml", "message/rfc822", fakeFetch("nope", 404) as never),
      // a JMAP-level method error inside a 200 OK
      call(s, cred, [MAIL], [["Email/changes", {}, "c0"]], fakeFetch({ methodResponses: [
        ["error", { type: "invalidArguments", description: "sinceState is not valid" }, "c0"],
      ] }) as never),
      // a short response array
      call(s, cred, [MAIL], [["Email/query", {}, "c0"], ["Email/get", {}, "c1"]],
        fakeFetch({ methodResponses: [["Email/query", { ids: [] }, "c0"]] }) as never),
      // a session without a mail account
      openSession("https://mail.example.nl", cred,
        fakeFetch({ ...SESSION, primaryAccounts: {} }) as never),
    ].map((p) => p.then(() => null, (e: unknown) => e)));

    for (const err of errors) {
      expect(err).toBeTruthy();
      const e = err as Error;
      const text = [e.message, String(e), e.stack ?? "",
        JSON.stringify(e, Object.getOwnPropertyNames(e))].join("\n");
      expect(text).not.toContain(pass);
      expect(text).not.toContain(encoded);
      expect(text).not.toContain(cred.authorization);
    }
  });
});
