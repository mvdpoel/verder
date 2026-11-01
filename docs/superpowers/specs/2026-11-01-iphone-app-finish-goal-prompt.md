ultracode

Goal: finish "verder for iPhone": every screen real, complete, and of a
quality that stands next to the best apps on the phone. Martin's words: "make
it complete, make it utterly premium top app". You work autonomously until
the definition of done below holds. Stop only for the things listed under
"Ask Martin".

Read first, in full: CLAUDE.md (every law and deploy trap applies),
docs/superpowers/specs/2026-10-28-iphone-app-design.md (the approved spec),
docs/superpowers/plans/2026-10-31-iphone-app-plan-3.md (slices 6–8), and
apps/ios/README.md.

## Where it stands (2026-11-01)

- Slices 1–7 are deployed and verified (CLAUDE.md has the record). The last
  deploy was P3-D2. Auto-filing ships OFF: DOCMETA_AUTO_APPLY stays unset
  until the docmeta gate passes on real history. Don't touch it.
- Tabs: Overzicht (opens first), Voor jou, Scan, Dossier (still a ComingSoon
  placeholder), Meer (account, notifications, developer; still says
  "Instellingen en de rest komen binnenkort").
- Promised to Martin and not yet built: put the money glance and "Door verder
  gedaan" on Overzicht.
- Open question to ask Martin on the first turn: the Overzicht tab sits behind
  Face ID, so the app asks for Face ID on every open. Options: keep it; show
  Overzicht ungated with no titles (counts only); or open on Scan again.
  Build his answer.

## Part A — complete the app: Plan 3 slice 8

Run Tasks 17–27 of plan 3 in order, in the plan's own form (TDD, review per
task, fix every finding at Important or above before the next task):

- money glance: Amsterdam weeks, leefgeld €100 a week, the /money/summary
  route
- pocket dossier, server and phone. This replaces the Dossier placeholder.
- share extension
- widget
- voice quick-log, with migration M-B (0041)
- weekly summary
- deploy P3-D3

Re-read each task against today's code before starting it. Plan 3 was
written before slices 6–7 landed, so rescope where the code already moved,
and write the rescope down in the plan.

After slice 8, close the remaining gaps:

- Dossier is a real tab.
- Meer is a real settings screen. Nothing in the app says "binnenkort".
- Overzicht carries the money glance and "Door verder gedaan".
- Every deep link and widget URL lands somewhere real.

## Part B — make it premium

Treat this as its own phase with its own evidence, not as polish sprinkled on
during Part A.

1. **Fixture mode first.**
   - Add a DEBUG-only launch argument (`-fixtures <name>`). It feeds canned
     DTOs through the real stores, so every screen renders in every state
     without a server: loading, empty, a single item, 498 items, long Dutch
     titles, error, offline, unauthorized, and an upload queue that is
     stuck.
   - Fixtures are synthetic. Never real case data.

2. **Screen inventory.**
   - List every screen, sheet, alert, notification, widget family and
     extension surface, with every state above.
   - Capture each one in the simulator (`xcrun simctl io booted screenshot`)
     in four conditions: iPhone 17, the smallest supported size, Dynamic
     Type at the largest accessibility size, and Reduce Motion on.
   - The app is dark only. Keep it that way.

3. **Review loop.**
   - Give the screenshots to independent design reviewers, each with a
     different lens:
     - hierarchy and typography
     - spacing and rhythm
     - motion and feedback
     - copy (Dutch; supportive towards Martin; official register for anyone
       else)
     - accessibility
     - "what makes this look cheap or unfinished"
   - Reviewers try to find faults. They don't approve.
   - Fix everything at Important or above, re-capture, and review again.
     Stop after two consecutive rounds turn up nothing above minor.

4. **The bar.** Apple Design Award quality, inside the Holodek system:
   - Tokens are ported one-to-one from apps/web/src/app/globals.css. Amber
     is ONLY for what waits on Martin.
   - One card component and one row component, used everywhere.
   - Skeleton placeholders instead of bare spinners.
   - Purposeful empty states.
   - Every error says what to do next. No screen is a dead end.
   - Tap targets of at least 44 pt. Real VoiceOver labels and order.
     Dynamic Type works all the way to the largest accessibility size
     without truncating meaning.
   - `.sensoryFeedback` on approve, reject, answer, sent and scanned.
   - Spring transitions that respect Reduce Motion. Swipe actions and
     context menus wherever iOS users expect them.
   - SF Symbols used consistently. The widget looks right in every family
     and on the lock screen.
   - Cold launch stays under 2 s on the phone. Measure it again after
     Part B; it was 202 ms.

5. **On the phone.** Install with `apps/ios/scripts/install.sh` (the phone
   must be unlocked). Show Martin the key screens and ask him to judge them.
   On-device screenshots contain real case data, so they never leave the
   Mac and are never published.

6. **Scope.** Polish freely. A new feature that isn't in the spec may be
   built only if:
   - it needs no server law change;
   - it sends nothing;
   - it is reversible.

   List each one in the report. Anything else is a proposal for Martin.

## Hard rules (unchanged, non-negotiable)

**Sending**
- Nothing is SENT (mail, push to anyone else, any outbound message) without
  Martin's approval of the final text. That includes test sends and test
  pushes: ask every time.
- Every mail from Verder bewindvoering / Regio 3 / Demi gets his attention.

**Evidence and AI output**
- Evidence stays append-only.
- AI output stays suggestion-only, except the filing amendment in the
  Project laws.

**Secrets**
- Never read, print or log:
  - secrets/loondossier.json
  - the APNs .p8
  - any token
  - .env.prod contents
  - ~/.config/claude-agent

**Deploys**
- Run `env -u NODE_ENV pnpm --filter web build` locally under Node 22.
- rsync with `/opt/homebrew/bin/rsync`, written out literally (never in a
  variable or array), using the exact CLAUDE.md exclude list. Run
  `--dry-run --info=del` first and read every `deleting` line.
- Migrations run from the homelab HOST before the images are rebuilt.
- Afterwards: nightly-verify must pass, and the ledger delta must match your
  prediction.

**Measurement**
- Measure before claiming. Never manufacture real events (a Verder mail, a
  scanned letter, a decision) to measure something. These are still open;
  wait for the real thing:
  - the badge delay after a real decision, including on a force-quit app
  - the latency of a real Verder mail's push and proposal
  - a scanned Verder letter
  - the cleanup comparison
  - the airplane-mode drain

**Destructive actions:** ask first.

**Language and time**
- UI is Dutch. Code, commits, docs and chat are English.
- Report times in Europe/Amsterdam.

## Ask Martin (keep working on whatever isn't blocked)

- the Face ID question above
- Face ID or passkey prompts on the phone
- unlocking the phone for installs
- judging the screens on the device
- approving any send or test push
- anything billable

## Standing authority

You may:
- ssh homelab
- deploy (following the rules above)
- commit and push to feat/iphone-app

Merging to main: open a PR at the end and ask.

## Done means

- [ ] Plan 3 Tasks 17–27 are done, and P3-D3 is deployed and verified.
- [ ] Every tab and surface is real. No placeholder or "binnenkort" text is
      left.
- [ ] The fixture screenshot set for every screen and state passes two
      clean review rounds. Publish it as a private artifact for Martin,
      fixtures only, before/after where it changed.
- [ ] Martin has seen the key screens on his phone.
- [ ] All iOS, api, worker and web tests are green.
- [ ] CLAUDE.md is updated with every trap found and every number measured.
- [ ] The final report to Martin covers what was built, what was measured,
      what is still waiting on real events, and the list of any features
      you added.
