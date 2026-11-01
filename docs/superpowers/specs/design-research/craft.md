# Craft references for the verder iPhone app

Researched 2026-11-01. I fetched and read every claim below from the source given. Nothing comes from memory. Where a source did not cover something, or the only source was weak (sponsored, a competitor, or a third-party "design guide"), the claim is marked **UNVERIFIED** or **weak source**. No screenshots were captured, because WebFetch returns text only. Each "seen in" line names the article and the passage the observation comes from.

Mapping key for verder screens: **Overzicht**, **Voor jou** (list/detail), **Scan + upload queue**, **Dossier** (offline), **Money glance**, **Meer**/settings, **Voice quick-log**, **Weekly summary**, **notifications**, **widgets** (incl. Live Activities), **share extension**, **sign-in/lock**, **permission pre-prompts**.

Holodek constraint, repeated because it filters everything below: dark only, void background with glass panels, signal cyan for actions, and **amber ONLY for "waits on Martin"**. Any reference that uses colour as decoration is adopted for its *structure* only, never for its palette.

---

## Award status: what is verified

| App | Recognition (verified) | Source |
|---|---|---|
| Flighty | **2023 ADA winner, Interaction** | https://developer.apple.com/design/awards/2023/ |
| Things 3 | 2017 ADA (press coverage; Apple's 2017 page not fetched) | https://9to5mac.com/2017/06/07/2017-apple-design-award-winners/, https://en.wikipedia.org/wiki/Things_(software) |
| Halide Mark II | 2022 ADA, Visuals and Graphics (secondary list) plus Apple "Behind the Design" | https://daringfireball.net/u/u8a, https://developer.apple.com/news/?id=x6bv1a36 |
| (Not Boring) Weather | **UNVERIFIED**: the App Store listing claims an "ADA finalist 2021", which I did not confirm on Apple's site. The sibling app **(Not Boring) Habits won a 2022 ADA** (Apple Behind the Design). (Not Boring) Camera is a **2026 ADA finalist, Visuals and Graphics** | https://apps.apple.com/app/id1531063436, https://developer.apple.com/news/?id=9ab1g4r3, https://developer.apple.com/design/awards/ |
| Mercury Weather | **No ADA found.** MacStories Selects 2023 Best Design | https://www.macstories.net/reviews/mercury-weather-a-crystal-clear-design-for-every-apple-device/ |
| Copilot Money | **2024 ADA finalist, Innovation** (not a winner) | https://developer.apple.com/design/awards/2024 |
| Structured | **2026 ADA finalist, Inclusivity**; App Store Editors' Choice | https://developer.apple.com/design/awards/, https://apps.apple.com/app/structured-daily-planner/id1499198946 |
| Gentler Streak | **2024 ADA winner, Social Impact**; 2023 ADA finalist, Visuals; 2022 Apple Watch App of the Year | https://developer.apple.com/design/awards/2024, https://developer.apple.com/design/awards/2023/, https://developer.apple.com/news/?id=3m0ht22s |
| Bear | 2017 ADA (developer's own blog post) | https://blog.bear.app/2017/06/thank-you-yes-you-for-our-2017-apple-design-award/ |
| Fantastical | **No ADA found**: 2020 Mac App of the Year only (single source). Its reputation rests on reviews | https://www.macstories.net/reviews/fantastical-for-iphone-review/ |
| Crouton | **2024 ADA winner, Interaction** | https://developer.apple.com/design/awards/2024 |

---

## 1. Flighty: one line per item, calm until something changes

**Sources**
- Apple ADA 2023 jury text: https://developer.apple.com/design/awards/2023/
- Apple "Behind the Design: Flighty" (2023-06-05): https://developer.apple.com/news/?id=970ncww4
- 9to5Mac on Live Activities (2022-10-24): https://9to5mac.com/2022/10/24/flighty-dynamic-island-iphone-live-activities/
- The Sweet Setup review (2019-07-23): https://thesweetsetup.com/flightys-beautiful-design-fast-push-notifications-make-it-one-of-the-best-flight-tracking-apps-on-the-app-store/

**Seen in**
- Behind the Design, Ryan Jones: *"Those airport boards have one line per flight, and that's a good guiding light — they've had 50 years of figuring out what's important."*
- *"We want Flighty to work so well that it feels almost boringly obvious."* and *"We really have to shine when things go awry."*
- On Live Activities: *"There's something comforting about information always being there… You don't have to check your phone and think, 'OK, I have to be at the gate in 32 minutes'."* When connectivity is lost (*"we have to assume that we won't see them again until they land"*), the Dynamic Island switches to a progress bar and counter that need no network.
- 9to5Mac: the Live Activity *"automatically begins three hours before departure"*. The compact Island shows *"a dynamically updating time-until-departure countdown and the gate number"*. On a change such as a delay, the banner expands briefly. In flight, progress keeps updating offline.
- Sweet Setup: flight details are *"easy to consume content cards"* (gate, "good to know", inbound plane, change history). The app imports from TripIt, calendar and email. A *Connection Assistant* alert on landing tells you what you need for the next leg.
- Process: the team sketches 20 concepts on a sheet of paper before reaching for existing assets (Behind the Design).
- **UNVERIFIED**: the "15 smart states" and "first full use of Live Activities" claims come only from blakecrosley.com, a third-party guide.

**What it does well**: hierarchy borrowed from a mature real-world convention, one row per item. Silence is the default, and the app speaks loudly only on change. The state on the Lock Screen keeps working with no network.

**Informs verder**
- **Voor jou list**: one line per thing waiting, like a departures board: what it is, who it's from, how long it has waited. An amber dot is the only state colour. Detail opens as content cards (who / what they ask / proposed answer / evidence / change history), mirroring Flighty's card stack.
- **Overzicht**: "boringly obvious". The top shows the single current state (the open stop / "waar het op wacht") as a board line, not a dashboard of tiles.
- **notifications**: speak only on change, and say what to do next, like the Connection Assistant ("Regio 3 vraagt X; voorstel klaar om te keuren").
- **widgets / Live Activity**: a Live Activity is a good fit for an *in-flight* proposal send or a long scan upload. Like Flighty, it must render meaningfully from its last known state with no network.
- **Dossier (offline)**: copy Flighty's no-connectivity rule. Design the offline state as a first-class view, not an error.

---

## 2. Things 3: card expansion, Magic Plus, gesture density

**Sources**
- Cultured Code features page: https://culturedcode.com/things/features/
- MacStories review: https://www.macstories.net/reviews/things-3-beauty-and-delight-in-a-task-manager/
- 2017 ADA coverage: https://9to5mac.com/2017/06/07/2017-apple-design-award-winners/

**Seen in**
- MacStories: tapping a task makes it *"pop out into a card-like form"* while the rest of the list fades back. Notes and checklists show in full on the card. Areas are bold and projects lighter beneath them, with a progress pie. Colour appears only in small accents, and calendar events *"turn grey once they pass."* Taptic feedback fires on pick-up, on Magic Plus and on pull-to-search.
- Features page: Magic Plus lets you *"drag it into place, and let go"*, so a new item is created exactly where it is dropped (Inbox, a date in Upcoming, a heading). Today groups calendar events at the top, and **This Evening** is a separate section. Quick Find gives results on the first keystroke. Swipe right reschedules, swipe left multi-selects, and dragging across the selection circles selects a range. *"Everything you do in Things is nicely animated for pop."*
- Empty states: **not described by either source (UNVERIFIED)**.

**What it does well**: almost no chrome. Hierarchy comes from type weight, not boxes. One distinctive gesture, Magic Plus, replaces a form. Animation does work: it shows where an item went.

**Informs verder**
- **Voor jou detail**: the Things card transition. The row expands in place into a sheet and the list dims behind it, so Martin never loses his place in the queue.
- **Voor jou list**: an evening-style split, for example **"Nu"** versus **"Kan wachten"**, separating proposals and questions from slow tasks without a second tab.
- **Overzicht / Meer**: Things' weight hierarchy (bold area, light project) maps onto Saira for display and Plex Mono for metadata.
- **Voice quick-log**: the Magic Plus *idea*, where the drop target decides where the item goes, could inspire a long-press on the log button that drops onto a spoor. Consider it, but do not copy it: it is a discoverability risk.
- **Global**: pull-down search, as in Things, mapped to the existing ⌘K search on web.

---

## 3. Halide Mark II: a pro tool that never overwhelms

**Sources**
- Apple "Behind the Design: Halide Mark II" (2022): https://developer.apple.com/news/?id=x6bv1a36
- Apple Developer Spotlight: https://developer.apple.com/news/?id=wezczlc6

**Seen in**
- de With: *"A camera is an extension of your body, and it works best when it creates muscle memory. We need to have consistent gestures… without changing buttons around all the time."*
- *"…a single yellow highlight color… used to indicate active state for a feature."* The single colour was not enough on its own: a tester shot photos without realising RAW was off, so the button design was changed to show each mode explicitly.
- *"The complexity is there… it's just not going to overwhelm you."* *"Even high-end settings like depth mode and histograms are never more than a few taps away."* Slatkin's bowling-bumpers analogy describes guard rails for a novice.
- Spotlight: the type simulates *"the classic etched-in-metal look of traditional cameras"*, and histograms and waveforms are offered as instruments.
- Gestures, one-handed reach, onboarding flow and haptics: **not described in either Apple piece (UNVERIFIED)**.

**What it does well**: one accent colour with one meaning, and the lesson that colour alone is insufficient for state. Instruments sit one tap away from the simple surface. Consistent placement builds muscle memory.

**Informs verder**
- **Global colour rule**: Halide is the precedent for Holodek's "amber only for waits on Martin". Its RAW lesson means amber also needs a **shape or label** (a dot plus the word "wacht op jou"), never colour alone. This matters for accessibility and for a dark-only theme.
- **Scan + upload queue**: camera-tool discipline. Big, stable controls in fixed places, and the variant (raw / baseline / documentEnhancer) shown as a labelled mode, not a tinted icon.
- **Meer/settings**: "advanced is a few taps away". Diagnostic detail such as the auth cause or push attempts lives one level down, never on the primary surface.
- Plex Mono echoes Halide's etched instrument type. Use it for amounts, dates and IDs as *readouts*.

---

## 4. (Not Boring) Weather and Habits: earned delight

**Sources**
- Apple "Behind the Design: (Not Boring) Habits" (2022 ADA): https://developer.apple.com/news/?id=9ab1g4r3
- TapSmart review of Weather: https://www.tapsmart.com/apps/not-boring-weather-fun-alternative-weather-watchers/
- App Store listing (award claim): https://apps.apple.com/app/id1531063436
- 2026 ADA finalist, (Not Boring) Camera: https://developer.apple.com/design/awards/

**Seen in**
- Habits: the checkbox is an animated event with 3D, custom sound and haptics. Allen: *"How do we take principles and techniques from games — the haptics and sounds and particle animations — and apply them to something as basic as a checkbox?"* A hold interaction needed *"feedback that told you you needed to keep holding."* *"Minimalism is a fun place to visit… but it's not somewhere I want to live."* Dawson: *"design is difficult to copy."*
- Weather (TapSmart): 3D graphics, a huge temperature figure up front, chunky condition icons, paid skins, sound effects only when Silent is off, and haptics *"so subtle you might even miss them."*
- Weather's own ADA status is **UNVERIFIED** (listing claim only).

**What it does well**: it spends its craft budget on the one most-repeated interaction. Hold-to-confirm gets progressive feedback.

**Informs verder** (with care, since verder's subject is serious)
- **Voor jou detail, approve/send**: the hold-to-confirm feedback lesson applies directly. Approving a send already sits behind Face ID, and the moment just before it deserves deliberate, progressive feedback (a haptic ramp plus a fill), not a plain button. Keep it **restrained**: no particles and no confetti on a reply to a bewindvoerder.
- **Weekly summary**: the one place where a moment of warmth fits, for example a quiet "deze week afgerond: 4". It matches the project's supportive tone toward Martin.
- **Overzicht**: the "big number up front" pattern, i.e. the count waiting on Martin rendered large in Saira, as Weather does with temperature.

---

## 5. Mercury Weather: three stacked bands, colour carries data

**Source**: MacStories review (2023 Best Design, MacStories Selects): https://www.macstories.net/reviews/mercury-weather-a-crystal-clear-design-for-every-apple-device/

**Seen in**
- The iPhone layout is three stacked sections: current conditions over a gradient, then a horizontal 24-hour strip, then eight days. Monthly averages *slide up from the bottom* on tap.
- *"a modern layout and clear typography to make it fast and easy to check current conditions and the forecast."*
- The gradient background *conveys* temperature or cloud cover. Colour is data, not decoration.
- Widgets: small and medium Home Screen widgets (current / hourly / daily, any saved location), Lock Screen widgets in every size, a Watch app, and a Mac menu bar with 4-hour and 4-day graphs.
- No Live Activities found. A "curved temperature graph" is **not in the source (UNVERIFIED)**.

**What it does well**: a strict now → soon → later band order, a widget family that covers every size with the same three data choices, and depth (monthly averages) offered as a sheet rather than a tab.

**Informs verder**
- **Money glance**: the Mercury structure. Now (this month so far, per account, since accounts are never merged), then a horizontal strip of recent months (hatched when incomplete, `geen data` when empty), then a disclosure sheet that slides up with the incidental and transfer disclosures. Those disclosures must stay reachable, because CLAUDE.md says removing them makes the page lie.
- **Overzicht**: now (what waits) → soon (tasks due) → later (spoor/stops).
- **widgets**: the same small / medium / Lock-Screen-inline set, each offering the same data choices (waiting count, next deadline, last scan status).

---

## 6. Copilot Money: a review queue on the dashboard

**Sources**
- 2024 ADA finalist (Innovation): https://developer.apple.com/design/awards/2024
- Apple developer article (Swift Charts): https://developer.apple.com/articles/copilot-money/
- Copilot help, Transactions tab: https://help.copilot.money/en/articles/9554412-transactions-tab-overview
- Copilot help, quick start: https://help.copilot.money/en/articles/11157550-quick-start-guide
- 9to5Mac (sponsored): https://9to5mac.com/2024/10/31/copilot-money-review-ipad-cash-flow-tags/

**Seen in**
- Help docs: new transactions appear in a **"To Review"** section on the Dashboard, and "View all" opens the Transactions tab. A light-blue unreviewed indicator appears beside items *throughout the app*. You can edit and save to review, or mark many as reviewed in bulk (keyboard `R` on web). After about 30 reviews, Copilot Intelligence starts suggesting a type and category.
- Apple article: the app is fully native, with *"core UIKit components… mold[ed] to what we want them to look like."* All data is local, *"so the app is really responsive."* Cash Flow uses interactive Swift Charts.
- 9to5Mac (**sponsored, weak**): the dashboard shows monthly spending, assets and debt, transactions and top categories. Cash Flow compares year-to-date with the same period last year.
- **UNVERIFIED / weak source** (freenance.io): "progress rings" for budgets, an AI confidence level per transaction, and widgets for the next bill and month spend.

**What it does well**: the AI-suggested item is a *queue to clear*, visible on the home screen and marked consistently everywhere it appears. Suggestions only start once there is enough history, which is the same golden rule verder follows.

**Informs verder**
- **Overzicht**: a "Voor jou" preview block, with the top 3 and "Alles bekijken", exactly like Copilot's To Review section.
- **Voor jou**: the unreviewed indicator. One consistent amber marker on every row and in every surface where a waiting item appears (Overzicht, Dossier, Money), so the meaning is learned once.
- **Voor jou list**: bulk actions for suggestions, kept *strictly* to what the laws allow. Discard or file can be bulk. Sending never can.
- **Money glance**: local data plus a native-chart responsiveness argument for the offline-capable money view.

---

## 7. Structured: one timeline as the spine

**Sources**
- App Store listing with Editors' Choice text: https://apps.apple.com/app/structured-daily-planner/id1499198946
- 2026 ADA finalist, Inclusivity: https://developer.apple.com/design/awards/

**Seen in**
- *"Most planners give you a blank page. Structured gives you a timeline."* Tasks and calendar sit on one visual timeline with drag-and-drop, a colour and an icon per task, and an **Inbox** for unscheduled capture (swipe actions added in 4.6.4). Interactive widgets come with a setup guide in Settings → Widgets. Live Activities serve the focus timer, and 4.6.0 made the Live Activity buttons give clearer feedback and dismiss after completion.
- Editors' Choice: *"Trusting Structured with our schedules has done wonders for our mental health."*
- Onboarding: **not described (UNVERIFIED)**.

**What it does well**: a single chronological spine plus an inbox for things not yet placed. The widget setup guide lives inside the app.

**Informs verder**
- **Dossier**: the case is already a vertical, newest-first time axis on web (`/timeline`). Structured shows the phone version: one spine with an icon per stop kind. **Undated stops go to an inbox-like `nu` / `onbekend` band**, which verder already has.
- **Meer/settings**: an in-app "Widgets toevoegen" guide, as Structured has. Widgets are invisible until someone adds them.
- **Live Activity**: copy Structured's 4.6.0 lesson. Interactive Live Activity buttons must show feedback and dismiss when done.

---

## 8. Gentler Streak: encouragement without shame

**Sources**
- 2024 ADA jury text: https://developer.apple.com/design/awards/2024
- Apple "Behind the Design" (2024-07-11): https://developer.apple.com/news/?id=3m0ht22s

**Seen in**
- Jury: *"powered not by insistent reminders but an optimistic and encouraging vibe… a subtle and consistently pleasing design language. Its health data is smartly organized, and its Monthly Summary view — which shows how you're doing in relation to your history — is less about hard comparisons and more about progress."*
- Behind the Design: *"It guided but it didn't push. And it wasn't based on numbers; it was more explanatory."* *"Statistics are just numbers. Without knowing how to interpret them, they are meaningless."* The abstract mascot **Yorhart** stands for *"what your heart would be telling you."* *"We want it to feel like a compass."*
- Activity Path and onboarding: **not in the source (UNVERIFIED)**.

**What it does well**: the tone of every number. Each figure is explained against your own history, and nothing is framed as failure.

**Informs verder**: the most important reference for **tone**, given CLAUDE.md's law to be supportive and encouraging toward Martin.
- **Weekly summary**: the Monthly Summary model. Compare against Martin's own past weeks ("3 meer afgehandeld dan vorige week"), not against a target. Explain, don't score.
- **notifications**: "not insistent reminders". The existing 08:00–22:00 window and change-only badge pushes are already in this spirit. Never re-nag the same item.
- **Money glance**: the "statistics are meaningless without interpretation" rule supports keeping the disclosure lines (incidental income, transfers) next to the numbers.
- **empty states across the app**: an empty Voor jou is an *achievement* state ("Niets wacht op je"), never a blank.

---

## 9. Bear: typographic calm

**Sources**
- Developer's own 2017 ADA post: https://blog.bear.app/2017/06/thank-you-yes-you-for-our-2017-apple-design-award/
- Wikipedia (2016 App of the Year plus 2017 ADA): https://en.wikipedia.org/wiki/Bear_(app)

**Seen in**: the award is verified. I fetched **no concrete design write-up** about specific screens, so details such as theme choices and the tag sidebar are **UNVERIFIED** and left out.

**Informs verder (lightly)**: **Dossier** document reading view. Treat body text as the content, with a Markdown-like quiet reading column. This is a recommendation by analogy, not a verified Bear feature.

---

## 10. Fantastical: input that understands sentences

**Sources**
- MacStories iPhone review: https://www.macstories.net/reviews/fantastical-for-iphone-review/
- Shawn Blanc on Fantastical 2: https://shawnblanc.net/?p=12393
- TechCrunch (Fantastical 2): https://techcrunch.com/2013/10/30/fantastical-2-brings-deep-reminders-support-revamped-ios-7-look-to-the-best-iphone-calendar

**Seen in** (mostly 2012–2014 sources, so treat them as historical):
- Natural-language parsing: typing "meet with Joe at noon on Tuesday at The Crab Shack" fills every field.
- DayTicker: a horizontal strip of days in which the centre day magnifies as you slide, and a torn-paper edge marks the month boundary.
- **No ADA found.** Its standing comes from reviews.

**Informs verder**
- **Voice quick-log**: the parse-as-you-speak preview. Show the structured result live (date, party, spoor) under the transcript, so Martin sees what verder understood *before* saving. A log entry is ledgered, so confirmation must be explicit. That fits the "AI output is suggestion-only" law.
- **Dossier**: a DayTicker-like month scrubber over the vertical time axis, with a magnified current band and month boundaries clearly marked.

---

## 11. Crouton: the next thing, right where you need it

**Sources**
- 2024 ADA jury text (Interaction): https://developer.apple.com/design/awards/2024
- MacStories review: https://www.macstories.net/reviews/crouton-review-an-elegant-modern-recipe-manager-and-cooking-aid/ (full text not retrieved)
- Tools and Toys: https://toolsandtoys.net/crouton-recipe-and-meal-planner-app-for-iphone-ipad/

**Seen in**
- Jury: *"Recipe apps rise and fall on their organization and information hierarchy… Everything in Crouton, from the next recipe step to the name of that missing spice, is easy to find and right where you need it. And its effortless series of interactions mean people can keep their focus on the counter rather than their screen."*
- Import a recipe from a copied URL (MacStories excerpt). Clean UI that prefers simplicity over Paprika-level features (Tools and Toys).
- **UNVERIFIED / weak source**: auto-detected timers on the Lock Screen (competitor page recipesage.com), and wink or hands-free navigation (iMore, Verve; not checked first-hand).

**What it does well**: the next step is always the primary object, so attention stays on the real-world task.

**Informs verder**
- **Scan + upload queue**: Martin's attention is on the paper, not the screen. Show one primary instruction at a time ("Draai de stapel om, lange kant", the duplex flow), large and in the reach zone.
- **share extension**: Crouton's URL import shows the pattern: accept, show what was recognised, one confirm.
- **Voor jou detail**: the "next step" principle. The proposed action is the primary object on the page, with evidence below it.

---

## Cross-cutting patterns → verder screens

| Pattern | Seen in | verder screen |
|---|---|---|
| One line per item, like a departures board | Flighty | Voor jou list, Overzicht |
| Silence by default, loud only on change; say what to do next | Flighty, Gentler Streak | notifications, badge |
| State survives no network | Flighty (Island in flight) | Dossier offline, widgets, Live Activity |
| One accent colour = one meaning, **plus a shape or label** | Halide | amber = "wacht op jou" everywhere |
| In-place card expansion, list dims | Things 3 | Voor jou detail |
| Now → soon → later bands; depth as a slide-up sheet | Mercury | Overzicht, Money glance |
| AI queue to clear, shown on the dashboard, marked everywhere | Copilot | Overzicht preview, Voor jou |
| Single chronological spine plus an inbox for the undated | Structured | Dossier |
| Numbers explained against your own history, never shamed | Gentler Streak | Weekly summary, Money glance |
| Hold-to-confirm with progressive feedback | (Not Boring) Habits | Approve and send (behind Face ID) |
| Live parse preview before commit | Fantastical | Voice quick-log |
| Next step is the primary object; hands busy elsewhere | Crouton | Scan, share extension |
| In-app widget setup guide | Structured | Meer/settings |

## Gaps: no verified reference found

- **sign-in/lock** and **permission pre-prompts**: none of the sources fetched describes these screens. Halide's camera permission and Flighty's notification permission onboarding are commonly cited, but **UNVERIFIED**. This needs its own research pass, for example the Apple HIG on onboarding and permission requests, rather than borrowing from these apps.
- Empty states for Things 3 and Bear: not described in any source fetched.
- Widget specifics for Things 3, Copilot and Bear: not in the sources fetched (Copilot's only from a weak source).
