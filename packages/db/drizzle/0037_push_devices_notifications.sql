-- verder for iPhone, slice 4 (spec §6.3): APNs devices, and a delivery record
-- for every notification.
--
-- Additive. Nothing is dropped, and no grant on an evidence table is weakened.
--
-- NONE OF THESE THREE TABLES IS EVIDENCE. Registering a device, raising a
-- notification and attempting its delivery append NO ledger event; /verify is
-- untouched. They exist because the 2026-10-27 web-push failure was
-- undiagnosable: nothing recorded that a push was attempted, where it went, or
-- what the push service answered. notify() writes one `notifications` row and
-- one `notification_attempts` row per destination, so "sent but never arrived"
-- is a query, not a guess.

-- A device token is a DELIVERY ADDRESS with no evidentiary value.
CREATE TABLE "push_devices" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Hex, as APNs hands it to the app. UNIQUE: re-registration overwrites the
  -- row (last_seen_at, app_version, session_id) rather than adding a second.
  "token"          text NOT NULL UNIQUE,
  -- STORED PER DEVICE, never set globally: a development-signed build's token
  -- sent to the production host answers 400 BadDeviceToken, the classic silent
  -- failure. The APNs host is chosen from this column.
  "environment"    text NOT NULL CHECK ("environment" IN ('development', 'production')),
  "bundle_id"      text NOT NULL,
  "app_version"    text NOT NULL,
  -- The better-auth session the device last registered under. NO FK: better-auth
  -- owns that table. notify() joins it to skip a device whose session was
  -- revoked in /settings/security (a lost phone) or has expired.
  "session_id"     text NOT NULL,
  "created_at"     timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at"   timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at"     timestamp with time zone,
  "revoked_reason" text
);
--> statement-breakpoint

-- DELETE is granted, unlike push_subscriptions (0006): a lost phone must be
-- removable outright, and spec §6.3 names it. The worker's 410 Unregistered
-- path still revokes by UPDATE, so the attempt history keeps its device row;
-- a hand DELETE leaves those attempts with push_device_id NULL (ON DELETE SET
-- NULL below) and their outcome intact.
GRANT SELECT, INSERT, UPDATE, DELETE ON "push_devices" TO verder_app, verder_worker;
--> statement-breakpoint

CREATE TABLE "notifications" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- verder-mail | creditor-mail | proposal | reminder | follow-up | task-due |
  -- filing | system | weekly. Free text, not an enum: a new kind must not need
  -- enum surgery and a host-first migration.
  "kind"       text NOT NULL,
  "level"      text NOT NULL CHECK ("level" IN ('time-sensitive', 'active', 'passive')),
  "title"      text NOT NULL,
  "body"       text NOT NULL,
  -- verder://proposal/<id>, verder://document/<id>, …
  "link"       text,
  -- Nullable UNIQUE: NULL means never deduplicated (Postgres treats NULLs as
  -- distinct). The clocks and at-least-once jobs (suggest.entry) key on it so a
  -- retried job raises one notification, not two.
  "dedup_key"  text UNIQUE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "notification_attempts" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "notification_id"      uuid NOT NULL REFERENCES "notifications"("id"),
  "channel"              text NOT NULL CHECK ("channel" IN ('apns', 'web-push')),
  "push_device_id"       uuid REFERENCES "push_devices"("id") ON DELETE SET NULL,
  -- No ON DELETE: push_subscriptions has no DELETE grant, so the case never arises.
  "push_subscription_id" uuid REFERENCES "push_subscriptions"("id"),
  -- Copied from the device at attempt time, not read back: the device row can
  -- be deleted, and the attempt must still say which APNs host it went to.
  "environment"          text,
  "outcome"              text NOT NULL CHECK ("outcome" IN ('delivered', 'rejected', 'error', 'skipped')),
  "status_code"          integer,
  -- The APNs `reason` (BadDeviceToken, Unregistered, …), `no-apns-key`,
  -- `no-vapid-keys`, or a transport message.
  "reason"               text,
  "apns_id"              text,
  "attempted_at"         timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX "notification_attempts_notification_idx" ON "notification_attempts" ("notification_id");
--> statement-breakpoint

-- THE DELIVERY RECORD: the worker writes it, the app reads it, nobody edits or
-- deletes it. A record that can be rewritten cannot diagnose anything, and no
-- reader needs DELETE. Only the worker sends (the web app holds no pg-boss
-- connection and cannot read secrets/), so the app gets no INSERT either.
GRANT SELECT, INSERT ON "notifications", "notification_attempts" TO verder_worker;
--> statement-breakpoint

GRANT SELECT ON "notifications", "notification_attempts" TO verder_app;
--> statement-breakpoint

-- COLUMN-LEVEL, NEVER `token`. notify() must skip a device whose session was
-- revoked (lost phone) or expired; that needs the session's id and expiry and
-- nothing else. The worker gains no way to read a bearer token.
GRANT SELECT ("id", "expires_at") ON "session" TO verder_worker;
