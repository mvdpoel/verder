# verder for iPhone — design

Status: draft for Martin's approval, 2026-10-28.
Scope: a native iPhone app plus the server-side changes that make verder a proactive assistant rather than a filing cabinet.

## 1. Intent

Two things, in Martin's words:

- **"I want to just snap it, that lowers resistance."** Paper letters arrive at home. The scanner is slow and upstairs, so letters wait. Getting a letter into verder must take seconds from wherever he stands.
- **"My proactive assistant is getting things done, not only waiting for my instructions but taking ownership. Make sure it has all information and things are going in the right direction."** When something comes in (his example: a reply from Statiegeld Nederland), verder works out what it means, proposes how to react, and acts once he agrees. It then keeps the matter moving.

The iPhone is where those two meet: the camera is the fastest way in, and the lock screen is where verder asks and Martin answers.

How a document gets ingested does not matter to him, as long as verder ingests it, learns from it, and takes the appropriate action.

## 2. Goals

1. **Snap.** Scan a multi-page letter with the camera. Edge detection, perspective, lighting and shadow cleanup, and wrinkle reduction run on the phone. The app uploads the result as one PDF to verder over the tunnel, from anywhere, with nothing asked up front.
2. **Notifications that work.** Native push over APNs. Today's web-push channel has never delivered a single notification (`push_subscriptions` held 0 rows until one was saved by hand, and that one shows nothing either), so this is the first working alert path verder has.
3. **Verder asks, Martin answers.** A single "Voor jou" (waiting on you) inbox on the phone. It holds proposed replies, questions, pending suggestions and tasks waiting on Martin, each answerable in one or two taps.
4. **Proactive server side.** For every relevant inbound mail, verder gathers the context, proposes a next step (a drafted reply, a task, or a question), sends on approval, and follows up when the other side goes quiet.
5. **Verder mail always gets his attention.** Any mail from the Verder organisation is the highest priority, handled as described in §6.4.
6. **The extras.** A home screen and lock screen widget, a share sheet extension, a voice quick-log, an offline pocket dossier, a money glance, and a weekly summary. Martin chose "all of it, fully built".
7. **Same design system.** The app uses the web app's Holodek tokens, the same two fonts and the same rules (§8).

## 3. Non-goals

- App Store or public distribution. The app is built for Martin's iPhone 16 Pro only, signed with his paid Apple Developer account.
- WhatsApp. It is a separate project, to be brainstormed after this one. iOS forbids an app from reading or sending WhatsApp messages, so it can only ever live on the server.
- iPad, Mac Catalyst, Android, Apple Watch.
- More than one user.
- Drafting with an on-device model.
- Critical alerts, which need Apple approval. Time-sensitive notifications are enough.

## 4. Anti-goals (failure even if it technically works)

- **Snapping is slower than walking upstairs.** Cold launch to camera must be under 2 s. No form before the shutter, and no waiting for the upload before the next letter.
- **Something is sent without Martin's explicit tap on the actual draft.** That includes a lock-screen "Approve" that fires without him seeing the text.
- **Amber stops meaning "waiting on you".** It leaks onto errors, decoration or "important".
- **Notifications become noise.** If the phone buzzes for newsletters, he'll silence it and miss Demi.
- **The phone keeps what the server destroyed.** A document purged or discarded on the server still sits in the offline cache.
- **The record lies about who acted.** An automatic action by verder must read as verder's, never as Martin's approval.
- **A money figure is invented.** For example, "leefgeld left this week" when verder has no budget figure (see §7.6).

## 5. Constraints (from the project and its laws)

- **Evidence tables are append-only,** and every evidence mutation appends a `ledger_events` row in the same transaction. Never weaken this.
- **AI output is suggestion-only, with ONE amendment that Martin made on 2026-10-28:** *filing and linking documents may happen without asking; sending always needs approval.* See §6.5 for exactly what the amendment covers and how it stays honest. Update CLAUDE.md's Project laws accordingly.
- **The golden rule holds for everything new:** record the model suggestion, Martin's verdict, and the edit diff for every proposal.
- **Language.** The app UI is Dutch. Code, comments, commits and docs are in English. The tone toward Martin is supportive; mail to anyone else is short, professional and official.
- **Public access is only via `https://verder.vanderpoel.pro`** (Cloudflare tunnel → homelab :3000). Auth is better-auth with passkeys (`PASSKEY_RP_ID` binds to the hostname) plus a password fallback. A Cloudflare WAF rate limit of 10/min/IP sits on `/api/auth/*`.
- **Deploy rules from CLAUDE.md apply in full:** rsync with the exact exclude list and a `--dry-run --info=del` first, migrations from the homelab HOST before new web/worker images, `nightly-verify` after, and a check that the ledger head is unchanged wherever a step should append nothing.
- **Only `next build` typechecks `apps/web`.** Run it locally before deploying a `packages/api` type change.
- **Toolchain.** Xcode 26.5 / iOS 26.5 SDK on macOS 26.6.2 are installed today. Update to the newest stable Xcode 26.x, and make sure it supports the iOS version actually running on Martin's phone (read it with `xcrun devicectl list devices` once the phone is connected and trusted).

## 6. Server side

### 6.1 Mobile API surface

Add a small versioned REST surface, `apps/web/src/app/api/mobile/v1/*`, backed by the existing routers through `serverCaller`. *(My call:)* a stable JSON contract owned by the app, rather than Swift speaking tRPC's wire format (and possibly superjson) and breaking on every router refactor. Endpoints are listed per feature below. Every route validates the session BEFORE touching the body, as `api/upload/route.ts` does.

### 6.2 Auth for a native client

- **Passkey sign-in** with `ASAuthorizationPlatformPublicKeyCredentialProvider` against the existing better-auth passkey endpoints, relying party `verder.vanderpoel.pro`.
- **The association file.** Native passkeys need an Associated Domains entitlement (`webcredentials:verder.vanderpoel.pro`) and an `apple-app-site-association` file at `/.well-known/` that is public, served as `application/json`, never redirected, and not behind the auth middleware or a Cloudflare challenge. Verify it with `curl` from outside.
- **Session.** It is a normal better-auth session, so it appears in `/settings/security` as a device and can be revoked there. Length: 30 days, as with "trust this device". Store the session credential in the Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, which lets background uploads work while the phone is locked). Use cookie or bearer, whichever better-auth supports cleanly. The builder decides, and records the measured reason.
- **App lock.** Face ID is required on launch and after more than 5 minutes in the background *(my call: this is the whole dossier in a pocket)*.

### 6.3 Push over APNs

- **New table `push_devices`** (migration; not evidence, so DELETE is allowed): APNs device token, environment (development/production), app version, created/last-seen, revoked. Endpoint: `POST /api/mobile/v1/push/register`.
- **Sending.** The worker sends token-based APNs over HTTP/2 using a `.p8` key from Martin's developer account, kept in `secrets/` (already in the rsync exclude list). A development-signed build talks to the APNs **sandbox** host, and getting that wrong is the classic silent failure.
- **One `notify()` in the worker** that every alert goes through: watchdog heals, Verder mail, proposals, follow-ups, the weekly summary, and the mail agent's summaries. It fans out to APNs, and to web-push for as long as that exists. Record each attempt and its APNs status in `worker_runs` (or a `notifications` table), so that "sent but never arrived" is diagnosable. The 2026-10-27 web-push failure was undiagnosable for exactly that reason.
- **Interruption levels.** `time-sensitive` for Verder mail and for anything due within 24 h (needs the time-sensitive entitlement). `active` for creditor mail, proposals and questions. `passive` for verder's own filing actions and the weekly summary.
- **Health.** Declare a new worker name in `worker-health.ts` with the right kind.

### 6.4 Mail from the Verder organisation

- **Rule:** any sender whose domain is in the Verder set (`@verdergroep.nl`, `@verderbewindmidden.nl`, the same list as `RELEVANT_SENDERS`) is priority 1, whoever the person is. Demi, Regio 3, Team Opstart, someone new. Keep the list in ONE place that both relevance and priority read.
- **Handling:**
  1. **Always tell.** A time-sensitive push within one poll cycle of ingest. The text is a one-line Dutch summary of what they ask, never just "nieuwe mail".
  2. **Lay it out.** In the app: what they ask, by when, what the dossier already holds that answers it, and what is missing.
  3. **Propose.** A drafted reply with the right vault documents attached, and/or a task for Martin ("Loonstrook oktober nodig").
  4. **Keep after it.** If the proposal is untouched after 24 h, one reminder push. If Martin replied and Verder has been silent for 7 calendar days *(my call; one setting)*, push and offer a follow-up draft.
- **Lower priority:** creditors (any party linked through `debt_parties`, or in the mail agent's watchlist) get the same pipeline at `active`. All other relevant mail is processed without a push and appears in the daily list.

### 6.5 Proposals: the proactive layer

**A new entity, `proposals`** (migration). A proposal is something verder wants Martin to approve:

- `kind`: `reply` | `question` | `follow-up`.
- `subject_ref`: the triggering raw email, document or task.
- `party_id`.
- `priority`.
- `payload`. For a reply: to, cc, subject, body, attachment document ids, and `In-Reply-To`/`References`. For a question: prompt plus 2–4 options and a free-text fallback.
- `model`, `prompt_version`, `model_output`.
- `status`: `pending` | `approved` | `edited` | `rejected` | `sent` | `failed` | `superseded`.
- `final_payload`, `diff`, `decided_at`, `sent_at`, `error`.

It is NOT evidence. The evidence is what happens on approval: a sent mail becomes an outbound log entry through the existing entries path, with its ledger event, and the sent message is attached. The proposal row keeps the golden-rule record (model output, verdict, diff).

**Context gathering** ("make sure it has all information"). Before drafting, assemble:
- the full thread;
- the party and its parent organisation;
- the party's log entries, debts (with `debt_parties` roles), open tasks and stops on the case map;
- the top knowledge-base hits for the message text;
- the documents already sent to this party.

The drafter must say in the proposal what it relied on (cited ids), so Martin can see why.

**Drafting model.** *(My call:)* Claude through the existing headless setup on the homelab (`claude -p`, Martin's long-lived token at `~/.config/claude-agent/oauth-token`, never printed). That is what the mail agent already uses. Ollama/qwen stays on classification and docmeta. The draft carries Martin's register for officials: short, professional, Dutch.

**Sending.**
- Gmail API with `gmail.send` scope. The send-only token currently lives in `/mnt/data/verder/scan-batch/`. Move it under `~/apps/verder/secrets/` and keep verder's ingest token read-only.
- A send happens only from an explicit approve action on a screen showing the final text, behind Face ID. A notification action may open the draft and may never send it.
- The send is idempotent: one proposal id gives at most one message (record the Gmail message id before marking `sent`, and refuse a second send).
- After sending, the outbound mail is ingested like any other through the existing dedup.

**Settled by Martin 2026-10-31:** every mail verder sends for him, watchlist replies included, becomes an outbound logbook entry with its ledger event.

**The mail agent folds in.** `/mnt/data/verder/mail-agent/` (cron, watchlist, `context.md`, drafts as `.md` files, handled at session start) becomes a producer of proposals through the same API instead of `.md` files. Its watchlist senders (Statiegeld Nederland, Bungas, Tikkie, Hanneke) stay out of the dossier unless Martin files them, which is why the agent exists alongside ingest. Generate `context.md` from the DB rather than hand-maintaining it, or retire it once proposals carry their own context. Keep `handled.log` until the app is proven.

**Answering a question** resolves to an ordinary existing action: link the document to debt X, set a task's status, create the suggested task. Every write goes through its existing ledgered path.

### 6.6 What verder may do on its own (the amendment)

- **Allowed without asking:**
  - applying a `document-meta` suggestion: title, type, sender party, and filing;
  - linking a document to an existing debt (`debt_documents`), stop, task or log entry.
- **Not allowed:**
  - creating or changing debts, amounts or registry decisions;
  - creating log entries;
  - changing task status;
  - discarding or purging;
  - anything outbound.
  All of these remain proposals or suggestions.
- **Gate.** Only above a confidence threshold the builder measures against the existing docmeta eval and real approval history. Below it, it stays a pending suggestion.
- **Honest record.** The suggestion's verdict reads `auto-applied` (new additive enum value; migration ordering trap as 0020–0034), with actor verder. Every resulting ledger event records that verder made it.
- **Visible and reversible.** A "Door verder gedaan" list (daily, `passive` push), with one-tap undo per item. Undo goes through the existing append-only change tables, and is recorded as a correction that feeds learning.

### 6.7 Upload from the phone

- **Endpoint.** `POST /api/mobile/v1/documents` (multipart). It mirrors `api/upload/route.ts`: auth first, a content-length guard against `MAX_UPLOAD_BYTES`, `storeFile`, and `registerUpload`.
- **Source.** New additive `doc_source` value `phone-scan` *(my call: so Files' "bron" branch shows where it came from; ordering trap as 0035)*. Share-extension imports use `phone-share`.
- **Idempotency.** The client sends a client-generated UUID, and retries must not double-ingest. Sha256 dedup already covers identical bytes. Also store the UUID for a re-encoded retry.
- **Pipeline.** Nothing new is needed after upload: `docmeta.sweep` picks up any document without `document_texts`, OCR and naming run, and suggestions appear. That is "ingests it, learns from it, takes action". If the document is a letter from Verder or a creditor, §6.4 and §6.5 apply to it as they do to mail. So ingested scanned letters ALSO produce proposals, not just mail.

### 6.8 Data the app reads

`/api/mobile/v1/inbox` (everything waiting on Martin, ranked), `/proposals/:id`, `/suggestions/:id`, `/tasks`, `/dashboard/summary` (map headline: the furthest-right open stop), `/money/summary`, `/documents/sync` (delta since a cursor, including purges and discards as tombstones), `/documents/:id/file`, `/entries/voice` (§7.4), `/weekly`.

## 7. The iPhone app

Native SwiftUI, iOS 26 minimum, iPhone only, portrait. It lives in `apps/ios/` in this monorepo, with the project generated by XcodeGen from a committed `project.yml` *(my call: a readable diff instead of a `.pbxproj`)*. No third-party dependencies unless one is measured as necessary.

**Targets:**
- the app;
- a Share Extension;
- a Widget Extension.

The three share an App Group (`group.pro.vanderpoel.verder`) for the upload queue and the cached data. Bundle id `pro.vanderpoel.verder` *(my call)*.

**Signing.** Development signing with Martin's team. Register the iPhone 16 Pro's UDID. Capabilities: Push Notifications, Associated Domains, App Groups, Time Sensitive Notifications, Keychain Sharing. Install with Xcode or `xcrun devicectl device install app`. A development profile lasts a year, and the app keeps working until then. Optionally use TestFlight internal testing for cable-free updates (no App Store review for internal testers). The builder may set it up if it is cheap; it is not required.

**Tabs:** `Scan` (opens on launch) · `Voor jou` · `Dossier` · `Meer`.

### 7.1 Scan

- **Capture.** On launch the camera is live (VisionKit `VNDocumentCameraViewController`, or the iOS 26 equivalent if better). It does multi-page capture, auto edge detection and perspective correction.
- **Cleanup**, on the phone, before the PDF is built: lighting and shadow normalisation and contrast (Core Image). Wrinkle and curl reduction: try Vision's iOS 26 document APIs first. **Measure on real crumpled letters** (shoot 5 real ones, compare before and after, and keep the comparison in the PR) and ship only what demonstrably helps. Unreadable output is worse than wrinkled output, and verder's OCR has to read it.
- **The PDF.** One PDF per capture session, grayscale or colour by page content, sized so a 3-page letter uploads in seconds on 4G *(target under 1.5 MB/page; the builder measures OCR accuracy on the homelab against the size)*.
- **Upload.** The PDF is queued in the App Group and sent with a background `URLSession` upload, retried with backoff, and it survives app kill and reboot. The UI is back at the camera immediately. A small queue indicator shows pending/sent/failed, and failed items are retryable.
- **Nothing asked.** Optionally, after sending, one non-blocking chip: "Iets bijzonders?" for a one-line note sent along as the upload's note. Never required.

### 7.2 Voor jou (waiting on you)

One ranked list: Verder-priority proposals, then other proposals and questions, pending suggestions, tasks waiting on Martin, and then "Door verder gedaan" (collapsed).

- **A reply proposal** shows the trigger (who, what they ask, the date), what verder relied on, and the editable draft with attachments. Actions: **Versturen** (Face ID, then send), **Aanpassen**, **Afwijzen** (optional reason, which feeds learning).
- **A question** shows its options as buttons. A question answer may be given from the notification itself (`UNNotificationAction`, `authenticationRequired`), because it never sends anything outward.
- **A suggestion** (log entry, docmeta, debt, task): approve/edit/reject, mirroring `/queue`.
- **Amber marks only items waiting on Martin,** exactly as on the web.

### 7.3 Notifications

Categories per kind, deep-linking to the item. Badge count = items waiting on Martin. Silent `content-available` pushes refresh the widget and the inbox cache.

### 7.4 Voice quick-log

Hold to record after a call. Transcribe on-device with iOS 26 `SpeechAnalyzer` in Dutch *(my call: no audio leaves the phone, no GPU contention on the homelab)*. Martin picks a party (the most recent first) and the channel (`call` by default), and the transcript is sent as a **log-entry suggestion**, not an entry. He approves it in Voor jou like any other. Audio is not kept unless he taps "bewaar opname", in which case it is uploaded as a document linked to the suggestion.

### 7.5 Dossier (pocket dossier)

- **What's cached.** An offline copy of filed documents, their metadata and extracted text, synced by delta from `/documents/sync`.
- **Search.** Titles plus text, on-device. The ⌘K-style search hits the server when online.
- **Viewing.** Open a document full-screen to show at a counter.
- **Protection.** Files use `NSFileProtectionComplete` and the app lock applies.
- **Tombstones are mandatory.** A purged or discarded document is deleted from the phone on the next sync, and the sync must resolve the effective status (`effectiveDocument` / `effective-status.ts`), never the raw `documents.status`, which reads "inbox" forever.
- **Also here:** the case map headline ("waar het nu op wacht"), the open tasks, and a vertical read-only version of the case map *(stretch; the builder may defer it to last)*.

### 7.6 Money glance

Read-only. Per account (never merged, per the money law), the recent months as /money computes them, with the same hatched and `geen data` states and the same disclosures. **No "leefgeld left this week" number until Martin supplies the weekly leefgeld amount** (see Open questions). verder holds no budget figure, and inventing one breaks an anti-goal.

### 7.7 Widget

Small, medium and lock screen sizes: the "wacht op jou" count, the top item, and the map headline. Tapping deep-links. Its data comes from the App Group cache, refreshed by silent push and the timeline policy.

### 7.8 Share extension

Accepts PDFs, images and files from any app (Mail, Photos, Files, WhatsApp's own share sheet). It enqueues into the same upload queue with source `phone-share`, with an optional one-line note.

### 7.9 Weekly summary

A Sunday 18:00 Europe/Amsterdam push *(my call)*: what moved this week (sent, received, filed, tasks done), and what is waiting. It opens a summary screen. The server composes it (§6.8 `/weekly`).

## 8. Design system

Port `apps/web/src/app/globals.css` `@theme` one-to-one into a Swift token file. The token file is the only place a colour, font, radius or glow is defined. Screens pick from it and invent nothing.

- **Ground and text.** `void` as the background; glass panels from `glass-a`→`glass-b` with an `edge` / `edge-lit` top border; the full `ink-*` scale.
- **Signal.** `signal` for action and links. **`attn` amber ONLY for what is waiting on Martin.** `okay` for system-healthy, `steel` for "it happened".
- **Type.** Saira (display) and IBM Plex Mono (mono), both OFL and bundled. Support Dynamic Type.
- **Shape and glow.** Radius 2 (chips/buttons/inputs) and 3 (panels). Glow only on something pressable or asking for attention.
- **Motion.** Nothing moves faster than the web's rule ("nothing moves for less than two seconds") except direct-manipulation feedback. Respect Reduce Motion.
- **Theme.** Dark only, like the web.

Before building screens, produce one token preview screen and compare it side by side with the web at the same content, as the first visual check.

## 9. Verification (what "done" means)

**On the phone:**
- Cold launch to camera under 2 s, measured with Instruments.
- 5 real letters (including one crumpled) scanned and checked: each arrives in Files with OCR text, a name and suggestions. One of them is from Verder, and it produced a time-sensitive push and a proposal.
- A proposal approved from the phone sends exactly one Gmail message with threading headers. It lands as an outbound log entry with a ledger event, and the golden-rule record shows the model output, the verdict and the diff. The first real send happens only on Martin's go.
- A push arrives on the lock screen with the phone locked and in a Focus mode, and a time-sensitive one breaks through.
- An auto-applied filing shows in "Door verder gedaan", and undo works.
- A purge on the web removes the document from the phone's cache on the next sync.

**Server:**
- Unit tests for every new pure function (priority rule, context assembly, proposal state machine, send idempotency, sync tombstones).
- `next build` locally.
- `nightly-verify` OK after deploy. Each migration's ledger delta matches its prediction (proposals and devices append nothing; sends and auto-applied filings append exactly their events).

**Every new scheduled job has run** from its schedule, witnessed in `worker_runs`.

## 10. Delivery order (my call; each slice ends verifiable)

1. Toolchain update, project skeleton, signing on the device, token preview screen.
2. Auth (passkeys, association file), app lock.
3. Scan → upload → ingest. This is usable on its own and is the thing he asked for first.
4. APNs and `notify()`, with web-push kept alongside.
5. Verder priority, proposals (reply/question/follow-up), sending, and the mail agent fold-in.
6. Voor jou on the phone, notification actions.
7. Autonomous filing with undo (the law amendment).
8. Share extension, widget, voice log, pocket dossier, money glance, weekly summary.

## 11. Left to the builder

The cookie vs bearer session mechanism, the exact DB shapes, the cleanup pipeline details, the confidence threshold (measured), the PDF compression settings (measured), the internal module layout, and whether TestFlight is worth it. Each decision goes in the PR with its measured reason.

## 12. Decisions settled after the builder check

Each of these is my call unless it says otherwise.

1. **Sending.** The worker container sends, using the existing send-only Gmail token (`gmail.send` scope, already granted; `gsend.mts` already sends from inside the worker image). The token is copied into `~/apps/verder/secrets/` and mounted read-only. No new OAuth consent is needed.
2. **Auth fallback.** The app offers password sign-in alongside passkeys, against the same better-auth endpoints. After the first sign-in, the app offers to register a native passkey. The first native passkey is registered against production, because that is the only RP ID the phone can reach.
3. **Send state machine and recovery.**
   - States: `approved → sending → sent | failed`.
   - Before calling Gmail, the worker generates the RFC 5322 `Message-ID` itself and stores it on the proposal in the same transaction that moves it to `sending`.
   - A recovery job looks for proposals stuck in `sending` and asks Gmail's Sent folder for that `Message-ID`. Found means the message went out: mark it `sent` and write the outbound entry. Not found after a timeout means it did not: mark it `failed` and notify. The proposal is never re-sent automatically.
   - The outbound log entry and its ledger event are written only after `sent`. The approval of the proposal IS Martin's approval of that entry, and the event's payload names the proposal id.
4. **Recording verder as the actor.** The "verder did this" marker is an ADDITIVE field on NEW events only. It never changes the payload shape of an existing event type in a way that would alter how old rows hash. The proof is `nightly-verify` passing on the full pre-existing chain after deploy. If a change to the hash input turns out to be unavoidable, use a new event type instead.
5. **Priority for scanned letters.** A scan's sender comes from OCR and is therefore a guess. When the guess is "Verder", the push is still time-sensitive, because missing a Verder letter costs more than a false alarm. The text says "lijkt van Verder", and the app shows the guessed sender as unconfirmed until Martin or the filing confirms it.
6. **APNs key.** Martin creates the `.p8` key in the Apple Developer portal; the builder walks him through it, or does it with him in the browser. One key covers both sandbox and production. Team ID and Key ID go into `.env.prod`, and the key file goes into `secrets/`.
7. **Phone and toolchain.** The iPhone 16 Pro is already paired with this Mac (`devicectl` lists it as iPhone17,1). Its iOS version is read in slice 1. If it is below iOS 26, that is a stop-and-ask, not a reason to lower the deployment target quietly.
8. **Sync cursor.** One monotonic cursor over three sources: new `documents`, `document_status_changes` and `document_purges`. A document whose discard is undone is downloaded again. Purged means deleted for good.
9. **What "waiting on Martin" means.** These items count:
   - pending proposals;
   - pending suggestions;
   - tasks in status `open` (not `waiting`, which means waiting on someone else);
   - the map's current open stop.

   **Settled by Martin 2026-10-31:** tasks in status `in-progress` count too (he is the one doing them); `waiting` does not.

   This one definition lives on the server and drives the inbox, the badge, the widget and the use of amber.
10. **Follow-up clock.** One clock per thread, started only by an outbound message verder sent or ingested. Threads without an outbound message have no clock.

## 13. Open question for Martin

- **Leefgeld per week.** The money glance can show "leefgeld over deze week" only if verder knows the weekly amount VerderGroep pays out. Until Martin answers, the glance shows the per-account months and no budget figure.
  - **Answered 2026-10-31:** VerderGroep pays € 100 per week. Plan 3 (`docs/superpowers/plans/2026-10-31-iphone-app-plan-3.md`, Task 17) stores it as `LEEFGELD_WEEKLY_CENTS=10000` in `.env.prod` and shows "leefgeld over deze week" only for days the bank statements cover; an uncovered week reads `geen data`, never a figure.
