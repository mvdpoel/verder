import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, schema, type Db } from "./index";

// Migration 0040 (M-A): the `auto-applied` verdict and the verder actor on
// document_status_changes. The two CHECKs are what keep the new columns from
// becoming a way to relabel Martin's own rows as verder's work, so each is
// exercised through the APP role, the one that actually writes this table.
const ADMIN_URL = "postgres://grip:grip@localhost:5432/grip";
const APP_URL = "postgres://grip_app:grip_app@localhost:5432/grip";
const RUN_REF = `auto-applied-test-${crypto.randomUUID()}`;
// Derived per run: documents.sha256 is UNIQUE and the dev DB is never truncated.
const FIXTURE_SHA = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

describe("migration 0040: auto-applied and the verder actor", () => {
  let admin: Db; let app: Db; let close: () => Promise<void>;
  let documentId: string; let suggestionId: string;

  beforeAll(async () => {
    const a = createDb(ADMIN_URL); const b = createDb(APP_URL);
    admin = a.db; app = b.db;
    close = async () => { await a.pool.end(); await b.pool.end(); };
    const [d] = await app.insert(schema.documents).values({
      sha256: FIXTURE_SHA, title: "Actor fixture.pdf", mime: "application/pdf",
      sizeBytes: 12, source: "upload", sourceRef: RUN_REF, receivedAt: new Date(),
    }).returning();
    documentId = d.id;
    // Keep pendingDocMeta's backlog from growing on the shared dev DB.
    await admin.insert(schema.documentTexts).values({ documentId, sha256: FIXTURE_SHA,
      text: "", extractor: "none", charCount: 0 });
    // A DECIDED suggestion, so the fixture never counts as waiting on Martin.
    const [s] = await app.insert(schema.suggestions).values({
      kind: "document-meta", status: "rejected", documentId,
    }).returning();
    suggestionId = s.id;
  });
  afterAll(() => close());

  it("suggestion_status includes auto-applied", async () => {
    const r = await admin.execute(sql`SELECT unnest(enum_range(NULL::suggestion_status))::text AS v`);
    expect(r.rows.map((row) => String(row.v))).toContain("auto-applied");
  });

  it("actor other than verder is rejected by the check", async () => {
    await expect(app.execute(sql`INSERT INTO document_status_changes
        (document_id, status, title, actor)
        VALUES (${documentId}, 'filed', 'x', 'martin')`))
      .rejects.toThrow(/dsc_actor_ck/);
  });

  it("suggestion_id without actor is rejected by the check", async () => {
    await expect(app.execute(sql`INSERT INTO document_status_changes
        (document_id, status, title, suggestion_id)
        VALUES (${documentId}, 'filed', 'x', ${suggestionId})`))
      .rejects.toThrow(/dsc_suggestion_needs_actor_ck/);
  });

  it("a verder row with or without a suggestion is accepted", async () => {
    const rows = await app.insert(schema.documentStatusChanges).values([
      { documentId, status: "inbox", title: "Actor fixture.pdf", actor: "verder", suggestionId: null },
      { documentId, status: "inbox", title: "Actor fixture.pdf", actor: "verder", suggestionId },
    ]).returning();
    expect(rows.map((r) => r.actor)).toEqual(["verder", "verder"]);
    expect(rows[1].suggestionId).toBe(suggestionId);
  });

  it("grip_app still has no UPDATE on document_status_changes", async () => {
    const r = await admin.execute(sql`SELECT
        has_table_privilege('grip_app', 'document_status_changes', 'UPDATE') AS app_upd,
        has_table_privilege('grip_worker', 'document_status_changes', 'UPDATE') AS worker_upd,
        has_table_privilege('grip_app', 'document_status_changes', 'DELETE') AS app_del,
        has_table_privilege('grip_app', 'document_status_changes', 'INSERT') AS app_ins`);
    expect(r.rows[0]).toEqual({ app_upd: false, worker_upd: false, app_del: false, app_ins: true });
  });
});
