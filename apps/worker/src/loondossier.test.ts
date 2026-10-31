import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { sha256Hex } from "@verder/core";
import {
  amsterdamToDate, createPortalClient, fetchLoondossier, parsePortalFiles, selectNew, titleFor,
  type PortalFile,
} from "./loondossier";
import { settleDocumentTexts } from "./test-support/document-texts";
import { fakeNotify } from "./test-support/fake-notify";

const DB_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const SECRETS = { username: "martin-secret-user", password: "hunter2-secret-pass" };
const CSRF = "csrf-secret-value";
const COOKIE = "cookie-secret-value";
const TOKEN = "tok-secret-1234";

const row = (id: number, name: string, period: number, at = "2026-10-05 13:02:16") => ({
  ID: id, fkFileID: id - 1, Grootte: 1234, DatumTijd: at, Naam: name, Jaar: 2026,
  PeriodeNummer: period, FileType: "Loonstrook", ContentHash: "x", OwnerDisplayName: "Saurens",
  IsUnread: true, IsGeldig: true });

const BASE_IDS = [33033493, 33349930, 33700516, 33993690];
const NAMES = ["Salaris juni 2026.pdf", "Salaris juli 2026.pdf", "Salaris augustus 2026.pdf",
  "Salaris september 2026.pdf"];
const AT = ["2026-07-03 09:00:00", "2026-08-04 09:00:00", "2026-09-03 09:00:00", "2026-10-05 13:02:16"];
const listing = (offset: number) =>
  BASE_IDS.map((id, i) => row(id + offset, NAMES[i], 6 + i, AT[i]));

/**
 * A fake portal. The dev DB is shared and keeps loondossier refs between runs,
 * so each test shifts the listing ids by `offset` to get ids no earlier run saw.
 */
function fakePortal(opts: { bytes: Record<number, string>; offset?: number; login?: boolean }) {
  const offset = opts.offset ?? 0;
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(input));
    const h = new Headers();
    if (u.pathname === "/Aanmelden" && (init?.method ?? "GET") === "GET") {
      h.append("set-cookie", `csrf=${COOKIE}; path=/; HttpOnly`);
      return new Response(`<form><input name="__RequestVerificationToken" type="hidden" value="${CSRF}" /></form>`,
        { status: 200, headers: h });
    }
    if (u.pathname === "/Aanmelden") {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("UserName")).toBe(SECRETS.username);
      expect(body.get("__RequestVerificationToken")).toBe(CSRF);
      expect((init?.headers as Record<string, string>).cookie).toBe(`csrf=${COOKIE}`);
      if (opts.login === false) return new Response('<input type="password"><li>Onjuist</li>', { status: 200 });
      h.set("location", "/ReactApp");
      return new Response(null, { status: 302, headers: h });
    }
    if (u.pathname === "/ReactApp") return new Response("<html/>", { status: 200 });
    if (u.pathname === "/ReactApp/ReactApp/GetToken") return new Response(`"${TOKEN}"`, { status: 200 });
    if (u.pathname.startsWith("/Mobile") && u.searchParams.get("token") !== TOKEN)
      return new Response("no", { status: 401 });
    if (u.pathname === "/Mobile/Werknemer/Jaren") return Response.json([2026, 0]);
    if (u.pathname === "/Mobile/Werknemer/Dossier")
      return Response.json(u.searchParams.get("jaar") === "2026" ? listing(offset) : []);
    const dl = /^\/File\/Download\/(\d+)$/.exec(u.pathname);
    if (dl && opts.bytes[Number(dl[1]) - offset] !== undefined)
      return new Response(opts.bytes[Number(dl[1]) - offset],
        { status: 200, headers: { "content-type": "application/pdf" } });
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
}

describe("parsePortalFiles", () => {
  it("maps the portal shape and reads DatumTijd as Amsterdam time", () => {
    const [f] = parsePortalFiles([row(33993690, "Salaris september 2026.pdf", 9)]);
    expect(f).toEqual({ id: "33993690", name: "Salaris september 2026.pdf",
      postedAt: new Date("2026-10-05T11:02:16Z"), year: 2026, period: 9, fileType: "Loonstrook" });
  });
  it("drops rows missing ID or Naam and rejects a non-array", () => {
    const good = row(1, "a.pdf", 1);
    expect(parsePortalFiles([good, { ...good, ID: undefined }, { ...good, Naam: "" }, null, 5]))
      .toHaveLength(1);
    expect(() => parsePortalFiles({ error: "x" })).toThrow("Onverwacht antwoord van het portaal");
  });
  it("applies winter time in January", () => {
    expect(amsterdamToDate("2026-01-15 12:00:00")).toEqual(new Date("2026-01-15T11:00:00Z"));
  });
});

describe("titleFor", () => {
  const months = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus",
    "september", "oktober", "november", "december"];
  it.each(months.map((m, i) => [m, String(i + 1).padStart(2, "0")]))("%s -> %s", (m, mm) => {
    expect(titleFor(`Salaris ${m} 2026.pdf`))
      .toEqual({ title: `Loonstrook.mp.2026-${mm}.Saurens.pdf`, payslip: true });
  });
  it("keeps names that do not match", () => {
    expect(titleFor("Jaaropgaaf 2025.pdf")).toEqual({ title: "Jaaropgaaf 2025.pdf", payslip: false });
    expect(titleFor("Salaris smarch 2026.pdf").title).toBe("Salaris smarch 2026.pdf");
  });
});

describe("selectNew", () => {
  it("excludes files whose loondossier ref is known", () => {
    const files = parsePortalFiles(listing(0));
    const fresh = selectNew(files, new Set(["loondossier:33033493", "loondossier:33993690"]));
    expect(fresh.map((f: PortalFile) => f.id)).toEqual(["33349930", "33700516"]);
  });
});

describe("portal client", () => {
  it("fails login with a message free of secrets", async () => {
    const client = createPortalClient(fakePortal({ bytes: {}, login: false }));
    await expect(client.login(SECRETS)).rejects.toMatchObject({ message: "Aanmelden bij Mijn LoonDossier mislukt (controleer de inloggegevens)" });
  });
  it("wraps network failures without leaking the cause", async () => {
    const client = createPortalClient((async () => { throw new Error(`boom ${TOKEN}`); }) as typeof fetch);
    await expect(client.login(SECRETS)).rejects.toMatchObject({ message: "Mijn LoonDossier is niet bereikbaar" });
  });
});

describe("fetchLoondossier", () => {
  async function credsFile() {
    const p = join(mkdtempSync(join(tmpdir(), "ld-cred-")), "loondossier.json");
    await writeFile(p, JSON.stringify({ ...SECRETS, totpSecret: null }));
    return p;
  }
  const lastRun = async (db: ReturnType<typeof createDb>["db"]) =>
    (await db.select().from(schema.workerRuns).where(eq(schema.workerRuns.worker, "loondossier"))
      .orderBy(desc(schema.workerRuns.ranAt)).limit(1))[0];
  const uniqueOffset = () => (1 + Math.floor(Math.random() * 1e6)) * 10;

  it("skips cleanly without a credentials file", async () => {
    const { db, pool } = createDb(DB_URL);
    const res = await fetchLoondossier({ db, vaultDir: tmpdir(), credentialsPath: "/nonexistent/x.json",
      enqueueDocMeta: async () => {}, notify: fakeNotify().notify });
    expect(res).toEqual({ listed: 0, new: 0, ingested: [] });
    expect((await lastRun(db)).detail).toEqual({ skipped: "no credentials" });
    await pool.end();
  });

  it("records a login failure as error without secrets", async () => {
    const { db, pool } = createDb(DB_URL);
    await fetchLoondossier({ db, vaultDir: tmpdir(), credentialsPath: await credsFile(),
      client: createPortalClient(fakePortal({ bytes: {}, login: false })),
      enqueueDocMeta: async () => {}, notify: fakeNotify().notify });
    const run = await lastRun(db);
    expect(run.status).toBe("error");
    expect(run.detail).toEqual({
      message: "Aanmelden bij Mijn LoonDossier mislukt (controleer de inloggegevens)",
      listed: 0, new: 0, ingested: [] });
    await pool.end();
  });

  it("ingests each new file once, is idempotent, and records no secret", async () => {
    const { db, pool } = createDb(DB_URL);
    const offset = uniqueOffset();
    const stamp = `${Date.now()}-${Math.random()}`;
    const bytes: Record<number, string> = Object.fromEntries(
      BASE_IDS.map((id, i) => [id, `%PDF fake ${NAMES[i]} ${stamp}`]));
    const { notify, sent: pushes } = fakeNotify();
    const enq: string[] = [];
    const deps = { db, vaultDir: mkdtempSync(join(tmpdir(), "ld-vault-")),
      credentialsPath: await credsFile(),
      client: createPortalClient(fakePortal({ bytes, offset })),
      enqueueDocMeta: async (id: string) => { enq.push(id); },
      notify };

    const first = await fetchLoondossier(deps);
    expect(first).toEqual({ listed: 4, new: 4, ingested: [
      "Loonstrook.mp.2026-06.Saurens.pdf", "Loonstrook.mp.2026-07.Saurens.pdf",
      "Loonstrook.mp.2026-08.Saurens.pdf", "Loonstrook.mp.2026-09.Saurens.pdf"] });
    expect(pushes).toEqual(first.ingested.map((t) =>
      ({ kind: "filing", level: "passive", title: "Nieuwe loonstrook", body: t })));
    expect(enq).toHaveLength(4);

    const [sept] = await db.select().from(schema.documents)
      .where(and(eq(schema.documents.source, "loondossier"),
        eq(schema.documents.sha256, sha256Hex(Buffer.from(bytes[33993690])))));
    expect(sept.sourceRef).toBe(`loondossier:${33993690 + offset}`);
    expect(sept.docType).toBe("loonstrook");
    expect(sept.mime).toBe("application/pdf");
    expect(sept.receivedAt).toEqual(new Date("2026-10-05T11:02:16Z"));
    for (const id of BASE_IDS)
      expect(await settleDocumentTexts(db, `loondossier:${id + offset}`)).toBe(1);

    const countEvents = async () => (await db.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.eventType, "document.ingested"))).length;
    const before = await countEvents();
    const second = await fetchLoondossier(deps);
    expect(second).toEqual({ listed: 4, new: 0, ingested: [] });
    expect(await countEvents()).toBe(before);
    expect(pushes).toHaveLength(4);

    const run = await lastRun(db);
    expect(run.status).toBe("ok");
    const dump = JSON.stringify(run.detail);
    for (const s of [SECRETS.username, SECRETS.password, CSRF, COOKIE, TOKEN])
      expect(dump).not.toContain(s);
    await pool.end();
  });

  it("a new payslip notifies passive filing", async () => {
    const { db, pool } = createDb(DB_URL);
    const offset = uniqueOffset();
    const stamp = `${Date.now()}-${Math.random()}`;
    const bytes: Record<number, string> = Object.fromEntries(
      BASE_IDS.map((id, i) => [id, `%PDF fake ${NAMES[i]} ${stamp}`]));
    const { notify, sent } = fakeNotify();
    const res = await fetchLoondossier({ db, vaultDir: mkdtempSync(join(tmpdir(), "ld-vault-")),
      credentialsPath: await credsFile(), client: createPortalClient(fakePortal({ bytes, offset })),
      enqueueDocMeta: async () => {}, notify });
    expect(res.ingested).toHaveLength(4);
    expect(sent).toHaveLength(4);
    for (const n of sent) expect(n).toMatchObject({ kind: "filing", level: "passive", title: "Nieuwe loonstrook" });
    expect(sent.map((n) => n.body)).toEqual(res.ingested);
    for (const id of BASE_IDS) await settleDocumentTexts(db, `loondossier:${id + offset}`);
    await pool.end();
  });

  it("does not report or push a file whose bytes the vault already holds", async () => {
    const { db, pool } = createDb(DB_URL);
    const offset = uniqueOffset();
    const content = `%PDF held elsewhere ${Date.now()}-${Math.random()}`;
    const buf = Buffer.from(content);
    const heldRef = `held-${sha256Hex(buf)}`;
    await db.insert(schema.documents).values({ sha256: sha256Hex(buf), sizeBytes: buf.length,
      mime: "application/pdf", title: "scan_0042.pdf", source: "nas-scan",
      sourceRef: heldRef, receivedAt: new Date() });
    const { notify, sent: pushes } = fakeNotify();
    const res = await fetchLoondossier({ db, vaultDir: mkdtempSync(join(tmpdir(), "ld-vault-")),
      credentialsPath: await credsFile(),
      client: createPortalClient(fakePortal({
        bytes: { 33033493: content, 33349930: content, 33700516: content, 33993690: content }, offset })),
      enqueueDocMeta: async () => {}, notify });
    expect(res).toEqual({ listed: 4, new: 4, ingested: [] });
    expect(pushes).toEqual([]);
    await settleDocumentTexts(db, heldRef);
    await pool.end();
  });
});
