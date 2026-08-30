import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { effectiveDocStatusSql, notDiscardedSql } from "./effective-status";

// queryChunks holds StringChunk/SQL objects, not plain strings — joining them
// with Array.prototype.join stringifies each via the default Object.prototype
// toString ("[object Object]"), so PgDialect is what actually renders the SQL
// text these assertions need to inspect.
const dialect = new PgDialect();
const render = (q: { queryChunks: unknown[] }) =>
  dialect.sqlToQuery(q as Parameters<PgDialect["sqlToQuery"]>[0]).sql;

describe("effective document status", () => {
  it("resolves through document_status_changes, newest first", () => {
    const q = render(effectiveDocStatusSql);
    expect(q).toContain("document_status_changes");
    expect(q).toContain("ORDER BY c.created_at DESC");
    expect(q).toContain("LIMIT 1");
  });

  // NULL <> 'discarded' is NULL, which drops every row whose status is unknown.
  // Six copies of this expression exist; this test is what keeps the rewrite
  // that "simplifies" it to <> from ever landing.
  it("uses IS DISTINCT FROM and never <>", () => {
    const q = render(notDiscardedSql);
    expect(q).toContain("IS DISTINCT FROM");
    expect(q).not.toMatch(/<>\s*'discarded'/);
  });
});
