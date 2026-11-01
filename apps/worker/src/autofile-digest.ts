/**
 * "Door verder gedaan", once a day (spec §6.6, Plan 3 Task 15): at 19:00
 * Amsterdam, if verder changed any document on its own in the last 24 hours,
 * one PASSIVE `filing` push says how many — and nothing else.
 *
 * COUNTS ONLY. A document title on the lock screen is the dossier read aloud to
 * whoever picks up the phone; the list behind the link (Voor jou → "Door verder
 * gedaan") shows the titles once the phone is unlocked.
 *
 * ONE PUSH PER DAY, EVER: the dedupKey `autofile:<Amsterdam day>` makes a
 * pg-boss retry, or a second run by hand, a duplicate `notify()` refuses —
 * never a second push.
 *
 * A quiet day sends nothing, and records anyway: the row is how
 * worker-health.ts tells a quiet day from a digest that stopped running.
 */
import { and, eq, gt, lte } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { dayKey } from "@verder/api/src/amsterdam";
import { verderActionKind } from "@verder/api/src/routers/verder-actions";
import { AUTOFILE_DIGEST_WORKER_NAME } from "@verder/api/src/worker-names";
import { recordRun } from "./heartbeat";
import type { NotifyFn } from "./notify/notify";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AutofileDigestDeps {
  db: Db;
  notify: NotifyFn;
  now?: () => Date;
}

export interface AutofileDigestResult {
  count: number; filed: number; named: number; sent: boolean;
}

/** "3 documenten opgeborgen", "1 document opgeborgen · 2 hernoemd". Pure. */
export function digestBody(filed: number, named: number): string {
  const parts: string[] = [];
  if (filed > 0) parts.push(`${filed} ${filed === 1 ? "document" : "documenten"} opgeborgen`);
  if (named > 0) parts.push(`${named} hernoemd`);
  return parts.join(" · ");
}

export async function runAutofileDigest(deps: AutofileDigestDeps): Promise<AutofileDigestResult> {
  const now = (deps.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - DAY_MS);
  const c = schema.documentStatusChanges;
  // The same source and the same kind rule as "Door verder gedaan" itself
  // (routers/verder-actions.ts), so the push never counts what the list omits.
  const rows = await deps.db.select({ suggestionId: c.suggestionId }).from(c)
    .where(and(eq(c.actor, "verder"), gt(c.createdAt, since), lte(c.createdAt, now)));
  const filed = rows.filter((r) => verderActionKind(r) === "auto-file").length;
  const named = rows.length - filed;

  let sent = false;
  if (rows.length > 0) {
    const r = await deps.notify({
      kind: "filing", level: "passive", title: "Door verder gedaan",
      body: digestBody(filed, named), link: "verder://inbox",
      dedupKey: `autofile:${dayKey(now)}`,
    });
    sent = !r.duplicate;
  }
  await recordRun(deps.db, AUTOFILE_DIGEST_WORKER_NAME, "ok", { count: rows.length, filed, named, sent });
  return { count: rows.length, filed, named, sent };
}
