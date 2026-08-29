/**
 * Amsterdam calendar arithmetic. PURE: no I/O, no imports.
 *
 * Extracted from money-series.ts, which has followed this rule since the money
 * work: a month is an Amsterdam question, and UTC-instant arithmetic disagrees
 * with it by the offset — enough to file a boundary stop under the wrong month.
 */

const DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit",
});

/** "YYYY-MM-DD" in Amsterdam. */
export function dayKey(d: Date): string {
  return DAY_FMT.format(d);
}

/** "YYYY-MM" in Amsterdam. */
export function monthKey(d: Date): string {
  return dayKey(d).slice(0, 7);
}

const MONTHS = ["januari", "februari", "maart", "april", "mei", "juni",
  "juli", "augustus", "september", "oktober", "november", "december"];

/** "2026-08" → "augustus 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/**
 * Every month from `newest` down to `oldest`, inclusive, newest first —
 * INCLUDING the ones with nothing in them. A quiet stretch is a fact about the
 * case and the map has to be able to show it.
 */
export function monthsBetween(oldest: string, newest: string): string[] {
  const out: string[] = [];
  let [y, m] = newest.split("-").map(Number);
  for (let guard = 0; guard < 1200; guard++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key <= oldest) break;
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}
