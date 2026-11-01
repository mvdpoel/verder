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
 * A month key as a single number, so two of them can be subtracted. Months
 * since year 0 — the origin is arbitrary and never leaves this module; only
 * differences are meaningful.
 */
export function monthIndex(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return y * 12 + (m - 1);
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

/**
 * A day key moved by `n` civil days. The key is already Amsterdam-local, so UTC
 * is used only as a calendar: no instant is formed, and the 23- and 25-hour
 * DST days cannot shift the answer (money-series.ts's `nextDay` discipline).
 */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** ISO weekday of a day key: 1 = Monday … 7 = Sunday. */
export function isoWeekday(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return dow === 0 ? 7 : dow;
}

/**
 * The seven Amsterdam civil days containing `day`, starting on ISO weekday
 * `startsOn` (1 = Monday, the default; 7 = Sunday). Computed on day keys only.
 */
export function weekBounds(day: string, startsOn = 1): { from: string; to: string } {
  if (!Number.isInteger(startsOn) || startsOn < 1 || startsOn > 7) {
    throw new RangeError(`weekBounds: startsOn must be an ISO weekday 1..7, got ${startsOn}`);
  }
  const back = (isoWeekday(day) - startsOn + 7) % 7;
  const from = addDays(day, -back);
  return { from, to: addDays(from, 6) };
}

/**
 * "2026-W44": always the ISO week (Monday start), whatever week the leefgeld
 * figure uses. The week belongs to the year its Thursday falls in, which is
 * how 2026-12-31 is 2026-W53 and 2024-12-30 is 2025-W01.
 */
export function isoWeekKey(day: string): string {
  const thursday = addDays(day, 4 - isoWeekday(day));
  const [y, m, d] = thursday.split("-").map(Number);
  const year = y;
  const dayOfYear = (Date.UTC(y, m - 1, d) - Date.UTC(year, 0, 1)) / 86_400_000;
  const week = Math.floor(dayOfYear / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const HOUR_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Amsterdam", hour: "2-digit", hourCycle: "h23",
});

/**
 * The INSTANT of `hour`:00 on the Amsterdam day `day` — the one place in this
 * module that turns a civil time into an instant. Amsterdam is UTC+1 or UTC+2,
 * so the candidate whose Amsterdam reading is that same day and hour wins; on
 * the fall-back day an hour that occurs twice (02:00) takes the earlier one.
 * Never called with an hour that does not exist (02:00 on the spring-forward
 * day): that throws rather than invent an instant.
 */
export function amsterdamAt(day: string, hour: number): Date {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError(`amsterdamAt: hour must be 0..23, got ${hour}`);
  }
  const [y, m, d] = day.split("-").map(Number);
  for (const offset of [2, 1]) {
    const at = new Date(Date.UTC(y, m - 1, d, hour - offset));
    if (dayKey(at) === day && Number(HOUR_FMT.format(at)) === hour) return at;
  }
  throw new RangeError(`amsterdamAt: ${day} ${hour}:00 does not exist in Amsterdam`);
}
