import { readFile } from "node:fs/promises";
import { inArray, and, eq } from "drizzle-orm";
import { sha256Hex } from "@verder/core";
import { schema, type Db } from "@verder/db";
import { ingestDocument } from "@verder/api/src/routers/documents";
import { storeFile } from "@verder/api/src/storage";
import { recordRun } from "./heartbeat";
import type { NotifyFn } from "./notify/notify";

const BASE = "https://mijn.loondossier.nl";

export interface PortalFile {
  /** File VERSION id: the download key, not fkFileID. */
  id: string;
  name: string;
  postedAt: Date;
  year: number | null;
  period: number | null;
  fileType: string | null;
}

/**
 * A portal failure carries a fixed message and the step it happened at. Never
 * the underlying error: undici messages can embed the request URL, and the
 * data URLs carry the session token in their query string.
 */
export class PortalError extends Error {
  constructor(readonly step: string, message: string) {
    super(message);
    this.name = "PortalError";
  }
}

export interface Credentials { username: string; password: string }

const MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli",
  "augustus", "september", "oktober", "november", "december"];

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v
    : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null;

/** The portal stamps wall-clock time in Amsterdam with no offset. */
export function amsterdamToDate(local: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  // Two passes: the offset at the guessed instant can differ from the offset
  // at the true one only within an hour of a DST switch.
  const guess = wall - offsetAt(wall);
  const date = new Date(wall - offsetAt(guess));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Parse the Dossier JSON at the boundary. A row without ID, Naam or a readable date is dropped. */
export function parsePortalFiles(raw: unknown): PortalFile[] {
  if (!Array.isArray(raw)) throw new PortalError("dossier", "Onverwacht antwoord van het portaal");
  const out: PortalFile[] = [];
  for (const row of raw) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const id = num(r.ID);
    if (id === null || typeof r.Naam !== "string" || r.Naam.trim() === "") continue;
    const postedAt = typeof r.DatumTijd === "string" ? amsterdamToDate(r.DatumTijd) : null;
    if (!postedAt) continue;
    out.push({ id: String(id), name: r.Naam.trim(), postedAt, year: num(r.Jaar),
      period: num(r.PeriodeNummer), fileType: typeof r.FileType === "string" ? r.FileType : null });
  }
  return out;
}

const SALARIS = /^Salaris (\p{L}+) (\d{4})\.pdf$/iu;

/** "Salaris september 2026.pdf" becomes "Loonstrook.mp.2026-09.Saurens.pdf"; anything else keeps its name. */
export function titleFor(name: string): { title: string; payslip: boolean } {
  const m = SALARIS.exec(name);
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : 0;
  if (!m || month === 0) return { title: name, payslip: false };
  return { title: `Loonstrook.mp.${m[2]}-${String(month).padStart(2, "0")}.Saurens.pdf`, payslip: true };
}

export const refFor = (f: PortalFile) => `loondossier:${f.id}`;

export function selectNew(files: PortalFile[], knownRefs: ReadonlySet<string>): PortalFile[] {
  return files.filter((f) => !knownRefs.has(refFor(f)));
}

type Fetch = typeof fetch;

export interface PortalClient {
  login(c: Credentials): Promise<void>;
  years(): Promise<number[]>;
  files(year: number): Promise<PortalFile[]>;
  download(id: string): Promise<Buffer>;
}

export function createPortalClient(fetchImpl: Fetch = fetch, base = BASE): PortalClient {
  const jar = new Map<string, string>();
  let token = "";

  const absorb = (res: Response) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
    }
  };
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

  async function call(step: string, path: string, init: RequestInit = {}): Promise<Response> {
    try {
      const res = await fetchImpl(base + path, { ...init, redirect: "manual",
        headers: { ...(init.headers as Record<string, string>), cookie: cookieHeader() } });
      absorb(res);
      return res;
    } catch {
      throw new PortalError(step, "Mijn LoonDossier is niet bereikbaar");
    }
  }

  async function follow(step: string, first: Response): Promise<{ res: Response; path: string }> {
    let res = first;
    let path = "";
    for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400; hop++) {
      const loc = res.headers.get("location");
      if (!loc) break;
      path = new URL(loc, base).pathname;
      res = await call(step, path + new URL(loc, base).search);
    }
    return { res, path };
  }

  async function json(step: string, path: string): Promise<unknown> {
    const res = await call(step, path);
    if (!res.ok) throw new PortalError(step, `Mijn LoonDossier gaf een fout (${res.status})`);
    try { return await res.json(); }
    catch { throw new PortalError(step, "Onverwacht antwoord van het portaal"); }
  }

  const q = () => `token=${encodeURIComponent(token)}`;

  return {
    async login(c) {
      const page = await call("login", "/Aanmelden");
      const html = await page.text();
      const csrf = /name="__RequestVerificationToken"[^>]*?value="([^"]+)"/.exec(html)
        ?? /value="([^"]+)"[^>]*?name="__RequestVerificationToken"/.exec(html);
      if (!page.ok || !csrf) throw new PortalError("login", "Aanmeldpagina van het portaal onleesbaar");
      const body = new URLSearchParams({ UserName: c.username, Password: c.password,
        __RequestVerificationToken: csrf[1] });
      const post = await call("login", "/Aanmelden", { method: "POST", body: body.toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" } });
      const landed = await follow("login", post);
      if (!landed.path.startsWith("/ReactApp"))
        throw new PortalError("login", "Aanmelden bij Mijn LoonDossier mislukt (controleer de inloggegevens)");
      const t = await call("token", "/ReactApp/ReactApp/GetToken");
      token = (await t.text()).trim().replace(/^"|"$/g, "");
      if (!t.ok || token === "") throw new PortalError("token", "Geen sessietoken van het portaal");
    },
    async years() {
      const raw = await json("jaren", `/Mobile/Werknemer/Jaren?${q()}`);
      if (!Array.isArray(raw)) throw new PortalError("jaren", "Onverwacht antwoord van het portaal");
      return raw.filter((y): y is number => typeof y === "number" && y > 0);
    },
    async files(year) {
      return parsePortalFiles(await json("dossier", `/Mobile/Werknemer/Dossier?${q()}&jaar=${year}`));
    },
    async download(id) {
      if (!/^\d+$/.test(id)) throw new PortalError("download", "Ongeldig bestandsnummer");
      const res = await call("download", `/File/Download/${id}`);
      if (!res.ok || (res.headers.get("content-type") ?? "").includes("text/html"))
        throw new PortalError("download", "Bestand kon niet worden gedownload");
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new PortalError("download", "Leeg bestand ontvangen");
      return buf;
    },
  };
}

export const DEFAULT_CREDENTIALS_PATH = "/repo/secrets/loondossier.json";

async function readCredentials(path: string): Promise<Credentials | "absent" | "invalid"> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "invalid"; }
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (typeof j.username === "string" && typeof j.password === "string" && j.username && j.password)
      return { username: j.username, password: j.password };
  } catch { /* falls through */ }
  return "invalid";
}

export interface LoondossierDeps {
  db: Db;
  vaultDir: string;
  client?: PortalClient;
  credentialsPath?: string;
  enqueueDocMeta(documentId: string): Promise<void>;
  notify: NotifyFn;
}

export async function fetchLoondossier(deps: LoondossierDeps): Promise<
  { listed: number; new: number; ingested: string[] }> {
  const result = { listed: 0, new: 0, ingested: [] as string[] };
  const creds = await readCredentials(
    deps.credentialsPath ?? process.env.LOONDOSSIER_CREDENTIALS ?? DEFAULT_CREDENTIALS_PATH);
  if (creds === "absent") {
    await recordRun(deps.db, "loondossier", "ok", { skipped: "no credentials" });
    return result;
  }
  if (creds === "invalid") {
    await recordRun(deps.db, "loondossier", "error", { message: "Inloggegevensbestand onleesbaar" });
    return result;
  }
  let failed = 0;
  try {
    const client = deps.client ?? createPortalClient();
    await client.login(creds);
    const files: PortalFile[] = [];
    for (const year of await client.years()) files.push(...await client.files(year));
    result.listed = files.length;

    const refs = files.map(refFor);
    const held = refs.length === 0 ? [] : await deps.db.select({ ref: schema.documents.sourceRef })
      .from(schema.documents)
      .where(and(eq(schema.documents.source, "loondossier"), inArray(schema.documents.sourceRef, refs)));
    const fresh = selectNew(files, new Set(held.map((h) => h.ref ?? "")));
    result.new = fresh.length;

    for (const f of fresh) {
      try {
        const buf = await client.download(f.id);
        const { title, payslip } = titleFor(f.name);
        await storeFile(deps.vaultDir, buf);
        const doc = await deps.db.transaction((tx) => ingestDocument(tx, {
          sha256: sha256Hex(buf), sizeBytes: buf.length,
          mime: f.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
          title, source: "loondossier", sourceRef: refFor(f), receivedAt: f.postedAt,
          ...(payslip || f.fileType?.toLowerCase() === "loonstrook" ? { docType: "loonstrook" } : {}) }));
        // A sha256 hit returns the document the NAS or mail already filed.
        if (doc.source !== "loondossier" || doc.sourceRef !== refFor(f)) continue;
        await deps.enqueueDocMeta(doc.id);
        result.ingested.push(title);
        await deps.notify({ kind: "filing", level: "passive", title: "Nieuwe loonstrook", body: title });
      } catch (err) {
        failed++;
        if (!(err instanceof PortalError)) throw err;
      }
    }
    if (failed > 0)
      await recordRun(deps.db, "loondossier", "error", { ...result, failed,
        message: "Niet alle bestanden konden worden opgehaald" });
    else await recordRun(deps.db, "loondossier", "ok", result);
  } catch (err) {
    await recordRun(deps.db, "loondossier", "error", { ...result,
      message: err instanceof PortalError ? err.message : "Onverwachte fout bij ophalen loonstroken" });
  }
  return result;
}
