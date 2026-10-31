/**
 * Where a log entry came from — the ONE spelling of the `entry_source` enum.
 * The pgEnum in schema.ts, the zod schemas in the entries and suggestions
 * routers and the Dutch label map are all built from this list, so adding a
 * source is one edit here plus one migration, and a label map that forgets the
 * new value fails to typecheck. Same shape as `doc-sources.ts`.
 *
 * `proposal` (0038) is a mail verder sent for Martin after he approved the
 * final text on his phone: the outbound entry written once Gmail has the
 * message, with `source_ref` = `proposal:<id>`.
 *
 * A leaf module with no imports, published as `@verder/db/entry-sources`,
 * because client components need the vocabulary and the package barrel
 * reaches `pg`.
 */
export const ENTRY_SOURCES = ["manual", "gmail-watch", "nas-watch", "proposal"] as const;

export type EntrySource = (typeof ENTRY_SOURCES)[number];
