import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { appendLedgerEvent } from "./ledger";
import { setTaskStatus } from "./task-decide";
import { documentStatusChangePayload } from "./verification";
import { resolveStopEvidence } from "./track-evidence";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

// The dev postgres is shared: every assertion is scoped to rows this suite made.
describe("resolveStopEvidence", () => {
  let db: Db; let userId: string;
  let entryId: string; let documentId: string; let gmailId: string;

  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `stops${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;

    gmailId = `gmail-${Date.now()}`;
    const sha = createHash("sha256").update(gmailId).digest("hex");
    const [doc] = await db.insert(schema.documents).values({
      title: "Beschikking.pdf", source: "email-attachment", sourceRef: gmailId,
      sha256: sha, mime: "application/pdf", sizeBytes: 10, receivedAt: new Date(),
    }).returning();
    documentId = doc.id;

    await db.insert(schema.rawEmails).values({
      gmailMessageId: gmailId, gmailThreadId: `thread-${gmailId}`,
      fromAddr: "demi@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
      subject: "Uitnodiging intake", sentAt: new Date("2026-06-12T09:00:00Z"),
      rawRfc822Sha256: createHash("sha256").update(`raw-${gmailId}`).digest("hex"),
      bodyText: "Beste Martin,",
    });

    const [entry] = await db.insert(schema.logEntries).values({
      occurredAt: new Date("2026-06-12T09:00:00Z"), channel: "email",
      direction: "inbound", summary: "Uitnodiging intake van Demi",
      source: "gmail-watch", createdBy: userId,
    }).returning();
    entryId = entry.id;
    await db.insert(schema.entryDocuments).values({ entryId, documentId });
  });

  it("resolves the entry, its documents and the e-mail behind them", async () => {
    const found = await resolveStopEvidence(db, [
      { id: "s1", entryId, taskId: null, documentId: null },
    ]);
    const e = found.get("s1")!;
    expect(e.entry?.summary).toBe("Uitnodiging intake van Demi");
    expect(e.entry?.channel).toBe("email"); // the entry's channel, not the stop's kind
    expect(e.documents.map((d) => d.id)).toContain(documentId);
    expect(e.email?.subject).toBe("Uitnodiging intake");
  });

  it("returns an entry for every stop asked about, even an empty one", async () => {
    const found = await resolveStopEvidence(db, [
      { id: "leeg", entryId: null, taskId: null, documentId: null },
    ]);
    const e = found.get("leeg")!;
    expect(e.entry).toBeNull();
    expect(e.documents).toEqual([]);
    expect(e.email).toBeNull();
  });

  it("yields no e-mail — and no error — when the source ref matches nothing", async () => {
    const sha = createHash("sha256").update(`orphan-${Date.now()}`).digest("hex");
    const [orphan] = await db.insert(schema.documents).values({
      title: "los.pdf", source: "email-attachment", sourceRef: "gmail-does-not-exist",
      sha256: sha, mime: "application/pdf", sizeBytes: 4, receivedAt: new Date(),
    }).returning();
    const found = await resolveStopEvidence(db, [
      { id: "s2", entryId: null, taskId: null, documentId: orphan.id },
    ]);
    expect(found.get("s2")!.email).toBeNull();
    expect(found.get("s2")!.documents.map((d) => d.id)).toEqual([orphan.id]);
  });

  it("reads one query per link type, not one per stop", async () => {
    // Fifty stops must not mean fifty round trips. The registry's N+1 was found
    // in production code twice; this one starts batched and stays batched.
    //
    // The fifty task ids are DISTINCT on purpose. The first version of this
    // fixture set taskId: null on all fifty, which cannot see a lookup that
    // fires once per LINKED TASK — and that lookup was there.
    const stamp = Date.now();
    const [waiting] = await db.insert(schema.tasks)
      .values({ title: `Batch wachten ${stamp}`, createdBy: userId }).returning();
    await db.transaction((tx) =>
      setTaskStatus(tx, userId, { taskId: waiting.id, status: "waiting" }));
    const [fresh] = await db.insert(schema.tasks)
      .values({ title: `Batch nieuw ${stamp}`, createdBy: userId }).returning();

    // The other 48 point at tasks that are not there: a stop may legitimately
    // point at something that does not resolve, and the count is about how many
    // round trips the linked task IDS cost, not how many of them resolve.
    const many = [
      { id: "bulk-waiting", entryId, taskId: waiting.id, documentId: null },
      { id: "bulk-fresh", entryId, taskId: fresh.id, documentId: null },
      ...Array.from({ length: 48 }, (_, n) => ({
        id: `bulk-${n}`, entryId, taskId: randomUUID(), documentId: null,
      })),
    ];
    let queries = 0;
    const counted = new Proxy(db, {
      get(target, prop, receiver) {
        // Both query starters. A batch that moves to selectDistinctOn must not
        // become invisible to the counter that is supposed to police it.
        if (prop === "select" || prop === "selectDistinctOn") queries++;
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
    const found = await resolveStopEvidence(counted, many);
    expect(queries).toBeLessThanOrEqual(6);
    // Batched, and still right: the status that exists, and the default for a
    // task nobody has decided on.
    expect(found.get("bulk-waiting")!.task?.status).toBe("waiting");
    expect(found.get("bulk-fresh")!.task?.status).toBe("open");
  });

  it("reads a task's status from its status changes, not from the task row", async () => {
    const [task] = await db.insert(schema.tasks).values({
      title: "Loonstrook opsturen", dueAt: new Date("2026-07-01T00:00:00Z"),
      createdBy: userId,
    }).returning();
    await db.transaction((tx) =>
      setTaskStatus(tx, userId, { taskId: task.id, status: "waiting" }));

    const found = await resolveStopEvidence(db, [
      { id: "s3", entryId: null, taskId: task.id, documentId: null },
    ]);
    // "waiting" lives only in task_status_changes — tasks has no status column,
    // so anything but effectiveTaskStatus would have to invent one.
    expect(found.get("s3")!.task).toEqual({
      id: task.id, title: "Loonstrook opsturen", status: "waiting",
      dueAt: new Date("2026-07-01T00:00:00Z"),
    });
  });

  it("does not offer a discarded document, and reads its live title", async () => {
    const stamp = Date.now();
    const [renamed] = await db.insert(schema.documents).values({
      title: "image.png", source: "email-attachment", sourceRef: `gmail-live-${stamp}`,
      sha256: createHash("sha256").update(`live-${stamp}`).digest("hex"),
      mime: "application/pdf", sizeBytes: 7, receivedAt: new Date(),
    }).returning();
    const [gone] = await db.insert(schema.documents).values({
      title: "logo.png", source: "email-attachment", sourceRef: `gmail-gone-${stamp}`,
      sha256: createHash("sha256").update(`gone-${stamp}`).digest("hex"),
      mime: "image/png", sizeBytes: 3, receivedAt: new Date(),
    }).returning();

    // Both writes go through the append-only path with their ledger event, the
    // way documents.update does it — a status change without one is tampering.
    for (const [doc, status, title] of [
      [renamed, "filed", "Beschikking VerderGroep.pdf"],
      [gone, "discarded", null],
    ] as const) {
      await db.transaction(async (tx) => {
        const [change] = await tx.insert(schema.documentStatusChanges)
          .values({ documentId: doc.id, status, title }).returning();
        await appendLedgerEvent(tx, {
          eventType: "document.updated", entityType: "document", entityId: doc.id,
          payload: documentStatusChangePayload(change),
        });
      });
    }

    const found = await resolveStopEvidence(db, [
      { id: "s4", entryId: null, taskId: null, documentId: renamed.id },
      { id: "s5", entryId: null, taskId: null, documentId: gone.id },
    ]);
    expect(found.get("s4")!.documents).toEqual([
      { id: renamed.id, title: "Beschikking VerderGroep.pdf", mime: "application/pdf" },
    ]);
    // The discard is appended, never written back to documents.status, so a raw
    // read would still hand Martin the signature image he threw away.
    expect(found.get("s5")!.documents).toEqual([]);
    expect(found.get("s5")!.email).toBeNull();
  });
});
