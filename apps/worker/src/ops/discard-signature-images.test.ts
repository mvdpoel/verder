import { afterAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { verifyChain, type ChainEvent } from "@verder/core";
import { createDb, schema } from "@verder/db";
import { appendLedgerEvent } from "@verder/api/src/ledger";
import { effectiveDocument, ingestDocument } from "@verder/api/src/routers/documents";
import { discardSignatureImages, SIGNATURE_IMAGE_INGESTED_BEFORE } from "./discard-signature-images";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("discardSignatureImages", () => {
  const { db, pool } = createDb(URL);
  afterAll(() => pool.end());
  const sha = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "a");
  const seedDocument = (over: {
    title: string; mime: string; source: "upload" | "email-attachment";
  }) => db.transaction((tx) => ingestDocument(tx, {
    sha256: sha(), sizeBytes: 10, receivedAt: new Date(), ...over }));
  // Every test that seeds a fresh fixture passes its own `before`, so the
  // suite cannot start failing once the default cutoff is in the past.
  const RUN = { before: new Date(Date.now() + 60_000) };
  const ledgerCount = async () => (await db.select().from(schema.ledgerEvents)).length;
  // Chain linkage only, exactly as documents.test.ts does it: this dev database
  // is shared and never truncated, so a whole-vault verification cannot be
  // asserted green here — but the hash chain must stay unbroken.
  const verifyLedger = async () => {
    const rows = await db.select().from(schema.ledgerEvents)
      .orderBy(asc(schema.ledgerEvents.seq));
    const events: ChainEvent[] = rows.map((e) => ({ seq: e.seq, eventType: e.eventType,
      entityType: e.entityType, entityId: e.entityId,
      payloadHash: e.payloadHash, prevHash: e.prevHash, eventHash: e.eventHash }));
    return verifyChain(events, (e) => e.payloadHash);
  };

  it("discards email-attachment images named image.png, one ledger event each", async () => {
    const junkA = await seedDocument({ title: "image.png", mime: "image/png",
      source: "email-attachment" });
    const junkB = await seedDocument({ title: "image.png", mime: "image/png",
      source: "email-attachment" });
    const real = await seedDocument({ title: "Beschikking.pdf", mime: "application/pdf",
      source: "email-attachment" });
    const upload = await seedDocument({ title: "image.png", mime: "image/png",
      source: "upload" });

    const before = await ledgerCount();
    const out = await discardSignatureImages(db, RUN);

    // At least our two: the shared dev database carries signature images left
    // behind by other test files, and the backfill is deliberately global.
    expect(out.discarded).toBeGreaterThanOrEqual(2);
    // One ledger event per discard, exactly — that is the append-only law here.
    expect(await ledgerCount()).toBe(before + out.discarded);
    expect(out.scanned).toBe(out.discarded + out.skipped);

    expect((await effectiveDocument(db, junkA.id)).effectiveStatus).toBe("discarded");
    expect((await effectiveDocument(db, junkB.id)).effectiveStatus).toBe("discarded");
    // A real attachment and a hand-uploaded file are never touched.
    expect((await effectiveDocument(db, real.id)).effectiveStatus).toBe("inbox");
    expect((await effectiveDocument(db, upload.id)).effectiveStatus).toBe("inbox");

    // Nothing is deleted: the rows and their bytes are still there.
    const [row] = await db.select().from(schema.documents)
      .where(eq(schema.documents.id, junkA.id));
    expect(row.sha256).toBe(junkA.sha256);
  });

  it("is idempotent — a second run appends nothing", async () => {
    await seedDocument({ title: "image.png", mime: "image/png",
      source: "email-attachment" });
    await discardSignatureImages(db, RUN);
    const after = await ledgerCount();

    const second = await discardSignatureImages(db, RUN);
    expect(second.discarded).toBe(0);
    // Everything it scanned was already discarded — the count itself cannot be
    // pinned, because the corpus is shared, but "all of it" can.
    expect(second.skipped).toBe(second.scanned);
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    expect(await ledgerCount()).toBe(after);
  });

  it("names every document it is about to touch, before touching it", async () => {
    const junk = await seedDocument({ title: "image.png", mime: "image/png",
      source: "email-attachment" });
    const lines: string[] = [];
    const out = await discardSignatureImages(db, { ...RUN, log: (l) => lines.push(l) });
    // One line per discard, and it identifies the row — this writes to the
    // evidence record, so the log has to say what it did.
    expect(lines).toHaveLength(out.discarded);
    expect(lines.some((l) => l.includes(junk.id) && l.includes("image.png"))).toBe(true);
  });

  it("never overrides a document Martin filed himself", async () => {
    // `image.png` is exactly the filename Gmail, Apple Mail and Outlook give a
    // pasted-from-clipboard image — a screenshot of a payment overview, a photo
    // of a letter — sent as a genuine attachment. Those are precisely the parts
    // the port filter now KEEPS, so they survive into this population. This
    // script is registered as a permanent pnpm script and written into
    // docs/deploy.md, so it WILL run again after a restore or a later deploy.
    // At that point an explicit human judgement must win over a title match.
    const kept = await seedDocument({ title: "image.png", mime: "image/png",
      source: "email-attachment" });
    await db.transaction(async (tx) => {
      await tx.insert(schema.documentStatusChanges).values({
        documentId: kept.id, status: "filed", title: "Betaaloverzicht ING.png" });
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: kept.id,
        payload: { id: kept.id, status: "filed",
          title: "Betaaloverzicht ING.png", docType: null } });
    });

    const out = await discardSignatureImages(db, RUN);

    expect((await effectiveDocument(db, kept.id)).effectiveStatus).toBe("filed");
    expect(out.scanned).toBe(out.discarded + out.skipped);
  });

  it("ignores documents ingested after the population it was measured against", async () => {
    // The doc comment's justification — "on 2026-08-20 it matched all nine and
    // nothing else" — is a measurement of one instant. Without a bound the
    // query does not encode it, and a re-run months later sweeps up every
    // image.png that arrived since.
    const later = await seedDocument({ title: "image.png", mime: "image/png",
      source: "email-attachment" });

    const out = await discardSignatureImages(db, { before: new Date("2020-01-01T00:00:00Z") });

    expect(out.scanned).toBe(0);
    expect(out.discarded).toBe(0);
    expect((await effectiveDocument(db, later.id)).effectiveStatus).toBe("inbox");
  });

  it("bounds the default run to the day the nine were measured", () => {
    // Not a tautology: it is the one place the constant's meaning is written
    // down as an assertion rather than a comment, and the tests above pass an
    // explicit `before` so they cannot silently rot past this date.
    expect(SIGNATURE_IMAGE_INGESTED_BEFORE.toISOString()).toBe("2026-08-21T00:00:00.000Z");
  });

  it("leaves the ledger chain verifying", async () => {
    await seedDocument({ title: "image.png", mime: "image/png",
      source: "email-attachment" });
    await discardSignatureImages(db, RUN);
    await expect(verifyLedger()).resolves.toMatchObject({ ok: true });
  });
});
