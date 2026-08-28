-- WebAuthn credentials for passkey sign-in (@better-auth/passkey 1.7.0).
--
-- This table is NOT evidence. It appends no ledger_events row, /verify never
-- reads it, and deleting a passkey must genuinely delete it — so verder_app
-- gets DELETE here, exactly as it already has on "session" and "verification"
-- in 0003_auth_grants.sql. The append-only law governs the evidence tables;
-- a credential is not evidence.
--
-- verder_worker gets nothing: the worker never authenticates a browser.
CREATE TABLE "passkey" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text,
  "public_key" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "credential_id" text NOT NULL,
  "counter" integer NOT NULL,
  "device_type" text NOT NULL,
  "backed_up" boolean NOT NULL,
  "transports" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "aaguid" text
);

CREATE INDEX "passkey_user_id_idx" ON "passkey" ("user_id");
CREATE INDEX "passkey_credential_id_idx" ON "passkey" ("credential_id");

GRANT SELECT, INSERT, UPDATE, DELETE ON "passkey" TO verder_app;
