/**
 * The table's selection reducer, pulled out of `files-table.tsx` so it can be
 * tested without a DOM and without guessing at how React reports a shift-click.
 *
 * A plain click always toggles exactly the row at `index`. A shift-click
 * toggles the whole span between `anchor` and `index` (inclusive) to whatever
 * the CLICKED row is about to become — the spreadsheet rule, so a shift-click
 * starting on an already-selected row clears the range instead of adding to
 * it, rather than a fixed "shift always adds".
 *
 * `shift` must already be resolved to a real boolean by the caller — this
 * function does not know how it was produced. For mouse input React's
 * checkbox `onChange` is driven off the native click event, which carries a
 * real `shiftKey`; for keyboard activation (Tab + Space) or assistive tech
 * there is no such property, and NOTHING here or at the call site may guess
 * one. A caller unsure whether `shiftKey` exists on the underlying event must
 * resolve the ambiguous case to `false` before calling this — degrading to a
 * single-row toggle is the only safe default. A wrongly-inferred range could
 * select a document that was never meant to leave the table.
 */
export function nextSelection(
  sel: ReadonlySet<string>,
  ids: readonly string[],
  index: number,
  anchor: number | null,
  shift: boolean,
): Set<string> {
  const next = new Set(sel);
  const span = shift && anchor !== null
    ? ids.slice(Math.min(anchor, index), Math.max(anchor, index) + 1)
    : [ids[index]];
  const turningOn = !sel.has(ids[index]);
  for (const id of span) turningOn ? next.add(id) : next.delete(id);
  return next;
}
