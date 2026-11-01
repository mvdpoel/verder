# Design research: Apple award winners and finalists as references for verder (iPhone)

Researched 2026-11-01. Scope: Apple Design Awards (ADA) 2023, 2024, 2025 and 2026, focusing on Delight and Fun, Interaction, Visuals and Graphics and Innovation, plus the App Store Awards "iPhone App of the Year" for 2023–2025.

## How to read this

- **Verified** means the app, its year, category and status (winner or finalist) were read on an apple.com or developer.apple.com page during this session. Quotes are Apple's published jury text from those pages.
- **No screenshots were viewed.** Each "came from" line names the text the finding is based on: Apple's jury description, an Apple Developer article, or a newsroom line. Anything about how a screen *looks* beyond that text is marked **(inference)** or **unverified**. Check it on the App Store page or on a device before copying it into a design.
- A note on category names: Apple's categories are **"Delight and Fun"** and **"Interaction"**, two separate categories. "Delight and Interaction" is not an Apple category.
- Games are left out. They share almost nothing with a calm, single-user dossier app.
- Spatial apps (Apple Vision Pro only, or iPad only) are listed in the appendix for completeness and are not used as references.

### verder screens used as tags
`Overzicht` · `Voor jou list/detail` · `Scan + upload queue` · `Dossier` · `Money glance` · `Meer/settings` · `Voice quick-log` · `Weekly summary` · `Notifications` · `Widgets` · `Share extension` · `Sign-in/lock` · `Permission pre-prompts`

### Holodek constraints that filter these references
The app is dark only: void background, glass panels and an ink scale. Signal cyan is reserved for things you can act on. Amber means one thing only: "waits on Martin". Type is Saira for display and IBM Plex Mono for data. Each reference below is judged by whether its *principle* fits these rules. Its palette is never copied. Several winners are warm, illustrated or playful, and only their structure carries over.

---

## Sources (all verified this session)

| Source | URL |
|---|---|
| ADA 2026 winners and finalists | https://developer.apple.com/design/awards/ |
| ADA 2025 winners and finalists | https://developer.apple.com/design/awards/2025/ |
| ADA 2024 winners and finalists | https://developer.apple.com/design/awards/2024/ |
| ADA 2023 winners and finalists | https://developer.apple.com/design/awards/2023/ |
| App Store Awards 2025 | https://www.apple.com/newsroom/2025/12/apple-unveils-the-winners-of-the-2025-app-store-awards/ |
| App Store Awards 2024 | https://www.apple.com/newsroom/2024/12/apple-honors-2024-app-store-award-winners/ |
| App Store Awards 2023 | https://www.apple.com/newsroom/2023/11/apple-unveils-app-store-award-winners-the-best-apps-and-games-of-2023/ |
| Behind the Design: Flighty | https://developer.apple.com/news/?id=970ncww4 |
| Copilot Money and Swift Charts | https://developer.apple.com/articles/copilot-money |

The ADA pages label only winners. Every unlabelled entry is a finalist. The 2023 and 2024 pages publish jury text for **winning apps only**, so finalist descriptions for those years are not available from Apple. Where this document describes a 2023 or 2024 finalist, that is marked.

---

## Tier 1: the closest matches to what verder is

### Flighty: ADA 2023 winner, Interaction (iPhone, iPad, Mac)
- **Sources:** ADA 2023 page; Behind the Design: Flighty (developer.apple.com/news/?id=970ncww4).
- **Came from:** the jury text: *"Live Activities and Dynamic Island integration … key information where you need it most … a look that mirrors time-honored airport design conventions … best-in-class support for widgets."* Also the Behind the Design article quoting Ryan Jones: *"We want Flighty to work so well that it feels almost boringly obvious."* On airport boards: *"one line per flight … they've had 50 years of figuring out what's important."* On being always visible: *"There's something comforting about information always being there… You don't have to check your phone."* The article says the team sketches about 20 concepts before choosing one.
- **What it does well:**
  1. It takes a stressful process and makes the app the calm part. That is exactly verder's job for a bewindvoering.
  2. It uses one real-world convention (the departure board, one line per item) as the grammar for every surface.
  3. It plans for being offline: it assumes the user disappears at takeoff and shows progress that keeps working without a connection.
- **Informs:**
  - `Overzicht`: one line per matter, departure-board style. Status word, last movement, who it waits on.
  - `Widgets` and `Notifications`: the answer to "what is the state right now" is visible without opening the app.
  - `Dossier` (offline pocket dossier): design the offline state as a normal state, not as an error.
  - Process: sketch about 20 options per screen before picking one.
- **Fit with Holodek:** strong. A departure board is already dark with mono type, so IBM Plex Mono for status columns maps directly onto it **(inference)**.

### Tiimo: App Store Awards 2025, iPhone App of the Year; ADA 2024 finalist, Inclusivity
- **Sources:** App Store Awards 2025 newsroom page; ADA 2024 page (finalist, Inclusivity, tiimo ApS, iPhone, iPad, Apple Watch).
- **Came from:** the newsroom line: *"an impressive visual planner and thoughtfully implemented AI that turns aspirations into actionable next steps."*
- **What it does well:** it turns a vague goal into a concrete next step, which is the core move of "Voor jou". It is designed with neurodivergent users in mind. Its ADA nomination is in Inclusivity.
- **Informs:**
  - `Voor jou list/detail`: every item ends in one concrete next action ("Goedkeuren", "Beantwoorden", "Later"), never an open question.
  - `Weekly summary`: show the week visually as steps taken, not a wall of text.
- **Unverified:** the specific visual-planner layout and its colour coding. Apple's text does not describe them.

### Structured: ADA 2026 finalist, Inclusivity (iPhone, iPad, Mac, Watch)
- **Source:** ADA 2026 page.
- **Came from:** the jury text: *"Visually sharp and easy to scan … prioritizes downtime as much as productivity … simple layout … incorporates the Foundation Models framework to suggest and pre-fill tasks."*
- **What it does well:** AI suggests and pre-fills while the human confirms. That is verder's suggestion-only law, shown in a UI that won recognition. It also treats rest as a first-class item.
- **Informs:**
  - `Voor jou detail`: show the AI-drafted text pre-filled, with editing and approval as the primary action. Make the AI origin visible but quiet.
  - `Overzicht`: a calm day should be shown as calm ("niets wacht op je"), not as an empty screen. This follows from the "downtime" principle **(inference)**.

### Gentler Streak: ADA 2024 winner, Social Impact; ADA 2023 finalist, Visuals and Graphics
- **Sources:** ADA 2024 page (winner text); ADA 2023 page (finalist listing only).
- **Came from:** the jury text: *"powered not by insistent reminders but an optimistic and encouraging vibe … a subtle and consistently pleasing design language … Monthly Summary view … less about hard comparisons and more about progress."*
- **What it does well:** its tone is encouraging and never nags. Its summaries frame progress against the user's *own* history instead of scoring them.
- **Informs:**
  - `Weekly summary`: "deze week afgerond: 4 · nog open: 2" framed as progress. No red deficits. This matches CLAUDE.md's "supportive/encouraging toward Martin".
  - `Notifications`: firm when something is due, never naggy and never repeated.
- **Note:** the 2023 finalist listing for Visuals and Graphics has no Apple description (finalist text is not published for 2023).

### The Outsiders: Athlete Tracker: ADA 2026 finalist, Interaction (iPhone, Watch)
- **Source:** ADA 2026 page (by Gentler Stories, the Gentler Streak team).
- **Came from:** the jury text: *"Training Readiness Score, a beautiful data visualization that shows training load alongside metrics such as sleep quality and resting heart rate."*
- **What it does well:** it folds many inputs into one glanceable score and still shows the components beside it.
- **Informs:**
  - `Money glance`: one headline figure (for example leefgeld left this month) with its components directly beneath it, never the number alone.
  - `Overzicht` header.
- **Caution:** verder must never *invent* a composite score for the case. The money-series law forbids a number that hides its disclosures. Borrow "headline plus visible parts", not "single score".

### Copilot Money: ADA 2024 finalist, Innovation (iPhone, Mac)
- **Sources:** ADA 2024 page (finalist listing); Apple Developer article *"How Copilot Money developed an interest in Swift Charts"*.
- **Came from:** the article: *"elegant graphs … a crystal-clear interface … accurate machine learning algorithms for categorizing transactions."* The team used **Swift Charts** for the interactive Cash Flow section instead of building custom charts. They styled native UIKit components rather than replacing them. All data is held locally, *"so the app is really responsive."*
- **What it does well:** personal-finance charts that feel native and responsive, built from system components.
- **Informs:**
  - `Money glance`: use Swift Charts for the per-account series. Keep data local so the glance opens instantly and offline.
  - It is the direct reference for an iPhone money chart.
- **Unverified:** the dark-mode colour treatment. The article's screenshot caption describes red, green and blue on a white background. verder must not use red or green as good/bad money signals, because amber is the only highlight colour.

### Tide Guide: Charts & Tables: ADA 2026 winner, Visuals and Graphics, and finalist, Interaction; ADA 2023 finalist, Interaction
- **Sources:** ADA 2026 page; ADA 2023 page.
- **Came from:** the 2026 jury text: *"rich full-screen charts present a boatload of weather data … in a crisp, clear manner that's easily understood … powerful widgets help swimmers and boat captains save a step right from the Home Screen. The app's palette is even designed to match the color of the sky throughout the day."* Also *"integrates the new design and Liquid Glass … custom animations."*
- **What it does well:** dense time-series data that stays legible. Widgets carry the main answer. Liquid Glass is used carefully and with purpose.
- **Informs:**
  - `Money glance` (full-screen chart on rotation or tap).
  - `Widgets`: the widget answers the question by itself.
  - Holodek glass panels: the reference for using Liquid Glass with restraint.
- **Do not borrow:** the sky-matched palette. Holodek has a fixed palette, and colour that shifts with time of day would weaken amber's single meaning.

### Moonlitt: Moon Phase Tracker: ADA 2026 winner, Interaction. Sister app Sunlitt: ADA 2024 finalist, Visuals and Graphics
- **Sources:** ADA 2026 page; ADA 2024 page (Sunlitt finalist listing).
- **Came from:** the jury text: *"SwiftUI-built utility … broad platform support … best-in-class Liquid Glass integration, and easy onboarding."*
- **What it does well:** a single-purpose utility, a model of Liquid Glass integration, and onboarding that gets out of the way.
- **Informs:**
  - `Permission pre-prompts` and first-run sign-in: short, one decision per screen **(inference from "easy onboarding")**.
  - Glass material on the tab bar and on sheets.
- **Unverified:** Sunlitt's 2024 description. Third-party coverage mentions a 3D sundial, widgets, Live Activities and the Dynamic Island, but Apple did not publish finalist text.

### Lumy: ADA 2025 finalist, Delight and Fun; App Store Awards 2024, Apple Watch App of the Year
- **Sources:** ADA 2025 page; App Store Awards 2024 newsroom page.
- **Came from:** the jury text: *"simple design, carefully curated color palette, and elegant widgets and Live Activities … a quick and intuitive way to get … information."*
- **Informs:** `Widgets` (small and medium), and the discipline of a curated, limited palette that fits Holodek.

---

## Tier 2: specific interactions worth borrowing

### Crouton: ADA 2024 winner, Interaction (iPhone and all platforms)
- **Source:** ADA 2024 page.
- **Came from:** the jury text: *"rise and fall on their organization and information hierarchy … Everything … is easy to find and right where you need it … effortless series of interactions mean people can keep their focus on the counter rather than their screen."*
- **Informs:**
  - `Dossier`: information hierarchy matters more than decoration. The thing you need next sits where your thumb is.
  - `Voice quick-log`: designed for when your attention is somewhere else.

### Mela – Recipe Manager: ADA 2025 finalist, Interaction (iPhone, iPad, Mac)
- **Source:** ADA 2025 page.
- **Came from:** the jury text: *"recipe steps … are subtly dimmed and highlighted at the proper time. Timers integrate with the Dynamic Island, recipe scanning is powered by the Vision framework, and ingredients plug right into the Reminders app."*
- **Informs:**
  - `Scan + upload queue`: Vision-based document scanning that hands off to a structured result.
  - `Voor jou detail` and multi-step tasks: dim what is done and highlight the current step. This is a natural use for ink-scale dimming.
  - `Notifications` and Live Activity: an upload in progress could be shown as a Live Activity **(inference)**.

### iA Writer: ADA 2025 finalist, Interaction (iPhone, iPad, Mac)
- **Source:** ADA 2025 page.
- **Came from:** the jury text: *"distraction-free … swiping right to access your library and left to preview a document."*
- **Informs:**
  - `Voor jou detail` (editing a proposed reply): a distraction-free text editor for the final text Martin approves.
  - `Dossier` document viewer: an edge swipe between list and preview.

### CapWords: ADA 2025 winner, Delight and Fun (iPhone, iPad)
- **Source:** ADA 2025 page.
- **Came from:** the jury text: *"Learn the name of a thing by taking a picture of it. With the snap of a camera and a fun animation … transforms everyday objects … into interactive stickers … each flash card transition is accompanied by a real-world sound."*
- **Informs:** `Scan + upload queue`. The moment a photographed page becomes an object in the queue deserves a short, satisfying transition, with a lift-off animation and a haptic. In the Holodek tone this should be a quiet, crisp tick, not something cute.

### Denim – Playlist Cover Maker: ADA 2025 finalist, Delight and Fun (iPhone)
- **Source:** ADA 2025 page.
- **Came from:** the jury text: *"seamless SwiftUI-built experience, with smooth scroll transitions and elegant text and mesh gradients … custom haptics … cool depth effects."*
- **Informs:** Holodek's void background could carry a very faint mesh gradient for depth behind glass **(inference)**. Use custom haptics sparingly, for "approved" and "sent".

### Vocabulary – Learn words daily: ADA 2025 finalist, Visuals and Graphics (iPhone, iPad, Watch)
- **Source:** ADA 2025 page.
- **Came from:** the jury text: *"A subtle example of excellence … Typography and iconography feel modern and balanced … a lovely instance of an app that quietly does everything right."*
- **Informs:** the overall bar. verder should feel like "quietly does everything right". It is a reference for typographic rhythm with Saira and Plex Mono, not for its illustrations.

### (Not Boring) Camera: ADA 2026 finalist, Visuals and Graphics (iPhone, iPad)
- **Source:** ADA 2026 page.
- **Came from:** the jury text: *"tactile throwback … giant buttons and haptic scroll wheels."*
- **Informs:** `Scan` capture screen. One huge, unmistakable capture button with haptic detents. Leave out the retro style.

### Kino: App Store Awards 2024, iPhone App of the Year
- **Source:** App Store Awards 2024 newsroom page.
- **Came from:** the newsroom line: *"shows users how cinematic life can be through its film-inspired filters and advanced controls."*
- **Informs:** `Scan` only loosely: advanced controls (the cleanup variants raw, baseline and documentEnhancer) kept behind a simple default. Weak reference.

### Detail: AI Video Editor: ADA 2026 finalist, Innovation (iPhone, iPad, Watch); App Store Awards 2025, iPad App of the Year
- **Sources:** ADA 2026 page; App Store Awards 2025 newsroom page.
- **Came from:** the jury text: *"simplicity of a camera app with the power of a professional AI … leverages the Foundation Models framework to turn a draft or outline into a ready-to-record … script."*
- **Informs:** `Voice quick-log`. Speak a rough note and get a structured draft back to approve. On-device models keep the content private.

### Hearing Buddy: ADA 2026 finalist, Inclusivity (iPhone, iPad, Watch)
- **Source:** ADA 2026 page.
- **Came from:** the jury text: *"Foundation Models framework and on-device speech-to-text … real-time captions and summaries."*
- **Informs:** `Voice quick-log`. Show the live transcript while Martin speaks, then a one-line summary he confirms. On-device processing is the right privacy posture for a bewind dossier.

### Harvee: ADA 2026 finalist, Social Impact (iPhone, Watch)
- **Source:** ADA 2026 page.
- **Came from:** the jury text: *"actionable guidance … on-device foundation models, sensitive health data stays secure."*
- **Informs:** `Weekly summary`. Turn data into guidance and say plainly that it stays on the device or on Martin's server. Leave out the avatar.

### Capybara AI Meeting Translator (finalist, Innovation) and Moises (finalist, Innovation): ADA 2025 (iPhone, iPad)
- **Source:** ADA 2025 page.
- **Came from:** Capybara: *"A relaxed little capybara hangs out on the screen while the app is doing its thing."* Moises: *"for all its technical magic, Moises is remarkably easy to understand and navigate."*
- **Informs:** `Scan + upload queue` and processing states. A calm, non-anxious "working" state, such as an OCR or upload in progress. In Holodek this would be a slow cyan pulse, not a mascot.

### Opal: ADA 2025 finalist, Social Impact (iPhone, iPad)
- **Source:** ADA 2025 page.
- **Came from:** the jury text: *"widgets, Shortcuts, and easy-to-set-up customizations … haptics when unlocking 'gems'."*
- **Informs:** `Meer/settings`: easy setup, plus Shortcuts and App Intents for "Log iets" and "Scan" **(inference)**.

### Bears Gratitude: ADA 2024 winner, Delight and Fun (iPhone, iPad, Mac)
- **Source:** ADA 2024 page.
- **Came from:** the jury text: *"a simple way to encourage … maintain … a daily … practice … thoughtfully considered touchpoints."*
- **Informs:** `Weekly summary`, through the habit-forming rhythm only. The illustration style does not fit Holodek.

### grug: ADA 2026 winner, Delight and Fun (iPhone)
- **Source:** ADA 2026 page.
- **Came from:** the jury text: *"there's no login, no cloud syncing, nothing extraneous."*
- **Informs:** a principle, not a visual. Cut everything extraneous. verder is single-user, so it should never show multi-user chrome.

---

## Tier 3: checked and judged weak or not applicable

| App | Award (verified) | Why it is not used |
|---|---|---|
| AllTrails | App Store Awards 2023, iPhone App of the Year. *"nurtures community through comprehensive trail guides and outdoor exploration"* | Community and maps. verder has neither. |
| Any Distance | ADA 2023 winner, Visuals and Graphics | Charts built to be shared. Possible inspiration for the money chart's motion only. |
| Duolingo | ADA 2023 winner, Delight and Fun | Gamified streaks are the wrong tone for a legal case. |
| Headspace | ADA 2023 winner, Social Impact | "Remarkably easy to navigate (collections are clearly labeled with understandable purposes)". A minor reference for labelling in `Meer`. |
| SwingVision | ADA 2023 winner, Innovation | Camera plus ML coaching. No match. |
| Arc Search | ADA 2024 finalist, Interaction (iPhone) | **Apple text unverified** (finalist text not published). Third parties cite AI summaries. A possible ⌘K or search analogue for the Dossier. |
| How We Feel, Ahead | ADA 2024 finalists, Social Impact (iPhone) | **Apple text unverified.** Mood UIs. |
| Watch Duty | ADA 2025 winner, Social Impact | *"clearly and reliably offering updates … real-time guidance"*. Relevant to `Notifications` reliability only. |
| Ground News | ADA 2025 finalist, Social Impact | *"color-coded bias markers … inspire trust, transparency"*. A note on provenance markers for the Dossier's sources (mail, scan, upload). |
| Rooms, Procreate Dreams, Feather, Play | various | Creative canvases. Visual or iPad scope. |
| Taobao, NBA, Primary, djay | various | Vision Pro or spatial. |

---

## Synthesis by verder screen

| verder screen | Primary references | Principle to carry over |
|---|---|---|
| Overzicht | Flighty, Structured, The Outsiders | Departure-board rows, one line per matter. A calm state is a real state. Headline figure with its parts visible. |
| Voor jou list/detail | Tiimo, Structured, Mela, iA Writer | Every item ends in one next action. The AI pre-fills and Martin confirms. Dim finished steps. A distraction-free editor for the final text. |
| Scan + upload queue | CapWords, Mela (Vision scan), (Not Boring) Camera, Capybara/Moises | One big capture control. A satisfying page-to-queue transition. A calm working state. |
| Dossier (offline) | Flighty (offline assumed), Crouton, iA Writer, Ground News | Offline is a designed state. Hierarchy before decoration. Swipe between list and preview. Provenance markers. |
| Money glance | Copilot Money, Tide Guide, The Outsiders | Swift Charts. Local data for an instant open. A full-screen legible chart. Never a figure without its disclosures. |
| Meer/settings | Opal, Headspace | Easy setup. Clear labels. Shortcuts. |
| Voice quick-log | Hearing Buddy, Detail, Crouton | Live on-device transcript, then a one-line confirm. Works hands-busy. |
| Weekly summary | Gentler Streak, Harvee, Bears Gratitude | Progress against Martin's own history. Encouraging and never punitive. Data turned into guidance. |
| Notifications | Flighty, Watch Duty, Gentler Streak | Information always there without opening the app. Reliable and never naggy. |
| Widgets | Flighty, Tide Guide, Lumy | The widget answers the question by itself. A curated, limited palette. |
| Share extension | Mela (import from other apps) | One-step import into a structured place **(inference; weak evidence)**. |
| Sign-in/lock | grug, Moonlitt | Nothing extraneous. Fast onboarding. **No award reference covers a Face ID gate directly.** |
| Permission pre-prompts | Moonlitt | One decision per screen, said plainly **(inference)**. |

## Gaps and unverified items
- No screenshots were inspected. Every visual claim beyond Apple's text needs to be checked on the App Store listing or a device.
- Apple's finalist descriptions for 2023 and 2024 are not published. This affects Sunlitt, Arc Search, Copilot Money (covered instead by Apple's Swift Charts article), Tiimo 2024, How We Feel, Ahead, Meditate and finity.
- Apple Developer "Behind the Design" articles for Gentler Streak, Crouton, Tiimo and Tide Guide were searched for and **not found** this session. Only Flighty's was found and read.
- No awarded app covers sign-in, lock screens or permission pre-prompts directly. Those screens need Apple's Human Interface Guidelines as their reference instead.

## Appendix: verified lists (apps only)
- **ADA 2026.** Delight and Fun: grug (W), Blippo+ (Mac), Metaballs. Interaction: Moonlitt (W), The Outsiders, Tide Guide. Visuals and Graphics: Tide Guide (W), Caradise (visionOS), (Not Boring) Camera. Innovation: NBA (W, visionOS), D-Day: The Camera Soldier (visionOS), Detail. Inclusivity: Guitar Wiz (W), Hearing Buddy, Structured. Social Impact: Primary (W, visionOS), Katha Room, Harvee.
- **ADA 2025.** Delight and Fun: CapWords (W), Lumy, Denim. Interaction: Taobao (W, Vision Pro), iA Writer, Mela. Visuals and Graphics: Feather (W, iPad), Vocabulary, CellWalk (Vision Pro). Innovation: Play (W), Moises, Capybara. Inclusivity: Speechify (W), Evolve, Train Fitness. Social Impact: Watch Duty (W), Ground News, Opal.
- **ADA 2024.** Delight and Fun: Bears Gratitude (W). Finalists Rooms and Dudel Draw. Interaction: Crouton (W). Finalists Procreate Dreams, Arc Search and finity. Visuals and Graphics: Rooms (W). Finalists Sunlitt and Meditate. Innovation: Procreate Dreams (W). Finalists Copilot Money, SmartGym and Wavelength. Inclusivity: oko (W). Finalists Complete Anatomy and Tiimo. Social Impact: Gentler Streak (W). Finalists How We Feel and Ahead. Spatial: djay (W).
- **ADA 2023.** Delight and Fun: Duolingo (W). Finalists CREME and Chantlings. Interaction: Flighty (W). Finalists Shuffles and Tide Guide. Visuals and Graphics: Any Distance (W). Finalists Gentler Streak and Riveo. Innovation: SwingVision (W). Finalists Camo Studio and Rise. Inclusivity: Universe (W). Finalists Anne and Passenger Assistance. Social Impact: Headspace (W). Finalists Duolingo and Sago Mini First Words. (The 2023 page lists finalists without saying which are apps and which are games. These were sorted by name.)
- **App Store Awards iPhone App of the Year:** 2023 AllTrails · 2024 Kino · 2025 Tiimo.
