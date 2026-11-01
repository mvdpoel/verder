ultracode

Goal: finish "verder for iPhone": every screen designed in Figma over at
least three iterations, then actually built and deployed, complete, and of a
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

## Part B — design every screen in Figma, three iterations, then build it

Martin's words: "design all screens via figma, re-iterate to make it look
more premium, and improved UX, 3 iterations too. Look online for references
at award winning apps with best UI and best UX." Part B runs alongside Part A:
design a screen in Figma before its SwiftUI is final, and bring existing
screens in line with their final Figma frames.

1. **Research first, online.**
   - Study current Apple Design Award winners and finalists (Delight and
     Interaction, Visuals and Graphics, Innovation), App Store "App of the
     Year" picks, and apps widely cited for their iOS craft, e.g.:
     - Things 3
     - Flighty
     - Halide
     - (Not Boring) Weather
     - Mercury Weather
     - Copilot Money
     - Structured
     - Gentler Streak
     - Bear
     - Fantastical
     - Crouton

     Verify each pick online rather than trusting this list.
   - Read Apple's Human Interface Guidelines for the iOS 26/27 visual
     language (Liquid Glass, tab bars, sheets, widgets, Live Activities).
   - Write a short reference board as the first page of the Figma file:
     - per reference: what exactly it does well (hierarchy, density,
       motion, empty states, onboarding, data glanceability) and which
       verder screen it informs;
     - the source URL and the screenshot or description it came from.
   - Distil it into a written design brief, committed to
     docs/superpowers/specs/: principles, the UX flows to improve, and what
     "premium" means for verder in measurable terms.

2. **Figma setup.**
   - Use the Figma MCP tools, loading the figma skills they require
     (figma-use, figma-generate-library, figma-generate-design).
   - Run `whoami`, then create one file "verder iPhone". Ask Martin which
     team or project it belongs in if that is ambiguous.
   - Build a component library from the Holodek tokens, ported one-to-one
     from apps/web/src/app/globals.css:
     - colour, type and spacing variables
     - card, row, button, badge, empty state, skeleton, sheet and tab bar
     - the amber "waits on Martin" treatment, which is used ONLY for that
   - Dark only.
   - **Synthetic data only:** never put real case data in Figma. That means
     no real names, amounts, organisations or letters. Figma is an outside
     service.

3. **Screen inventory.**
   - Design a frame for every screen and surface:
     - sign-in and lock
     - Overzicht
     - Voor jou: the list and every detail (proposal, suggestion, task,
       question), plus Door verder gedaan
     - Scan and the upload queue
     - Dossier
     - money glance
     - Meer and its settings
     - voice quick-log
     - weekly summary
     - every notification type, including the long-press actions
     - every widget family and the lock-screen widgets
     - the share extension
     - permission pre-prompts
   - Give each screen its key states: loading, empty, a single item, many
     items (498), long Dutch titles, error, offline, unauthorized.
   - Also cover the largest accessibility text size and the smallest
     iPhone.

4. **Three iterations at least, per screen.**
   - Pages `Iteration 1`, `Iteration 2`, `Iteration 3` (more if needed), so
     every version stays visible side by side. Never overwrite one.
   - After each iteration, capture the frames with `get_screenshot` and
     give them to independent design reviewers. Each reviewer has a
     different lens:
     - visual hierarchy and typography
     - spacing and rhythm
     - UX flow: taps to goal, dead ends, what Martin must think about
     - Dutch copy: supportive towards Martin; official register for anyone
       else
     - accessibility
     - "compared with the reference board, what makes this look cheap or
       unfinished"
   - Reviewers try to find faults; they do not approve.
   - Each next iteration must answer every finding at Important or above.
     Under each frame, write a change note explaining what changed and
     why.
   - A screen is final only when it has at least three iterations AND its
     last review round found nothing above minor.
   - Show Martin the final iteration of the key screens (Overzicht, Voor jou
     list and detail, Scan, Dossier). His feedback starts another iteration.

5. **The bar every final frame meets.**
   - **Consistency**
     - One card component and one row component.
     - SF Symbols are used consistently.
   - **States and errors**
     - Skeletons instead of bare spinners.
     - Purposeful empty states.
     - Every error names the next step, and no screen is a dead end.
   - **Interaction**
     - Swipe actions and context menus where iOS users expect them.
     - Haptics are specified on approve, reject, answer, sent and scanned.
     - Motion is specified (spring, matched geometry) with a Reduce Motion
       fallback.
   - **Accessibility**
     - Tap targets of at least 44 pt.
     - Real VoiceOver order.
     - Dynamic Type works to the largest accessibility size without losing
       meaning.
   - **Widgets:** right in every family and on the lock screen.

6. **Build it to the frames.**
   - Implement each final frame in SwiftUI.
   - Add a DEBUG-only `-fixtures <name>` launch argument that feeds the
     same synthetic data as Figma through the real stores, so every state
     renders without a server.
   - For each screen and state, capture the simulator
     (`xcrun simctl io booted screenshot`) and put it next to its Figma
     frame. Fix every difference at Important or above, and re-capture.
   - Cold launch stays under 2 s on the phone. Measure it again; it was
     202 ms.
   - Install on the phone with `apps/ios/scripts/install.sh` (the phone
     must be unlocked) and let Martin judge the key screens there.
     On-device screenshots contain real case data, so they never leave the
     Mac.

7. **Scope.** Polish and UX improvements are yours to make. A new feature
   that isn't in the spec may be built only if:
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
- which Figma team or project to use, if that is ambiguous
- judging the final Figma frames of the key screens

## Standing authority

You may:
- ssh homelab
- deploy (following the rules above)
- commit and push to feat/iphone-app

Merging to main: open a PR at the end and ask.

## Done means

- [ ] The online reference board and the design brief exist (the board in
      Figma, the brief committed).
- [ ] EVERY screen and surface in the Figma file has at least three
      iterations, with review notes, and its final frame passed a review
      round with nothing above minor.
- [ ] Every final frame is ACTUALLY IMPLEMENTED in SwiftUI.
- [ ] The simulator screenshot of every final frame matches its Figma frame,
      on fixtures, side by side.
- [ ] Plan 3 Tasks 17–27 are done, and P3-D3 is DEPLOYED and verified on
      the homelab: nightly-verify OK, ledger delta as predicted.
- [ ] The finished app is installed on Martin's phone, and he has judged the
      key screens there.
- [ ] Every tab and surface is real. No placeholder or "binnenkort" text is
      left.
- [ ] All iOS, api, worker and web tests are green.
- [ ] The Figma file link plus a private artifact for Martin: per screen,
      iteration 1 → 3 → the built app, fixtures only.
- [ ] CLAUDE.md is updated with every trap found and every number measured.
- [ ] The final report to Martin covers what was built, what was measured,
      what is still waiting on real events, and the list of any features
      you added.
