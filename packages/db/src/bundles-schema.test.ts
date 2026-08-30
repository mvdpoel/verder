import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./index";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("migration 0032", () => {
  const { db } = createDb(APP_URL);

  it("keeps documents append-only for the app role", async () => {
    const { rows: [row] } = await db.execute<{ can: boolean }>(sql`
      SELECT has_table_privilege('verder_app','documents','UPDATE') AS can`);
    expect(row.can).toBe(false);
  });

  it("lets the app role delete a bundle link but never a document", async () => {
    const { rows: [bundle] } = await db.execute<{ can: boolean }>(sql`
      SELECT has_table_privilege('verder_app','bundle_documents','DELETE') AS can`);
    expect(bundle.can).toBe(true);
    const { rows: [doc] } = await db.execute<{ can: boolean }>(sql`
      SELECT has_table_privilege('verder_app','documents','DELETE') AS can`);
    expect(doc.can).toBe(false);
  });

  it("refuses a manual bundle that carries a rule", async () => {
    await expect(db.execute(sql`
      INSERT INTO bundles (name, kind, rule) VALUES ('bad', 'manual', '{}'::jsonb)`))
      .rejects.toThrow(/bundles_rule_ck/);
  });

  it("refuses a rule bundle with no rule", async () => {
    await expect(db.execute(sql`
      INSERT INTO bundles (name, kind) VALUES ('bad', 'rule')`))
      .rejects.toThrow(/bundles_rule_ck/);
  });

  it("carries a party column on both document tables", async () => {
    const { rows: [row] } = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name IN ('documents','document_status_changes')
        AND column_name = 'party_id'`);
    expect(row.n).toBe(2);
  });
});
