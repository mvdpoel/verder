import { afterAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { verifyChain, type ChainEvent } from "@verder/core";
import { createDb, schema } from "@verder/db";
import { effectiveDocument, ingestDocument } from "@verder/api/src/routers/documents";
import { discardSignatureImages } from "./discard-signature-images";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("discardSignatureImages", () => {
  const { db, pool } = createDb(URL);
  afterAll(() => pool.end());
  const sha = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "a");
  const seedDocument = (over: {
    title: string; mime: string; source: "upload" | "email-attachment";
  }) => db.transaction((tx) => ingestDocument(tx, {
    sha256: sha(), sizeBytes: 10, receivedAt: new Date(), ...over }));
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
    const out = await discardSignatureImages(db);

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
    await discardSignatureImages(db);
    const after = await ledgerCount();

    const second = await discardSignatureImages(db);
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
    const out = await discardSignatureImages(db, { log: (l) => lines.push(l) });
    // One line per discard, and it identifies the row — this writes to the
    // evidence record, so the log has to say what it did.
    expect(lines).toHaveLength(out.discarded);
    expect(lines.some((l) => l.includes(junk.id) && l.includes("image.png"))).toBe(true);
  });

  it("leaves the ledger chain verifying", async () => {
    await seedDocument({ title: "image.png", mime: "image/png",
      source: "email-attachment" });
    await discardSignatureImages(db);
    await expect(verifyLedger()).resolves.toMatchObject({ ok: true });
  });
});
