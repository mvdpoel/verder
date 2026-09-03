/**
 * The tombstone's first line. Pure and separate from the JSX for the reason
 * `discardAction` is: a client component cannot be unit-tested directly, but
 * the copy that must be right can be. This module in particular carries NO
 * "use client" and NO React import — `document-purge.tsx` pulls in
 * `next/navigation` and the trpc client, and a unit test importing the copy
 * through that file would drag all of it into a node-environment vitest run.
 *
 * Amsterdam, not UTC: a purge at 00:30 CEST is the 3rd here and the 2nd in UTC,
 * and this line is read by someone in Almere. The dash is omitted rather than
 * left dangling when no reason was given — the field is optional by design, so
 * the blank case is the normal one, not the edge one.
 */
export function purgeTombstoneLine(
  purge: { at: Date; reason: string | null; sizeBytes: number },
): string {
  const d = new Intl.DateTimeFormat("nl-NL", {
    timeZone: "Europe/Amsterdam", day: "2-digit", month: "2-digit", year: "numeric",
  }).format(purge.at);
  const head = `Definitief verwijderd op ${d}`;
  return purge.reason ? `${head} — ${purge.reason}` : head;
}
