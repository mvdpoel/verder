/**
 * How a document reached the vault — the ONE spelling of the `doc_source`
 * enum. The pgEnum in schema.ts, every zod schema and every Dutch label map
 * are built from this list, so adding a source is one edit here plus one
 * migration, and a label map that forgets the new value fails to typecheck.
 *
 * A leaf module with no imports, published as `@verder/db/doc-sources`,
 * because client components need the vocabulary and the package barrel
 * reaches `pg`.
 */
export const DOC_SOURCES = [
  "upload", "nas-scan", "email-attachment", "loondossier", "phone-scan", "phone-share",
] as const;

export type DocSource = (typeof DOC_SOURCES)[number];
