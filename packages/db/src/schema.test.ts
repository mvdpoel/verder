import { describe, expect, it } from "vitest";
import { createDb } from "./client";
import * as schema from "./schema";

const url = process.env.DATABASE_URL ?? "postgres://grip:grip@localhost:5432/grip";

describe("schema", () => {
  it("inserts and reads a party", async () => {
    const { db, pool } = createDb(url);
    const [p] = await db.insert(schema.parties)
      .values({ kind: "organization", name: "VerderGroep" }).returning();
    expect(p.id).toBeTruthy();
    const found = await db.select().from(schema.parties);
    expect(found.some((r) => r.id === p.id)).toBe(true);
    await pool.end();
  });

  it("stores retrieval citations on a suggestion without touching proposed", async () => {
    const { db, pool } = createDb(url);
    const [s] = await db.insert(schema.suggestions).values({
      kind: "log-entry",
      model: "qwen3.5:9b",
      promptVersion: "entry-v1",
      proposed: { summary: "VerderGroep vraagt loonstroken" },
      retrievedRefs: [{
        entityType: "document", entityId: crypto.randomUUID(),
        title: "Loonstrook juni", score: 0.031, snippet: "…loonstrook juni 2026…",
      }],
    }).returning();
    expect(s.retrievedRefs).toHaveLength(1);
    // Provenance lives beside the proposal, never inside it: `proposed` is
    // diffed against `final_payload` to record Martin's edits (golden rule).
    expect((s.proposed as Record<string, unknown>).retrievedRefs).toBeUndefined();
    await pool.end();
  });
});

describe("APP_ACTOR", () => {
  // The app was renamed verder → Grip on 2026-11-04, but this stored value is
  // hashed into ledgered `document.updated` payloads and pinned by
  // dsc_actor_ck. Changing it would make /verify report every auto-file and
  // auto-name change as tampering. It must stay "verder".
  it("is the historic stored value 'verder', not the app's new name", () => {
    expect(schema.APP_ACTOR).toBe("verder");
  });
});
