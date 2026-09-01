# Mail phase 1 — Stalwart at home, verder reading over JMAP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get mail flowing into the dossier again by standing up Stalwart on the homelab, importing the Gmail archive into it, and having the worker ingest over JMAP instead of the Gmail API.

**Architecture:** Stalwart runs as a fourth compose service on the homelab with its metadata store and its blob store both on `/mnt/data` — local ext4 on NVMe with 342 GB free. They stay two settable paths, but in phase 1 they point at the same local volume. A new `MailPort` interface replaces the query-based `GmailPort` with a cursor-based `changedSince(cursor)`, which is what JMAP's `Email/changes` actually offers. `pollMail` reuses the existing `ingestRawEmail` transaction wholesale, so evidence handling, the vault write and the outbox repair are unchanged. Nothing here appends a ledger event.

**Tech Stack:** TypeScript, Node 22, pnpm 10, Drizzle, pg-boss, vitest, Docker Compose, Stalwart Mail Server, Vandelay (JMAP migration CLI), Google Takeout.

**Spec:** `docs/superpowers/specs/2026-08-29-mail-architecture-design.md`

## Global Constraints

- Phase 1 touches **no MX record and no DNS** for mail. Delivery keeps going to Gmail throughout.
- **NEVER put Stalwart's metadata store on NFS.** Both stores live on `/mnt/data` (local NVMe, 342 GB free), so the rule is never approached rather than merely respected. `/` has only 40 GB free and is not the volume for this.
- **Never rewrite a historical `raw_emails.gmail_message_id`.** It is also `documents.source_ref`, and the case map's third level derives from it.
- Evidence tables stay append-only. This work appends **zero** `ledger_events` rows; `nightly-verify`'s chain head must be unchanged after every deploy.
- Run all builds and tests with `env -u NODE_ENV` — the shell exports `NODE_ENV=development`, which breaks `next build`.
- Worker tests need the dev postgres (`docker compose up -d postgres`) and poppler (`brew install poppler`).
- Deploy sync is the canonical rsync with the full exclude list from `docs/deploy.md`; always `--dry-run --info=del` first and read every `deleting` line.
- Migrations run from the homelab HOST **before** the new images are deployed.
- JMAP is HTTPS and may ride the Cloudflare tunnel. SMTP may not, and phase 1 configures no SMTP listener at all.

---

### Task 1: `raw_emails.source` discriminator

**Files:**
- Create: `packages/db/migrations/0028_raw_emails_source.sql`
- Modify: `packages/db/src/schema.ts` (the `rawEmails` table)
- Test: `packages/db/src/raw-emails-source.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `rawEmails.source` — a `text` column, `NOT NULL DEFAULT 'gmail'`, values `'gmail' | 'jmap'`. Task 5 writes `'jmap'`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/raw-emails-source.test.ts
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client";

const URL = "postgres://verder:verder@localhost:5432/verder";

describe("raw_emails.source", () => {
  it("defaults existing rows to gmail so no historical id is rewritten", async () => {
    const { db, pool } = createDb(URL);
    const r = await db.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'raw_emails' AND column_name = 'source'`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].is_nullable).toBe("NO");
    expect(String(r.rows[0].column_default)).toContain("gmail");
    await pool.end();
  });

  it("accepts jmap and rejects anything else", async () => {
    const { db, pool } = createDb(URL);
    await expect(db.execute(sql`
      INSERT INTO raw_emails (gmail_message_id, gmail_thread_id, from_addr, to_addr,
        subject, sent_at, raw_rfc822_sha256, body_text, source)
      VALUES ('t-bad', 't', 'a@b.nl', 'c@d.nl', 's', now(), 'h', '', 'imap')`))
      .rejects.toThrow();
    await pool.end();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/db && env -u NODE_ENV npx vitest run src/raw-emails-source.test.ts`
Expected: FAIL — first test gets 0 rows because the column does not exist.

- [ ] **Step 3: Write the migration and the schema column**

```sql
-- packages/db/migrations/0028_raw_emails_source.sql
-- Additive and defaulted: every existing row is Gmail-sourced, and its
-- gmail_message_id stays exactly as it is. That column is also
-- documents.source_ref and the case map's third level derives from it, so it
-- is never rewritten — only labelled.
ALTER TABLE raw_emails
  ADD COLUMN source text NOT NULL DEFAULT 'gmail';

ALTER TABLE raw_emails
  ADD CONSTRAINT raw_emails_source_check CHECK (source IN ('gmail', 'jmap'));
```

```ts
// packages/db/src/schema.ts — inside pgTable("raw_emails", { ... })
  source: text("source").notNull().default("gmail"),
```

- [ ] **Step 4: Apply and run the tests**

Run:
```bash
env -u NODE_ENV pnpm --filter @verder/db migrate
cd packages/db && env -u NODE_ENV npx vitest run src/raw-emails-source.test.ts
```
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/0028_raw_emails_source.sql packages/db/src/schema.ts packages/db/src/raw-emails-source.test.ts
git commit -m "feat(db): label a raw email's source without touching its id"
```

---

### Task 2: The `MailPort` interface and the cursor store

**Files:**
- Create: `apps/worker/src/mail/port.ts`
- Create: `apps/worker/src/mail/cursor.ts`
- Test: `apps/worker/src/mail/cursor.test.ts`

**Interfaces:**
- Consumes: `recordRun` from `apps/worker/src/heartbeat.ts`, `schema.workerRuns`.
- Produces:
  - `interface MailMessage` — same shape as `GmailMessage` (`id, threadId, from, to, subject, sentAt, bodyText, raw, attachments, skippedParts?`).
  - `interface MailPort { changedSince(cursor: string | null): Promise<{ ids: string[]; cursor: string }>; getMessage(id: string): Promise<MailMessage> }`
  - `readCursor(db: Db, worker: string): Promise<string | null>`
  - `writeCursor(db: Db, worker: string, cursor: string, detail: object): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// apps/worker/src/mail/cursor.test.ts
import { describe, expect, it } from "vitest";
import { createDb } from "@verder/db";
import { readCursor, writeCursor } from "./cursor";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("JMAP cursor", () => {
  it("is null before the first run, so the first poll is a full sync", async () => {
    const { db, pool } = createDb(URL);
    expect(await readCursor(db, `never-run-${Date.now()}`)).toBeNull();
    await pool.end();
  });

  it("round-trips the newest cursor and ignores older runs", async () => {
    const { db, pool } = createDb(URL);
    const w = `cursor-test-${Date.now()}`;
    await writeCursor(db, w, "state-1", { ingested: 0 });
    await writeCursor(db, w, "state-2", { ingested: 3 });
    expect(await readCursor(db, w)).toBe("state-2");
    await pool.end();
  });

  // THE TRAP that bit gmail's retryAfter: readCursor takes the LATEST run, so a
  // run that forgets to carry the cursor forward silently resets the sync to
  // full and re-ingests everything.
  it("survives a run that recorded no cursor", async () => {
    const { db, pool } = createDb(URL);
    const w = `cursor-gap-${Date.now()}`;
    await writeCursor(db, w, "state-1", { ingested: 1 });
    await writeCursor(db, w, "state-1", { skipped: "nothing to do" });
    expect(await readCursor(db, w)).toBe("state-1");
    await pool.end();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && env -u NODE_ENV npx vitest run src/mail/cursor.test.ts`
Expected: FAIL — `Cannot find module './cursor'`.

- [ ] **Step 3: Write the interface and the cursor store**

```ts
// apps/worker/src/mail/port.ts
/** A message the port refused to promote to a document — see isInlineBodyImage. */
export interface SkippedPart { filename: string; mime: string; contentId: string | null }

export interface MailMessage {
  id: string; threadId: string; from: string; to: string; subject: string;
  sentAt: Date; bodyText: string; raw: Buffer;
  attachments: { filename: string; mime: string; data: Buffer }[];
  skippedParts?: SkippedPart[];
}

/**
 * Discovery is CURSOR-based, not query-based.
 *
 * Gmail forced a time window (`newer_than:7d`) because its list API has no
 * delta. JMAP's `Email/changes` returns exactly what changed since a state
 * string, which is why the whole class of bug fixed on 2026-08-29 — re-fetching
 * the same unchanged messages forever — cannot be written here.
 */
export interface MailPort {
  changedSince(cursor: string | null): Promise<{ ids: string[]; cursor: string }>;
  getMessage(id: string): Promise<MailMessage>;
}
```

```ts
// apps/worker/src/mail/cursor.ts
import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { recordRun } from "../heartbeat";

/**
 * The JMAP state string from the latest run of `worker`, or null for a first
 * sync. No new table for one string — worker_runs already carries per-run
 * detail, the same place gmail's retryAfter lives.
 */
export async function readCursor(db: Db, worker: string): Promise<string | null> {
  const [last] = await db.select({ detail: schema.workerRuns.detail })
    .from(schema.workerRuns).where(eq(schema.workerRuns.worker, worker))
    .orderBy(desc(schema.workerRuns.ranAt)).limit(1);
  const raw = (last?.detail as { cursor?: unknown } | null)?.cursor;
  return typeof raw === "string" ? raw : null;
}

/**
 * Record a run CARRYING THE CURSOR FORWARD. Every run must pass the cursor it
 * ended on, including a no-op run: readCursor takes the latest row, so a run
 * that drops it resets the sync to full and re-ingests the whole mailbox.
 */
export async function writeCursor(
  db: Db, worker: string, cursor: string, detail: object,
): Promise<void> {
  await recordRun(db, worker, "ok", { ...detail, cursor });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && env -u NODE_ENV npx vitest run src/mail/cursor.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/mail/port.ts apps/worker/src/mail/cursor.ts apps/worker/src/mail/cursor.test.ts
git commit -m "feat(worker): a cursor-based mail port interface and its state store"
```

---

### Task 3: The JMAP client

**Files:**
- Create: `apps/worker/src/mail/jmap-client.ts`
- Test: `apps/worker/src/mail/jmap-client.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface JmapSession { apiUrl: string; downloadUrl: string; accountId: string }`
  - `openSession(base: string, token: string, fetchFn?: typeof fetch): Promise<JmapSession>`
  - `call<T>(s: JmapSession, token: string, using: string[], calls: unknown[][], fetchFn?): Promise<T[]>`
  - `download(s: JmapSession, token: string, blobId: string, name: string, type: string, fetchFn?): Promise<Buffer>`

- [ ] **Step 1: Write the failing test**

```ts
// apps/worker/src/mail/jmap-client.test.ts
import { describe, expect, it, vi } from "vitest";
import { call, download, openSession } from "./jmap-client";

const SESSION = {
  apiUrl: "https://mail.example.nl/jmap/api",
  downloadUrl: "https://mail.example.nl/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-1" },
};

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(
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
    const f = vi.fn(async () => new Response(Buffer.from("raw-bytes"), { status: 200 }));
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && env -u NODE_ENV npx vitest run src/mail/jmap-client.test.ts`
Expected: FAIL — `Cannot find module './jmap-client'`.

- [ ] **Step 3: Write the client**

```ts
// apps/worker/src/mail/jmap-client.ts
export interface JmapSession { apiUrl: string; downloadUrl: string; accountId: string }

const MAIL = "urn:ietf:params:jmap:mail";

async function ok(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`JMAP ${what} failed: ${res.status} ${res.statusText}`);
  return res;
}

export async function openSession(
  base: string, token: string, fetchFn: typeof fetch = fetch,
): Promise<JmapSession> {
  const res = await ok(await fetchFn(`${base}/.well-known/jmap`, {
    headers: { Authorization: `Bearer ${token}` },
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
 */
export async function call<T>(
  s: JmapSession, token: string, using: string[], calls: unknown[][],
  fetchFn: typeof fetch = fetch,
): Promise<T[]> {
  const res = await ok(await fetchFn(s.apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ using, methodCalls: calls }),
  }), "api");
  const body = await res.json() as { methodResponses: [string, T, string][] };
  return body.methodResponses.map(([, args]) => args);
}

/** downloadUrl is a URI template; every placeholder must be substituted. */
export async function download(
  s: JmapSession, token: string, blobId: string, name: string, type: string,
  fetchFn: typeof fetch = fetch,
): Promise<Buffer> {
  const url = s.downloadUrl
    .replace("{accountId}", encodeURIComponent(s.accountId))
    .replace("{blobId}", encodeURIComponent(blobId))
    .replace("{name}", encodeURIComponent(name))
    .replace("{type}", encodeURIComponent(type));
  const res = await ok(await fetchFn(url, {
    headers: { Authorization: `Bearer ${token}` },
  }), "download");
  return Buffer.from(await res.arrayBuffer());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && env -u NODE_ENV npx vitest run src/mail/jmap-client.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/mail/jmap-client.ts apps/worker/src/mail/jmap-client.test.ts
git commit -m "feat(worker): a minimal JMAP client — session, calls, blob download"
```

---

### Task 4: `JmapPort`

**Files:**
- Create: `apps/worker/src/mail/jmap-port.ts`
- Test: `apps/worker/src/mail/jmap-port.test.ts`

**Interfaces:**
- Consumes: `MailPort`, `MailMessage`, `SkippedPart` from Task 2; `JmapSession`, `call`, `download` from Task 3.
- Produces: `makeJmapPort(deps: { session, token, call, download }): MailPort` and `isInlineBodyImage(a: JmapAttachment): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/worker/src/mail/jmap-port.test.ts
import { describe, expect, it, vi } from "vitest";
import { isInlineBodyImage, makeJmapPort } from "./jmap-port";

const S = { apiUrl: "https://x/api", downloadUrl: "d", accountId: "a" };

describe("isInlineBodyImage", () => {
  // Same rule as the Gmail port: image/* AND inline AND a cid. macOS Mail marks
  // EVERY attachment inline, so disposition alone would drop a mailed
  // Beschikking.pdf unrecoverably.
  it("skips a cid image the body embeds", () => {
    expect(isInlineBodyImage({ name: "logo.png", type: "image/png", disposition: "inline", cid: "x@y", blobId: "b" })).toBe(true);
  });
  it("keeps an inline PDF, because only images are body furniture", () => {
    expect(isInlineBodyImage({ name: "Beschikking.pdf", type: "application/pdf", disposition: "inline", cid: "x@y", blobId: "b" })).toBe(false);
  });
  it("keeps an image with no cid — a pasted screenshot is a real attachment", () => {
    expect(isInlineBodyImage({ name: "image.png", type: "image/png", disposition: "inline", cid: null, blobId: "b" })).toBe(false);
  });
  it("keeps anything with missing metadata rather than guessing it away", () => {
    expect(isInlineBodyImage({ name: "x", type: null, disposition: null, cid: null, blobId: "b" })).toBe(false);
  });
});

describe("JmapPort", () => {
  it("returns created and updated ids plus the new cursor", async () => {
    const call = vi.fn(async () => [{
      newState: "s2", created: ["e1"], updated: ["e2"], destroyed: ["e3"] }]);
    const port = makeJmapPort({ session: S, token: "t", call: call as never, download: vi.fn() as never });
    const r = await port.changedSince("s1");
    expect(r.ids).toEqual(["e1", "e2"]);   // destroyed is not ingestable
    expect(r.cursor).toBe("s2");
  });

  it("downloads the raw message and every non-inline attachment", async () => {
    const call = vi.fn(async () => [{ list: [{
      id: "e1", threadId: "t1", blobId: "raw-blob", subject: "Stukken",
      receivedAt: "2026-08-01T10:00:00Z",
      from: [{ email: "case@verdergroep.nl" }], to: [{ email: "martin@vanderpoel.pro" }],
      bodyValues: { "1": { value: "Beste Martin" } },
      textBody: [{ partId: "1" }],
      attachments: [
        { name: "checklist.pdf", type: "application/pdf", disposition: "attachment", cid: null, blobId: "b1" },
        { name: "logo.png", type: "image/png", disposition: "inline", cid: "c@d", blobId: "b2" },
      ] }] }]);
    const download = vi.fn(async (_s, _t, blobId) => Buffer.from(`bytes-${blobId}`));
    const port = makeJmapPort({ session: S, token: "t", call: call as never, download: download as never });
    const m = await port.getMessage("e1");
    expect(m.from).toBe("case@verdergroep.nl");
    expect(m.raw.toString()).toBe("bytes-raw-blob");
    expect(m.attachments.map((a) => a.filename)).toEqual(["checklist.pdf"]);
    expect(m.skippedParts?.map((p) => p.filename)).toEqual(["logo.png"]);
    expect(m.bodyText).toBe("Beste Martin");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && env -u NODE_ENV npx vitest run src/mail/jmap-port.test.ts`
Expected: FAIL — `Cannot find module './jmap-port'`.

- [ ] **Step 3: Write the port**

```ts
// apps/worker/src/mail/jmap-port.ts
import type { JmapSession } from "./jmap-client";
import type { MailMessage, MailPort, SkippedPart } from "./port";

const MAIL = "urn:ietf:params:jmap:mail";

export interface JmapAttachment {
  name: string | null; type: string | null;
  disposition: string | null; cid: string | null; blobId: string;
}

/**
 * An image the HTML body embeds by cid is furniture, not a document.
 *
 * All THREE conditions are required. macOS and iOS Mail mark every attachment
 * inline and give each a Content-Id, so disposition alone would silently drop a
 * mailed Beschikking.pdf — and a skipped part never becomes a document, never
 * reaches the queue and is not recoverable by re-polling.
 */
export function isInlineBodyImage(a: JmapAttachment): boolean {
  return (a.type ?? "").startsWith("image/")
    && a.disposition === "inline"
    && !!a.cid;
}

interface Deps {
  session: JmapSession;
  token: string;
  call: <T>(s: JmapSession, token: string, using: string[], calls: unknown[][]) => Promise<T[]>;
  download: (s: JmapSession, token: string, blobId: string, name: string, type: string) => Promise<Buffer>;
}

const PROPS = ["id", "threadId", "blobId", "subject", "receivedAt", "from", "to",
  "textBody", "bodyValues", "attachments"];

export function makeJmapPort(d: Deps): MailPort {
  return {
    async changedSince(cursor) {
      const [r] = await d.call<{
        newState: string; created: string[]; updated: string[]; destroyed: string[];
      }>(d.session, d.token, [MAIL], [["Email/changes", {
        accountId: d.session.accountId, sinceState: cursor ?? null, maxChanges: 500,
      }, "c0"]]);
      // `destroyed` is deliberately dropped: there is nothing to ingest, and the
      // vault is append-only anyway.
      return { ids: [...r.created, ...r.updated], cursor: r.newState };
    },

    async getMessage(id): Promise<MailMessage> {
      const [r] = await d.call<{ list: Record<string, never>[] }>(
        d.session, d.token, [MAIL], [["Email/get", {
          accountId: d.session.accountId, ids: [id], properties: PROPS,
          fetchTextBodyValues: true,
        }, "c0"]]);
      const e = r.list[0] as unknown as {
        id: string; threadId: string; blobId: string; subject: string | null;
        receivedAt: string;
        from: { email: string }[] | null; to: { email: string }[] | null;
        textBody: { partId: string }[] | null;
        bodyValues: Record<string, { value: string }> | null;
        attachments: JmapAttachment[] | null;
      };
      if (!e) throw new Error(`JMAP Email/get returned nothing for ${id}`);

      const attachments: MailMessage["attachments"] = [];
      const skippedParts: SkippedPart[] = [];
      for (const a of e.attachments ?? []) {
        const mime = a.type ?? "application/octet-stream";
        const name = a.name ?? "unnamed";
        if (isInlineBodyImage(a)) {
          skippedParts.push({ filename: name, mime, contentId: a.cid });
        } else {
          attachments.push({ filename: name, mime,
            data: await d.download(d.session, d.token, a.blobId, name, mime) });
        }
      }

      const partId = e.textBody?.[0]?.partId;
      return {
        id: e.id, threadId: e.threadId,
        from: e.from?.[0]?.email ?? "",
        to: (e.to ?? []).map((x) => x.email).join(", "),
        subject: e.subject ?? "(no subject)",
        sentAt: new Date(e.receivedAt),
        bodyText: (partId && e.bodyValues?.[partId]?.value) || "",
        // The Email's own blobId IS the RFC822 original — one download, and the
        // same canonical bytes the vault has always stored.
        raw: await d.download(d.session, d.token, e.blobId, "raw.eml", "message/rfc822"),
        attachments, skippedParts,
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && env -u NODE_ENV npx vitest run src/mail/jmap-port.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/mail/jmap-port.ts apps/worker/src/mail/jmap-port.test.ts
git commit -m "feat(worker): a JMAP mail port with the same inline-image rule"
```

---

### Task 5: `pollMail`

**Files:**
- Create: `apps/worker/src/mail/poll.ts`
- Test: `apps/worker/src/mail/poll.test.ts`
- Modify: `apps/worker/src/gmail.ts` — export `ingestRawEmail` unchanged, widen its `msg` parameter type to `MailMessage`

**Interfaces:**
- Consumes: `MailPort` (Task 2), `readCursor`/`writeCursor` (Task 2), `ingestRawEmail` from `apps/worker/src/gmail.ts`.
- Produces: `pollMail(deps: { db, mail: MailPort, vaultDir, enqueueSuggest }): Promise<{ ingested: number }>`

- [ ] **Step 1: Write the failing test**

```ts
// apps/worker/src/mail/poll.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { pollMail } from "./poll";
import type { MailPort } from "./port";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const vault = () => mkdtempSync(join(tmpdir(), "jmap-vault-"));

function msg(id: string) {
  return { id, threadId: "t1", from: "case@verdergroep.nl", to: "martin@vanderpoel.pro",
    subject: "Stukken aanleveren", sentAt: new Date(), bodyText: "Beste Martin",
    raw: Buffer.from(`raw-${id}`),
    attachments: [{ filename: "a.pdf", mime: "application/pdf", data: Buffer.from("pdf") }] };
}
const port = (ids: string[], cursor = "s2"): MailPort => ({
  changedSince: async () => ({ ids, cursor }),
  getMessage: async (id) => msg(id),
});

describe("pollMail", () => {
  it("ingests, stores the raw bytes in the vault and enqueues the suggestion", async () => {
    const { db, pool } = createDb(URL);
    const id = `j-${Date.now()}`;
    const enqueued: string[] = [];
    const r = await pollMail({ db, mail: port([id]), vaultDir: vault(),
      enqueueSuggest: async (x) => { enqueued.push(x); } });
    expect(r.ingested).toBe(1);
    expect(enqueued).toHaveLength(1);
    const [row] = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.gmailMessageId, id));
    expect(row.source).toBe("jmap");
    await pool.end();
  });

  it("is idempotent on a re-run of the same id", async () => {
    const { db, pool } = createDb(URL);
    const id = `j-idem-${Date.now()}`;
    const deps = { db, mail: port([id]), vaultDir: vault(), enqueueSuggest: async () => {} };
    expect((await pollMail(deps)).ingested).toBe(1);
    expect((await pollMail(deps)).ingested).toBe(0);
    await pool.end();
  });

  it("advances the cursor so the next poll asks only for changes", async () => {
    const { db, pool } = createDb(URL);
    const seen: (string | null)[] = [];
    const p: MailPort = {
      changedSince: async (c) => { seen.push(c); return { ids: [], cursor: "s-next" }; },
      getMessage: async (id) => msg(id),
    };
    await pollMail({ db, mail: p, vaultDir: vault(), enqueueSuggest: async () => {} });
    await pollMail({ db, mail: p, vaultDir: vault(), enqueueSuggest: async () => {} });
    expect(seen[0]).toBeNull();
    expect(seen[1]).toBe("s-next");
    await pool.end();
  });

  it("isolates a failing message so the healthy ones still ingest", async () => {
    const { db, pool } = createDb(URL);
    const bad = `j-bad-${Date.now()}`, good = `j-good-${Date.now()}`;
    const p: MailPort = {
      changedSince: async () => ({ ids: [bad, good], cursor: "s2" }),
      getMessage: async (id) => {
        if (id === bad) throw new Error("boom");
        return msg(id);
      },
    };
    const r = await pollMail({ db, mail: p, vaultDir: vault(), enqueueSuggest: async () => {} });
    expect(r.ingested).toBe(1);
    await pool.end();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && env -u NODE_ENV npx vitest run src/mail/poll.test.ts`
Expected: FAIL — `Cannot find module './poll'`.

- [ ] **Step 3: Widen `ingestRawEmail` and write `pollMail`**

In `apps/worker/src/gmail.ts`, re-export the shared types instead of keeping a second copy — delete its local `SkippedPart` interface and import both from the new module, so the two ports cannot drift apart:

```ts
import type { MailMessage, SkippedPart } from "./mail/port";
export type { SkippedPart };
// ...
export async function ingestRawEmail(
  deps: { db: Db; vaultDir: string },
  msg: MailMessage,
  opts?: { skipSuggest?: boolean; source?: "gmail" | "jmap" },
): Promise<string> {
```
and inside the insert, add `source: opts?.source ?? "gmail",` to the `.values({...})`.

```ts
// apps/worker/src/mail/poll.ts
import { eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { ingestRawEmail } from "../gmail";
import { recordRun } from "../heartbeat";
import { readCursor, writeCursor } from "./cursor";
import type { MailPort } from "./port";

const WORKER = "mail";

export async function pollMail(deps: {
  db: Db; mail: MailPort; vaultDir: string;
  enqueueSuggest: (rawEmailId: string) => Promise<void>;
}): Promise<{ ingested: number }> {
  let ingested = 0;
  const failures: { id: string; message: string }[] = [];
  const skippedParts: unknown[] = [];

  const cursor = await readCursor(deps.db, WORKER);
  let next = cursor ?? "";
  try {
    const changed = await deps.mail.changedSince(cursor);
    next = changed.cursor;
    for (const id of changed.ids) {
      // One bad message must not block the rest of the mailbox.
      try {
        const [seen] = await deps.db.select().from(schema.rawEmails)
          .where(eq(schema.rawEmails.gmailMessageId, id));
        if (seen) {
          // Outbox repair: the ingest committed but the enqueue failed after it.
          if (!seen.suggestQueuedAt) await enqueueAndMark(deps, seen.id);
          continue;
        }
        const msg = await deps.mail.getMessage(id);
        for (const p of msg.skippedParts ?? []) skippedParts.push({ ...p, messageId: id });
        const rawEmailId = await ingestRawEmail(deps, msg, { source: "jmap" });
        await enqueueAndMark(deps, rawEmailId);
        ingested++;
      } catch (err) {
        failures.push({ id, message: String(err) });
      }
    }
  } catch (err) {
    // The cursor is NOT advanced on a discovery failure: the next poll must ask
    // the same question again rather than skip whatever changed meanwhile.
    await recordRun(deps.db, WORKER, "error",
      { message: String(err), ...(cursor ? { cursor } : {}) });
    throw err;
  }

  await writeCursor(deps.db, WORKER, next, { ingested, failures, skippedParts });
  return { ingested };
}

async function enqueueAndMark(
  deps: { db: Db; enqueueSuggest: (rawEmailId: string) => Promise<void> },
  rawEmailId: string,
): Promise<void> {
  await deps.enqueueSuggest(rawEmailId);
  await deps.db.update(schema.rawEmails).set({ suggestQueuedAt: new Date() })
    .where(eq(schema.rawEmails.id, rawEmailId));
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/worker && env -u NODE_ENV npx vitest run src/mail/ src/gmail.test.ts && env -u NODE_ENV npx tsc --noEmit`
Expected: PASS — 4 new poll tests, the existing 14 gmail tests still green, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/mail/poll.ts apps/worker/src/mail/poll.test.ts apps/worker/src/gmail.ts
git commit -m "feat(worker): ingest over JMAP, reusing the evidence-first transaction"
```

---

### Task 6: Stalwart on the homelab

**Files:**
- Create: `ops/stalwart/config.toml`
- Modify: `docker-compose.prod.yml`
- Modify: `docs/deploy.md` — a Stalwart section
- Modify: `.env.example` — `JMAP_BASE_URL`, `JMAP_TOKEN`, `STALWART_DATA_DIR`, `STALWART_BLOB_DIR`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a JMAP endpoint at `http://localhost:8080` on the homelab, and `JMAP_BASE_URL` / `JMAP_TOKEN` in `.env.prod`.

This task has no unit test — it is a deployment. Its verification steps are assertions against the running service.

- [ ] **Step 1: Add the compose service**

```yaml
# docker-compose.prod.yml — alongside postgres, web, worker
  stalwart:
    # PIN THE TAG. Never :latest on the service that holds the archive —
    # Stalwart is pre-1.0 and its on-disk format is still being finalised,
    # so an unattended pull could land a version that will not open the store.
    image: stalwartlabs/mail-server:v0.11.5
    restart: unless-stopped
    volumes:
      # Metadata on the NVMe. NEVER on the NAS mount: an NFS-backed mail
      # database corrupts.
      - ${STALWART_DATA_DIR:?}:/opt/stalwart-mail/data
      # Blobs may live on the NAS — 2.9 TB free vs 39 GB on the NVMe.
      - ${STALWART_BLOB_DIR:?}:/opt/stalwart-mail/blobs
      - ./ops/stalwart/config.toml:/opt/stalwart-mail/etc/config.toml:ro
    ports:
      # Bound to loopback like the web app: JMAP reaches the world through the
      # cloudflared tunnel, never directly. No SMTP listener in phase 1.
      - "127.0.0.1:8080:8080"
```

- [ ] **Step 2: Write the config**

```toml
# ops/stalwart/config.toml
[server.listener.jmap]
bind = ["0.0.0.0:8080"]
protocol = "http"

[store.data]
type = "rocksdb"
path = "/opt/stalwart-mail/data"

[store.blob]
type = "fs"
path = "/opt/stalwart-mail/blobs"

[storage]
data = "data"
blob = "blob"
fts = "data"
lookup = "data"
```

- [ ] **Step 3: Deploy and create the account**

```bash
# from the Mac — dry run FIRST and read every deleting line
rsync -avn --delete --info=del \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude '.turbo' \
  --exclude '.serena' --exclude 'nightly.log' --exclude '.env.prod' \
  --exclude 'secrets' --exclude 'vault-files' ./ homelab:~/apps/verder/
# then the real run, same flags without -n

ssh homelab 'cd ~/apps/verder && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml up -d stalwart'
```

Create the mailbox account and an API token. **The exact admin command is version-specific and is NOT reproduced here on purpose** — read it from Stalwart's docs for the tag you pinned rather than trusting a remembered syntax. The shape is: create an account for `martin@vanderpoel.pro`, then mint an API token with mail read/write scope. Put the results in `~/apps/verder/.env.prod` (mode 600, never committed):

```
JMAP_BASE_URL=http://stalwart:8080
JMAP_TOKEN=<the token>
STALWART_DATA_DIR=/mnt/data/verder/stalwart/data
STALWART_BLOB_DIR=/mnt/data/verder/stalwart/blobs
```

- [ ] **Step 4: Verify the endpoint answers**

```bash
ssh homelab 'curl -s -H "Authorization: Bearer $JMAP_TOKEN" \
  http://localhost:8080/.well-known/jmap | head -c 400'
```
Expected: JSON containing `apiUrl`, `downloadUrl` and a `primaryAccounts` entry for `urn:ietf:params:jmap:mail`.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.prod.yml ops/stalwart/config.toml docs/deploy.md .env.example
git commit -m "feat(ops): run Stalwart on the homelab, JMAP only, loopback-bound"
```

---

### Task 7: Import the Gmail archive

**Files:** none in the repo. This is an operational task; its output is data.

**Interfaces:**
- Consumes: the running Stalwart from Task 6.
- Produces: a populated mailbox and a recorded baseline message count for Task 8's verification.

- [ ] **Step 1: Export from Google**

In the browser: Google Takeout → Mail only → `.mbox`, or the Admin console's Data Export. Neither touches IMAP or the Gmail API, so neither is affected by the rate limit. Expect 72 hours, up to 14 days.

Read the Gmail size at `one.google.com/storage` while you wait, for the record — but it no longer gates anything: `/mnt/data` has 342 GB free and the estimate is ~30 GB. Stage the `.mbox` on `/mnt/data` too, NOT on `/`, which has 40 GB free and would need the archive twice over during the import.

- [ ] **Step 2: Get the archive onto the homelab**

For Takeout, download and `scp`. For Data Export, pull it straight from the bucket:

```bash
ssh homelab 'gcloud storage cp -r gs://<export-bucket>/<path> /mnt/data/verder/mail-import/'
```

- [ ] **Step 3: Dry-run the import**

```bash
ssh homelab 'vandelay import takeout --dry-run \
  --path /mnt/data/verder/mail-import martin.sqlite'
```
Expected: a message count and no errors. Note the count — Task 8 checks against it.

- [ ] **Step 4: Import for real, then verify**

```bash
ssh homelab 'vandelay import takeout --path /mnt/data/verder/mail-import martin.sqlite && \
  vandelay export --url http://localhost:8080 --token "$JMAP_TOKEN" martin.sqlite'
```

Verify the count matches the dry run via a JMAP `Email/query` with a `calculateTotal` request. A shortfall means a partial import — Vandelay is convergent, so re-run it rather than starting over.

- [ ] **Step 5: Record the baseline**

Write the final message count into `docs/deploy.md`'s Stalwart section. Task 8 and the monthly restore drill both assert against it.

---

### Task 8: Schedule `mail.poll` and cut ingestion over

**Files:**
- Modify: `apps/worker/src/index.ts`
- Modify: `docs/deploy.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `pollMail` (Task 5), `openSession` (Task 3), `makeJmapPort` (Task 4), the running Stalwart (Task 6).
- Produces: a live `mail.poll` schedule feeding the existing `suggest.entry` queue.

- [ ] **Step 1: Wire it up**

```ts
// apps/worker/src/index.ts — replacing the commented-out gmail.poll block
import { openSession, call, download } from "./mail/jmap-client";
import { makeJmapPort } from "./mail/jmap-port";
import { pollMail } from "./mail/poll";

await boss.createQueue("mail.poll");
await boss.schedule("mail.poll", "* * * * *");
await boss.work("mail.poll", async () => {
  const token = process.env.JMAP_TOKEN!;
  const session = await openSession(process.env.JMAP_BASE_URL!, token);
  const mail = makeJmapPort({ session, token, call, download });
  await pollMail({ db, mail, vaultDir: process.env.VAULT_DIR ?? "./vault-files",
    enqueueSuggest: async (rawEmailId) => { await boss.send("suggest.entry", { rawEmailId }); } });
});
```

Every minute is safe here in a way it never was for Gmail: `Email/changes` returns a delta, the server is Martin's own, and there is no quota.

- [ ] **Step 2: Run the whole worker suite**

Run: `cd apps/worker && env -u NODE_ENV npx vitest run && env -u NODE_ENV npx tsc --noEmit`
Expected: PASS, all files green, typecheck clean.

- [ ] **Step 3: Deploy**

Migration 0028 runs from the homelab HOST first, then the images:

```bash
ssh homelab 'cd ~/apps/verder && env -u NODE_ENV pnpm --filter @verder/db migrate'
# rsync (dry run first), then:
ssh homelab 'cd ~/apps/verder && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml build worker && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml up -d worker'
```

- [ ] **Step 4: Verify ingestion and that no evidence moved**

```bash
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod -f docker-compose.prod.yml \
  exec -T postgres psql -U verder -d verder -c \
  "SELECT ran_at, status, detail FROM worker_runs WHERE worker='"'"'mail'"'"' ORDER BY ran_at DESC LIMIT 5;"'
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod -f docker-compose.prod.yml \
  exec -T worker pnpm --filter worker nightly-verify'
```

Expected: `mail` runs recorded `ok` with a `cursor`, the first carrying the bulk of the import and later ones near zero; `nightly-verify` green with the **chain head unchanged** — this sub-project appends no ledger events, so a moved head means something wrote evidence.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/index.ts docs/deploy.md CLAUDE.md
git commit -m "feat(worker): ingest from Stalwart over JMAP, every minute"
```

---

### Task 9: Re-baseline the evals

**Files:**
- Modify: `CLAUDE.md` — the eval baselines block

**Interfaces:**
- Consumes: a populated mailbox and live ingestion from Task 8.
- Produces: updated golden-rule baselines.

Message parsing changed, so the baselines in CLAUDE.md describe a pipeline that no longer exists. They must be re-measured, not assumed.

- [ ] **Step 1: Run each eval three times**

```bash
ssh homelab 'cd ~/apps/verder && for i in 1 2 3; do \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker \
  pnpm --filter worker eval; done'
```
Repeat for `task-eval` and `registry-eval`. Runs alongside the prod stack often abort on the 120 s Ollama timeout from GPU contention — rerun rather than trusting a crashed run.

- [ ] **Step 2: Record the ranges**

Update CLAUDE.md's baselines with the observed range across three completed runs, not the best one. A single lucky run recorded as the baseline is how a regression becomes invisible.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: re-baseline the evals after the JMAP cutover"
```

---

### Task 10: Back up the Stalwart store

**Files:**
- Modify: `ops/nightly.sh`
- Create: `ops/mail-backup.sh`
- Test: `apps/worker/src/ops/mail-backup.test.ts`

**Interfaces:**
- Consumes: the running Stalwart (Task 6) and its imported archive (Task 7).
- Produces: `$BACKUP_DIR/mail/native-YYYY-MM-DD.tar.zst` nightly and `$BACKUP_DIR/mail/maildir-YYYY-WW.tar.zst.age` weekly.

The moment Task 7 finishes, the archive is precious and single-copy. This task is not optional polish.

- [ ] **Step 1: Write the failing test**

```ts
// apps/worker/src/ops/mail-backup.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const sh = readFileSync("ops/mail-backup.sh", "utf8");

describe("mail-backup.sh", () => {
  // FORMAT IS THE LOAD-BEARING DECISION: a native snapshot depends on the same
  // pre-1.0 Stalwart reading its own on-disk format. Maildir restores anywhere.
  it("produces a provider-neutral Maildir export, not only a native snapshot", () => {
    expect(sh).toMatch(/maildir/i);
    expect(sh).toMatch(/vandelay|export/i);
  });

  it("encrypts before anything leaves for a third party", () => {
    expect(sh).toMatch(/age -r|restic/);
  });

  it("fails loudly rather than silently skipping", () => {
    expect(sh).toMatch(/set -euo pipefail/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && env -u NODE_ENV npx vitest run src/ops/mail-backup.test.ts`
Expected: FAIL — `ENOENT: ops/mail-backup.sh`.

- [ ] **Step 3: Write the script**

```bash
#!/usr/bin/env bash
# Mail backup. Two formats on purpose — see the spec, section 2.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source ./.env.prod; set +a

STAMP=$(date +%F)
WEEK=$(date +%G-W%V)
OUT="${BACKUP_DIR:?}/mail"
mkdir -p "$OUT"

# 1. Native snapshot, nightly. Fast to restore, and only restorable by a
#    Stalwart that still reads this on-disk format.
docker compose --env-file .env.prod -f docker-compose.prod.yml stop stalwart
tar -C "${STALWART_DATA_DIR:?}" -cf - . | zstd -q -o "$OUT/native-$STAMP.tar.zst"
docker compose --env-file .env.prod -f docker-compose.prod.yml start stalwart
find "$OUT" -name 'native-*.tar.zst' -mtime +30 -delete

# 2. Neutral Maildir export, weekly. Restorable into ANY mail server, which is
#    what makes pre-1.0 Stalwart an acceptable system of record.
if [ ! -f "$OUT/maildir-$WEEK.tar.zst.age" ]; then
  TMP=$(mktemp -d)
  vandelay export --url "$JMAP_BASE_URL" --token "$JMAP_TOKEN" \
    --format maildir --path "$TMP" mail.sqlite
  # Encrypted BEFORE it can reach Dropbox or TransIP Stack: those are third
  # parties holding bewindvoering correspondence. The key lives in the password
  # manager and on paper, never only on this machine.
  tar -C "$TMP" -cf - . | zstd -q | age -r "${BACKUP_AGE_RECIPIENT:?}" \
    -o "$OUT/maildir-$WEEK.tar.zst.age"
  rm -rf "$TMP"
fi

echo "mail-backup.sh: done ($STAMP)"
```

- [ ] **Step 4: Run tests, then wire into the nightly cron**

Add to `ops/nightly.sh`, after the vault mirror step:

```bash
# 3b. Mail store — native nightly, Maildir weekly. See ops/mail-backup.sh.
./ops/mail-backup.sh
```

Run: `chmod +x ops/mail-backup.sh && cd apps/worker && env -u NODE_ENV npx vitest run src/ops/mail-backup.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add ops/mail-backup.sh ops/nightly.sh apps/worker/src/ops/mail-backup.test.ts
git commit -m "feat(ops): back the mail store up in two formats, one of them neutral"
```

---

### Task 11: The monthly restore drill

> **SUPERSEDED — EXECUTED 2026-09-01, DIFFERENTLY. Do not build what is written
> below.** The task as drafted is entirely mocked: every dependency is a fake and
> step 3 delivers only the pure `runDrill` boolean, with no `main()`, no restore
> and no scratch server. That is a green test over an unexercised backup. What
> shipped restores for real — `ops/mail-restore-drill.sh`,
> `ops/mail-drill.compose.yml`, `apps/worker/src/ops/mail-restore-drill.ts` —
> and was run twice in production at 1m36s. Three concrete errors below, all
> measured: `expectedCount` is **146,270**, not 4182; the neutral **Maildir**
> export it says to exercise **does not exist** (`vandelay export --format
> maildir` is not a thing), so tier 2 is a Vandelay SQLite archive checked with
> `vandelay inspect`; and `jmapAnswers` **cannot be a search**, because
> `Email/query` filters return nothing on this store in production too. It is
> also not a pg-boss job — the restore is tens of minutes and pg-boss expires a
> job at ~15. The measured record is in CLAUDE.md and the runbook in
> `docs/deploy.md` §8.12. Kept, not deleted, so the diff between what was
> planned and what was true stays readable.


**Files:**
- Create: `apps/worker/src/ops/mail-restore-drill.ts`
- Test: `apps/worker/src/ops/mail-restore-drill.test.ts`
- Modify: `apps/worker/package.json` — a `mail-drill` script

**Interfaces:**
- Consumes: the backups from Task 10; `sendPush` from `apps/worker/src/push.ts`; `recordRun` from `apps/worker/src/heartbeat.ts`.
- Produces: `runDrill(deps): Promise<{ ok: boolean; restored: number; expected: number; sampled: number }>`, recorded in `worker_runs` as `mail-drill`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/worker/src/ops/mail-restore-drill.test.ts
import { describe, expect, it, vi } from "vitest";
import { runDrill } from "./mail-restore-drill";

const base = {
  restore: async () => 4182,
  expectedCount: async () => 4182,
  sampleMatches: async () => true,
  jmapAnswers: async () => true,
  notify: vi.fn(async () => {}),
  record: vi.fn(async () => {}),
};

describe("mail restore drill", () => {
  it("passes when the count matches, the sample is byte-identical and JMAP answers", async () => {
    const r = await runDrill({ ...base });
    expect(r.ok).toBe(true);
  });

  it("fails on a short restore rather than reporting success", async () => {
    const r = await runDrill({ ...base, restore: async () => 4000 });
    expect(r.ok).toBe(false);
  });

  // A count can match while the bytes are wrong — that is the failure a drill
  // exists to catch, and a count-only check would miss it.
  it("fails when a sampled message is not byte-identical", async () => {
    const r = await runDrill({ ...base, sampleMatches: async () => false });
    expect(r.ok).toBe(false);
  });

  // Alerting must not depend on mail: this drill tests the mail system.
  it("notifies by push on failure", async () => {
    const notify = vi.fn(async () => {});
    await runDrill({ ...base, restore: async () => 0, notify });
    expect(notify).toHaveBeenCalledOnce();
  });

  it("says nothing on success, so a green month is quiet", async () => {
    const notify = vi.fn(async () => {});
    await runDrill({ ...base, notify });
    expect(notify).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && env -u NODE_ENV npx vitest run src/ops/mail-restore-drill.test.ts`
Expected: FAIL — `Cannot find module './mail-restore-drill'`.

- [ ] **Step 3: Write the drill**

```ts
// apps/worker/src/ops/mail-restore-drill.ts

/**
 * A backup that has never been restored is a rumour.
 *
 * Restores the latest backup into a scratch Stalwart and asserts three things,
 * because any one of them alone can pass while the backup is useless: the
 * message count, that a sample is byte-identical by sha256, and that JMAP
 * answers at all. The caller alternates which FORMAT is restored — the drill
 * must exercise the neutral Maildir export at least monthly, or the survival
 * path stays unproven until the day it is needed.
 */
export interface DrillDeps {
  restore: () => Promise<number>;
  expectedCount: () => Promise<number>;
  sampleMatches: () => Promise<boolean>;
  jmapAnswers: () => Promise<boolean>;
  notify: (msg: { title: string; body: string }) => Promise<void>;
  record: (status: "ok" | "error", detail: object) => Promise<void>;
}

export async function runDrill(d: DrillDeps): Promise<{
  ok: boolean; restored: number; expected: number; sampled: boolean;
}> {
  const restored = await d.restore();
  const expected = await d.expectedCount();
  const sampled = await d.sampleMatches();
  const answers = await d.jmapAnswers();
  const ok = restored === expected && sampled && answers;

  await d.record(ok ? "ok" : "error", { restored, expected, sampled, answers });
  if (!ok) {
    await d.notify({
      title: "Mail restore drill FAILED",
      body: `restored ${restored} of ${expected}, sample ${sampled ? "ok" : "MISMATCH"}, jmap ${answers ? "ok" : "silent"}`,
    });
  }
  return { ok, restored, expected, sampled };
}
```

- [ ] **Step 4: Run the tests and add the script**

In `apps/worker/package.json` scripts: `"mail-drill": "tsx src/ops/mail-restore-drill.ts"`.

Run: `cd apps/worker && env -u NODE_ENV npx vitest run src/ops/mail-restore-drill.test.ts && env -u NODE_ENV npx tsc --noEmit`
Expected: PASS, 5 tests, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/ops/mail-restore-drill.ts apps/worker/src/ops/mail-restore-drill.test.ts apps/worker/package.json
git commit -m "feat(worker): prove the mail backup restores, monthly, by push on failure"
```

---

## What phase 1 deliberately does not do

- No MX change, no SMTP listener, no WireGuard, no TransIP. Mail still **arrives** at Gmail; Stalwart is fed by the import and, until phase 2, does not receive new mail on its own.
- **This is the honest limit of phase 1:** it restores the archive and the JMAP path, but new mail still lands in Gmail. Bridging that gap until phase 2 needs either a Gmail forward into Stalwart or a periodic re-import, and that decision belongs to the phase 2 plan.
- No deletion from Gmail. That is the cleanup sub-project.
