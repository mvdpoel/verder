// One notify() that every alert goes through (spec §6.3). It fans out to APNs
// and to the existing web-push, and RECORDS EVERY ATTEMPT: one `notifications`
// row per call and one `notification_attempts` row per destination, with the
// APNs status, reason and environment. The 2026-10-27 web-push failure was
// undiagnosable precisely because nothing recorded that a push was attempted,
// where it went, or what the push service answered — so here an error is
// written down, never dropped, and a destination that was not tried says why
// (`no-apns-key`, `no-vapid-keys`, `session-ended`).
//
// NONE OF THIS IS EVIDENCE. It appends no ledger event.
//
// notify NEVER THROWS. A broken alert path must not fail the job it reports on
// (a watchdog heal, a suggest.entry run): every failure is recorded where it
// can be and logged with console.error where it cannot.
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { NOTIFY_WORKER_NAME } from "@verder/api/src/worker-names";
import { recordRun } from "../heartbeat";
import { realTransport, type PushTransport } from "../push";
import { http2ApnsSender, loadApnsConfig, type ApnsEnvironment, type ApnsSender } from "./apns";

export type NotifyLevel = "time-sensitive" | "active" | "passive";
export type NotifyKind =
  | "verder-mail" | "creditor-mail" | "proposal" | "reminder" | "follow-up"
  | "task-due" | "filing" | "system" | "weekly";

export interface NotifyInput {
  kind: NotifyKind; level: NotifyLevel; title: string; body: string;
  link?: string; dedupKey?: string; threadId?: string; collapseId?: string;
}

export interface NotifyDeps {
  db: Db;
  /** Defaults to a lazy, memoised sender built from APNS_* env; null = no usable key. */
  apns?: () => Promise<ApnsSender | null>;
  /** Defaults to the VAPID transport; null = VAPID keys unset. */
  webPush?: () => PushTransport | null;
}

export interface NotifyResult {
  notificationId: string | null; duplicate: boolean;
  delivered: number; failed: number; skipped: number;
}

/** What every alerting caller takes in its deps (Plan 2 Task 5): tests inject a fake. */
export type NotifyFn = (n: NotifyInput) => Promise<NotifyResult>;

/** notify() bound to a database with the default APNs and web-push senders. */
export function notifier(db: Db): NotifyFn {
  return (n) => notify({ db }, n);
}

/** The iOS notification category per kind. MIRRORED in the iOS app (Plan 2 Task 7): a rename here must be made there too. */
export const CATEGORY: Record<NotifyKind, string> = {
  "verder-mail": "VERDER_MAIL",
  "creditor-mail": "CREDITOR_MAIL",
  proposal: "PROPOSAL",
  reminder: "REMINDER",
  "follow-up": "FOLLOW_UP",
  "task-due": "TASK_DUE",
  filing: "FILING",
  system: "SYSTEM",
  weekly: "WEEKLY",
};

/**
 * APNs answers that mean "this token will never work again". A 400
 * BadDeviceToken is revoked as well: the app re-registers on its next launch,
 * which restores a valid token with the right environment — while leaving it
 * would fail every alert forever, silently, from the one device that matters.
 */
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "Unregistered"]);

// ---- defaults --------------------------------------------------------------
// Built on first use, never at module scope: importing this file reads no key
// and opens no socket. Memoised, so the provider token and the h2 sessions are
// shared by every notify() in the process (Apple throttles a key minted more
// often than every 20 minutes). A missing key is memoised too; adding one takes
// a worker restart, which every deploy already does.
let defaultSender: Promise<ApnsSender | null> | null = null;

function defaultApns(): Promise<ApnsSender | null> {
  defaultSender ??= loadApnsConfig().then((cfg) => (cfg ? http2ApnsSender(cfg) : null));
  return defaultSender;
}

/**
 * Closes the default APNs sender's HTTP/2 sessions. Every ONE-SHOT entrypoint
 * that can reach notify must call this in a `finally`, or an open h2 session
 * keeps the process alive after its work is done. The long-running worker never
 * needs it.
 */
export async function closeNotify(): Promise<void> {
  const pending = defaultSender;
  defaultSender = null;
  if (!pending) return;
  try { (await pending)?.close(); } catch { /* nothing to close */ }
}

function defaultWebPush(): PushTransport | null {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return null;
  return realTransport();
}

// ---- the fan-out -------------------------------------------------------------

type Attempt = typeof schema.notificationAttempts.$inferInsert;
type Outcome = "delivered" | "rejected" | "error" | "skipped";

type RecordAttempt = (a: Omit<Attempt, "notificationId" | "outcome"> & { outcome: Outcome }) => Promise<void>;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function notify(deps: NotifyDeps, n: NotifyInput): Promise<NotifyResult> {
  const result: NotifyResult = { notificationId: null, duplicate: false, delivered: 0, failed: 0, skipped: 0 };
  const { db } = deps;
  try {
    // 1. The notification row. ON CONFLICT on the nullable UNIQUE dedup_key:
    // an at-least-once job or a clock firing twice raises ONE notification. A
    // duplicate sends nothing and records no run — a clock that dedups every
    // tick would otherwise write a row a minute that says nothing.
    const inserted = await db.insert(schema.notifications).values({
      kind: n.kind, level: n.level, title: n.title, body: n.body,
      link: n.link ?? null, dedupKey: n.dedupKey ?? null,
    }).onConflictDoNothing({ target: schema.notifications.dedupKey })
      .returning({ id: schema.notifications.id });
    if (inserted.length === 0) return { ...result, duplicate: true };
    const notificationId = inserted[0].id;
    result.notificationId = notificationId;

    const record: RecordAttempt = async (a) => {
      await db.insert(schema.notificationAttempts).values({ ...a, notificationId });
      if (a.outcome === "delivered") result.delivered++;
      else if (a.outcome === "skipped") result.skipped++;
      else result.failed++;
    };

    await fanOutApns(deps, n, record);
    await fanOutWebPush(deps, n, record);

    await recordRun(db, NOTIFY_WORKER_NAME, result.delivered > 0 ? "ok" : "error", {
      notificationId, delivered: result.delivered, failed: result.failed, skipped: result.skipped });
  } catch (err) {
    console.error(`notify: ${n.kind} "${n.title}" failed: ${message(err)}`);
  }
  return result;
}

async function fanOutApns(deps: NotifyDeps, n: NotifyInput, record: RecordAttempt): Promise<void> {
  const { db } = deps;
  // The session check rides the device query: the worker holds column-level
  // SELECT on session(id, expires_at) and nothing else (0037), so it can tell a
  // live session from a revoked or expired one without ever seeing a token.
  const devices = await db.select({
    id: schema.pushDevices.id,
    token: schema.pushDevices.token,
    environment: schema.pushDevices.environment,
    sessionLive: sql<boolean>`coalesce(${schema.session.expiresAt} > now(), false)`,
  }).from(schema.pushDevices)
    .leftJoin(schema.session, eq(schema.session.id, schema.pushDevices.sessionId))
    .where(isNull(schema.pushDevices.revokedAt));
  if (devices.length === 0) return;

  const live: typeof devices = [];
  for (const d of devices) {
    if (d.sessionLive) { live.push(d); continue; }
    // A lost phone is revoked in /settings/security by ending its session; from
    // then on it gets nothing. Signing in again and re-registering restores it.
    await revokeDevice(db, d.id, "session-ended");
    await record({ channel: "apns", pushDeviceId: d.id, environment: d.environment,
      outcome: "skipped", reason: "session-ended" });
  }
  if (live.length === 0) return;

  let sender: ApnsSender | null = null;
  let setupError: string | null = null;
  try { sender = await (deps.apns ?? defaultApns)(); }
  catch (err) { setupError = `apns-setup: ${message(err)}`; }

  for (const d of live) {
    const base = { channel: "apns", pushDeviceId: d.id, environment: d.environment } as const;
    if (setupError !== null) { await record({ ...base, outcome: "error", reason: setupError }); continue; }
    if (sender === null) { await record({ ...base, outcome: "skipped", reason: "no-apns-key" }); continue; }
    try {
      const r = await sender.send(d.environment as ApnsEnvironment, d.token, {
        title: n.title, body: n.body, level: n.level, category: CATEGORY[n.kind],
        threadId: n.threadId, collapseId: n.collapseId, link: n.link,
      });
      const answer = { statusCode: r.statusCode, reason: r.reason, apnsId: r.apnsId };
      if (r.statusCode >= 200 && r.statusCode < 300) {
        await record({ ...base, ...answer, outcome: "delivered" });
      } else if (r.statusCode === 410 || (r.statusCode === 400 && DEAD_TOKEN_REASONS.has(r.reason ?? ""))) {
        await revokeDevice(db, d.id, r.reason ?? String(r.statusCode));
        await record({ ...base, ...answer, outcome: "rejected" });
      } else {
        await record({ ...base, ...answer, outcome: "error" });
      }
    } catch (err) {
      await record({ ...base, outcome: "error", reason: message(err) });
    }
  }
}

async function revokeDevice(db: Db, id: string, reason: string): Promise<void> {
  // By UPDATE, never DELETE, so the attempt history keeps its device row.
  await db.update(schema.pushDevices).set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(schema.pushDevices.id, id), isNull(schema.pushDevices.revokedAt)));
}

async function fanOutWebPush(deps: NotifyDeps, n: NotifyInput, record: RecordAttempt): Promise<void> {
  const { db } = deps;
  const subs = await db.select().from(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.revoked, false));
  if (subs.length === 0) return;

  // The VAPID transport is built only here, and only when there is someone to
  // send to: setVapidDetails throws on a malformed key, and that must become an
  // attempt row rather than an exception out of notify.
  let transport: PushTransport | null = null;
  let setupError: string | null = null;
  try { transport = (deps.webPush ?? defaultWebPush)(); }
  catch (err) { setupError = `web-push-setup: ${message(err)}`; }

  // The service worker (apps/web/public/sw.js) reads title and body.
  const payload = JSON.stringify({ title: n.title, body: n.body });
  for (const sub of subs) {
    const base = { channel: "web-push", pushSubscriptionId: sub.id } as const;
    if (setupError !== null) { await record({ ...base, outcome: "error", reason: setupError }); continue; }
    if (transport === null) { await record({ ...base, outcome: "skipped", reason: "no-vapid-keys" }); continue; }
    try {
      const r = await transport.send(sub, payload);
      const code = (r as { statusCode?: unknown } | undefined)?.statusCode;
      await record({ ...base, outcome: "delivered", statusCode: typeof code === "number" ? code : null });
    } catch (err) {
      const code = (err as { statusCode?: unknown }).statusCode;
      const statusCode = typeof code === "number" ? code : null;
      if (statusCode === 404 || statusCode === 410) {
        // Gone for good, as the old web-push sender always treated it.
        await db.update(schema.pushSubscriptions).set({ revoked: true })
          .where(eq(schema.pushSubscriptions.id, sub.id));
        await record({ ...base, outcome: "rejected", statusCode, reason: message(err) });
      } else {
        // EVERY other error is now recorded. The old sender dropped these on the floor.
        await record({ ...base, outcome: "error", statusCode, reason: message(err) });
      }
    }
  }
}
