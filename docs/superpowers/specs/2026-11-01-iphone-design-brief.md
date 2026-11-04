# verder for iPhone — design brief

Written 2026-11-01. This distils the three research notes in
`docs/superpowers/specs/design-research/` (`awards.md`, `craft.md`, `hig.md`)
into the bar that every Figma frame and every SwiftUI screen is judged against.
It serves the goal prompt `2026-11-01-iphone-app-finish-goal-prompt.md`
(Part B §5 is the minimum; this brief makes it measurable) and the approved
spec `2026-10-28-iphone-app-design.md` §7–8.

Reference shorthand: **R1–R30** are the HIG references in `hig.md`. App names
refer to the entries in `awards.md` / `craft.md`. Every claim about what an app
*looks like* is the research's text, not a screenshot; those notes mark what is
unverified, and this brief does not upgrade it.

---

## 1. Principles

1. **Boringly obvious, one line per matter.** Every list reads like a
   departures board: one row per thing, with what it is, who it is from, how
   long it has waited, and who it waits on. Hierarchy comes from type weight
   and position, not boxes. *Flighty (one line per flight, "boringly
   obvious"), Things 3 (weight hierarchy, almost no chrome), Crouton
   (hierarchy over decoration).*
2. **One colour, one meaning, always with a word.** Amber means "wacht op
   jou" and nothing else, and it never appears without the dot *and* the
   words. Cyan means "you can act on this". Everything else is the ink scale.
   *Halide (single highlight colour; the RAW lesson that colour alone is not
   enough), R2 ("avoid using the same color to mean different things"), R10.*
3. **The next step is the primary object.** Every screen ends in a concrete
   action, or says plainly that nothing is needed. The AI draft arrives
   pre-filled, Martin edits and confirms it, and its origin is visible but
   quiet. *Tiimo (aspirations into next steps), Structured (AI pre-fills,
   human confirms), Crouton (the next step is right where you need it), R30
   (actions in the bottom half).*
4. **Calm by default; speak only on change.** Notifications and badges move
   only when something changed and say what to do next. Nothing nags twice.
   An empty queue is an achievement ("Niets wacht op je."), not a blank.
   *Flighty (loud only when things go awry), Gentler Streak ("not insistent
   reminders"), Structured (downtime is a real state), R16/R17.*
5. **Offline and locked are designed states, not errors.** The phone renders
   from its last known state with the age stated, and the locked glance shows
   counts and money but no titles. *Flighty (the Island keeps working in
   flight), Copilot Money (local data, so it is instantly responsive), R16/R18
   (no sensitive data on the lock screen).*
6. **Numbers come with their parts and their explanation.** A headline figure
   never stands alone. The disclosures (incidental income, transfers, hatched
   months, `geen data`) sit beside it, and progress is measured against
   Martin's own past, never against a target. *The Outsiders (headline plus
   visible parts), Mercury Weather (now → soon → later; depth in a sheet),
   Gentler Streak ("statistics without interpretation are meaningless"),
   R23.*
7. **Craft goes into the moments that repeat, and delight is never
   decoration.** Spend the polish on approve, send, scan and answer: a
   progressive confirm, one crisp haptic, a transition that shows where the
   item went. No confetti, no mascots, no ambient motion that carries
   meaning. *(Not Boring) Habits (craft spent on the checkbox), CapWords
   (page-to-object transition), Things 3 ("animation shows where an item
   went"), R29 ("don't mistake delight for decoration").*
8. **System chrome is glass; case content is not.** Liquid Glass belongs to
   the tab bar, nav bar, sheet chrome and floating controls. Holodek panels
   are content and are drawn as token fills (`glass-a`→`glass-b`, `edge`,
   `edge-lit`), never `.glassEffect`. *R1 ("Don't use Liquid Glass in the
   content layer"), Tide Guide and Moonlitt (Liquid Glass used with
   restraint).*

---

## 2. What "premium" means, in measurable terms

Every final frame and every built screen passes every line below. A reviewer
checks each one and reports the measured number, not an impression.

### 2.1 Speed and perceived speed

| Measure | Bar | How it is checked |
|---|---|---|
| Cold launch to first frame | **< 2 s hard limit; ≤ 400 ms target** (measured 202–206 ms on 2026-10-31) | Instruments App Launch, 3 cold processes on the phone |
| First meaningful frame (cached content or skeleton) | **≤ 100 ms** after the tab appears | No bare `ProgressView` anywhere a list or card will appear (today: 6 of them) |
| Cached content on screen | **≤ 300 ms** from the App Group cache, then refresh in place | Fixture run with the network off |
| Tap response (press state visible) | **≤ 1 frame** (120 Hz ProMotion) | Every custom button has a pressed state (R15) |
| Network-bound action feedback | in-button progress **within 100 ms**; never a full-screen blocker | Approve, answer, retry, undo |

### 2.2 Layout and type

- **Tap targets ≥ 44 × 44 pt**, every one, including chips, inline "opnieuw"
  links and the disclosure in "Door verder gedaan" (R10). Use a larger hit area
  where the visual is smaller.
- **Spacing on a 4-pt grid** using only these steps: 4 · 8 · 12 · 16 · 20 · 24
  · 32 · 40 · 48 (Tailwind's 0.25 rem step, which the web already uses).
  Screen gutter **16 pt**; gap between cards **16 pt**; padding inside a card
  **16 pt**; gap between rows inside a card **12 pt**. Off-grid values (today:
  `26`, `10`, `6`) are a review finding.
- **At most 4 type sizes per screen** (system chrome excluded), from **two
  families only**: Saira (display) and IBM Plex Mono (readouts: dates,
  amounts, IDs, counts as data).
- **Type ramp** (all `relativeTo:` a text style, so Dynamic Type scales it, R9):

  | Role | Font | Size (Large) | Text style |
  |---|---|---|---|
  | Screen title | Saira Regular | 28 | `.title` (collapses on scroll) |
  | Hero number | Saira Regular or Light | 34–48 | `.largeTitle` |
  | Row title / card head | Saira Regular or Medium | 17 | `.body` / `.headline` |
  | Secondary line | Saira Regular | 15 | `.subheadline` |
  | Readout / label | Plex Mono Regular | 12–13 | `.footnote` / `.caption` |

- **Nothing under 11 pt.** The web's `.lbl` (9.5 px) and `.micro` (10 px) are
  rendered at **11 pt minimum** on iOS (R9, R19).
- **Weights:** no Ultralight or Thin anywhere. Light is allowed only at
  ≥ 28 pt. The current `.ultraLight` title and the `.light` 14 pt body text are
  review findings (R9). Bold Text swaps to the next weight up.
- **Corner radii:** content chips use `--radius-chip` (2) and panels use
  `--radius-panel` (3). Containers the system owns (sheets, widgets, Live
  Activities, the tab bar) keep their system concentric shape. Do not square
  them, and do not round the content to match them (hig.md §3.6).
- **Long titles:** two lines, then tail truncation for prose and **middle**
  truncation for file names (`Loonstrook.mp.2026-07…pdf`, R8). Never
  truncate a count or an amount.
- **Titles fit the nav bar:** ≤ 15 characters (R5). Overzicht, Voor jou,
  Scan, Dossier, Geld, Meer, Weekoverzicht and Instellingen all fit.

### 2.3 Contrast (computed on `void` #04070d; `hig.md` §3.5)

| Use | Allowed tokens | Ratio |
|---|---|---|
| Body and row text ≤ 17 pt | `ink-bright` 18.6, `ink` 16.0, `ink-soft`, `ink-mute` 8.2 | target **≥ 7:1** (R3) |
| Labels and readouts ≤ 17 pt | `ink-label` 5.1 at minimum | floor **≥ 4.5:1** |
| `ink-dim` 4.4, `ink-faint` 3.3 | **only** text ≥ 18 pt or bold, or non-text (rules, axes, hatching) | ≥ 3:1 |
| `signal` 11.6, `attn` 9.6, `okay` 12.0, `steel` 12.5 | any size | ≥ 7:1 |

On a glass panel the ratio drops. Verify every text token on `plate`
(#0a0f18, the panel's flattened colour) as well as on `void`, and with
Increase Contrast and Reduce Transparency turned on. Today's `ink-dim` dates
in 11 pt mono fail; move them to `ink-label`. Sheets use `plate` as the
"elevated" background (R3), which keeps us inside the token set.

### 2.4 States: no screen without a next step

Every screen has a frame for each state: **loading** (a skeleton in the shape
of the real content, never a spinner), **empty**, **one item**, **many**
(498), **long Dutch titles**, **error**, **offline**, **unauthorized**,
**locked**, **AX5** and **iPhone SE (375 × 667 pt)**.

- **Empty** says why and what next. For example: "Niets wacht op je." plus
  the last moment something was handled; or "Nog geen scans — scan je eerste
  brief" with the button.
- **Error** names the cause in one plain Dutch line plus a verb button
  ("Opnieuw proberen", "Opnieuw inloggen", "Open Instellingen"). Never
  "lukte niet" alone.
- **Offline** shows cached content with "offline · bijgewerkt 14:02" in a mono
  readout, and actions that need the server are disabled *with the reason*,
  never silently.
- **Unauthorized** is one screen with one button back to sign-in. It never
  flashes a list first.
- **Dead-end count = 0**: a review finding for any frame from which Martin
  cannot reach a next action or a way back in one tap.

### 2.5 Haptic map (SwiftUI `.sensoryFeedback`; R13)

| Moment | Feedback | Notes |
|---|---|---|
| Approve (Versturen accepted by server) | `.success` | After Face ID, when the server answers. Not on the button press |
| Proposal actually **sent** (state → `sent` while visible) | `.success` | A second, distinct moment; may arrive minutes later |
| Answer a question | `.success` | In-app; the notification action has no haptic of its own |
| Reject / Afwijzen confirmed | `.impact(.soft)` | Rejecting is not a failure, so it does not get `.error` |
| Suggestion approved / task status changed | `.success` | Including from a swipe action |
| Swipe crosses its action threshold | `.selection` | Once per crossing |
| Scan handed to the queue | `.impact(.medium)` | When the PDF is enqueued, after the camera has closed |
| Upload succeeded | none in the foreground | Avoid buzzing for background work; the queue strip updates |
| Upload failed / action failed | `.error` | With the inline retry |
| Undo ("Door verder gedaan") | `.impact(.light)` | |
| Destructive confirm (purge step 2) | `.warning` | |
| Month scrub in money chart | `.selection` | Per month crossed |
| Camera live, voice recording | **none** | R13: never disturb camera or microphone |

All haptics are skipped when the system haptics setting is off. Nothing
depends on them.

### 2.6 Motion (R10, R12; the web's "nothing moves for less than two seconds" governs *ambient* motion only)

| Transition | Spec | Reduce Motion fallback |
|---|---|---|
| Row → detail (Voor jou, Dossier) | matched geometry on the row's title plus a zoom navigation transition; spring response **0.35 s**, damping **0.86**; the list dims to 40% behind it (Things 3) | crossfade **0.2 s**, no scale |
| Card expand / collapse ("Door verder gedaan", disclosures) | spring 0.3 s, damping 0.9; height only | instant height change, fade content 0.15 s |
| Item leaves the queue after a decision | slide-out plus collapse 0.25 s, then the count ticks with `.contentTransition(.numericText())` | fade out 0.15 s; the number swaps |
| Scan → queue | the page thumbnail shrinks into the queue strip, 0.4 s spring (CapWords) | fade |
| Hold-to-confirm "Versturen" | a fill runs over **0.6 s** with a haptic ramp; release early cancels; Face ID follows ((Not Boring) Habits) | the same fill as a plain progress bar; a tap-and-confirm alternative for VoiceOver and Switch Control |
| In-progress symbol | SF Symbol `.pulse` (uploading), `.replace` (state change), `.bounce` once (done) (R14) | static symbol |
| Ambient Holodek (`breathe`, `drift`, `sweep`, `halo`, `spin-*`) | allowed on Overzicht and Lock only; ≤ 0.2 Hz; never carries information | **off entirely** |
| Widgets / Live Activities | system update animations only, ≤ 2 s (R18, R19) | system |

Every transition can be interrupted: a tap during an animation is honoured,
never queued (R12).

### 2.7 Accessibility

- **VoiceOver:** one element per row, read in this order: kind, title, who,
  "wacht op jou", age. For example: "Voorstel, antwoord aan Regio 3, wacht op
  jou, 2 dagen". Swipe actions are exposed as custom actions. Screen titles
  are headings. The chart gets a one-sentence description and an audio graph
  (R11).
- **Dynamic Type to AX5:** inline metadata stacks vertically at accessibility
  sizes. Counts and amounts never truncate. The tab bar keeps working with
  the system's large-content viewer.
- **Never colour alone:** every amber, hatched or `geen data` state also
  carries a word (R2, R23).

### 2.8 Consistency

- **One card component and one row component** across all tabs. A second
  card style is a review finding.
- **SF Symbols:** filled variants in the tab bar and swipe actions. Weight
  matched to the adjacent Saira weight. One symbol per concept, everywhere,
  e.g. `tray.full.fill` = Voor jou, `doc.viewfinder` = scan,
  `checkmark.seal` = gedaan door verder.
- **Copy:** supportive towards Martin ("Goed bezig — nog 2 open."); an
  official register for anything addressed to someone else (drafts).
  Verb-first buttons (R15).

---

## 3. UX flows to improve, per screen

"Now" is measured from the code on `feat/iphone-app` at 3406734; "—" means
the screen does not exist yet. A tap is a tap; Face ID is counted
separately because it is not Martin's effort but is still friction.

| Screen | Goal | Now | Target | What changes |
|---|---|---|---|---|
| **Sign-in** | First sign-in | email + password + Inloggen; passkey offered afterwards | 1 tap + Face ID (passkey) on any later install | Buttons name the method: "Inloggen met toegangssleutel" first (never the English "passkey" in the UI; session expiry reads "Je sessie is verlopen."), "Inloggen met wachtwoord" second (R26). A cause line under every failure. |
| **Lock** | Reveal titles from Overzicht | tap "Toon details" + Face ID | **Face ID once, by itself, on open and on reopen past the 5-min grace — never per screen switch** (Martin, 2026-11-01; `252a4fc`); not on Scan, so the shutter is never covered | The app-switcher snapshot is covered while locked. The launch screen is plain `void` with no logo (R27). |
| **Overzicht** (opens first; **ungated, counts and money only, titles after unlock** — Martin, 2026-11-01) | Know "is anything waiting on me?" | 0 taps (count card) | 0 taps | Board-style order now → soon → later (Mercury): waiting count as the hero number → money glance → tasks → scans → "Door verder gedaan" count. A preview of the top 3 with "Alles bekijken" after unlock (Copilot "To Review"). A calm state is a real state. |
| | Open the top waiting item | tab Voor jou → row (2) | 1 (tap the preview row; Face ID if locked) | Preview rows deep-link. |
| **Voor jou list** | Decide an unchanged suggestion | row → Goedkeuren (2) | 1 swipe (leading = Goedkeuren; trailing = Niet relevant) | Swipe actions plus a context menu with the same actions plus "Bekijken". Bulk approve for suggestions only, never for proposals (sending is never bulk). |
| | Mark a task done | row → Status wijzigen → status (3) | 1 swipe ("Gedaan") or 2 via the menu | `waiting` and `in-progress` reachable from the context menu. |
| | Triage 498 | one long list | grouped sections **Nu** (proposals, questions) / **Kan wachten** (suggestions, tasks) with counts; show 20 per section plus "Toon alle 312" | Things' This Evening split; R8 "most relevant first, offer view more". |
| **Proposal detail** | Send an unedited reply from its push | tap push → (Face ID unlock) → Versturen → Face ID (2 taps, 2 Face ID) | 2 taps, Face ID ×2 kept (the fresh Face ID on send is the law) | Order: trigger card → **draft as the primary object** → Versturen bottom-pinned (R30) with hold-to-confirm → evidence and attachments below. Aanpassen opens a large sheet editor with Annuleren leading (R7); swipe-dismiss with edits asks first. |
| **Question detail** | Answer | long-press push → option (1 action, 0 app opens) | same | In-app: options as full-width 44 pt buttons. Confirm dialog only when the option has consequences. |
| **Suggestion detail** | Edit then approve | row → field edits → Goedkeuren | same, plus the edited fields marked "aangepast" | Edit diff visible before approve (golden rule). |
| **Task detail** | Change status | 3 | 2 | Status as a segmented control, not a buried button. |
| **Door verder gedaan** | Undo a wrong auto-filing | Voor jou → scroll to section → expand → Ongedaan maken (3+) | 2 (Overzicht count → item → Ongedaan maken) | Inline undo with a 5 s undo toast, not an alert (R24). Auto-name rows explain that they are undone with `normalize-names --undo`, so they carry no dead button. |
| **Scan** | Scan a letter from a locked phone | open app → Scan tab → "Scan een brief" → pages → Bewaar (3 + pages) | **1 + pages** via a Control Center / Action-button "Scan" control or a Home-screen quick action (R20) | The camera opens directly. Duplex hint ("Draai de stapel om, lange kant") as the one instruction. |
| **Upload queue** | See that it arrived; retry a failure | strip text plus "opnieuw" | 0 / 1 | Per-item rows with a pulse symbol while uploading. The queue lives in the **tab-bar bottom accessory** while non-empty (R4), and a Live Activity while 3+ are draining (R18). |
| **Dossier** | Show a document at a counter, offline | — (placeholder) | 3 taps + typing (tab → search → result) | Search field at the top; recent first; full-screen viewer with an edge swipe back (iA Writer). Offline state shown inline. Headline "waar het nu op wacht", then open tasks, then a vertical read-only case map. Purge is never offered here. |
| **Money glance** | Leefgeld left this week | — | 0 taps (on Overzicht, shown while locked) | Hero: "€ 38,20 over deze week" with spent and deposits listed beneath it. Per account, never merged. Tap → full Geld screen with Swift Charts bars, hatched and `geen data` labelled in text, and the disclosures in a slide-up sheet (Mercury). No figure when uncovered. |
| **Meer + settings** | Turn off one notification kind | — ("binnenkort") | 2 (Meer → Meldingen → toggle) | Sections: Account (devices, passkey, sign out) · Meldingen (per kind, R17) · Widgets toevoegen (guide, Structured) · Over verder · Ontwikkelaar one level down (Halide "advanced a few taps away"). No appearance toggle (R3). |
| **Voice quick-log** | Log a phone call | — | **2**: Action-button / "Leg vast in verder" → hold-to-talk → release; party preselected (most recent) → Bewaar | Medium sheet with a grabber (R7). Live on-device transcript, then a parsed preview (party, channel `call`, date) before saving (Fantastical). It is saved as a *suggestion*. Recording state in the tab accessory. No haptics while recording. |
| **Weekly summary** | Read the week | — | 1 (tap the Sunday push) | Steps taken, compared with Martin's own past weeks; no red deficits (Gentler Streak). What verder did on its own is stated plainly (R29). One next step at the end: "2 wachten nog op je → Voor jou". |
| **Notifications** (9 categories + `q.<id>`) | Act without opening | PROPOSAL / REMINDER / FOLLOW_UP carry "Bekijken"; questions carry their options | Drop "Bekijken" (an open-only action duplicates a tap, R16). TASK_DUE gains **Gedaan** (`authenticationRequired`, Martin's own action). Questions keep their options (≤ 4). | Lock-screen preview never shows a creditor or an amount; the hidden-preview placeholder "Nieuw bericht van verder" stays. Every body names the next step ("Voorstel klaar om te keuren"). Interruption levels: see §5 open decision. |
| **Widgets** | See the count without unlocking | small / medium / lock (Plan 3) | small · medium · large · accessoryCircular · accessoryRectangular · accessoryInline, plus StandBy | Small: hero count plus "wachten op jou". Medium: count plus top 2 items (titles `.privacySensitive()`). Large: top 5 plus the map headline. Circular: count. Rectangular: count plus the age of the oldest. Inline: "verder · 3 voor jou". Meaning survives the tinted, clear and vibrant modes **without amber** (R19). Every tap deep-links to the exact item. 16 pt margins. |
| **Share extension** | File a PDF from Mail | — | 2 after the share sheet (verder → Versturen) | One screen: thumbnail, title, optional one-line note, Versturen trailing. Progress continues in the app's queue, not in the extension (R22). |
| **Permission pre-prompts** | Grant camera / mic / notifications | system alert only (notifications after unlock) | 1 tap ("Ga verder") → system alert | One screen per permission, asked at first use. One button, not titled "Toestaan", no close (R25). Active Dutch purpose strings ("verder gebruikt de camera om brieven voor je dossier te scannen."). |

---

## 4. Reference board

The Figma file's first page carries the same table with a short description
per row. The research found no screenshots; each row cites the text it came
from.

| Reference | What it does well | verder screen | Source |
|---|---|---|---|
| Flighty (ADA 2023 Interaction) | One line per item; calm until change; works offline | Overzicht, Voor jou list, Notifications, Widgets, Dossier offline | https://developer.apple.com/news/?id=970ncww4 |
| Things 3 (ADA 2017) | Row expands to a card, list dims; weight hierarchy; swipe density | Voor jou detail, all lists | https://www.macstories.net/reviews/things-3-beauty-and-delight-in-a-task-manager/ |
| Halide Mark II (ADA 2022) | One highlight colour with one meaning, plus a label; pro controls one tap away | Amber rule, Scan, Meer | https://developer.apple.com/news/?id=x6bv1a36 |
| (Not Boring) Habits (ADA 2022) | Craft spent on the repeated interaction; hold with progressive feedback | Versturen hold-to-confirm | https://developer.apple.com/news/?id=9ab1g4r3 |
| (Not Boring) Camera (ADA 2026 finalist) | Giant tactile capture control | Scan | https://developer.apple.com/design/awards/ |
| Mercury Weather (MacStories Selects 2023) | Now → soon → later bands; depth in a sheet; full widget set | Overzicht, Money glance, Widgets | https://www.macstories.net/reviews/mercury-weather-a-crystal-clear-design-for-every-apple-device/ |
| Copilot Money (ADA 2024 finalist) | AI review queue on the dashboard, marked the same everywhere; Swift Charts; local data | Overzicht preview, Voor jou, Money glance | https://developer.apple.com/articles/copilot-money |
| Structured (ADA 2026 finalist) | One timeline spine plus an inbox; AI pre-fills; in-app widget guide | Dossier, Voor jou detail, Meer | https://apps.apple.com/app/structured-daily-planner/id1499198946 |
| Gentler Streak (ADA 2024 Social Impact) | Encouraging tone; progress against your own history | Weekly summary, Notifications, empty states | https://developer.apple.com/news/?id=3m0ht22s |
| Tiimo (iPhone App of the Year 2025) | Turns a goal into the next concrete step | Voor jou, Weekly summary | https://www.apple.com/newsroom/2025/12/apple-unveils-the-winners-of-the-2025-app-store-awards/ |
| The Outsiders (ADA 2026 finalist) | Headline figure with its components visible | Money glance, Overzicht | https://developer.apple.com/design/awards/ |
| Tide Guide (ADA 2026 Visuals) | Dense time series kept legible; widget answers alone; restrained Liquid Glass | Money (full screen), Widgets | https://developer.apple.com/design/awards/ |
| Moonlitt (ADA 2026 Interaction) | Best-in-class Liquid Glass; easy onboarding | Tab bar, sheets, Pre-prompts | https://developer.apple.com/design/awards/ |
| Crouton (ADA 2024 Interaction) | Next step right where you need it; attention on the real task | Scan, Share extension, Voor jou detail | https://developer.apple.com/design/awards/2024 |
| Mela (ADA 2025 finalist) | Vision scan into structure; dim done steps, highlight the current one | Scan, multi-step tasks | https://developer.apple.com/design/awards/2025/ |
| iA Writer (ADA 2025 finalist) | Distraction-free editor; edge swipe between list and preview | Proposal editor, Dossier viewer | https://developer.apple.com/design/awards/2025/ |
| CapWords (ADA 2025 Delight) | Capture becomes an object with a satisfying transition | Scan → queue | https://developer.apple.com/design/awards/2025/ |
| Fantastical | Live parse preview before commit | Voice quick-log | https://www.macstories.net/reviews/fantastical-for-iphone-review/ |
| Hearing Buddy (ADA 2026 finalist) | On-device live transcript, then a summary | Voice quick-log | https://developer.apple.com/design/awards/ |
| Vocabulary (ADA 2025 finalist) | "Quietly does everything right" typographic balance | Overall bar | https://developer.apple.com/design/awards/2025/ |
| Apple HIG (iOS 27; R1–R30) | Glass vs content, tab bars, sheets, widgets, privacy pre-prompts, haptics | Every screen; the only source for Lock, Sign-in, Pre-prompts | https://developer.apple.com/design/human-interface-guidelines/ |

---

## 5. Constraints — NOT negotiable

1. **Amber (`attn` #e8a557) only for "waits on Martin"**, as defined
   server-side by `loadWaiting` (`packages/api/src/waiting.ts`). It is never
   used for errors, importance, brand, money or decoration, and it always
   appears with the words "wacht op jou" or a count that says so. Its glow
   (`--shadow-attn`) follows the same rule.
2. **Dark only.** There is no light variant and no appearance toggle. Every
   frame is designed on `void`.
3. **Dutch UI.** Every label, notice and notification is Dutch: supportive
   towards Martin, official register for anyone else. Code, specs and review
   notes are English.
4. **Tokens from `apps/web/src/app/globals.css` only**, via
   `apps/ios/Verder/Theme/Tokens.swift` (guarded by `TokensMatchWebTests`)
   and the identical Figma variables. A missing colour is a design question
   for the web token file first, never a local hex. Contrast problems are
   solved by *choosing a different token for that use* (§2.3), not by
   inventing one.
5. **Synthetic data only in Figma.** No real names, amounts, organisations,
   case numbers, IBANs or letters. Figma is an outside service. The same
   synthetic set feeds the DEBUG `-fixtures <name>` launch argument, so frames
   and simulator captures match. On-device screenshots contain real data and
   never leave the Mac.
6. **Nothing sends without Martin's approval of the final text.** It is never
   a bulk action and never a notification action. The fresh Face ID on
   Versturen stays. Test sends and test pushes are asked for every time. A
   question answer from a notification is allowed because it sends nothing
   outward.
7. **The laws hold in the UI:** AI output appears as a suggestion until Martin
   decides (the filing amendment and "Door verder gedaan" excepted); debts,
   amounts, registry decisions, log entries, task status, discard and purge
   are never done by verder on its own; money accounts are never merged and
   no figure is shown without its disclosures; the locked glance and lock
   screen show counts and money only, never titles.

### Open decisions (flag to Martin; do not drift)

- **Icon badge semantics.** The HIG reserves the badge for unread
  notifications, and it is always red. verder's badge is the waiting count
  (498). Keep it knowingly, or narrow it.
- **Interruption levels.** Every Verder mail is Time Sensitive today (spec
  §12.5 and the law "every mail from Verder gets his attention"). R17 would
  split it: Time Sensitive for today's deadlines, Active for mail and
  proposals, Passive for digests. Keep it until Martin decides.
- **Face ID setting.** R26 discourages an in-app biometric opt-in. The lock
  stays always-on, with no toggle in Meer.
- **The accounts when no weekly budget is set (`money-no-budget`).** RESOLVED
  2026-11-03 by the "money · final" frame `Money glance / no-budget`: there is
  no leefgeld card and no GELD card; the rest card leads with one row per
  account, "Beheerrekening" / "··6789 · NIEUWSTE BOEKING ZA 24 OKT", each
  opening Geld on that account. No amounts, so no total and no "€ 0,00".
  Unlocked only: the tail names an account. The leefgeldrekening is the one
  the server marks `isLeefgeldAccount`; beside exactly one of it, the one
  other account is the beheerrekening; anything else reads "Rekening".
- **Two finals disagree about the Overzicht leefgeld card.** "money · final"
  (16:56) draws it as "€ 37,60 over deze week" with Uitgegeven/Ontvangen
  readouts, a partial week as "€ 52,10 over"; "overzicht · final" (17:54,
  `leefgeld-kaart · varianten`) draws "over van € 100,00", a partial week as
  "€ 47,90 uitgegeven t/m do 29 okt · OVER nog niet bekend". The build keeps
  the NEWER overzicht variant (it is also the one that never claims what is
  left of a week no statement covers yet). Martin to choose. What switching
  to the money-final card would take, as compared on 2026-11-03: stacked
  Uitgegeven/Ontvangen rows with meta lines ("3 boekingen", "do 29 okt · van
  beheerrekening") instead of two columns and the "Alleen je
  leefgeldrekening." footer; a partial week as "€ 52,10 over" with a "• Deels"
  chip and "Gaat over ma t/m do 29 okt…"; overspend as "↑ € 12,40 meer
  uitgegeven / dan het weekbedrag" with a "€ 100" marker label; a document
  icon and a meta line on geen data / nog geen afschriften / niet herkend, and
  the Geld screen's instruction ("Lees … in op de computer, onder Register →
  Afschrift inlezen.") instead of "Importeer … op de website" plus a link.
  The two wordings now disagree between Overzicht and Geld; whichever card
  wins, one of them should change.
- **Geld's "Niet in de balken" in the money-final frame shows money the
  server never leaves out of the bars.** The sheet frame lists "Tussen je
  eigen rekeningen · Naar leefgeldrekening € 2.100,00", but
  `splitInternalTransfers` (money-series.ts) only pairs legs WITHIN one
  account, so a beheer → leefgeld transfer is a debit in the beheerrekening's
  spending bar (the fixtures carry it as `leefgeld` in `outByCategory`).
  Putting those rows in the fixture would draw a disclosure the server cannot
  produce. Likewise the frame titles a one-off credit by its kind
  ("Teruggave"), which no field holds; the build titles it by counterparty.
  Both need a server decision first, not a fixture.
- **Meldingen per soort needs a server half that does not exist yet**
  (2026-11-03, "meer · final"). The phone reads and writes `GET`/`POST
  /api/mobile/v1/push/preferences` (`{"muted": [category…]}`, per iPhone);
  no such route, column or `notify()` filter exists, so production answers
  404 and Meldingen shows every kind as "aan" with no switch — honest, since
  every kind IS sent. Building it is a migration (a `muted` list on
  `push_devices`), the route, and `notify()` skipping a muted kind for that
  device; `VERDER_MAIL` stays unmutable. The level words follow the worker,
  not the frame where they differ: Termijn is "tijdgevoelig", and the
  footnotes say proposals/reminders/follow-ups about Verder's post and a
  failed send are time-sensitive.
- **Account offers "Toegangssleutel toevoegen" only while the account has
  none** (frame "Account / normaal" draws AAN with no add row). Before
  2026-11-03 the button stayed for any count, so a second device could add
  its own; now that is "andere apparaten via de website".
- **The Geld captions under the headline numbers** (2026-11-03) come from the
  server (`apps/web/src/lib/mobile-money-meta.ts`: `outRows`, `inSources`),
  NOT YET DEPLOYED. Until the web image is rebuilt the phone draws none of
  them (it decodes both as optional). The income caption names the payer the
  bank wrote ("Atelier Sterrenwacht"); the frame's "Salaris ·" is a kind the
  server does not know and is not invented.
- **A Verder-mail tap lands on Voor jou; there is no "Mail van …" screen**
  (2026-11-04, "notifications · final"). The frames `verder-mail · na tik ·
  voorstel in voorbereiding / geen antwoord nodig / geen voorstel gemaakt`
  draw a mail detail with a status card. They are RETIRED for now, not built:
  the phone has no route that serves a mail (`/api/mobile/v1/*` has inbox,
  proposals, suggestions, tasks, documents — no raw email), and "geen
  antwoord nodig" / "geen voorstel gemaakt" are verdicts the worker does not
  record per mail (`proposals` holds what WAS drafted, not a decision not to
  draft). A fixture-only screen would draw states production cannot reach.
  Building it is a server half first: a mail read route and a per-mail
  proposal verdict. Until then the push links `verder://inbox`, where the
  proposal appears once drafted.
- **An answer given from a notification leaves no confirmation-and-undo row
  on Voor jou** (frame `na antwoord · Voor jou`, RETIRED). In the app an
  answer is HELD on the phone for its undo window before it posts; a
  notification action posts at once (`NotificationRouter`, no view exists
  to hold it), and the server has no undo for a proposal answer. A "Brief
  gekoppeld · Ongedaan maken" row would offer an undo nothing can carry
  out. The answered question simply leaves the list and the count. If Martin
  wants the row, it needs a server-side answer undo first.
- **Notification grouping is iOS's** ("gegroepeerde stapel", "vergrendeld ·
  iPhone SE"). The frames draw two separate cards; iOS collapses
  notifications from one app with no distinct `thread-id` into one group,
  and on the lock screen stacks the rest behind the newest. The build's part
  is the ORDER: what waits longest on Martin is sent last so it lands on top
  (capture.sh sends the follow-up before the reminder, the filing digest
  before the Verder mail). The worker sets no `thread-id` on reminders or
  follow-ups; separate cards would need one per kind there. Not done: it
  is Martin's call whether the frames' separate cards are worth a worker
  change, and until then the second card is read by expanding the group.
- **The notification captures are the WORKER's copy, and the worker keeps
  creditors off the lock screen** (2026-11-04). Before, the fixtures carried
  the frames' words while production sent other text, and two pushes broke
  the §3 rule that a preview never shows a creditor or an amount. Now, where
  the priority is creditor, no title or body names a party, a subject or a
  summary: "Mail van een schuldeiser" / "Tik om hem te bekijken. Hij staat
  al in je dossier."; a scanned letter "Brief van een schuldeiser" / "Herkend aan het e-mailadres op de brief. Tik om hem te bekijken; hij staat al in je dossier."; a reply
  proposal "Voorstel klaar om te lezen" / "… Het is een antwoord aan een
  schuldeiser."; a follow-up "Herinneringsmail klaar" / "… De schuldeiser
  heeft sinds 16 okt niet gereageerd." The weekly title is "Je week in
  verder". Kept, against the frames: a letter's body says how its sender
  was recognised (it is a guess from the OCR text; "Brief lijkt van een
  schuldeiser" as a title truncated beside the timestamp, so the hedge moved
  to the body); the creditor body does not promise "kiezen bij welke
  vordering hij hoort", because the tap opens Voor jou, not a picker; a
  Verder mail is still "Verder: <afzender>" / the one-line summary (a title
  built from the summary would truncate at AX5 — the summary wraps in the
  body), and that summary can still hold an amount; a question's title is
  still "Voorstel: <ask>", free model text; the reminder stays "Wacht nog:
  <ask>"; the weekly body is `weeklyBody`'s counts ("3 verstuurd · 7 binnen
  · 5 opgeborgen · 2 taken klaar — 4 wachten op jou"), with no "Tik voor je
  week". The pushes in `apps/ios/scripts/pushes/` now carry these texts
  except the three AX5 cuts below and the system and question pushes.
- **Verder proposals, follow-ups to Verder and deadline pushes stay
  time-sensitive, so iOS draws "TIJDGEVOELIG" where the frames draw a plain
  card** (`proposal`, `follow-up`, `task-due · lang ingedrukt · Gedaan`; at
  AX5 the header takes two lines, "TIJDGE-/VOELIG"). This is the open
  interruption-levels decision above, not drift: the build keeps the
  worker's levels until Martin decides, and the captures show them.
- **Notification texts are cut to what AX5 shows whole.** The filing digest's
  title is the worker's own "Door verder gedaan" — the frame's "2 opgeborgen
  · 1 hernoemd" as a TITLE clipped to "…hernoe…" beside "5 min. geleden" —
  and the counts lead the body. The reminder fixture reads "Voorstel wacht op
  je": at AX5 the lock screen gives a title two lines and "Voorstel wacht nog
  op je" truncated to "Voorstel wacht nog…". The worker's own reminder title
  ("Wacht nog: <vraag>") carries free text and can still truncate there. The deadline push's body is "Deadline <dag>.
  Al gedaan? Kies Gedaan." (worker) / "Uiterlijk di 3 nov. Al gedaan? Kies
  Gedaan." (fixture): iOS clips a long-pressed preview at AX5 to a fixed
  height, and neither a swipe nor a held drag in the capture scrolled it, so the frame's longer body was cut
  mid-word above the Gedaan button.
