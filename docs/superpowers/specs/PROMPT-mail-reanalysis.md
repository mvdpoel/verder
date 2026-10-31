Re-analyse the mail plan end to end, with everything measured since the review
was written. SCOPE: judgement and re-derivation first. Propose before you build;
the only things already authorised are read-only probes and work on the
throwaway zone.

SOURCES, in priority order:
  The review that superseded the spec (the current thinking):
    docs/superpowers/specs/2026-09-02-mail-architecture-review.md
    Read it whole. It has THREE appended logs after the original review —
    the measurement log, the M1/token log, and the spool log — and the later
    ones correct the earlier ones. Read its status header first: the review was
    read-only, the logs were NOT.
  The spec now on trial for a second time:
    docs/superpowers/specs/2026-08-29-mail-architecture-design.md
    §8 of the review lists fifteen passages already judged dead. They are still
    in the file. Nobody has struck them.
  The proven prototype and its teardown steps:  ops/cloudflare/README.md
  Phase 1, executed:  docs/superpowers/plans/2026-08-29-mail-phase-1-jmap.md
  Deploy runbook, §8 especially:  docs/deploy.md
  CLAUDE.md — the measured record, and NOT yet updated with anything from
    2026-09-02. That gap is itself a finding.

STATE, verified 2026-09-02, do not re-derive:
  - HEAD 288e838. NOTHING from 2026-09-02 is committed. Untracked: the review
    document, ops/cloudflare/, and four docs/mail-*.{html,json} diagram files.
  - Ledger 140 events / 77 documents / 140 raw_emails, head fe94663d4ae6,
    UNCHANGED across the whole day. Nothing done on 2026-09-02 wrote evidence.
  - Schedules live: mail.poll and search.drain and docmeta.sweep at * * * * *,
    gmail.poll */15, nas.scan and registry.mine */2, heartbeat */5.
  - vanderpoel.pro MX still Google. SPF and DMARC live. google._domainkey absent.
  - homelab: age 1.1.1 installed, BACKUP_AGE_RECIPIENT unset, rclone has zero
    remotes. The age private key exists in exactly ONE place, ~/.config/age on
    the MacBook, mode 600.
  - Cloudflare: R2 NOT enabled. KV namespace verder-mail-spool-probe live.
    Workers m1-mail-spool, m1-home-stub, m1-mail-probe on babeltube.tech only.

WHAT CHANGED, each of these measured, several contradicting the documents:

 1. THE FRONT DOOR IS DECIDED AND PROVEN. Option C: Cloudflare terminates SMTP,
    an Email Worker posts the raw bytes over the existing tunnel. Measured: a
    thrown handler, an unroutable host and dead DNS all yield 421 so the sender
    queues; setReject yields 555; and a SWALLOWED error yields 250 with the mail
    lost. Postfix, WireGuard, the HA-IP and a port-25 certificate are all struck.
    M2 (the TransIP LoadBalancer) is moot unless option C is rejected for some
    other reason.

 2. THE NUMBER THAT CHANGED THE DESIGN. Exchange Online expires queued mail
    after 24 HOURS by default, not the 4-5 days RFC 5321 suggests. The review's
    own "the senders queue for days" was too generous and is corrected in place.
    A power cut is covered; a dead disk is not.

 3. THE SPOOL IS BUILT AND PROVEN, on KV, on the throwaway zone. One real
    message: 2789 bytes and an identical Message-ID at both ends, and a drain
    against a still-down home KEPT the message. Storage is KV and not R2 because
    enabling R2 attaches an auto-renewing subscription to Martin's card; that
    click is his and was deliberately not taken.

 4. THE TOKEN WIDENED ITSELF. The mp8s cert-manager token is the USER token
    hermes-agent-all-access and carries API Tokens Write, so it can grant itself
    permissions with no dashboard. It gained Email Routing Rules Write, Email
    Routing Addresses Write, Email Security DMARC Reports Read and Workers
    Routes Write. Consider whether that self-granting property is acceptable or
    should be narrowed.

 5. A WRONG CONCLUSION I PUBLISHED AND THEN CORRECTED. I claimed Cloudflare was
    suppressing _dmarc, on a sound differential test (a byte-identical control
    served in 12 s while _dmarc did not for 100+ s). It appeared on its own ~45
    minutes later. Slow is not suppressed. Check whether any OTHER conclusion in
    these documents rests on the same shape of inference.

 6. ENABLING EMAIL ROUTING REWRITES THE APEX. It installs Cloudflare MX on the
    apex AND an apex SPF authorising Cloudflare only. On vanderpoel.pro that
    would take live mail from Google mid-bewindvoering. This is why every probe
    runs on babeltube.tech.

 7. TURNING ON BACKUP ENCRYPTION WOULD BREAK THE RESTORE DRILL, on a five-week
    delay. mail-backup.sh writes the weekly archive as plaintext OR .age, never
    both; the drill refuses to decrypt and counts a skipped tier 2 as failure,
    in the one worker whose errors never age out. The proposed fix — plaintext
    on the NAS, encrypted only on the way out — is NOT made.

OPEN, and none of these has been decided:
  a. The R2 subscription. Martin's click, or stay on KV and live with 25 MiB
     per value and 1000 writes a day.
  b. THE HOME ENDPOINT. Nothing accepts a pushed message today; verder PULLS
     from Stalwart over JMAP. This is the largest unbuilt piece and it needs a
     design: where it lives, how it authenticates, how it performs Email/import,
     and what it does with a duplicate.
  c. Spool monitoring. A spool filling up quietly is an outage that looks like
     health.
  d. DKIM in the Google Workspace console, then Start authentication.
  e. Dropbox OAuth, and whether the account has room for 3.83 GB weekly.
  f. The mail-backup.sh change from finding 7.
  g. The warm second store: keep the spec's replica, settle for a forwarded
     copy you can read, or accept being blind during an outage.
  h. When the MX actually moves, and the 30-quiet-polls criterion for retiring
     the Gmail bridge.
  i. The JMAP request timeout, deferred since phase 1 and still absent.
  j. Whether to keep or tear down the babeltube.tech prototype.

WHAT I WANT OUT OF THIS:
  a. Is option C still the right call now that the spool exists and the 24-hour
     number is known? Argue it, do not assume it because it was measured.
  b. A design for the home endpoint (b above), because everything else waits on
     it. Include what happens on a duplicate, and how it fails safe.
  c. An ordering for the open list: what is gated on what, what is an hour, and
     what is a week. Say plainly which items are not worth doing at all.
  d. A judgement on whether the prototype should become production or be thrown
     away and rebuilt with what was learned.
  e. Anything in the review or the spec that is now dead text and should be
     struck rather than left to mislead a future reader. The spec still carries
     fifteen such passages that nobody has removed.
  f. Whether the 2026-09-02 work belongs in CLAUDE.md, and if so, what the
     shortest honest version is. It is long and it is all measured.

METHOD:
  - Read before concluding. The review contradicts the spec, and its later logs
    contradict its earlier ones.
  - Distinguish READ-FROM-SOURCE from MEASURED-AGAINST-A-RUNNING-THING, and say
    which every claim is. Finding 5 is what happens when that slips.
  - Where you recommend a test, say what it costs, whether it is reversible, and
    what would invalidate the run.
  - Prefer removing a thing over adding one. The best result of the last review
    was deleting Postfix, WireGuard and a load balancer.

NON-NEGOTIABLE:
  - Nothing routed at vanderpoel.pro. Probes run on babeltube.tech.
  - No subscription, no payment method, no terms accepted. If a path needs one,
    stop and say so.
  - Do not enable Email Routing on any zone that carries mail.
  - env -u NODE_ENV for anything you run; tests from the package directory.
  - Migration before images if any migration appears; verify after.
  - Talk to me in English; the app stays Dutch.
