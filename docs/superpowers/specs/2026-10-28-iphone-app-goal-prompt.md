ultracode

Goal: build "verder for iPhone" end to end, as specified in
docs/superpowers/specs/2026-10-28-iphone-app-design.md. Martin approved that
spec. Read it in full, then read CLAUDE.md in full. Every law and deploy trap
in CLAUDE.md applies.

Order: deliver in the slices of spec §10, one at a time. A slice is done when
its own verification from spec §9 passes on the real phone and the real
homelab. Do not start the next slice until it is.

Before code:
- Write the implementation plan with superpowers:writing-plans into
  docs/superpowers/plans/2026-10-28-iphone-app.md.
- Settle the types and module shape for the proposals pipeline and the mobile
  API with pstack:architect.

Toolchain (slice 1):
- Update Xcode to the newest stable 26.x and install the matching iOS platform.
- Connect Martin's iPhone 16 Pro (paired; devicectl id
  4151AD85-3F8B-5DE7-9B5F-CCD2534206A5) and read its iOS version. Below iOS 26
  is a stop-and-ask.
- Sign with Martin's paid team, development profile, this device only. Never
  App Store.

Hard rules:
- Nothing is ever SENT (mail, any outbound message) without Martin's explicit
  approval of the final text. That includes test sends: ask first, every time.
- Evidence stays append-only. Each migration is applied from the homelab HOST
  before the new web/worker images.
- Before each deploy: `next build` runs locally, and the rsync dry run
  (`--dry-run --info=del`) has every `deleting` line read.
- After each deploy: nightly-verify passes, and the ledger delta matches what
  you predicted.
- Measure before claiming. That covers the cleanup quality on 5 real letters,
  the auto-file confidence threshold, PDF size against OCR accuracy, cold
  launch time, and a push actually arriving on the locked phone. Record each
  number in the PR or in CLAUDE.md.
- Ask Martin for the manual steps only he can do: the APNs .p8 key in the
  developer portal, Face ID or passkey prompts on the phone, and letters to
  scan. Keep working on whatever isn't blocked meanwhile.
- The app UI is Dutch. Code, commits and docs are English.
- Port the Holodek tokens from apps/web/src/app/globals.css one-to-one.
  Amber is only for what is waiting on Martin.

Standing authority: ssh homelab, push to main, deploy. Destructive actions
still get asked first.

Finish:
- Update CLAUDE.md: the iPhone app, the law amendment (verder may file and
  link documents on its own; sending always needs approval), every trap you
  found, and every measured number.
- Report each slice to Martin, with times in Europe/Amsterdam.
