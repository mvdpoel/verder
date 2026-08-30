import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { LINKABLE_ENTITY_TYPES, entityHref, recentEntities } from "./recent";

const ID = "11111111-1111-1111-1111-111111111111";

describe("entityHref", () => {
  it("maps every linkable type to a real route under apps/web/src/app/(app)", () => {
    expect(entityHref("document", ID)).toBe(`/files/${ID}`);
    expect(entityHref("entry", ID)).toBe(`/logbook/${ID}`);
    expect(entityHref("financial_item", ID)).toBe(`/registry/${ID}`);
    expect(entityHref("debt", ID)).toBe(`/registry/debts/${ID}`);
    expect(entityHref("task", ID)).toBe(`/tasks/${ID}`);
    expect(entityHref("track", ID)).toBe("/timeline");
    expect(entityHref("stop", ID)).toBe(`/timeline?stop=${ID}`);
  });

  it("covers the whole linkable list, so no row can render without a target", () => {
    for (const t of LINKABLE_ENTITY_TYPES) {
      expect(entityHref(t, ID), t).toMatch(/^\//);
    }
  });
});

// The app role only holds SELECT on search_chunks (migration 0016), so fixtures
// are written with the worker role and read back with the app role — the same
// split production runs with.
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("recentEntities", () => {
  let app: Db; let worker: Db;
  beforeAll(() => {
    app = createDb(APP_URL).db;
    worker = createDb(WORKER_URL).db;
  });

  it("returns the newest-indexed head chunks with their route, capped at the limit", async () => {
    const entityId = crypto.randomUUID();
    await worker.insert(schema.searchChunks).values([
      { entityType: "task", entityId, chunkIndex: 0, title: "Palette probe head",
        body: "eerste stuk", sourceHash: crypto.randomUUID() },
      { entityType: "task", entityId, chunkIndex: 1, title: "Palette probe tail",
        body: "tweede stuk", sourceHash: crypto.randomUUID() },
    ]);

    const rows = await recentEntities(app, 8);
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(rows[0].entityId).toBe(entityId);
    expect(rows[0].title).toBe("Palette probe head");
    expect(rows[0].href).toBe(`/tasks/${entityId}`);
    // chunk_index > 0 must never appear: one long document may not fill the list.
    expect(rows.some((r) => r.title === "Palette probe tail")).toBe(false);
  });

  it("never lists a discarded document, but keeps the statusless ones", async () => {
    // Discard enqueues a reindex, so a just-discarded signature logo would arrive at
    // the very TOP of this indexed_at-ordered list — the worst possible place for it.
    const junk = crypto.randomUUID();
    const keep = crypto.randomUUID();
    await worker.insert(schema.searchChunks).values([
      { entityType: "document", entityId: junk, chunkIndex: 0, title: "Palette probe junk",
        body: "handtekening logo", status: "discarded", sourceHash: crypto.randomUUID() },
      // No status at all: most entity types have none, and they must survive the filter.
      { entityType: "task", entityId: keep, chunkIndex: 0, title: "Palette probe statusless",
        body: "iets te doen", sourceHash: crypto.randomUUID() },
    ]);

    const rows = await recentEntities(app, 8);
    expect(rows.some((r) => r.title === "Palette probe junk")).toBe(false);
    expect(rows.some((r) => r.title === "Palette probe statusless")).toBe(true);
  });

  it("never lists a record type the palette cannot open", async () => {
    await worker.insert(schema.searchChunks).values({
      entityType: "party", entityId: crypto.randomUUID(), chunkIndex: 0,
      title: "Palette probe party", body: "Naam: VerderGroep",
      sourceHash: crypto.randomUUID(),
    });

    const rows = await recentEntities(app, 8);
    expect(rows.some((r) => r.title === "Palette probe party")).toBe(false);
    for (const r of rows) {
      expect(LINKABLE_ENTITY_TYPES as readonly string[]).toContain(r.entityType);
    }
  });

  it("skips a chunk left behind by a retired entity kind", async () => {
    // entity_type is TEXT, and the milestone/timeline_event chunks written before
    // sub-project 6 outlive the swap — `reindex --prune` walks the CURRENT
    // vocabulary and never visits them. entityHref has no case for one, so it
    // would hand the palette a row whose href is undefined.
    const [probe] = await worker.insert(schema.searchChunks).values({
      entityType: "milestone", entityId: crypto.randomUUID(), chunkIndex: 0,
      title: "Palette probe retired kind", body: "Mijlpaal uit een vorige versie",
      sourceHash: crypto.randomUUID(),
    }).returning();

    const rows = await recentEntities(app, 8);
    expect(rows.some((r) => r.title === "Palette probe retired kind")).toBe(false);
    for (const r of rows) expect(r.href).toMatch(/^\//);

    // The dev database is shared, and tracks-schema.test.ts asserts that
    // migration 0023's DELETE holds: NO chunk of a retired kind anywhere. This
    // probe must not outlive its own test, or it fails that one on the next
    // run. search_chunks is derived, so deleting from it is legal.
    await worker.delete(schema.searchChunks)
      .where(eq(schema.searchChunks.id, probe.id));
  });
});
