import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client";
import { DOC_SOURCES } from "./doc-sources";

const URL = "postgres://verder:verder@localhost:5432/verder";

async function enumValues(): Promise<string[]> {
  const { db, pool } = createDb(URL);
  try {
    const r = await db.execute(sql`SELECT unnest(enum_range(NULL::doc_source))::text AS v`);
    return r.rows.map((row) => String(row.v));
  } finally {
    await pool.end();
  }
}

describe("doc_source", () => {
  it("admits the two phone sources", async () => {
    const values = await enumValues();
    expect(values).toContain("phone-scan");
    expect(values).toContain("phone-share");
  });

  // The TypeScript list is what every zod schema and label map is built from;
  // if it and the database ever disagree, a value either cannot be stored or
  // cannot be filtered on. Order matters too: drizzle-kit diffs on it.
  it("matches DOC_SOURCES exactly, in order", async () => {
    expect(await enumValues()).toEqual([
      "upload", "nas-scan", "email-attachment", "loondossier", "phone-scan", "phone-share",
    ]);
    expect([...DOC_SOURCES]).toEqual(await enumValues());
  });
});
