/**
 * The two decisions the halte link pickers make, kept pure so they can be
 * tested without React and without a database — the same habit as
 * `track-marks.ts`.
 *
 * A halte stores an ID and nothing else. Names, dates and statuses shown next
 * to a link are read live on every render, so a halte may be AHEAD of reality
 * but can never contradict it.
 */

export type LinkOption = { id: string; label: string };

/**
 * The options a picker shows.
 *
 * `tracks.linkOptions` returns a PAGE of candidates (the most recent ones, or
 * what a search matched). The link a halte already has may not be on that page
 * — an entry from June, a document renamed since. If it were simply missing,
 * the `<select>` would fall back to "— geen —" and the next Opslaan would drop
 * a koppeling Martin never saw and never touched. So the current one is always
 * present, and it leads, because it is the answer to "what is this now?".
 */
export function linkOptionList(
  rows: LinkOption[], current: LinkOption | null
): LinkOption[] {
  if (!current) return rows;
  return rows.some((r) => r.id === current.id) ? rows : [current, ...rows];
}

/**
 * A picker's value as the router wants it.
 *
 * "" is the "— geen —" option, and it must become an explicit `null`, not
 * `undefined`: the router strips undefined so a partial update only touches
 * the columns it was given, which would make a koppeling impossible to REMOVE.
 * Every picker clears back to none.
 */
export function linkId(value: string): string | null {
  return value.trim() || null;
}
