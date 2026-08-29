# Eigen mail: Stalwart thuis, een voordeur bij TransIP

Date: 2026-08-29
Status: approved, phase 1 planned
Sub-project 9. The mailbox cleanup (sender triage + bulk delete against Gmail)
is a SEPARATE sub-project that sequences before phase 3 of this one; it gets its
own spec.

## Why

Gmail ingestion is down and cannot be restarted. On 2026-08-29 the account sat
in an account-level rate limit that refuses even a 1-unit `users.getProfile` and
a 5-unit `messages.list`, and that every attempt re-arms for another fifteen
minutes — 378 rate-limited skips in 24 hours, last successful poll 00:07. The
burn that caused it is fixed (`buildQueries` filters server-side now), but a
cheaper query cannot escape a lockout that ignores cost per call. `gmail.poll`
is therefore unscheduled and **no mail reaches the dossier at all**.

That is the trigger, not the reason. The reason is that a bewindvoerings- and
WSNP-dossier should not depend on one provider's undocumented throttle to decide
whether a sommation from a schuldeiser is seen this week. Martin: e-mail is the
most important service he uses, "so this has got to be unbreakable".

## What this is not

**Not a cheaper Gmail.** The comparison of Fastmail, Migadu, Purelymail and Zoho
is done and recorded in the research; Martin chose to self-host. Cost is not the
driver.

**Not a Gmail cleanup.** Deleting the thousands of commercial mails is its own
sub-project with its own destructive-action design. This spec only has to make
sure the junk does not become TransIP's problem, and the 90-day window in §2
does that on its own.

**Not a second mailbox for anyone else.** One domain, `vanderpoel.pro`, one
human. `dytechsolutions.nl` stays on Google and is out of scope.

## What the investigation established

Measured this session, not assumed. Everything else in this spec is a proposal.

- **mp8s is on the home LAN.** Single Talos node, `192.168.188.56`, `EXTERNAL-IP
  <none>`, its one LoadBalancer `<pending>` for 192 days. mp8s and the homelab
  are ONE failure domain — one router, one ISP, one power feed — and neither can
  host an MX.
- **TransIP is the only public front door.** Five nodes with real public IPs
  across four networks: `149.210.166.143`, `136.144.162.163`, `149.210.166.144`,
  `37.97.184.180`, `93.119.6.69`, with a working LoadBalancer via
  `haip.transip.net`.
- **Cloudflare does not proxy port 25.** No MX can ride a tunnel. Arbitrary-TCP
  tunnels need a paid Zero Trust plan, so the TransIP↔home transport is
  WireGuard, dialled OUTBOUND from home so the house keeps zero inbound ports.
- **TransIP blocks outbound 25/465/587 by default** to protect its IP reputation,
  and opens them on request, free. Inbound is not part of that block — but this
  is UNVERIFIED and is the first thing phase 2 must prove.
- **Stalwart is the only practical self-hosted JMAP server.** Mailcow (Dovecot)
  and Maddy do not speak JMAP at all, and JMAP is a hard requirement.
- **Bulk export exists and touches neither IMAP nor the Gmail API.** Google
  Takeout and the Workspace Data Export tool both produce `.mbox`; Data Export
  lands in a Cloud Storage bucket you pull with `gcloud storage`. Stalwart's own
  migration CLI, **Vandelay**, imports Google Takeout `.mbox` directly.
- **The homelab has three local volumes, not one.** The `203 GB / 37 GiB free`
  figure is the ROOT partition only, and reading it as "the machine" is what
  first pointed this design at the NAS. The real inventory (`df -H`, decimal, as
  the machine reports it):

  | Mount | Device | Size | Free | Holds |
  | --- | --- | --- | --- | --- |
  | `/` | Kingston p5 | 221 GB | **40 GB** (82%) | OS, Postgres, verder vault |
  | `/mnt/data` | Kingston p2 | 790 GB | **342 GB** (55%) | docker, ollama-models, airteq-voice |
  | `/mnt/ai` | Lexar 2 TB | 2.1 TB | **351 GB** (83%) | HuggingFace cache, k3 |
  | `/mnt/nas-download` | NAS, NFS | 7.3 TB | 2.9 TB | backups |

  ~690 GB of free LOCAL NVMe. Mailbox capacity is not a constraint here.
- **Martin's Gmail size: ~30 GB, his estimate, not measured.** See Open questions.

## 1. Topology

```
                 MX 10 → mx1 (149.210.166.143)
  the internet ──MX 20 → mx2 (37.97.184.180)      [TransIP, public]
                            │
                  ┌─────────▼─────────────┐
                  │ Postfix (edge)        │  accept + queue + fan out
                  └────┬─────────────┬────┘
                 LMTP  │             │  SMTP over WireGuard
                       ▼             ▼  (dialled OUTBOUND from home)
            ┌──────────────────┐   ┌──────────────────────┐
            │ Stalwart @TransIP│   │ Stalwart @home       │
            │ 90-day window    │   │ full archive         │
            │ emergency inbox  │   │ ← verder reads JMAP  │
            └──────────────────┘   └──────────────────────┘
                       └──── outbound ────┬─→ Resend (HTTPS API)
```

**Postfix at the edge, not Stalwart.** The always-on front door is the component
that must never surprise anyone, so it is the mature one. It accepts, queues and
fans out; if both destinations are unreachable it holds mail on disk, which is
its oldest and best-tested path. Stalwart's pre-1.0 status is acceptable for a
mailbox you can restore; it is not what should stand between a schuldeiser and
an accepted message.

**Two MX records in two different TransIP networks.** This is the free
redundancy layer. Cloudflare cannot provide a fourth: Email Routing insists on
owning the zone's MX records and stops working the moment another MX takes
priority, so it cannot sit behind a self-hosted primary.

**DUAL DELIVERY, NOT REPLICATION.** Postfix delivers each accepted message
twice, to two independent stores. Neither is a copy of the other, so there is no
replication protocol to break and **no split-brain on content**. Divergence is
limited to flags (read/unread, folders), which is cosmetic and cannot lose a
message. The rejected alternative — home primary, TransIP async replica — works
until the day it is needed and then produces two mailboxes to merge by hand,
under exactly the stress this design exists to avoid.

**Why the TransIP replica is warm rather than a pure spool.** Martin chose it
knowingly over the smaller-footprint option: during a home outage he can still
read and reply. The footprint constraint is honoured by the 90-day window (§2),
not by refusing to store.

## 2. Storage and the backup fan-out

**Home holds the full archive; TransIP holds a rolling 90 days** — measured
from each message's own date, pruned nightly, so the window slides rather than
filling up. Junk from 2019
cannot reach TransIP whatever the cleanup sub-project does or does not delete.

**The whole store goes on `/mnt/data`** — metadata and blobs both, local ext4 on
NVMe, 342 GB free. At Martin's estimated ~30 GB that is under a tenth of the
volume, and the cleanup sub-project only shrinks it. `/mnt/ai` has comparable
free space but sits at 83% behind a HuggingFace cache that grows without asking;
`/mnt/data` is the calmer neighbour.

The metadata/blob split stays in the config as two settable paths, because phase
2 may want it and it costs nothing — but in phase 1 both point at the same local
volume. **NEVER put the metadata store on NFS** — that is how a mail database
corrupts. Keeping the whole store local means that rule is never approached
rather than merely respected.

The honest limit: `/mnt/data` is a second partition on the SAME physical disk as
`/`. That is capacity, not redundancy — one dead Kingston takes root and the mail
store together. The backup fan-out below is what covers that, which is its job.

**Five backup targets, grouped honestly:**

| | Targets | Survives |
| --- | --- | --- |
| Same house | mp8s, homelab, NAS | a disk dying |
| Off-site | Dropbox, TransIP Stack | fire, flood, theft, ransomware |

Three of the five die together. 3-2-1 holds only because of the last two.

**FORMAT IS THE LOAD-BEARING DECISION.** A native Stalwart snapshot restores
fast and depends on the same Stalwart version reading its own on-disk format —
precisely the thing still being finalised before 1.0. A neutral **Maildir**
export restores into anything: another Stalwart, Dovecot, Fastmail, back into
Gmail. So: nightly native snapshot for speed, **weekly Maildir export for
survival**, and never a generation where only the native form exists.

**Encrypt before it leaves.** Dropbox and TransIP Stack would hold bewindvoering
correspondence. Backups to them are encrypted by Martin (`age` or `restic`), not
merely by the provider's at-rest promise. **The key cannot live only on the
homelab** — losing the homelab would lose the backups with it. Password manager,
and on paper.

This extends `ops/nightly.sh`; it does not add a second cron.

## 3. Monitoring, and what "tested restore" means

**Alerts go by push, never by mail.** `sendPush` (web-push/VAPID) already exists
and does not depend on the thing being monitored. An alerting path that emails
you is useless in exactly the outage it is for.

Four probes:

1. **End-to-end delivery, hourly.** Resend sends to a canary address on the
   domain; the probe asserts arrival in BOTH stores within 5 minutes. The only
   check that exercises the whole chain — MX, edge, tunnel, fan-out, both stores.
2. **Edge queue depth.** Postfix holding mail for home beyond 15 minutes means the
   tunnel or the homelab is down. Below that it is ordinary retry, not an
   incident.
3. **Store divergence.** Message counts for the last 90 days should agree between
   home and TransIP.
4. **Perimeter.** MX resolves, TLS not near expiry, relay not blocklisted, DMARC
   reports ingested.

**The drill, monthly and automated.** Restore last night's backup into a scratch
Stalwart container and assert three things: message count matches, a sample of
messages is byte-identical by sha256, and JMAP answers. Recorded in
`worker_runs`, non-zero exit on failure, exactly like `nightly-verify`.

**The drill must exercise the Maildir export at least monthly**, not only the
native snapshot. Testing solely the fast path leaves the survival path unproven,
which is the failure you would discover only when it is the one you need. A
backup that has never been restored is a rumour.

## 4. DNS and Cloudflare

Zone `vanderpoel.pro` on Cloudflare (`leia`/`vick` NS). Token: mp8s secret
`cert-manager/cloudflare-api-token` — DNS and Access, NOT rulesets/WAF.

**Tunnels, as inventoried 2026-08-29:**

| ID | Name | Status | Carries |
| --- | --- | --- | --- |
| `ebef6630` | homelab-host | healthy, 4 conns | `verder.vanderpoel.pro`, chat |
| `d65103f1` | homelab-tunnel | healthy, 4 conns | ~35 mp8s hostnames |
| `b27a94fc` | operator-os-dev | healthy, 4 conns | `os.vanderpoel.pro` |
| `02515f1c` | transip-airteq | healthy, 8 conns | TransIP workloads |
| `50654928` | aios-daemon | **DOWN, 0 conns** | `hermes.vanderpoel.pro` — dead record |

Access apps on the zone: verder, snowball, Frits Control UI, ArgoCD.

### THE LANDMINE

```
CNAME  *.vanderpoel.pro  →  vanderpoel.pro  [proxied]
```

A proxied wildcard. Every undefined hostname resolves to Cloudflare anycast,
which carries HTTP/HTTPS and nothing else. `mx1.vanderpoel.pro` will resolve
beautifully — to an address that drops port 25 on the floor. DNS looks healthy
and mail silently fails.

**EVERY MAIL HOSTNAME MUST BE AN EXPLICIT DNS-ONLY (GREY CLOUD) RECORD.** Not a
preference; the wildcard guarantees the failure otherwise. Cloudflare will not
let you proxy an MX record, but it will happily let you proxy the A record the MX
points at, which breaks mail just as thoroughly.

**The corollary is useful: JMAP is HTTPS, so it CAN ride the tunnel.**
`mail.vanderpoel.pro` goes through `homelab-host` with Access in front, exactly
like verder does today. Only SMTP has to touch the open internet.

### Three gaps that exist right now

| Record | State | Consequence |
| --- | --- | --- |
| SPF (apex TXT) | **absent** | nothing authorises Google to send as the domain |
| DMARC (`_dmarc`) | **absent** | no policy, no reports, no spoofing visibility |
| DKIM (`google._domainkey`) | **absent** | outbound is unsigned |

There is a `smtp._domainkey` RSA key from an earlier setup — identify it before
trusting or removing it. These are live weaknesses today, not future ones: the
domain has been sending unauthenticated mail to Verder and to creditors.

### Target record set

| Type | Name | Value | Proxy |
| --- | --- | --- | --- |
| A | `mx1` | `149.210.166.143` | **DNS-only** |
| A | `mx2` | `37.97.184.180` | **DNS-only** |
| MX 10 | `@` | `mx1.vanderpoel.pro` | n/a |
| MX 20 | `@` | `mx2.vanderpoel.pro` | n/a |
| TXT | `@` | `v=spf1 include:_spf.resend.com -all` | n/a |
| TXT | `resend._domainkey` | Resend's DKIM key | n/a |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=…` | n/a |
| CNAME | `mail` | homelab-host tunnel | proxied (JMAP is HTTPS) |

DMARC starts at `p=none` with reporting, watched for a week, then tightened to
`quarantine` and only then `reject`.

## 5. The verder integration

`GmailPort` already has the right shape — `listMessageIds` / `getMessage` — so
this is a new implementation behind the existing interface, not a rewrite.

- **`JmapPort`.** `Email/query` + `Email/get` chained in ONE round trip via
  back-references; blob download for attachments; blob upload +
  `EmailSubmission` for drafts-with-attachments and sending.
- **`Email/changes` replaces the time window.** A JMAP state string is the real
  equivalent of Gmail's History API. Fetching deltas rather than sweeping seven
  days makes the entire class of bug fixed this week impossible to reintroduce.
- **IDENTITY MUST NOT BREAK.** `raw_emails.gmail_message_id` is ALSO
  `documents.source_ref`, and the metro map's third level (the mail and its files
  under a stop) is DERIVED from it, never stored. Keep the column, add a `source`
  discriminator (`"gmail" | "jmap"`), and never rewrite a historical id.
- **The vault is the safety net.** Every row carries `rawRfc822Sha256`, so
  content stays independently verifiable regardless of which provider issued the
  id.
- **No rate limits.** It is Martin's own server: poll every 60 s, or use
  `PushSubscription` for real time.
- **Budget a new eval baseline.** Message parsing changes, so the entry, task and
  docmeta evals must be re-measured against the golden rule, not assumed.

Outbound sending goes Stalwart → Resend over the **HTTPS API**, not SMTP:
Resend's SMTP ports are exactly the ones TransIP blocks, and 3.000 free sends a
month is far above Martin's volume.

## 6. Cutover

| Phase | What | MX touched? |
| --- | --- | --- |
| 1 | Stalwart at home, Takeout → Vandelay import, `JmapPort`, verder ingesting again | no |
| 2 | TransIP edge: prove inbound 25, request the outbound opening, Postfix, WireGuard, test on a throwaway subdomain MX | no |
| 3 | SPF/DKIM/DMARC first, then TTL to 300, then swap MX; Gmail forwarding stays ON | **yes** |
| 4 | 30 quiet days, then decommission the Workspace seat | no |

**Phase 1 restores the lost ingestion without touching mail delivery at all.**
That is worth doing first whether or not the rest ever happens, and it is the
part that ends the current outage.

**Phase 2 is where this design can still die.** If TransIP refuses inbound 25,
the front door has no home and §1 needs rework before anything else proceeds.

**Order within phase 3 is not negotiable:** authentication records go in and are
observed BEFORE the MX moves. Swapping MX first means a window where mail
arrives at a domain with no SPF, no DKIM and no DMARC.

## Open questions

1. **How large is the Gmail mailbox?** Martin's estimate is ~30 GB; still not
   measured, because the Gmail API exposes no aggregate byte count and the
   worker's token is `gmail.readonly`, so no Drive API. The figure lives at
   `one.google.com/storage`. **It no longer decides anything structural** —
   `/mnt/data` has 342 GB free and swallows the estimate ten times over. What it
   still sizes is the BACKUP fan-out: a 30 GB store means a ~30 GB weekly Maildir
   export encrypted to Dropbox and TransIP Stack every generation, which is the
   strongest argument for running the mailbox cleanup BEFORE the import rather
   than before phase 3. Note also that "mailboxes" may span `dytechsolutions.nl`,
   which is out of scope, so the in-scope figure may be well under 30 GB.
2. **Does TransIP allow inbound port 25 on the k8s LoadBalancer?** Their
   published block is explicitly about OUTGOING mail ports. Unverified, and
   phase 2 gate.
3. **What is `smtp._domainkey`?** A live DKIM record for an unidentified sender.
4. **Is `vanderpoel.pro` a paid Workspace seat?** Decides whether phase 4 saves
   ~€83/year or nothing.

## Risks, honestly

- **Stalwart is pre-1.0** and would become the system of record for the service
  Martin calls the most important one he uses. Mitigations: it also speaks
  IMAP4rev2 so the escape hatch is at the protocol layer; the weekly Maildir
  export does not depend on Stalwart existing; and the drill proves both.
- **Both stores run the same software**, so a Stalwart bug is a correlated
  failure across home and TransIP. The Maildir export is the only thing that
  isn't correlated. This is a real limit of the dual-delivery design and is
  accepted knowingly.
- **A warm replica means two inboxes.** Flags, folders and sent mail diverge
  during a failover. Nothing is lost; it is still friction, and the honest
  version of "the worst divergence is an unread flag" is that it is also a second
  Sent folder.
- **The operator is one person with a WSNP timer running.** Every hour spent on
  mail infrastructure is an hour not spent on the dossier. Phase 1 is the part
  that pays for itself; phases 2–4 are optional and can wait indefinitely without
  losing phase 1's benefit.
