# Mail re-analysis: option C with the spool, the home endpoint, and what to strike

Date: 2026-09-02, evening
Status: **proposal. Nothing was built and nothing in production changed.** Every
probe in §0 is read-only: SQL against the Vandelay archive on the homelab,
one HTTP GET of the live Stalwart session object, one GET of the tunnel
configuration through the Cloudflare API, a shallow clone of Stalwart at the
pinned tag into a scratch directory, and four Cloudflare documentation pages.
No DNS, no Worker, no KV, no Stalwart write, no ledger event, no commit.
Ledger stays at 140 events, head `fe94663d…`, as the brief states.

Supersedes the *conclusions* of `2026-09-02-mail-architecture-review.md`
where the two disagree (listed in §7); that file stays as the record of what
was measured and when. The 2026-08-29 spec is treated here as **superseded in
full** (§7.1) rather than patched.

Answers the brief in order: §1 (a) option C, §2 (b) the home endpoint, §3 (c)
ordering, §4 (d) the prototype, §7 (e) dead text, §8 (f) CLAUDE.md. §5 is
finding 4 (the token), §6 is finding 5 applied to the rest of the documents.

## 0. What this re-analysis measured, and what it only read

Read-from-source and measured-against-a-running-thing are kept apart, as the
project does. Every claim later in this document cites one of these rows.

### Measured (read-only), this session

| # | What | How | Result |
| --- | --- | --- | --- |
| M-a | Daily mail volume, ALL mail (commercial included) | `sqlite3 -readonly martin.sqlite`, `emails.received_at` | **21,139 messages in the 12 months to 2026-08-29**; June–Aug 2026: **4,743 in 92 days = 51.6/day, 424 MiB = 4.6 MB/day**. Per month 1,428–2,512 |
| M-b | Messages over Cloudflare's 25 MiB inbound cap | same, `length(blobs.data) > 26214400` | **6 of 146,270 all-time; 2 in the last 12 months.** Largest ever 33.85 MB; largest in 12 months 28.7 MB. Over 10 MiB: 50 all-time, 7 in 12 months |
| M-c | What Cloudflare's documented rejection rules (R-3) would have done to the archive, judged from Gmail's own `Authentication-Results: mx.google.com` header on each message | `authres.py` over the 21,139 blobs' header blocks; case correspondents = `RELEVANT_SENDERS` in `.env.prod` + every `parties.email` in prod (read-only `SELECT`) | **1 of 21,139 would have been rejected** (autoradam.nl: SPF and DKIM both not `pass`). **0 of the 56 messages from case correspondents.** 52 had `dmarc=fail`, all under `p=NONE`, so none under a reject/quarantine policy. 232 carried no Google verdict (mostly Martin's own sent mail) |
| M-d | Live Stalwart session object | `curl -u` on the homelab, `/.well-known/jmap` | `uploadUrl http://stalwart:8080/jmap/upload/{accountId}/`; `maxSizeUpload 50,000,000`; `maxObjectsInSet 500`; `maxCallsInRequest 16`; the mail capability is advertised, so `Email/import` is mandatory (RFC 8621 §4.8); `maxSizeAttachmentsPerEmail 50,000,000`. `urn:ietf:params:jmap:blob` reports `maxSizeBlobSet 7,499,488`, which bounds JSON-embedded blobs only and not the upload endpoint |
| M-e | `homelab-host` tunnel ingress | `GET /accounts/<a>/cfd_tunnel/<id>/configurations` with the mp8s token | Remotely managed. Two rules: `chat.vanderpoel.pro → http://192.168.188.148:8420`, `verder.vanderpoel.pro → http://localhost:3000`, catch-all `http_status:404`. Tunnel id `ebef6630-d1dc-4660-8a0e-0a1e393880f8`. **The mp8s token can read tunnel configuration**, which the token record did not list |
| M-f | Stalwart source at the pinned tag | `git clone --depth 1 --branch v0.16.19`, commit `a0cf06f8…` | see R-1, R-2 |
| M-g | **M4, run 2026-09-06** on the drill's scratch server restored from `native-2026-09-03.tar.zst` (extract 154 s, healthy on first check, torn down after) | upload + `Email/import` + `Email/get` + a second import of the same blob + `Email/changes` + seven `Email/query` filters, via the worker image on the compose network; production untouched | upload 200 (357 B); import `created` with id, thread, blobId; **`receivedAt` as supplied** (an hour in the past) is what `Email/get` returns; **the same blob imported twice makes TWO Emails** in one thread; `Email/changes` since the pre-import state lists both; `subject`, `text`, `from` and `inMailbox`+`after` filters all find the new message AND a Vandelay-imported control; **`header` filters return 0** with no error. Production afterwards: `mail` runs `ok` every minute, 0 `mail-drill` rows, 0 scratch containers, scratch directory empty; **ledger 486 events before and after, newest event 2026-09-03 11:02 UTC, so M4 appended nothing**. (The brief's 140 events / 77 documents were the 2026-09-02 morning figures; the growth to 486 / 211 by 2026-09-03 is 134 `nas-scan` documents and 2 mail attachments from other work, not mail infrastructure.) |
| M-h | **The same filters against PRODUCTION, 2026-09-06, read-only** | one `Email/query` per filter over the worker image | `subject` of an old message → 1; `text` → 414; `from` → 1,244; `after 2026-08-01` → 1,734; **every `header` form → 0** (`["Message-ID"]`, with and without a value, bracketed or not, and `["Subject", …]`). So "Email/query filters return nothing on this store" (CLAUDE.md, deploy.md, jmap-counts.ts) is **wrong as stated today**: only the `header` filter returns nothing. READ at the tag afterwards (`crates/jmap/src/email/query.rs:125-156`): `EmailFilter::Header` is routed to a separate `EmailSearchField::Headers` key/value condition (`Equal` for Message-ID-class headers or a bare name, `Contains` otherwise), while `subject`/`text`/`from` use the Subject/Body/From text fields. That `Headers` field answers nothing on this deployment for new and old messages alike; why is not measured. The consequence for the design is unchanged: never key anything on a `header` filter, and dedup at home |

**What invalidates M-c:** it judges Gmail's verifiers, not Cloudflare's. Both
implement the same three standards and Cloudflare's rule is stated in terms of
their outcomes, so the direction holds; the exact count could differ by a
handful (a DNS lookup that failed at one and not the other). The 232 messages
with no Google verdict are outside the measurement. The 56 case-correspondent
messages are the 12-month subset of the dossier's senders; earlier years were
not scanned.

### Read from source, not measured

| # | Claim | Source |
| --- | --- | --- |
| R-1 | `Email/import` → `email_ingest` with `IngestSource::Jmap`. Errors it can return: `invalidProperties` (bad mailbox), `blobNotFound`, `invalidEmail` (parser refuses, or no recognised header), `overQuota`. **No `alreadyExists`** on import; that error exists only for `Email/copy` and IMAP | `crates/jmap/src/email/import.rs` at v0.16.19 |
| R-2 | **The Message-ID duplicate skip is `is_smtp()` only** (`ingest.rs:207-237`), and **spam classification runs for the SMTP source only** (`ingest.rs:244-361`). An imported message is stored as given, twice if asked twice, unclassified, no Sieve | `crates/email/src/message/ingest.rs` |
| R-3 | Email Routing **rejects a message that fails both SPF and DKIM**, and **rejects a message that fails the sender's DMARC policy**; may delay or block RBL-listed IPs; inbound cap **25 MiB, larger messages are rejected** | developers.cloudflare.com, email-service postmaster + limits pages |
| R-4 | Workers Free: **10 ms CPU per invocation**, **50 subrequests per invocation** where "a subrequest is any request a Worker makes using the Fetch API or to Cloudflare services like R2, KV, or D1", 100,000 requests/day, **5 Cron Triggers per account**, 128 MB memory | workers/platform/limits |
| R-5 | KV Free: **1,000 writes/day** to different keys, 1 write/s to the same key, 25 MiB value, 512 B key, 1 KB metadata; "changes may take **up to 60 seconds or more** to be visible in other global network locations"; nothing stated about `list()` lag specifically | kv/platform/limits, kv/concepts/how-kv-works |
| R-6 | RFC 8621 §4.8: `Email/import` takes `blobId`, `mailboxIds`, `keywords`, `receivedAt`; the server MAY reject with `alreadyExists` (Stalwart does not, R-1) | RFC 8621 |

---

## 1. (a) Is option C still the right call?

Yes, and the argument has changed shape since the review, so it is re-made
here rather than assumed.

### 1.1 What C is now

The review's C was "Cloudflare terminates SMTP, a Worker posts home, and the
senders' queues are the buffer". The spool log corrected the buffer: senders'
queues are worth about a day (Exchange Online's default), so C without a
spool covers a power cut and not a dead disk. C *with* the spool is a
different design: **custody moves to the edge the moment home cannot take it,
and no sender's clock is involved at all** unless the edge store is down too.
The queue that Postfix would have provided is now KV, proven for one message,
and the only thing the senders' queues still cover is the double failure
(home down AND KV refusing writes), where 421 is the honest answer.

### 1.2 What the alternatives would buy, priced against the measurements

| Concern | C + spool (measured where stated) | B, a VPS with Postfix | A, HA-IP + Postfix on TransIP |
| --- | --- | --- | --- |
| Buffer when home is down | KV, 25 MiB/value, 1,000 writes/day (R-5); an outage day costs ~52 writes (M-a), 5% of the cap | Postfix spool on the VPS disk, no cap that matters | same, on a PVC |
| Mail Cloudflare refuses that Gmail took | **1 of 21,139 in 12 months, 0 of 56 case-correspondent messages** (M-c); **2 messages/yr over 25 MiB** (M-b), which the sender is told about with a bounce | none; Postfix takes what you configure | same as B |
| Hosts to patch, certificates, port 25 reputation | none | one host, one cert, one IP whose reputation is yours | one pod, one cert, one HA-IP at € 11,99/month (read) |
| Path from the edge to home | the tunnel that already carries the app (M-e) | WireGuard or a second HTTP hop; Postfix cannot POST, so it needs a relay or LMTP over the VPN | same |
| New failure domain | none; Cloudflare already fronts DNS, the tunnel and the app | the VPS provider | TransIP k8s |
| What it cannot do | hold mail through a **Cloudflare** outage (then 421, 24 h); accept > 25 MiB | nothing structural | nothing structural |

The two regressions C carries are now numbers rather than worries: about one
refused message a year and about two oversized ones, both of which the sender
learns about immediately. That is smaller than the risk of one more host that
one person has to keep patched during a WSNP.

### 1.3 The concentration risk the review did not price

C puts DNS, the tunnel, the app's front door, the MX and the spool in **one
Cloudflare account**, and finding 4 shows that account is reachable by a
token that widens itself. A suspended or compromised account takes all of it
at once, and the senders' 24 hours do not cover an account dispute. This is
the one argument for B that survives, and it is answered by things the plan
already needs for other reasons:

- the age-encrypted archive **off the homelab** (open item f, e), so mail is
  never only in the house *and* only at Cloudflare;
- the Gmail bridge staying until the §6 criterion, and phase 4 gated on the
  off-site decrypt, so Google remains a receiving copy through the cutover;
- **the registrar, MEASURED via RDAP 2026-09-02: Key-Systems GmbH (IANA 269),
  not Cloudflare**, nameservers `leia`/`vick.ns.cloudflare.com`, status
  `client transfer prohibited`. So the nameservers can be repointed away from
  a lost Cloudflare account at the registrar, and an account loss is a bad day
  rather than the end of the domain. **THE SAME RECORD SAYS THE REGISTRATION
  EXPIRES 2026-09-06**, four days after this was written, last changed
  2026-08-12. Whether that is a pending auto-renewal or a lapse in progress is
  not something RDAP can say; it is D8 and it is urgent.

### 1.4 Verdict

**C, with the spool, on KV, under three conditions that are ours to build**:
the Worker never swallows (measured: the difference between 421 and a lost
message), the Worker has its own timeout (the `slow@` case measured 120 s of
held SMTP session), and the spool is monitored from the house (§2.7). None of
those conditions is met by the prototype as it stands (§4). B stays in the
drawer as the fallback that never needs measuring; A is struck for good, and
M2 with it.

The R2 question (open item a) is closed by M-a: the binding KV limit during
an outage is 52 writes a day against 1,000, and the 25 MiB value cap equals
the inbound cap, so no message KV cannot hold is a message Cloudflare would
have accepted. **Stay on KV. Do not click the subscription.** Revisit only if
a measured outage day exceeds ~500 writes, which is ten times today's
volume.

---

## 2. (b) The home endpoint

Everything else on the open list waits on this, so it is designed in full.
It is **not** what the 2026-09-02 end-state diagram draws: that diagram has the
tunnel delivering `Email/import` straight into Stalwart, with no verder code
in between. §2.1 says why that is the wrong place for it.

### 2.1 Where it lives, and why not the two obvious alternatives

**Recommendation: a small HTTP listener inside the existing worker process**,
`apps/worker/src/mail/inbound.ts`, started by `index.ts` only when
`MAIL_INBOUND_TOKEN` is set. Compose publishes it on `127.0.0.1:3100`; the
tunnel gains one ingress rule `mail-in.vanderpoel.pro → http://localhost:3100`
(M-e shows the file is two rules and a catch-all, so this is a three-line
change) and the zone gains one proxied CNAME for that hostname pointing at the
tunnel. The worker already holds every dependency the endpoint needs: the
JMAP client and `from-env.ts` (one credential seam, by law), the worker
database role, `recordRun`, and the poll that will pick the message up a
minute later.

Rejected, with the reason:

- **The Worker talking JMAP to Stalwart through the tunnel directly** (what
  the diagram draws). Three faults. (1) The Worker would hold the mailbox app
  password, which can *read* the whole mailbox, and a Worker secret is
  readable by anything that can deploy Workers, which the self-widening
  token can (finding 4). A single-purpose endpoint's secret can only *add*
  mail. (2) Stalwart's session object hands back URLs built from
  `STALWART_PUBLIC_URL` verbatim (deploy.md §8.2), so the Worker cannot use
  the session at all and would have to construct URLs by hand, or that
  variable changes to a public FQDN and the poll and the drill both move
  with it. (3) Stalwart's HTTP stack becomes internet-facing instead of
  loopback-only, for a pre-1.0 server holding the dossier's mail.
- **A route in the Next.js app at `verder.vanderpoel.pro/api/mail/inbound`.**
  Saves the DNS record and the ingress rule. Costs: the app role would need
  the JMAP credential and a write grant on the receipts table, the JMAP
  client would move out of the worker, and the human app behind passkeys and
  a WAF rule would acquire a machine endpoint with a static bearer. The
  worker is the machine side of this system; the receiver belongs with it.

### 2.2 The wire contract

```
POST https://mail-in.vanderpoel.pro/inbound
Authorization: Bearer <MAIL_INBOUND_TOKEN>      # 32 random bytes, hex; compared with timingSafeEqual
Content-Type: message/rfc822
Content-Length: <required; 411 without it>
X-Envelope-From: <message.from as Cloudflare gave it>
X-Envelope-To:   <message.to>
X-Edge-Received-At: <ISO 8601, the moment the Worker first saw the message;
                     for a drained message the spooledAt it was stored with>
X-Spool-Key: <the KV key, when drained; absent on the direct path>
<body: message.raw, byte for byte, never modified>
```

Nothing is added to the message bytes. The envelope and the edge timestamp
travel as headers and land in the receipt row (§2.4), never in the message:
the vault stores the sender's bytes, and a header we inserted would change
the sha256 the vault and the dedup both key on.

| Response | Meaning to the Worker | When |
| --- | --- | --- |
| `200 {accepted:true, duplicate:false, jmapEmailId}` | delivered; delete from spool | `Email/import` returned `created` and the receipt row is written |
| `200 {accepted:true, duplicate:true}` | delivered (already had it); delete from spool | the sha256 is in `mail_inbound` |
| `401` | permanent (misconfiguration) | bad or missing bearer |
| `411`, `413` | permanent | no length; length or body over 26 MiB (Cloudflare caps at 25 MiB, so this cannot happen from a real Worker; it is here so the endpoint has a bound of its own) |
| `422` | permanent for THIS message | Stalwart answered `invalidEmail` |
| `503` | temporary; keep in spool, stop the drain | Stalwart unreachable, session refused, upload or import failed with anything else, `overQuota`, `blobNotFound`, or the 30 s internal budget expired |
| `500` | temporary | anything the code did not foresee |

### 2.3 The custody rule, spelled for this side

**2xx is returned only after Stalwart has answered `created` for the
message.** Not after the upload (a blob without an Email is garbage-collected
after `uploadTtl`), not after the receipt row (a row without the import would
tell the next retry "already held" about a message nobody holds, which is the
one unrepairable direction). Order is therefore: dedup lookup → upload →
`Email/import` → receipt row → 200. A crash between import and row costs one
mailbox duplicate on retry (§2.4); a crash before import costs a retry. There
is no ordering in which a message can be lost while the Worker is told it was
kept.

The `email()` handler on the other side keeps the rule it was measured on:
anything that is not a 2xx from home is a failure, failure goes to the spool,
a spool failure is thrown, and a thrown handler is a 421. The `forward()`
copy, if D2 chooses one, runs **after** custody is established and swallows
its own errors, which is the one place swallowing is correct: the message is
already durable, and a destination bouncing a DMARC-strict forward must not
421 a message home already holds.

### 2.4 Duplicates, and why the key is the bytes

Duplicates are **normal, not exceptional**, under this design. KV is eventually
consistent (R-5, "up to 60 seconds or more"), so a drain can list a key that a
previous drain already delivered and deleted; the Worker's fetch can time out
after home imported; a cron drain and a manual drain can overlap. Stalwart
will not catch any of it (R-2). So the endpoint keeps its own receipts:

```sql
-- 0034_mail_inbound.sql (additive; not evidence; no ledger event)
CREATE TABLE mail_inbound (
  sha256            text PRIMARY KEY,          -- of the message bytes as received
  message_id        text,                      -- normaliseMessageId(raw), informational, indexed
  envelope_from     text,
  envelope_to       text,
  bytes             integer NOT NULL,
  edge_received_at  timestamptz NOT NULL,      -- X-Edge-Received-At
  spool_key         text,                      -- NULL on the direct path
  jmap_email_id     text NOT NULL,
  jmap_blob_id      text NOT NULL,
  imported_at       timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON mail_inbound TO verder_worker;
GRANT SELECT ON mail_inbound TO verder_app;
```

The key is **sha256 of the bytes**, never the Message-ID. The project already
wrote down why, at `message-id.ts`: a false positive on an attacker-chosen
identity drops a message permanently, a false negative costs one duplicate.
Two different messages cannot share a sha256; two copies of one message
always do, because the spool stores and replays the exact bytes. The
Message-ID is recorded beside it for triage and nothing decides on it.

Hashing happens **at home, in Node**, never in the Worker: the free plan
allows 10 ms of CPU per invocation (R-4) and a SHA-256 over a 25 MiB body is
not 10 ms. The Worker sends what it has for free (`rawSize`, the Message-ID
header, the envelope).

What a duplicate costs, stated: a second copy in Martin's Stalwart inbox for
the rare case "imported, then the response was lost". The dossier is
unaffected, because `pollMail` dedups on Message-ID within a run and on the
content hash against `raw_emails` (both already measured). This is the
cheap direction and it is accepted.

### 2.5 How it lands in Stalwart

1. `openSession` per request, exactly as the poll does per tick (a rotated
   app password heals on the next request).
2. `POST {uploadUrl}` with the body and `Content-Type: message/rfc822`;
   `maxSizeUpload` is 50,000,000 (M-d), twice the largest message Cloudflare
   can hand over.
3. `Email/import` with `mailboxIds: {<inbox>: true}`, `keywords: {}`,
   `receivedAt: X-Edge-Received-At`. The inbox id is the mailbox whose `role` is `inbox` in an unfiltered
   `Mailbox/get` (the same call `jmap-counts.ts` already makes; `Mailbox/query`
   is avoided because filters are the unexplained path), resolved once per process and
   re-resolved on an `invalidProperties` naming `mailboxIds`. `receivedAt` is
   the edge time so a message drained after a two-day outage sorts where it
   arrived, not when the house came back; the sender's `Date` header is
   untouched and is what `documents.received_at` derives from.
4. Read `created[<id>]`; anything in `notCreated` maps per the table in §2.2.

**Steps 2–4 were MEASURED on 2026-09-06 (M-g)**: the upload and import work exactly
as written, `receivedAt` takes, and a second import of the same blob makes a second
Email, which is the duplicate §2.4 exists for. `Email/changes` returned both ids, so
the poll's handoff needs nothing new.

No Sieve, no spam classification, no `$seen` (R-2). That is a change from
Gmail, which filed spam for Martin: under C the catch-all delivers every
message Cloudflare accepted into one inbox. Cloudflare's own screening
(R-3, RBLs) is what stands in front of it. Whether Stalwart's classifier
should run on imported mail is a Stalwart configuration question for after
the MX moves, not a reason to route through SMTP now.

### 2.6 Failure table, from the sender's point of view

| Situation | Home says | Worker does | Sender is told | Who holds it |
| --- | --- | --- | --- | --- |
| all well | 200 | nothing more | 250 | Stalwart |
| tunnel down, worker down, Stalwart down, home slow past the Worker's 60 s | no answer / 503 | spool | 250 | KV |
| home 401 (rotated token, misdeploy) | 401 | spool under `dead/`, alert | 250 | KV, and a human |
| Stalwart refuses the bytes (`invalidEmail`) | 422 | spool under `dead/`, alert | 250 | KV, and a human |
| home + KV both failing | — | throw | **421** | the sender, ~24 h |
| message > 25 MiB | never reaches the Worker | — | 5xx from Cloudflare | the sender, bounced |
| fails SPF+DKIM, or sender's DMARC policy | never reaches the Worker | — | rejected by Cloudflare (R-3) | the sender, bounced |
| drain finds home down | 503 | stop, keep everything | — | KV |
| drain finds a `dead/` message | — | skip, keep | — | KV, and a human |

Two rules that the prototype does not have, both visible in this table: **a
4xx from home never bounces the sender** (a home-side bug that 4xx'd
everything would otherwise bounce all mail permanently; parking under
`dead/` keeps custody and makes it a human's problem), and **a 4xx never
stops the drain** (the prototype stops at the first failure of any kind, so
one refused message would block every message behind it forever).

Timeouts nest: the endpoint budgets 30 s for session + upload + import
(`AbortSignal.timeout` on each), the Worker waits 60 s on its fetch, and
Cloudflare was measured tolerating 120 s. Home's 503 therefore always
arrives before the Worker gives up, which is what keeps "timed out after
import" rare.

### 2.7 Monitoring the spool from inside the house

The house cannot read KV without a Cloudflare token, and a token at home is
another secret. So the Worker **pushes** the number: every scheduled drain
(cron `*/5`) ends with `POST /spool-status {remaining, oldestSpooledAt, dead,
delivered}` to the same endpoint, which records one `worker_runs` row under
`mail-spool`, `ok` when `remaining` is 0 or younger than 15 minutes, `error`
otherwise. Declared in `worker-health.ts` as `{ kind: "watcher", everyMs: 5 *
MINUTE }`, so 15 minutes of silence is `down`. Silence here means exactly the
two things worth an alarm: the Worker's cron is dead, or the house cannot be
reached from the edge. This costs one KV `list` per drain, no new table, and
uses the taxonomy as built.

What it does not do, stated: alert Martin while the house is down. Every
alerting path in this system lives in the house. The cheap fix is D2's
`forward()` copy to a mailbox on a phone (§3), which doubles as the
"read during an outage" answer. Anything more is a second alerting system.

### 2.8 What changes in the Worker

The `accept()`/`drain()` cascade stays as measured. Around it:

- **`DRAIN_BATCH` 25 → 15.** A drain costs `list` + per message `get` +
  `fetch` + `delete` = 1 + 3N subrequests, and the free plan allows 50
  (R-4). At 25 the pass dies at the 17th message. Bounded and not lossy, but
  it is a limit the prototype was never run into because it drained one
  message.
- **A 60 s `AbortSignal.timeout` on the home fetch**, in both the handler and
  the drain, so a wedged house becomes a spool write and not a held SMTP
  session.
- **4xx vs 5xx** as in §2.6: a 4xx moves the key to `dead/`; a 5xx stops.
- **`/spool-status` push** at the end of `scheduled()`.
- **No recipient switch, no `brokenStore`**: production has one home URL and
  one store. The probe switch that made M1 measurable is exactly what must
  not ship.
- **Secrets**: `HOME_URL`, `HOME_TOKEN` as Worker secrets; `DRAIN_KEY` stays
  for the manual drain.
- **No hashing, no header rewriting.**

### 2.9 Tests, and the one that must run against real infrastructure

Unit: the handler as a pure function over injected `importer`, `receipts`,
`clock` (the shape `pollMail` uses): every row of §2.2 and §2.6, the
custody ordering (a failing receipt insert after a successful import still
returns 200; a failing import never inserts), the timing-safe compare, the
26 MiB bound. Migration test in `packages/db` for the grants.

Then, because this project has now recorded three times that a green suite
never caught what the first real run found in two minutes, the deploy is not
done until these have been run **against the real stack, from the
babeltube.tech Worker**: a message while the worker container is stopped
(must spool, must drain on `up`), a message while Stalwart is stopped (503,
spool), the same message posted twice (`duplicate:true`, one inbox copy), a
message with a deliberately broken header block (422 → `dead/`), and twenty
spooled messages drained on the free plan (the subrequest cap). And one
negative test the drill taught: point the Worker at a home that returns 200
without importing, and confirm the receipt row is what proves custody, not
the status code.

### 2.10 What it deliberately does not do

No relevance filtering (that is the poll's, and the mailbox must hold
everything). No ledger event (nothing here is evidence; the poll's ingest
appends them, as today). No modification of bytes. No reading of the
mailbox. No SMTP anywhere.

---

## 3. (c) Ordering, gates, and what is not worth doing

Hours are Martin's or a session's; "week" means calendar time waiting on
something external.

| Order | Item | Gated on | Effort | Do it? |
| --- | --- | --- | --- | --- |
| 1 | **d. DKIM in the Google Workspace console** | nothing | 10 min, Martin, plus 48 h for DNS | **Yes, now.** Google stays the outbound sender until submission moves, so this is needed regardless of any phase |
| 2 | **i. JMAP request timeout** (`AbortSignal.timeout` on the three `fetchFn` calls) | nothing | 1 h | **Yes, first code change.** §2 adds a fourth JMAP call path; it should not inherit the gap |
| 3 | **§5 token decision** | nothing | 15 min, Martin | Yes; it decides how many secrets the mail path has |
| 4 | **M4** (Email/import on the drill's scratch server, plus the filter probe) | a drill run (~2 min) | 20 min | **Yes.** It proves §2.5 against a running Stalwart before any endpoint code, and settles whether the search defect is the import's or the server's |
| 5 | **b. Home endpoint** (§2), migration 0034, Worker rewrite, `mail-spool` decl | 2, 4 | 1–2 days incl. the real-infra tests | Yes; everything below waits on it |
| 6 | **c. Spool monitoring** | 5 | included in 5 (§2.7) | Yes |
| 7 | **M6** (what enabling Email Routing does to a zone that ALREADY has an apex SPF and MX; on babeltube.tech) | nothing | 30 min | **Yes, before 12.** The cutover is "enable routing on vanderpoel.pro", and the only measurement so far was on an empty zone |
| 8 | **f. `mail-backup.sh`: plaintext on the NAS AND `.age` beside it** | nothing | 1 h + one hand-run | Yes; unblocks 9 |
| 9 | **D3: age key on paper and in a manager reachable without the Mac** | Martin | 30 min | Yes; until then `BACKUP_AGE_RECIPIENT` stays unset (the key is in exactly one place) |
| 10 | **e. Off-site push** | 8, 9, Martin's Dropbox OAuth and quota | 1 h after the grant | Yes, but check the quota **before** the OAuth: a free Dropbox refuses 3.83 GB. If it does not fit, pick a different free or near-free target rather than a bigger Dropbox plan: the file is age-encrypted, so any provider will do, and a Maildir tarball would be the same ~3.8 GB because the compressed bytes ARE the messages |
| 11 | **2-week canary** on babeltube.tech with the production Worker code and the real endpoint | 5 | 2 weeks elapsed, ~0 effort | Yes |
| 12 | **h. MX move** (enable routing on vanderpoel.pro, restore SPF to authorise Google + Cloudflare, TTL 300 first) | 1, 5–11, and one off-site decrypt passed (review §3 gate) | 1 evening | Yes |
| 13 | h′. **Retire the Gmail bridge** by the 30-quiet-runs criterion; flip the decl to `retired` the same deploy | 12 + ~30 days | 30 min | Yes |
| 14 | Phase 4, the seat | 13 + an off-site decrypt within the month | — | Later |
| — | **g. Warm second Stalwart** | — | days | **No.** Two Sent folders, two stores of the same pre-1.0 software, a second server to back up, and it still cannot be read without a public IMAPS port. Replace with D2 = a `forward()` copy to a mailbox on Martin's phone, which is free under C, needs one verification click, and is also the only alert path that survives the house being down |
| — | **a. R2** | — | — | **No** (§1.4) |
| — | **M2, HA-IP** | — | — | **No**; struck with A |
| — | **j. Prototype** | — | — | See §4: keep the zone and the cascade, throw away the edges |

Two notes on item 12. First, enabling routing on the zone rewrites the apex
SPF to Cloudflare-only (measured on the empty zone); Google is still the
sender that day, so the SPF must be re-set in the same session to
`v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net ~all` (the
Cloudflare include matters only if `forward()` is used). M6 is what says
whether Cloudflare overwrites, refuses, or leaves an existing record. Second,
the 24 h Exchange number applies to *senders*; the cutover itself has no
window in which mail is unheld, because Gmail keeps receiving whatever
still resolves to the old MX and the bridge keeps polling it.

---

## 4. (d) Production, or throw away and rebuild?

**Keep the cascade and the zone; throw away everything around them.**

Keep, because it was measured and its shape is right: `accept()` and
`drain()` in `spool-worker.js`, the `spoolPut`/`spoolTake` seam, the
`DRAIN_KEY`-gated manual drain, and `babeltube.tech` as the staging zone
(it is the only place the Worker can be exercised end to end without
touching a zone that carries mail, and it is where the §2.9 tests and the
§3 canary run).

Throw away, because each is a probe artefact that would be a defect in
production: the recipient-localpart switch and `brokenStore` in the
`email()` handler; `home-stub.js` (replaced by the real endpoint);
`smtp-code-probe.worker.js` (its result is recorded; the code has no second
use); the KV namespace `verder-mail-spool-probe` (create `verder-mail-spool`
so a test drain can never deliver a probe message into the real inbox);
`console.log` as the only telemetry; `DRAIN_BATCH` 25 (§2.8); the
stop-on-any-failure drain (§2.6).

Tear-down of the throwaway pieces is the README's list minus the zone's
routing and the spool Worker, which the canary reuses. The zone's catch-all
goes back to `drop` after the MX has moved and the bridge has retired.

---

## 5. Finding 4: the token that widens itself

The four permissions added on 2026-09-02 are not the problem; two of them
(`Email Routing Rules Write`, `Workers Routes Write`) are needed and one
(`DMARC Reports Read`) will be. The problem is the **property**: a token
stored in two Kubernetes secrets, used unattended by cert-manager and by
agent sessions, that carries `API Tokens Write` and can therefore become
any permission on the account without a human. M-e adds that it can also
read tunnel configuration, which was not on its record. After §2 ships, the
same token can redeploy the spool Worker and read its `HOME_TOKEN` secret,
so it holds mail custody too.

Recommendation, in Martin's hands because it is his account:

1. Mint **one account token for the mail path** with exactly: Workers Scripts
   Write, Workers KV Storage Write, Workers Routes Write and Email Routing
   Rules Write on `babeltube.tech` and `vanderpoel.pro`, DNS Write on those
   two zones, Cloudflare Tunnel Write (for the one ingress rule), and
   nothing else. Store it where the deploy runs, not in mp8s.
2. **Remove `API Tokens Write` from `hermes-agent-all-access`**, and move
   `Email Routing Addresses Write` to the mail token from step 1: it is needed
   only if D2 chooses `forward()`, and then by the deploy, not by cert-manager. The token can make that
   edit to itself; afterwards it cannot undo it, which is the point. Keep a
   copy of the pre-change definition as the earlier session did.
3. Leave the rest of it alone: cert-manager depends on its DNS scope, and
   nothing here needs it narrower.

If Martin prefers the convenience of a token that can grant itself what a
session needs, that is a legitimate choice, and it should be written down
as "every session with mp8s access holds the whole Cloudflare account,
including mail".

---

## 6. Finding 5, applied to everything else

The shape of the `_dmarc` error was: *absence within a window, beside a
positive control, turned into a mechanism*. Every conclusion in the review,
its logs, the spec and CLAUDE.md was re-read for that shape.

| Conclusion | Same shape? | Standing |
| --- | --- | --- |
| "`Email/query` filters return nothing on this store; most likely an index Vandelay never populated" | **Yes.** A zero with no JMAP error is ambiguous between an empty index and a filter the server interprets differently from the client; the unfiltered control proves the store, not the query | **RESOLVED 2026-09-06 (M-g, M-h): the inference was wrong in the way finding 5 predicts.** `subject`, `text`, `from` and date filters work on production today and on a restored snapshot; only the `header` filter returns 0, for new and old messages alike, so the zero was a property of that one filter and not of an index Vandelay left empty. The three places that state the general claim need the narrower one |
| "A bare listener on a TransIP node is unreachable on ANY port" | Partly: controls were interleaved and the NodePort flip is a positive result, but a same-source rate limit was observed during the run and "any port" rests on four ports in one window | Moot under C; recorded correctly as measured-with-caveat. Nothing to correct |
| "babeltube.tech's MX appeared only once a rule existed" | Yes | Already flagged in the log as consistent-not-proven. Leave it |
| "The lockout had lifted" | No: a positive answer from the call that was refused throughout | Stands |
| "R2 is not enabled; enabling attaches a subscription" | No: read off the dashboard | Stands |
| "146,270 = the whole store" | No: server-side `calculateTotal` against the importer's own count | Stands |
| "The age private key exists in exactly one place" | An inventory claim, not an absence inference | Stands |
| "Cloudflare does not proxy port 25" | Read from source; aimed at the wrong layer, as the review already says | Stands as corrected |
| "KV's 1,000 writes/day is far above one person's backlog" | Was an estimate | **Now measured**: 52/day (M-a). Stands |
| "The senders queue for days" (M1 ANSWERED section) | An RFC default taken as behaviour | Corrected in the spool log; the earlier sentence still stands uncorrected in place (§7.2) |

Nothing else in the documents rests on the `_dmarc` shape. One new claim in
this document has a related weakness and is marked as such: M-c judges
Cloudflare's rule through Gmail's verifiers.

---

## 7. (e) Dead text

### 7.1 The spec: supersede it, do not patch it

The review's §8 lists fifteen passages and every one is still in the file.
Striking them one by one would leave a document whose §1 diagram, §4 record
set, §6 phase table and "Why" are all replaced by text pointing elsewhere.
The honest edit is one paragraph at the top of
`2026-08-29-mail-architecture-design.md`:

> **SUPERSEDED 2026-09-02.** §1 (topology), §4 (record set), §6 (phases 2–4)
> and the first sentence of "Why" are dead as written: measured 2026-09-02,
> see the review and the re-analysis of the same date. What survives
> unchanged: the "What this is not" section, §2's storage layout and backup
> tiers, §3's alerting-by-push rule, §5, the "Risks" section, and open
> questions 1, 3, 4, 5. Phase 1 was executed as planned.

plus the fifteen inline strikes from review §8, because a reader who lands
on §4 by search must not find a record set that "CANNOT work as drawn"
(the spec's own words) presented as the target.

### 7.2 The review itself now carries dead text

Its later logs correct its earlier sections in place only twice. These
should be marked, not deleted:

| Where | Text | Do |
| --- | --- | --- |
| Verdict line 2, §1.3, §9 D1 | "none is measured", "Do not choose yet", "Measure A only if C fails" | banner: C measured and chosen the same day; A and M2 struck |
| §2.3 rows 2c, 2d; §7 M1, M2 | measurement plan | banner: M1 done, M2 moot |
| §3.1 step 1 | "Install `age` on the homelab (it is missing …)" | done; the log says so, this line does not |
| Measurement log, **"M5 — SPF is live; DMARC is being suppressed by Cloudflare"** | the whole subsection concludes a mechanism the next section retracts | **a one-line SUPERSEDED banner at the top of that subsection**, because a reader who stops there leaves with the wrong conclusion. The retraction later in the file is not enough |
| M1 ANSWERED, "queues and retries for the days RFC 5321 §4.5.4.1 describes" | corrected by the spool log's 24 h number | inline: "for about a day on Exchange Online (see the spool log)" |
| Spool log, "What is still missing", item 1 | "needs its own design" | pointer to §2 here, once approved |
| §1.3 table, C column, "Queue when home is down: the senders' queues, **if** the Worker can answer 4xx" | true and superseded by the spool | inline note |

### 7.3 Elsewhere

- `ops/cloudflare/README.md`, "Storage: KV today, R2 later": R2 is not
  "later"; §1.4. Also add the subrequest cap (§2.8) so the next reader does
  not raise `DRAIN_BATCH`.
- `docs/mail-endstate.architecture.json`: the `tunnel → stalwart:
  Email/import` edge draws the design §2.1 rejects; it wants a `mail-inbound`
  node between them. Also the `Maildir writer` and `Dropbox` nodes are
  tagged proposed/open, which is correct.
- CLAUDE.md, "Mail phase 2 gate" bullet: "the only remaining path is a
  `type: LoadBalancer` Service on 25 → HA-IP … STILL UNMEASURED" is dead;
  §8 replaces it.
- CLAUDE.md, "Files" and "phase 1" entries: every "`gmail.poll` stays
  unscheduled forever" is already superseded in place by the bridge entry.
  Leave them; the superseding line is adjacent.

---

## 8. (f) CLAUDE.md

Yes, it belongs there: every line below is measured, several contradict the
file as it stands, and the file is where the next session reads before it
touches mail. The shortest honest version, as one bullet in the project's
register:

> - **Mail front door DECIDED 2026-09-02: option C, Cloudflare Email Routing
>   → Email Worker → HTTPS home over the existing tunnel; Postfix, WireGuard,
>   the HA-IP and M2 are STRUCK.** Measured on the throwaway zone
>   `babeltube.tech` (never on `vanderpoel.pro`): a thrown handler, an
>   unroutable host and dead DNS all yield **421** so the sender queues;
>   `setReject` yields 555; **a swallowed error yields 250 and the mail is
>   LOST**, the one dangerous line, and it is ours. **THE SPOOL IS BUILT AND
>   PROVEN on Workers KV**, not R2 (R2 attaches an auto-renewing subscription
>   to Martin's card; the click is his and was not taken): one real message,
>   2789 bytes and an identical Message-ID at both ends, and a drain against a
>   still-down home KEPT it. KV is adequate on measurement: **52 messages/day
>   all-in** (Jun–Aug 2026, Vandelay archive) against 1,000 writes/day, and the
>   25 MiB value cap equals Cloudflare's inbound cap. **The number that made the
>   spool necessary: Exchange Online expires queued mail after 24 h by
>   default**, not RFC 5321's 4–5 days, so senders' queues cover a power cut and
>   not a dead disk. **Cloudflare's documented rejection rules cost 1 of 21,139
>   archived messages over 12 months and 0 of 56 from case correspondents; its
>   25 MiB cap costs ~2 messages a year** (largest ever 33.85 MB). **ENABLING
>   EMAIL ROUTING REWRITES THE APEX MX AND THE APEX SPF** (measured on an empty
>   zone) — never on `vanderpoel.pro` until the cutover session, and re-set SPF
>   to authorise Google in the same session. **SPF and DMARC (`p=none`) are LIVE
>   on `vanderpoel.pro`; DKIM (`google._domainkey`) still needs the Workspace
>   console.** A DNS lesson: a new `_dmarc` TXT was not served for 100+ s while a
>   byte-identical control served in 12 s, and appeared on its own ~45 min later
>   — slow is not suppressed; "absent beside a control" licenses "re-check
>   later", not a mechanism. **THE TOKEN WIDENED ITSELF**: `hermes-agent-all-
>   access` is a USER token with API Tokens Write and can grant itself any
>   permission without a dashboard; narrowing it is Martin's decision (§5 of
>   the re-analysis). **`BACKUP_AGE_RECIPIENT` MUST STAY UNSET** until
>   `mail-backup.sh` writes the plaintext weekly AND a `.age` beside it: the
>   drill refuses to decrypt and counts a skipped tier 2 as failure in the one
>   worker whose errors never age out, on a five-week delay; and the age private
>   key exists in exactly ONE place (`~/.config/age` on the MacBook). **Stalwart
>   `Email/import` does NOT dedup** (read at v0.16.19: the Message-ID skip is
>   `is_smtp()` only, no `alreadyExists`) and runs no spam classifier, so the
>   home endpoint keeps sha256 receipts of its own. Nothing accepts a pushed
>   message yet; the endpoint is designed (`2026-09-02-mail-reanalysis.md` §2)
>   and unbuilt. `gmail.poll` at `*/15` remains the bridge until the MX moves.

That is long for a bullet and every clause has a reader: the next session
that touches DNS, the backup, the token, or the Worker. Nothing in it is a
projection.

---

## 9. Proposed measurements and tests (need a go-ahead; none has run)

| # | What | Cost | Reversible | What invalidates a run |
| --- | --- | --- | --- | --- |
| M4 | **DONE 2026-09-06, see M-g/M-h.** Upload + `Email/import` proven, duplicate-on-import proven, `Email/changes` handoff proven, and the search claim corrected to "`header` filters only" | ran in ~4 min | was; nothing left behind (0 drill containers, empty scratch, production stalwart untouched) | — |
| M6 | On `babeltube.tech`: add an apex SPF TXT and a dummy MX, disable Email Routing, re-enable it, read back every apex record | 30 min | yes; the zone carries no mail and every record is deletable | reading before propagation settles (the `_dmarc` lesson: wait, re-read, and use the API's stored records as the control) |
| T1 | The §2.9 real-infrastructure tests, from the babeltube.tech Worker against the production endpoint | 1 h once §2 is built | yes; test messages land in the real inbox and are irrelevant to the poll | a Worker still pointed at the stub; a test that reads the status code instead of the receipt row |
| T2 | Drain of 20 spooled messages on the free plan | 10 min | yes | a paid Workers plan (the cap is 10,000 there) |
| M7 | Optional: what SMTP code the sender gets when the Worker is killed by Cloudflare for exceeding its wall-clock budget | one evening | yes | moot once the Worker has its own timeout; run only if a held session is ever observed in production |

---

## 10. Decisions for Martin

- **D1** front door: **DECIDED 2026-09-06: C with the spool on KV** (§1). A and M2 struck; R2 unsubscribed.
- **D2** warm second store: **DECIDED 2026-09-06: a `forward()` copy to a mailbox on
  Martin's phone**, not a second Stalwart. The provider is a PERSONAL GMAIL, not the
  Workspace seat; the exact address is named when the Worker is built, and it needs one
  verification click.
- **D3** age key custody: **DECIDED 2026-09-06: paper twice (one copy in the house, one
  elsewhere) plus a password-manager entry with an offline cache on the phone.** Martin's
  30 minutes; `BACKUP_AGE_RECIPIENT` stays unset until he says it is done (§3 item 9).
- **D4** off-site target: **DECIDED 2026-09-06: TransIP Stack**, not Dropbox. Stack is
  Nextcloud-based WebDAV, which rclone supports (`webdav` backend, vendor `nextcloud`) with a
  username and an app password rather than an OAuth grant; the quota is whatever the Stack
  plan holds and must be read before the first push. The weekly push follows D3 (§3 item 10).
- **D6** the token: **DECIDED 2026-09-06, kept as is.** The consequence is recorded in
  CLAUDE.md and the token memory: every session with mp8s access holds the whole
  Cloudflare account, including mail.
- **D7** the home endpoint: **APPROVED 2026-09-06 as designed in §2.** The build
  follows the order in §3 with M4 first.
- **D8** the domain: RDAP showed `vanderpoel.pro` (registrar Key-Systems GmbH, reseller
  most likely TransIP) expiring 2026-09-06. **Martin confirmed the renewal on 2026-09-06.**
- **D9, raised by Martin 2026-09-06: the Sign-in-with-Google inventory.** Phase 4 deletes
  the Google identity `martin@vanderpoel.pro`, and every service where he signed in with
  Google stops admitting him; a later Google account with the same address would carry a
  different subject id and would not be recognised either. So phase 4 gains a gate: the
  list from `myaccount.google.com/connections` (authoritative for active grants) and the
  admin console's "Accessed apps" (cumulative, org-wide), each app given a password or
  passkey login or a changed e-mail BEFORE the seat goes. The alternative worth pricing is
  keeping the seat as identity only after the MX moves, with the Gmail service switched
  off. MEASURED 2026-09-06: the mail archive is NOT a usable inventory — Google's security
  alerts have named only devices since 2019 (69 "Security alert" mails since 2022, all
  "a new sign-in on <device>"), the 2019 alerts name three apps, and third-party welcome
  mail says "with Google" in six cases across ten years.
- **D10, found in the same scan: the domain has other Google accounts.** `fae@vanderpoel.pro`
  and `damian@vanderpoel.pro` receive Google security alerts with Martin as recovery
  address, and one alert reads "Nieuw apparaat ingelogd op damian@vanderpoel.pro". The spec's
  "one domain, one human" is therefore false at the Workspace level. Whether these are
  users with their own mailboxes or aliases decides two things: where their mail goes when
  the MX moves (the catch-all Worker would deliver it into Martin's inbox), and whether
  phase 4 can delete "the seat" at all. **ANSWERED 2026-09-06: damian@ and fae@ get their
  OWN mailboxes on Stalwart.** So the store hosts three accounts, and the following change:
  1. **The endpoint routes by recipient.** Cloudflare invokes the Worker once per envelope
     recipient, so `X-Envelope-To` names exactly one address; the endpoint maps it to a
     Stalwart account from a fixed list (`martin`, `damian`, `fae`). An address not on the
     list is refused at the Worker with `setReject` (a 5xx the sender sees, as Google gives
     for an unknown user), never delivered into somebody else's inbox.
  2. **Importing into another account needs a right the poll's credential does not have.**
     Two ways, both to be MEASURED on the scratch server before one is chosen: an ingest
     principal granted `mayAddItems` on each Inbox through Stalwart's mailbox sharing
     (`urn:ietf:params:jmap:mail:share` is advertised, and `import.rs` checks
     `Acl::AddItems` on shared mailboxes), or one app password per account in `.env.prod`.
     The first keeps the home endpoint write-only; the second hands the worker full read
     access to two mailboxes it must never read.
  3. **The dossier reads Martin's account only.** `mail.poll` authenticates as
     martin@ and sees nothing of the other two; that is a privacy line, not an accident,
     and the endpoint's credential must not be reused by the poll.
  4. **Spam.** `Email/import` runs no classifier (R-2), which was tolerable for one
     dossier-shaped mailbox and is not for two family inboxes that Gmail filtered until now.
     The SMTP/LMTP path into Stalwart runs the classifier, routes by recipient natively and
     dedups on Message-ID per mailbox; it costs an internal listener and an SMTP client in
     the endpoint. This re-opens §2.5's choice and wants a measurement (M4c: an LMTP listener
     on the scratch server, one message per recipient, spam headers read back).
  5. **Tier 2 of the backup pulls ONE account** (`--account-name martin@`), so the survival
     archive would not hold the other two mailboxes; `mail-backup.sh` needs one pull per
     account, and the drill's manifest counts only Martin's mailboxes today.
  6. **They need a way to read and send.** Stalwart publishes JMAP only, through the
     tunnel; there is no webmail in the stack and IMAPS cannot ride the tunnel. Before the
     MX moves, each user needs a client that works (a JMAP-capable app, or a webmail
     service inside the compose network behind the tunnel and a login) and an outbound
     path. This is a sub-project, not a task.
  7. **Phase 4 is three identities, not one**, and D9's inventory applies to each: a child's
     school or gaming account signed in with Google is exactly the login that breaks.
  **History: DECIDED 2026-09-06, they start EMPTY on Stalwart.** Their Gmail history stays
  at Google while the seats exist and is gone with them unless exported first, which is a
  line for the phase 4 checklist. **Identities: DECIDED 2026-09-06, ALL THREE SEATS STAY as Google
  identities with the Gmail service switched off after the MX has moved.** Phase 4 is
  therefore no longer "delete the seat": it is "switch Gmail off per user, once the bridge
  has retired by the §6 criterion", and D9's SSO inventory stops being a gate and becomes
  optional per person. Two things to verify BEFORE the switch, read from Google's own
  documentation and not from memory: what Workspace does with a user's mail data once the
  Gmail service is off for them (export first if it is deleted on a timer), and that
  Sign in with Google keeps working for an account whose Gmail is off (it should; it is a
  Google identity, not a mailbox). Still open: which client; which delivery path (M4c).
- **D11, DECIDED 2026-09-06: a WEBMAIL behind the tunnel is how all three read and send.**
  Candidate: **Roundcube** (mature, responsive "elastic" skin on phones, one container with
  SQLite, IMAP and submission to Stalwart INSIDE the compose network, CalDAV/CardDAV plugins
  that Stalwart already serves), with SnappyMail as the fallback if the phone experience
  disappoints. Shape: `mail.vanderpoel.pro` → tunnel → the Roundcube container; Roundcube →
  `stalwart:143`/`:587` on the compose network, never published to the host; users log in
  with their Stalwart password. Consequences, all to be measured before the MX moves:
  1. Stalwart needs an IMAP listener and a submission listener again, bound to the
     compose network only — the wizard's six were deleted on purpose; two come back,
     unpublished, and `docker compose port stalwart 143` must still fail.
  2. The login page is internet-facing. The zone's ONE free-plan rate-limit rule (today on
     verder's `/api/auth/*`) is widened to cover Roundcube's login POST as well, and
     Stalwart's own authentication rate limit stands behind it.
  3. Outbound: Roundcube → Stalwart submission → Stalwart's queue → a **relay**, because a
     home IP does not deliver. Resend offers SMTP relay, so the spec's "Resend over HTTPS"
     becomes "Stalwart relays to Resend over SMTP submission", DKIM signed by whichever side
     the domain records authorise. Outbound is its own measurement; nothing sends until it
     has passed.
  4. The measurement (M8): Roundcube container on the compose network against a Stalwart
     with an internal IMAP listener; log in as martin@, read the inbox; create damian@,
     send martin→damian locally, read it as damian. Where it runs is Martin's call: on the
     scratch server (needs the recovery admin passed to the drill container and the
     listener created through the registry API, an hour of source reading first) or on
     PRODUCTION with an unpublished listener (five minutes in /admin, reversible, no data
     touched, but a production config change).
