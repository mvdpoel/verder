import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MailEnvError, mailEnvFrom, openMailPort } from "./from-env";

/**
 * THE ONLY TEST IN THIS DIRECTORY THAT SPEAKS HTTP, and that is the whole point
 * of the file.
 *
 * Every other mail test injects a fake `fetch` or a fake `call`/`download`, so
 * the suite went fully green while the three things that actually break a
 * deployment had never once been executed: whether the credential reaches the
 * wire as a header a server accepts, whether the base URL joins into a path a
 * server routes, and whether the downloadUrl template gets substituted before
 * it is dialled. A mocked fetch answers all three "yes" by construction.
 *
 * So this file stands up a REAL `node:http` server on port 0 and drives the
 * real `openSession`/`call`/`download` against it. It asserts on what the
 * SERVER SAW — the Authorization header, the request path, the substituted
 * download URL — because that is the only side of the wire a mock cannot forge.
 *
 * The expected Authorization value is computed here from the user and password
 * directly, NEVER by calling `basic()`: a test that builds the header with the
 * same function the code under test uses agrees with itself no matter what
 * either one does.
 */

const USER = "martin@vanderpoel.pro";
// A colon inside the app password is legal (RFC 7617 splits at the FIRST one
// only) and Stalwart's generated passwords are opaque, so the fixture carries
// one: a credential path that split on every colon would authenticate as a
// different password and this server would answer 401.
const PASSWORD = "app_2f8c:secret";
const EXPECTED_AUTH = `Basic ${Buffer.from(`${USER}:${PASSWORD}`, "utf8").toString("base64")}`;
const ACCOUNT = "acct-mail-1";

const RAW = Buffer.from("From: incasso@example.nl\r\nSubject: Aanmaning\r\n\r\nbody\r\n", "utf8");
const ATT = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"

const EMAIL = {
  id: "e1", threadId: "t1", blobId: "blob-raw",
  subject: "Aanmaning",
  sentAt: "2026-08-12T09:00:00Z",
  receivedAt: "2026-08-12T09:00:05Z",
  from: [{ email: "incasso@example.nl" }],
  to: [{ email: USER }],
  textBody: [{ partId: "1" }],
  bodyValues: { "1": { value: "body" } },
  attachments: [{
    name: "aanmaning.pdf", type: "application/pdf",
    disposition: "attachment", cid: null, blobId: "blob-att",
  }],
};

interface Seen { method: string; path: string; auth: string | undefined }
const seen: Seen[] = [];
let server: Server;
let base = "";

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: Buffer | string, type: string): void {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = req.url ?? "";
  const auth = req.headers.authorization;
  seen.push({ method: req.method ?? "", path, auth });

  // EVERY request, not only the session: the download is a separate HTTP call
  // made by separate code, and a credential threaded correctly into openSession
  // and dropped on the way to download() is exactly the shape of bug a mocked
  // fetch cannot see.
  if (auth !== EXPECTED_AUTH) return send(res, 401, '{"error":"unauthorized"}', "application/json");

  if (req.method === "GET" && path === "/.well-known/jmap") {
    return send(res, 200, JSON.stringify({
      apiUrl: `${base}/jmap/api`,
      // A real RFC 8620 template. If the port shipped this string unsubstituted
      // the request below lands on a path holding literal braces and this
      // server 404s it.
      downloadUrl: `${base}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
      primaryAccounts: { "urn:ietf:params:jmap:mail": ACCOUNT },
    }), "application/json");
  }

  if (req.method === "POST" && path === "/jmap/api") {
    const body = JSON.parse(await readBody(req)) as { methodCalls: [string, unknown, string][] };
    return send(res, 200, JSON.stringify({
      methodResponses: body.methodCalls.map(([, , callId]) =>
        ["Email/get", { accountId: ACCOUNT, state: "s1", list: [EMAIL] }, callId]),
    }), "application/json");
  }

  if (req.method === "GET" && path.startsWith("/jmap/download/")) {
    const [, , , account, blobId] = new URL(path, base).pathname.split("/");
    if (account !== ACCOUNT) return send(res, 404, "wrong account", "text/plain");
    if (blobId === "blob-raw") return send(res, 200, RAW, "message/rfc822");
    if (blobId === "blob-att") return send(res, 200, ATT, "application/pdf");
    return send(res, 404, "no such blob", "text/plain");
  }

  send(res, 404, "not found", "text/plain");
}

beforeAll(async () => {
  server = createServer((req, res) => {
    handle(req, res).catch(() => send(res, 500, "test server fault", "text/plain"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(() => { seen.length = 0; });

/** A plain object, never `process.env`: these tests run in the same process as
 *  relevance.test.ts, which reads JMAP_USER out of the real environment. */
function envWith(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { JMAP_BASE_URL: base, JMAP_USER: USER, JMAP_APP_PASSWORD: PASSWORD, ...over };
}

describe("openMailPort against a real server", () => {
  it("authenticates with HTTP Basic, not a bearer token", async () => {
    await openMailPort(envWith());

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].path).toBe("/.well-known/jmap");
    expect(seen[0].auth).toBe(EXPECTED_AUTH);
    // The two ways the credential has actually gone wrong: threaded as a bearer
    // token (the retired JMAP_TOKEN shape), or interpolated as an object.
    expect(seen[0].auth).not.toMatch(/^Bearer /);
    expect(seen[0].auth).not.toContain("[object Object]");
  });

  it("fails loudly when the app password is wrong", async () => {
    // Proves the assertion above is worth something: this server really does
    // refuse a credential it does not recognise, so a passing auth test is a
    // statement about the header and not about a permissive fake.
    await expect(openMailPort(envWith({ JMAP_APP_PASSWORD: "not-the-password" })))
      .rejects.toThrow(/401/);
  });

  it("substitutes the download template and carries the credential into it", async () => {
    const port = await openMailPort(envWith());
    const msg = await port.getMessage("e1");

    expect(msg.raw.equals(RAW)).toBe(true);
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0].filename).toBe("aanmaning.pdf");
    expect(msg.attachments[0].data.equals(ATT)).toBe(true);
    expect(msg.subject).toBe("Aanmaning");
    expect(msg.from).toBe("incasso@example.nl");

    // Every placeholder resolved, with the account id the SESSION named rather
    // than anything the caller knew.
    const downloads = seen.filter((s) => s.path.startsWith("/jmap/download/"));
    expect(downloads.map((s) => s.path)).toEqual([
      `/jmap/download/${ACCOUNT}/blob-att/aanmaning.pdf?type=application%2Fpdf`,
      `/jmap/download/${ACCOUNT}/blob-raw/raw.eml?type=message%2Frfc822`,
    ]);
    expect(seen.map((s) => s.auth)).toEqual(seen.map(() => EXPECTED_AUTH));
    expect(seen.some((s) => s.path.includes("{"))).toBe(false);
  });

  // `openSession` concatenates `${base}/.well-known/jmap`, so a JMAP_BASE_URL
  // copied out of a browser bar with its trailing slash produces `//.well-known`
  // — a path a strict router 404s, and this server is one.
  it("tolerates a trailing slash on JMAP_BASE_URL", async () => {
    const port = await openMailPort(envWith({ JMAP_BASE_URL: `${base}/` }));
    const msg = await port.getMessage("e1");

    expect(seen[0].path).toBe("/.well-known/jmap");
    expect(seen.some((s) => s.path.startsWith("//"))).toBe(false);
    expect(msg.id).toBe("e1");
  });
});

describe("mailEnvFrom", () => {
  it("names every missing variable at once", () => {
    // One at a time is the slow path: an operator learns about JMAP_USER only
    // after a deploy cycle spent fixing JMAP_BASE_URL.
    const err = (() => {
      try { mailEnvFrom({}); return null; } catch (e) { return e as Error; }
    })();
    expect(err).toBeInstanceOf(MailEnvError);
    expect(err!.message).toContain("JMAP_BASE_URL");
    expect(err!.message).toContain("JMAP_USER");
    expect(err!.message).toContain("JMAP_APP_PASSWORD");
  });

  it("refuses a missing app password without naming any value", async () => {
    await expect(openMailPort(envWith({ JMAP_APP_PASSWORD: undefined })))
      .rejects.toBeInstanceOf(MailEnvError);
    // and it refuses BEFORE dialling: no request was made with half a credential.
    expect(seen).toHaveLength(0);

    let message = "";
    try { mailEnvFrom(envWith({ JMAP_APP_PASSWORD: undefined })); } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("JMAP_APP_PASSWORD");
    // Every throw in this path can reach worker_runs.detail, which the
    // dashboard renders and the nightly dump writes off-box.
    expect(message).not.toContain(USER);
    expect(message).not.toContain(base);
  });

  it("treats an empty-string JMAP_USER as missing", () => {
    // `??` does not fire on "", and a bare `JMAP_USER=` line is far more common
    // than an absent one — see ownMailboxAddresses. An empty user would
    // otherwise authenticate as nobody.
    expect(() => mailEnvFrom(envWith({ JMAP_USER: "" }))).toThrow(MailEnvError);
    expect(() => mailEnvFrom(envWith({ JMAP_USER: "   " }))).toThrow(/JMAP_USER/);
  });

  it("does not read the retired JMAP_TOKEN", () => {
    expect(() => mailEnvFrom({ JMAP_BASE_URL: base, JMAP_TOKEN: "t" }))
      .toThrow(/JMAP_USER/);
  });

  it("strips exactly one trailing slash", () => {
    expect(mailEnvFrom(envWith({ JMAP_BASE_URL: "http://stalwart:8080/" })).baseUrl)
      .toBe("http://stalwart:8080");
    expect(mailEnvFrom(envWith({ JMAP_BASE_URL: "http://stalwart:8080" })).baseUrl)
      .toBe("http://stalwart:8080");
  });
});
