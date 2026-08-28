# Passkeys and 30-day device trust

Date: 2026-08-28
Status: approved, ready for implementation planning

## Goal

Retire the Cloudflare Access email-verification gate in front of
`verder.vanderpoel.pro` and make the app's own login screen the front door:
sign in with a passkey (MacBook Touch ID, iPhone Face ID), with the existing
password kept as a fallback, and a **"trust this device for 30 days"** choice
that decides how long the session lives.

## Why now

Cloudflare Access sends an email code on every new browser. That is a second
credential ceremony on top of a login screen that already exists, and the
codes arrive in the same mailbox the worker polls for case correspondence.
A passkey is both stronger and less work: it cannot be phished, cannot be
typed into the wrong site, and on Martin's own hardware it is one touch.

## What was verified before designing

These are measurements against the installed tree, not assumptions. Each one
changed the design.

1. **`@better-auth/passkey` is a separate package.** better-auth 1.7.0 core
   exports no passkey plugin — its `exports` map lists `two-factor`,
   `email-otp`, `magic-link`, `siwe` and others, and no passkey. The plugin
   lives in `@better-auth/passkey@1.7.0`, peer-locked to `better-auth ^1.7.0`,
   wrapping `@simplewebauthn/{server,browser}` v13.

2. **`rememberMe: false` shortens the database row, not merely the cookie.**
   `better-auth/dist/db/internal-adapter.mjs` line 248:
   `expiresAt: dontRememberMe ? getDate(3600 * 24, "sec") : getDate(sessionExpiration, "sec")`.
   So the short-session half of this feature is a library feature.

3. **The passkey plugin ignores it.** Its verify-authentication endpoint calls
   `internalAdapter.createSession(targetUserId, void 0, void 0, void 0, …)` —
   `dontRememberMe` is hardcoded `undefined`. A passkey sign-in therefore
   *always* gets the full `session.expiresIn`. Closing this gap is the only
   part of the trust mechanism that needs custom code.

4. **`databaseHooks.<model>.create.before` is a real, usable choke point.**
   `better-auth/dist/db/with-hooks.mjs` runs `hooks[model]?.create?.before(data, context)`
   before every create, passes the current auth context, and merges a returned
   `{ data: … }` over the row. Both sign-in paths pass through
   `createSession`, so one hook governs both.

5. **`opts.fetchOptions` reaches the session-creating request.** In
   `@better-auth/passkey/dist/client.mjs` the passkey sign-in action spreads
   `...opts?.fetchOptions` into the `POST /passkey/verify-authentication`
   call — the request that creates the session. A custom header set by the
   login page is therefore visible to the hook on the passkey path as well as
   the password path.

6. **The drizzle adapter keys on the better-auth field name, not the SQL
   column.** `@better-auth/drizzle-adapter` resolves
   `schemaModel[getFieldName({ model, field })]`, where `field` is the
   plugin's field key. The drizzle *property* must therefore be spelled
   `credentialID`; the SQL column name is ours to choose. This is the same
   rule the existing tables already demonstrate (`userId: text("user_id")`),
   and it means `credentialID: text("credential_id")` is correct. The adapter
   also looks the model up as `schema["passkey"]`, singular, matching the
   existing `user` / `session` / `account` / `verification` exports.

7. **The data path is already properly enforced; the middleware is not the
   wall.** `apps/web/src/middleware.ts` only checks that a cookie *named*
   `better-auth.session_token` exists — it never validates it. That is
   survivable because every surface that returns data revalidates:
   `/api/trpc` calls `getAuth().api.getSession`, and `/api/files/[sha256]`,
   `/api/upload`, `/api/registry-import`, `/verify/export` and
   `/registry/export` all go through `serverCaller()` →
   `getSessionUserId()` → `protectedProcedure`. `apps/web/src/lib/trpc-server.ts`
   already carries a comment saying so. Removing Cloudflare Access therefore
   exposes far less than the middleware suggests. It still gets fixed here
   (§ Session guard), for a reason that is about correctness rather than
   about a hole.

## Design

### Sign-in model

Passkey primary, password fallback. The password stays for two reasons: it is
the bootstrap for registering a passkey on a device that has none, and it is
the only thing standing between a lost laptop and a shell on the homelab.
Sign-ups remain disabled (`ALLOW_SIGNUP`), and the app remains single-user.

### The 30-day choice

One checkbox on the login form, **"Trust this device for 30 days"**, governs
both paths through a single mechanism:

- `session.expiresIn` is configured to 30 days globally.
- The login page attaches `x-verder-trust-device: 1` to the sign-in call when
  the box is ticked — via `fetchOptions.headers` for both
  `signIn.email(…, { headers })` and `signIn.passkey({ fetchOptions: { headers } })`.
- A `databaseHooks.session.create.before` hook in `createAuth()` reads that
  header off the auth context and returns
  `{ data: { expiresAt: <now + 30d | now + 12h> } }`.

Untrusted sign-ins get a 12-hour session. Trusted ones get 30 days, rolling
via `session.updateAge`.

**Why not `rememberMe: false` alone:** it covers the password path only
(finding 3), and it hardcodes 1 day rather than the 12 hours wanted.

**Fallback if the header does not arrive.** Finding 5 says it will, but the
passkey client spreads `...options` *after* `...opts?.fetchOptions`, so a
plugin-level fetch option could in principle shadow the headers. The
integration test in § Testing asserts the hook observes the header on **both**
paths. If it ever fails, the documented fallback is a short-lived
`verder.trust_device` cookie set by the login page before sign-in and read
from `context.headers`, which cannot miss a sub-request. Do not switch to the
cookie pre-emptively — the header leaves no state behind and the test is what
decides.

### Device list and revocation

No new device table. better-auth already stores `ipAddress` and `userAgent`
on each `session` row, so a session *is* a device for this purpose, and
`listSessions` / `revokeSession` give the list and the revoke button for free.
A 30-day session that is signed out or revoked is a device that is no longer
trusted, which is the correct semantics.

### `passkey` table — migration 0025

Fields taken verbatim from the plugin's `src/schema.ts` (read out of the
shipped bundle), with this project's timestamptz and snake_case conventions:

| better-auth field | drizzle property | column | type | notes |
|---|---|---|---|---|
| `name` | `name` | `name` | text, nullable | user-supplied label |
| `publicKey` | `publicKey` | `public_key` | text, not null | |
| `userId` | `userId` | `user_id` | text, not null | FK `user.id`, on delete cascade, indexed |
| `credentialID` | `credentialID` | `credential_id` | text, not null | indexed |
| `counter` | `counter` | `counter` | integer, not null | see note |
| `deviceType` | `deviceType` | `device_type` | text, not null | |
| `backedUp` | `backedUp` | `backed_up` | boolean, not null | |
| `transports` | `transports` | `transports` | text, nullable | comma-joined |
| `createdAt` | `createdAt` | `created_at` | timestamptz, nullable | |
| `aaguid` | `aaguid` | `aaguid` | text, nullable | authenticator *model* id |

The plugin declares `counter` as `type: "number"`, which the adapter expects
to be a drizzle `integer`. A WebAuthn signature counter is a uint32 and can in
principle exceed `int4`; in practice Apple and Google passkeys — the only ones
in play here — report `0` and never increment. Keep `integer` to match the
adapter and revisit only if a hardware security key is ever registered.

Grants mirror `0003_auth_grants.sql`:
`GRANT SELECT, INSERT, UPDATE, DELETE ON "passkey" TO verder_app;`

**This does not violate the append-only law.** `passkey` is auth
infrastructure in the same class as `session` and `verification`, not an
evidence table: it appends no `ledger_events` row, `/verify` does not read it,
and removing a passkey must genuinely remove it. The law governs evidence, and
a credential is not evidence.

**Ordering trap, the same one 0020, 0021, 0022 and 0023 each carried:** run
`pnpm --filter @verder/db migrate` from the homelab **host, before** the new
web image is deployed. Otherwise every sign-in — passkey *and* password, since
the plugin extends the shared schema — fails on
`relation "passkey" does not exist`, and the login screen is the one page that
cannot afford to 500.

### rpID and the dev/prod boundary

`rpID` comes from `PASSKEY_RP_ID` — `localhost` in development,
`verder.vanderpoel.pro` in production — with `rpName` from `PASSKEY_RP_NAME`
("Verder") and `origin` taken from the existing `APP_URL`. Both new variables
must be added to `~/apps/verder/.env.prod` on the homelab, which is excluded
from the rsync and therefore edited in place. A passkey is cryptographically
bound to its rpID, so **a passkey registered in dev will never work in prod
and vice versa**. That is WebAuthn working correctly, not a defect, and it
means the production passkey must be registered against the production host
after deploy.

### Login page

`apps/web/src/app/(auth)/login/page.tsx` is rewritten:

- "Sign in with passkey" as the primary action.
- Email + password collapsed behind "other ways to sign in", still fully
  functional.
- The trust checkbox, applying to whichever path is used.
- Error copy stays in the current supportive register. A failed passkey
  attempt must not read as an accusation; `AUTH_CANCELLED` (the user dismissed
  the Touch ID sheet) is not an error worth showing at all.

### `/settings/security`

A new route — there is no `/settings` today, and both halves of this feature
need somewhere to live.

- **Your passkeys**: name, when added, remove. Registration prompts for a name
  because nothing can infer one: Apple devices zero the AAGUID under the
  default `attestation: "none"` flow, so the plugin's own AAGUID lookup table
  resolves nothing for a MacBook or an iPhone. The plugin's
  `registration.requireSession` defaults to true and uses a *fresh* session
  middleware, so adding a passkey already requires a recent sign-in.
- **Your devices**: active sessions with user agent, IP, which one is current,
  when it expires, and a revoke button.
- **Change password**: the seed script skips a user that already exists, so
  without this there is no way to move to a longer password short of a shell
  on the homelab. `changePassword` is already part of better-auth's core API;
  this is a form, not a mechanism.

### Session guard

`apps/web/src/app/(app)/layout.tsx` gains a real session check that redirects
to `/login` when `getSessionUserId()` returns null.

This is needed because of a mismatch the feature introduces: an untrusted
session's *cookie* still carries the global 30-day `maxAge` while its database
row expires after 12 hours. The presence-checking middleware would wave that
dead cookie through to a page that then fails to load data. The fix belongs in
the layout, where the session can actually be validated, rather than in
middleware. The middleware stays as the cheap first pass.

### Replacing what Access was doing

- `minPasswordLength` 6 → 12 in `createAuth()`. The comment currently
  justifying 6 ("single-user self-hosted") no longer holds once the form is
  reachable from the open internet. Note precisely what this does and does
  not do: better-auth enforces a minimum on sign-**up** and set-password, not
  on sign-**in**, so raising it does not invalidate the existing password and
  cannot lock anyone out. Choosing a longer one is a recommended follow-up,
  not a forced migration — and it is done through the new change-password
  form rather than the seed script, which skips a user that already exists.
- better-auth's built-in `rateLimit` enabled for auth paths.
- Cloudflare: delete the Access application and policy for the hostname; add
  one WAF rate-limiting rule on `/api/auth/*` (10 requests/minute per IP).
  The tunnel, the hostname, and `WEB_BIND=127.0.0.1` are unchanged — the app
  is still reachable only through the tunnel.

### Documentation

`docs/deploy.md` § 4 currently recommends putting Access in front of the
hostname; it is rewritten to describe the rate-limit rule instead. The
CLAUDE.md "Public access" line is updated to drop the Access allow-list and
record the passkey model.

## Testing

- **`packages/auth`** — integration test against the dev database:
  a sign-in carrying `x-verder-trust-device: 1` produces a session expiring
  ~30 days out; one without it expires ~12 hours out. Asserted for **both**
  the password path and the passkey path, since finding 3 is precisely that
  the two paths differ. This test is what validates the header mechanism; see
  the fallback note under § The 30-day choice.
- **`packages/db`** — schema and grants test for `passkey`, following the
  existing `schema.test.ts` pattern: columns present with the expected types,
  `verder_app` holds SELECT/INSERT/UPDATE/DELETE, `verder_worker` holds
  nothing on it.
- **`apps/web`** — the layout guard redirects an invalid session to `/login`.
- **Manual, unavoidable.** WebAuthn cannot be exercised without an
  authenticator. Registration and sign-in get a hands-on pass in dev against
  Touch ID (rpID `localhost`), and a second pass in production against
  `verder.vanderpoel.pro` after deploy, before Access is removed.

## Implementation shape — built for a dynamic workflow

The work parallelises cleanly. **The controlling constraint is that no two
concurrently running agents may write the same file**, so ownership is
assigned explicitly below. Nothing else about the ordering is load-bearing.

### Phase 1 — three agents in parallel, no shared files

| Agent | Owns | Depends on |
|---|---|---|
| **db** | `packages/db/src/schema.ts` (append `passkey`), `packages/db/drizzle/0025_passkey.sql`, `packages/db/src/passkey-schema.test.ts` | — |
| **guard** | `apps/web/src/app/(app)/layout.tsx` and its test | — |
| **docs** | `docs/deploy.md`, `CLAUDE.md` | — |

### Phase 2 — one agent, needs the table to test against

| Agent | Owns | Depends on |
|---|---|---|
| **auth** | `packages/auth/package.json` (add `@better-auth/passkey@1.7.0`), `packages/auth/src/index.ts` (passkey plugin, session-expiry hook, `minPasswordLength`, `rateLimit`), `packages/auth/src/index.test.ts`, and **creates** `apps/web/src/lib/auth-client.ts` | phase 1 **db** |

`auth-client.ts` is created here rather than in phase 3 on purpose: both
phase-3 agents import it, and if either created it they would collide.

### Phase 3 — two agents in parallel

| Agent | Owns | Depends on |
|---|---|---|
| **login** | `apps/web/src/app/(auth)/login/page.tsx` | phase 2 |
| **settings** | `apps/web/src/app/(app)/settings/security/**` (passkeys, devices, change password) and the nav entry pointing at it | phase 2 |

If the nav lives in a file the **guard** agent also touches, the nav entry
moves to phase 3 alone and `layout.tsx` stays with **guard**; confirm before
dispatching.

### Phase 4 — the session, not an agent

Everything that touches production stays in the session, where it can be seen
and stopped:

1. `env -u NODE_ENV` typecheck, lint, full test run; commit; push.
2. rsync to the homelab using the **exact** exclude list in CLAUDE.md — the
   dry run with `--info=del` first, and read every `deleting` line.
3. Add `PASSKEY_RP_ID` and `PASSKEY_RP_NAME` to `~/apps/verder/.env.prod`
   in place — it is rsync-excluded and will not arrive with the code.
4. `pnpm --filter @verder/db migrate` **from the host, before** the images.
5. Rebuild and deploy web (worker is untouched by this work).
6. `nightly-verify` — it must report the ledger head **unchanged**. This
   feature appends no evidence; a moved head would mean something wrote some.
7. Register the production passkey and confirm it signs in. Reset the password
   to a 12+ character one through the new form.
8. **Only then** delete the Cloudflare Access application and add the WAF
   rate-limit rule.

Step 8 is last for a reason worth stating plainly: removing Access before a
working production passkey exists would leave the old login screen as the only
way in, with the new password policy already in force. Doing it last means
there is no moment at which Martin can be locked out of his own case file.
