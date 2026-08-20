import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { LINKABLE_ENTITY_TYPES, entityHref, recentEntities } from "./recent";

const ID = "11111111-1111-1111-1111-111111111111";

describe("entityHref", () => {
  it("maps every linkable type to a real route under apps/web/src/app/(app)", () => {
    expect(entityHref("document", ID)).toBe(`/vault/${ID}`);
    expect(entityHref("entry", ID)).toBe(`/logbook/${ID}`);
    expect(entityHref("financial_item", ID)).toBe(`/registry/${ID}`);
    expect(entityHref("debt", ID)).toBe(`/registry/debts/${ID}`);
    expect(entityHref("task", ID)).toBe(`/tasks/${ID}`);
    expect(entityHref("milestone", ID)).toBe("/milestones");
    expect(entityHref("timeline_event", ID)).toBe("/timeline");
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
});
