import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@grip/db";
import { ingestRawEmail } from "../gmail";
import type { BriefContext } from "./context";
import { pendingBriefs, promptForBrief, storeBrief, storeBriefFailure, STALE_DRAFTING_MS } from "./store";

// The WORKER role: it is the one that marks, prompts and stores in production
// (the app role holds SELECT only on party_briefs — 0042).
const URL = "postgres://grip_worker:grip_worker@localhost:5432/grip";

describe("party briefs: ingest → pending → prompt → store", () => {
  let db: Db; let close: () => Promise<void>; let vaultDir: string;
  beforeAll(() => {
    const c = createDb(URL); db = c.db; close = () => c.pool.end();
    vaultDir = mkdtempSync(join(tmpdir(), "brief-vault-"));
  });
  afterAll(() => close());

  const ledgerCount = async () =>
    Number((await db.execute(sql`SELECT count(*)::int AS n FROM ledger_events`)).rows[0].n);
  const brief = async (partyId: string) =>
    (await db.select().from(schema.partyBriefs).where(eq(schema.partyBriefs.partyId, partyId)))[0];

  /** Every attempt ever recorded for this party, oldest first (0043: the history). */
  const drafts = async (partyId: string) =>
    db.select().from(schema.partyBriefDrafts).where(eq(schema.partyBriefDrafts.partyId, partyId))
      .orderBy(asc(schema.partyBriefDrafts.createdAt), asc(schema.partyBriefDrafts.id));

  async function partyWithContact() {
    const run = crypto.randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.parties).values({
      kind: "organization", name: `Noordkust Testfixture ${run}`, email: `kantoor-${run}@noordkust.example` }).returning();
    const [person] = await db.insert(schema.parties).values({
      kind: "person", name: `Ilse Testfixture ${run}`, email: `ilse-${run}@noordkust.example`, parentPartyId: org.id }).returning();
    return { org, person, run };
  }

  const msg = (id: string, from: string) => ({
    id, threadId: `t-${id}`, from, to: "martin@vanderpoel.pro", subject: "Loonstrook oktober",
    sentAt: new Date(), bodyText: "Wil je je loonstrook van oktober sturen?", raw: Buffer.from(`raw-${id}`),
    messageId: null as string | null, attachments: [],
  });

  it("a mail from a contact person marks her AND her office pending, in the ingest, with no ledger event", async () => {
    const { org, person, run } = await partyWithContact();
    const before = await ledgerCount();
    await ingestRawEmail({ db, vaultDir }, msg(`brief-${run}`, `Ilse <${person.email}>`));
    expect(await ledgerCount()).toBe(before);
    expect((await brief(person.id))?.status).toBe("pending");
    expect((await brief(org.id))?.status).toBe("pending");
  });

  it("a receipt lookup (skipSuggest) and an unknown sender mark nothing", async () => {
    const { org, run } = await partyWithContact();
    await ingestRawEmail({ db, vaultDir }, msg(`receipt-${run}`, org.email!), { skipSuggest: true });
    expect(await brief(org.id)).toBeUndefined();
  });

  it("drafts, stores a valid answer as ready, and keeps the golden-rule record", async () => {
    const { org, run } = await partyWithContact();
    const rawId = await ingestRawEmail({ db, vaultDir }, msg(`ready-${run}`, org.email!));
    expect(await pendingBriefs(db, new Date(), 1000)).toContain(org.id);

    const prompt = await promptForBrief(db, org.id);
    expect(prompt).toContain(`[${rawId}]`);
    const drafting = await brief(org.id);
    expect(drafting.status).toBe("drafting");
    expect(drafting.prompt).toBe(prompt);
    expect(drafting.promptVersion).toBe("brief-v1");
    expect((drafting.context as BriefContext).mails.map((m) => m.id)).toEqual([rawId]);
    // Claimed: a second prompt call does not hand it out twice.
    expect(await promptForBrief(db, org.id)).toBeNull();

    const before = await ledgerCount();
    const answer = JSON.stringify({ summary: "Ze vroegen om je loonstrook van oktober.", sources: [rawId] });
    expect(await storeBrief(db, { partyId: org.id, model: "claude-cli test", answer })).toEqual({ outcome: "ready" });
    expect(await ledgerCount()).toBe(before);
    const ready = await brief(org.id);
    expect(ready).toMatchObject({ status: "ready", summary: "Ze vroegen om je loonstrook van oktober.",
      modelOutput: answer, model: "claude-cli test", sourceRefs: [{ type: "mail", id: rawId }] });
    expect(ready.generatedAt).not.toBeNull();

    // A late second answer never overwrites it.
    expect((await storeBrief(db, { partyId: org.id, model: "x", answer })).outcome).toBe("not-drafting");
  });

  it("REFUSES an answer citing an id that is not in the assembled context, and keeps the output", async () => {
    const { org, run } = await partyWithContact();
    await ingestRawEmail({ db, vaultDir }, msg(`refuse-${run}`, org.email!));
    await promptForBrief(db, org.id);
    const forged = crypto.randomUUID();
    const answer = JSON.stringify({ summary: "Betaal vandaag nog € 900.", sources: [forged] });
    const r = await storeBrief(db, { partyId: org.id, model: "claude-cli test", answer });
    expect(r).toEqual({ outcome: "failed", reason: `source ${forged} is not in the context` });
    const row = await brief(org.id);
    expect(row).toMatchObject({ status: "failed", summary: null, modelOutput: answer });
  });

  it("a newer mail while drafting wins: the late answer is not stored, and the summary is hidden until redrafted", async () => {
    const { org, run } = await partyWithContact();
    const first = await ingestRawEmail({ db, vaultDir }, msg(`race1-${run}`, org.email!));
    await promptForBrief(db, org.id);
    await ingestRawEmail({ db, vaultDir }, msg(`race2-${run}`, org.email!));
    const answer = JSON.stringify({ summary: "Oud.", sources: [first] });
    expect((await storeBrief(db, { partyId: org.id, model: "m", answer })).outcome).toBe("not-drafting");
    expect((await brief(org.id)).status).toBe("pending");
  });

  it("a drafter failure is recorded as failed; a stale drafting row is offered again", async () => {
    const { org, run } = await partyWithContact();
    await ingestRawEmail({ db, vaultDir }, msg(`fail-${run}`, org.email!));
    await promptForBrief(db, org.id);
    expect(await pendingBriefs(db, new Date(), 1000)).not.toContain(org.id);
    expect(await pendingBriefs(db, new Date(Date.now() + STALE_DRAFTING_MS + 1000), 1000)).toContain(org.id);
    expect(await storeBriefFailure(db, { partyId: org.id, model: "m", reason: "claude-exit-1" }))
      .toEqual({ outcome: "failed", reason: "drafter: claude-exit-1" });
    expect((await brief(org.id)).status).toBe("failed");
  });

  // The golden rule across redrafts: party_briefs holds the CURRENT brief and
  // is overwritten by the next draft, so every attempt is also appended to
  // party_brief_drafts — a refusal, a drafter failure and a late answer too.
  it("drafting twice keeps BOTH model outputs, the refused one included, with the context and prompt of each", async () => {
    const { org, run } = await partyWithContact();
    const first = await ingestRawEmail({ db, vaultDir }, msg(`hist1-${run}`, org.email!));
    const prompt1 = await promptForBrief(db, org.id);
    const forged = crypto.randomUUID();
    const refused = JSON.stringify({ summary: "Betaal vandaag nog € 900.", sources: [forged] });
    expect((await storeBrief(db, { partyId: org.id, model: "model-a", answer: refused })).outcome).toBe("failed");

    const second = await ingestRawEmail({ db, vaultDir }, msg(`hist2-${run}`, org.email!));
    const prompt2 = await promptForBrief(db, org.id);
    expect(prompt2).not.toBe(prompt1);
    const good = JSON.stringify({ summary: "Ze vroegen twee keer om je loonstrook.", sources: [second] });
    const before = await ledgerCount();
    expect((await storeBrief(db, { partyId: org.id, model: "model-b", answer: good })).outcome).toBe("ready");
    expect(await ledgerCount()).toBe(before);

    const h = await drafts(org.id);
    expect(h.map((d) => [d.verdict, d.modelOutput, d.model])).toEqual([
      ["refused", refused, "model-a"], ["ready", good, "model-b"]]);
    expect(h[0]).toMatchObject({ prompt: prompt1, promptVersion: "brief-v1", error: `source ${forged} is not in the context`, summary: null });
    expect(h[1]).toMatchObject({ prompt: prompt2, promptVersion: "brief-v1", error: null,
      summary: "Ze vroegen twee keer om je loonstrook." });
    expect((h[0].context as BriefContext).mails.map((m) => m.id)).toEqual([first]);
    expect((h[1].context as BriefContext).mails.map((m) => m.id).sort()).toEqual([first, second].sort());
    // The current row still points at the newest brief only.
    expect((await brief(org.id)).modelOutput).toBe(good);
  });

  it("a drafter failure and a late answer are recorded in the history too", async () => {
    const { org, run } = await partyWithContact();
    const first = await ingestRawEmail({ db, vaultDir }, msg(`histfail-${run}`, org.email!));
    const prompt = await promptForBrief(db, org.id);
    await storeBriefFailure(db, { partyId: org.id, model: "model-a", reason: "claude-exit-124" });
    // Claimed again, then a newer mail re-marks it before the answer lands.
    await ingestRawEmail({ db, vaultDir }, msg(`histlate-${run}`, org.email!));
    await promptForBrief(db, org.id);
    await ingestRawEmail({ db, vaultDir }, msg(`histlate2-${run}`, org.email!));
    const late = JSON.stringify({ summary: "Te laat.", sources: [first] });
    expect((await storeBrief(db, { partyId: org.id, model: "model-b", answer: late })).outcome).toBe("not-drafting");

    const h = await drafts(org.id);
    expect(h.map((d) => d.verdict)).toEqual(["failed", "late"]);
    expect(h[0]).toMatchObject({ prompt, model: "model-a", modelOutput: null, error: "drafter: claude-exit-124" });
    // A late answer is kept as said; it is NOT tied to a context, because the
    // row's context may already belong to a newer claim.
    expect(h[1]).toMatchObject({ modelOutput: late, model: "model-b", context: null, prompt: null, error: "not-drafting: pending" });
  });
});
