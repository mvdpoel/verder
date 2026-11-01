# Apple HIG research for verder for iPhone

Researched 2026-11-01. Target: iOS 27 on Martin's iPhone 16 Pro (dark only, Holodek tokens from `apps/web/src/app/globals.css`).

## How this was gathered (and what that means for trust)

- The HIG pages at `developer.apple.com/design/human-interface-guidelines/<page>` are rendered by JavaScript, so a plain fetch returns only the title. Every HIG page below was read in full from the same content as JSON at `https://developer.apple.com/tutorials/data/design/human-interface-guidelines/<page>.json`, downloaded 2026-11-01. Each reference cites the human URL. The JSON endpoint is the source of the quoted text.
- **No screenshots were taken.** The HIG art arrives as image references with no captions. Where this document says "description", it means the HIG's own prose next to that art, not a picture I looked at.
- Each page's change log is quoted so you can see how current it is. Several pages changed at WWDC26 (2026-06-08), and some changed again in September and October 2026.
- iOS 27 facts that are not in the HIG come from apple.com pages, cited inline. Third-party press is used only to corroborate. Anything I could not confirm against an Apple page is tagged **UNVERIFIED**.
- Contrast ratios for Holodek tokens are **computed** (WCAG relative luminance, opaque token over `--color-void` #04070d). The calculation script is in the scratchpad and is not committed.

Screen key used throughout: **OV** Overzicht · **VJ** Voor jou list/detail · **SC** Scan + upload queue · **DO** Dossier (offline) · **MO** Money glance · **ME** Meer/settings · **VQ** Voice quick-log · **WS** Weekly summary · **NO** notifications · **WI** widgets · **SH** share extension · **LK** sign-in/lock · **PP** permission pre-prompts.

---

## 0. The platform as of today (iOS 27)

| Fact | Source | Status |
|---|---|---|
| iOS 27's Liquid Glass gets "more uniform refraction and improved contrast". "A new slider lets you easily customize how Liquid Glass looks, from ultraclear to fully tinted." | https://www.apple.com/os/ios/ (iOS 27 page, quoted verbatim) | verified |
| "A new transparency slider in Settings allows users to personalize their visual experience … while the design also seamlessly adapts to a variety of accessibility settings." | https://www.apple.com/newsroom/2026/06/apple-aids-app-development-with-new-intelligence-frameworks-and-advanced-tools/ | verified |
| iOS 26.1 added a binary Clear/Tinted choice (Settings → Display & Brightness → Liquid Glass). The iOS 27 slider replaces it. | https://www.tomsguide.com/phones/iphones/ios-26-1-lets-you-adjust-liquid-glass-transparency-on-your-iphone-heres-how-to-do-it, https://www.macworld.com/article/2947565/ios-26-1-beta-4-does-the-unthinkable-you-can-control-how-glassy-liquid-glass-should-be.html | third-party, consistent with Apple's iOS 27 wording |
| Apple design kits (Figma, Sketch) for iOS/iPadOS/macOS 27 were published 2026-06-23 at https://developer.apple.com/design/resources/ | https://developer.apple.com/news/?id=e2lxw9l1 | verified |
| The HIG "Design principles" page was reintroduced 2026-06-08 (Purpose, Agency, Responsibility, Familiarity, Flexibility, Simplicity, Craft, Delight). | https://developer.apple.com/design/human-interface-guidelines/design-principles | verified |
| A new "Designing for iPhone Duo" page (2026-09-09) describes a two-display, hinged iPhone where tab bars and toolbars move to the **side**. | https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo | verified. Not Martin's device, but it is the strongest argument yet for size classes and no fixed widths. |
| iPhone 16 Pro is 402 × 874 pt @3x. | https://useyourloaf.com/blog/iphone-16-screen-sizes/, https://yesviz.com/devices/iphone-16-pro/ | third-party. The HIG Layout page no longer lists per-device sizes in its text (**UNVERIFIED in HIG**). |
| Status-bar glyphs are rounder in iOS 27; app icons get separate Liquid Glass layers. | https://www.gizmodo.jp/article/wwdc26-ios27-design/, https://www.bgr.com/2191219/ios-27-liquid-glass-fix-customization/ | **UNVERIFIED** (press only). Apple's page says only "App icons are sharper and more detailed." |

**Design consequence.** On iOS 27 the system's glass ranges from almost clear to almost opaque, and only Martin controls where it sits. Every Holodek surface that sits under or next to system glass (tab bar, nav bar, sheets, the notification banner) has to be checked at both ends of the slider and with Reduce Transparency and Increase Contrast on.

---

## 1. References

Each reference gives the source, the description it came from, the checkable rules, what it does well, and the screens it informs.

### R1 · Materials: Liquid Glass belongs to controls, never to content
- **Source:** https://developer.apple.com/design/human-interface-guidelines/materials (change log: 2025-06-09 added, 2025-09-09 updated Liquid Glass).
- **Description:** The prose next to the hero art describes Liquid Glass as "a distinct functional layer for controls and navigation elements — like tab bars and sidebars — that floats above the content layer".
- **Rules:**
  - "Don't use Liquid Glass in the content layer." Use standard materials (ultra-thin, thin, regular, thick) for structure inside content. Content-layer exceptions are transient controls such as sliders and toggles.
  - "Use Liquid Glass effects sparingly" on custom controls.
  - Glass comes in two variants. *Regular* is the default for text-heavy components. *Clear* is only for components over visually rich media, with a **35% dark dimming layer** if the content beneath is bright.
  - Use vibrant label colours (`label` / `secondaryLabel` / `tertiaryLabel`) on materials. Avoid `quaternaryLabel` on thin and ultra-thin materials.
- **Does well:** It cleanly separates "chrome" from "case content". That is exactly the separation Holodek already draws between the rail and the panels.
- **Informs:** all screens. In particular, Holodek's `glass-a`/`glass-b` panels are **content**, so on iOS they must be custom fills or standard materials, never `.glassEffect`. Only the tab bar, nav bar, sheet chrome and floating action buttons should be Liquid Glass. Apply this to **OV, VJ, DO, MO** first.

### R2 · Color: Liquid Glass colour and status colour
- **Source:** https://developer.apple.com/design/human-interface-guidelines/color (change log: 2025-06-09, 2025-12-16 Liquid Glass).
- **Description:** "Liquid Glass color" section.
- **Rules:**
  - Glass "has no inherent color". Symbols and text on small glass elements (tab bars, toolbars) are monochrome by default.
  - "Apply color sparingly … reserve it for elements that truly benefit from emphasis, such as status indicators or primary actions. To emphasize primary actions, apply color to the background rather than to symbols or text."
  - "Avoid using the same color to mean different things."
  - "Avoid relying solely on color."
  - Keep the resting state, at the top of a scroll, legible where content colour sits under controls.
- **Does well:** It formally backs Holodek's law that amber means "waits on Martin" and nothing else, and that cyan means action.
- **Informs:** the **VJ** amber state must also carry a shape or word, because colour alone is not enough. The primary action on **VJ** detail ("Versturen") should be a cyan-tinted `.prominent` button with the colour on the background. Keep the tab bar monochrome.

### R3 · Dark Mode: a dark-only app is allowed, but justify it
- **Source:** https://developer.apple.com/design/human-interface-guidelines/dark-mode
- **Description:** "Best practices" and "Dark Mode colors" sections.
- **Rules:**
  - "In rare cases, consider using only a dark appearance in the interface."
  - "Avoid offering an app-specific appearance setting."
  - Contrast must be "no lower than 4.5:1. For custom foreground and background colors, strive for a contrast ratio of **7:1, especially in small text**."
  - Test with Increase Contrast and Reduce Transparency, separately and together.
  - On iOS, modals and popovers move from the *base* to the *elevated* background, so an elevated sheet should be a little brighter than the void.
- **Does well:** It gives a concrete contrast floor for custom palettes.
- **Informs:** all screens. Dark only matches Holodek. Do not add an appearance toggle in **ME**. Sheets on **VJ** and **SC** need an "elevated void" token. See the token audit in §3.

### R4 · Tab bars
- **Source:** https://developer.apple.com/design/human-interface-guidelines/tab-bars (change log: 2025-07-28 Liquid Glass, 2025-12-16 updated, **2026-06-08** terminology/art).
- **Description:** The iOS platform section says "A tab bar floats above content at the bottom of the screen. Its items rest on a Liquid Glass background that allows content beneath to peek through."
- **Rules:**
  - Use the tab bar for navigation, not actions. Keep it visible except under a modal.
  - Avoid overflow: the trailing tab becomes "More", which hides content.
  - Never disable or hide a tab. If a section is empty, explain why.
  - Use single-word labels and **filled** SF Symbols.
  - A dedicated **search tab** can sit at the trailing end.
  - A tab bar with an attached **accessory** (`tabViewBottomAccessory`) can minimise on scroll-down and move the accessory inline. Tapping a tab or scrolling to the top restores it.
  - The badge is "a red oval containing white text", reserved "for critical information".
  - Keep the number of tabs small. iPad guidance says five or fewer by default.
- **Does well:** The accessory is a native home for "something is in progress".
- **Informs:** the tab set (OV / VJ / SC / DO / Meer = 5, so no More tab). Put the **SC** upload queue's live progress, and an active **VQ** recording, in the bottom accessory instead of a custom overlay. **DO** search could be the trailing search tab, but only if it replaces a tab rather than becoming a sixth. **Tension:** a red tab badge clashes with the amber law. See §3.

### R5 · Toolbars (navigation bars)
- **Source:** https://developer.apple.com/design/human-interface-guidelines/toolbars (change log: 2025-06-09, 2025-12-16).
- **Description:** The "Titles" section and the iOS platform section.
- **Rules:**
  - Keep the title "under 15 characters". Never use the app name as a title.
  - Use **large titles** that collapse on scroll.
  - Use `.prominent` for "key actions such as Done or Submit". Specify **one** primary action, on the trailing side.
  - Reduce custom toolbar backgrounds and tinting. Use a scroll edge effect instead.
- **Does well:** It gives a measurable title budget.
- **Informs:** titles must fit: "Overzicht" (9), "Voor jou" (8), "Dossier" (7), "Geld" (4), "Weekoverzicht" (13, which fits), "Instellingen" (12). **WS** and **VJ** detail each get one trailing prominent action.

### R6 · Scroll views: scroll edge effects
- **Source:** https://developer.apple.com/design/human-interface-guidelines/scroll-views (change log: **2026-06-08** updated scroll edge effects).
- **Description:** "Scroll edge effects" section.
- **Rules:**
  - Prefer the *automatic* style.
  - Use the effect "only when a scroll view is behind floating interface elements". It is "not decorative".
  - Use one scroll edge effect per view.
- **Informs:** Do not paint a solid strip under the nav bar or tab bar on **OV / VJ / DO**. Let the system edge effect separate them.

### R7 · Sheets
- **Source:** https://developer.apple.com/design/human-interface-guidelines/sheets (change log: **2026-03-24** updated button placement).
- **Description:** iOS/iPadOS section, next to art of a sheet with Cancel and Done.
- **Rules:**
  - On iOS, **Cancel goes on the leading edge and Done on the trailing edge**.
  - Pair Done with Cancel or Back. Never show all three together.
  - Show one sheet at a time.
  - Detents are *medium* (about half height) and *large*. Include a **grabber** in a resizable sheet. It also works with VoiceOver.
  - Support swipe-to-dismiss. If there are unsaved changes, confirm with an action sheet.
  - For long or multi-step flows, prefer full-screen modal.
- **Informs:**
  - **VJ**: editing a proposal's text is a large-detent sheet with Annuleren/Versturen. Swipe-dismissing with edits asks for confirmation.
  - **VJ**: answering a question can use a medium detent.
  - **SC**: the camera is full-screen (VisionKit already is).
  - **VQ**: medium-detent sheet with a grabber.

### R8 · Lists and tables
- **Source:** https://developer.apple.com/design/human-interface-guidelines/lists-and-tables
- **Rules:**
  - Keep row text succinct. A middle ellipsis can preserve the start and end of a long string.
  - Use the disclosure indicator for drill-in and the info button only for extra info.
  - Do not combine a section index with trailing disclosure indicators.
  - For long lists, show the most relevant first and offer "view more".
  - Use grouped style (headers, footers, extra spacing) for grouped data.
- **Related:** https://developer.apple.com/design/human-interface-guidelines/designing-for-ios says "let people swipe to navigate back or initiate actions in a list row".
- **Informs:**
  - **VJ** list: a grouped list by kind (Voorstellen / Vragen / Suggesties / Taken). Swipe actions for quick decisions, with destructive actions distinct.
  - **DO**: long file titles such as `Loonstrook.mp.2026-07.Saurens.pdf` use middle truncation.

### R9 · Typography and Dynamic Type
- **Source:** https://developer.apple.com/design/human-interface-guidelines/typography (change log: 2025-03-07 expanded Dynamic Type, 2025-12-16 emphasized weights).
- **Rules:**
  - iOS default text size is **17 pt** and the minimum is **11 pt**. Avoid Ultralight, Thin and Light weights.
  - A custom font must "implement the same behaviors" as system fonts: Dynamic Type and Bold Text.
  - At accessibility sizes, keep truncation minimal, stack inline items above or below, and keep the hierarchy.
  - Do not blow up everything. Prioritise the content people care about.

**iOS Large (default) text styles, size/leading in pt:**

| Style | Size/leading | Weight |
|---|---|---|
| Large Title | 34/41 | Regular |
| Title 1 | 28/34 | Regular |
| Title 2 | 22/28 | Regular |
| Title 3 | 20/25 | Regular |
| Headline | 17/22 | Semibold |
| Body | 17/22 | Regular |
| Callout | 16/21 | Regular |
| Subhead | 15/20 | Regular |
| Footnote | 13/18 | Regular |
| Caption 1 | 12/16 | Regular |
| Caption 2 | 11/13 | Regular |

- At xxxLarge, Body is 23/29. At AX5, Body is **53/62** and Large Title is 60/70.
- The Caption 2 row at Large was cut off in my extraction. 11/13 is the long-standing value but is **UNVERIFIED** against this revision.
- **Informs:** all screens. Saira and IBM Plex Mono have to scale through `UIFontMetrics` / `Font.custom(_:size:relativeTo:)`, and Bold Text has to swap weights. Holodek's mono micro-labels (dates, `ink-dim`) must not go below 11 pt. **MO** amounts and **OV** counts must survive AX5 without truncation by stacking.

### R10 · Accessibility: targets, spacing, contrast, motion
- **Source:** https://developer.apple.com/design/human-interface-guidelines/accessibility (change log: 2025-03-07, 2025-06-09).
- **Rules:**
  - iOS control size is **44×44 pt** by default and **28×28 pt** at minimum.
  - Padding is about **12 pt** around bezeled elements and about **24 pt** around unbezeled ones.
  - Text contrast: up to 17 pt needs **4.5:1**; 18 pt or bold needs **3:1**.
  - Do not convey information by colour alone.
  - Reduce Motion asks for:
    - fewer automatic and repetitive animations
    - tighter springs
    - fades instead of x/y/z transitions
    - no animating into or out of blur
  - Assistive Access: "ask for confirmation twice" before hard-to-recover actions.
- **Informs:** every tappable row and chip, at 44 pt. Holodek's breathe, spin-slow, drift, sweep and halo animations **must stop** under Reduce Motion (**OV** hero, **LK**). The purge confirmation in **DO** is already two-step.

### R11 · VoiceOver
- **Source:** https://developer.apple.com/design/human-interface-guidelines/voiceover
- **Rules:**
  - Label every key element. Describe meaningful images and exclude decorative ones.
  - Give charts a concise description.
  - Use headings for navigation and group related elements.
  - Announce content or layout changes.
  - Support the rotor.
- **Informs:** **VJ** rows are grouped as one element ("Voorstel, antwoord aan Regio 3, wacht op jou"). The **MO** chart gets a description and audio graph. The badge or amber state is spoken as words.

### R12 · Motion
- **Source:** https://developer.apple.com/design/human-interface-guidelines/motion (change log: 2025-09-09 Liquid Glass).
- **Rules:**
  - Motion must be purposeful and optional, and never the only carrier of information.
  - Avoid motion on frequent interactions.
  - "Let people cancel motion."
  - SF Symbols animations are preferred for small state changes.
  - The visionOS section warns against sustained oscillation around **0.2 Hz**. That is visionOS-specific, but a useful ceiling for the "breathe" idea; Holodek's breathe at 3 s is about 0.33 Hz.
- **Informs:** the **OV** ambient motion is decorative, so make it subtle and off under Reduce Motion. **LK** unlock transitions should not block input.

### R13 · Playing haptics
- **Source:** https://developer.apple.com/design/human-interface-guidelines/playing-haptics
- **Rules:**
  - Use system patterns "according to their documented meanings". Notification feedback has **success**, **warning** and **failure**. Use impact as a physical metaphor and selection while a value changes.
  - Be consistent, do not overuse, make haptics complement visuals, and make them optional.
  - Haptics must not disrupt the camera or microphone.
- **Informs:**
  - success: proposal sent (**VJ**), scan uploaded (**SC**), quick-log saved (**VQ**)
  - failure: upload failed
  - selection: detent or segmented changes in **MO**
  - none during **VQ** recording or while the **SC** camera is live

### R14 · SF Symbols
- **Source:** https://developer.apple.com/design/human-interface-guidelines/sf-symbols (change log: 2025-07-28 SF Symbols 7 Draw and gradients).
- **Rules:**
  - Rendering modes: monochrome, hierarchical, palette, multicolor. SF Symbols 7 adds gradients.
  - Use variable colour for change, not depth.
  - Nine weights match SF text. Scales are small, medium and large.
  - Use the **fill** variant for tab bars and swipe actions.
  - Animations: Appear, Bounce (once, "an action occurred"), Scale, Pulse (ongoing activity), Variable color, Replace / Magic Replace, and Draw.
- **Informs:** tab icons are filled. Use Pulse for an uploading **SC** item and Replace (down-up) for a state change in **VJ**. Match the symbol weight to Saira's weight at each size.

### R15 · Buttons
- **Source:** https://developer.apple.com/design/human-interface-guidelines/buttons (change log: 2025-06-09, 2025-12-16 Liquid Glass).
- **Rules:**
  - Every custom button needs a press state.
  - Use a prominent style for the most likely action, and few of them.
  - Use **style, not size**, to mark the preferred choice.
  - Labels are verb-first.
  - Never give the primary role to a destructive action.
  - iOS sizes: Mini **28**, Small **32**, Regular **44**, Large **52**, Extra large **64** pt, capsule.
  - A trailing ellipsis means the button opens more input.
- **Informs:** the **VJ** detail pair "Versturen" (prominent) and "Aanpassen…" (bordered) are the same size. **DO** "Definitief verwijderen" is never prominent. **Tension:** Holodek's 2 px chip radius against system capsules. See §3.

### R16 · Notifications
- **Source:** https://developer.apple.com/design/human-interface-guidelines/notifications (change log: 2023-10-24).
- **Rules:**
  - Be concise. Never send several notifications for the same thing.
  - Do not tell people to do tasks in the app. Use actions instead.
  - Errors go in an alert, not a notification.
  - "**Avoid including sensitive, personal, or confidential information**."
  - Write body text for the hidden-previews case.
  - Titles are short. Use sentence case with punctuation.
  - Do not include the app name.
  - **Up to four action buttons** with short title-case labels.
  - Do not add an action that only opens the app.
  - Prefer nondestructive actions and give each an SF Symbol.
  - Use the badge **only** for the number of unread notifications. Keep it current. Setting it to zero clears Notification Center. Never mimic a badge.
- **Informs:**
  - **NO**: creditor names and amounts should not show on the lock screen preview. Use generic copy, e.g. "Nieuwe brief over je dossier", and reveal detail inside.
  - **NO**: the question category's Ja/Nee are fine; "Bekijken" as an action duplicates a tap.
  - **Badge tension:** see §3.

### R17 · Managing notifications (interruption levels)
- **Source:** https://developer.apple.com/design/human-interface-guidelines/managing-notifications

| Level | Overrides scheduled summary | Breaks Focus | Overrides silent switch |
|---|---|---|---|
| Passive | no | no | no |
| Active (default) | no | no | no |
| Time Sensitive | yes | yes | no |
| Critical | yes | yes | yes (entitlement) |

- **Rules:** Use Time Sensitive "only for notifications that are relevant in the moment … happening now or will happen within an hour". Represent urgency accurately. Provide in-app notification settings.
- **Informs:** **NO**. Today every Verder mail is time-sensitive (CLAUDE.md, Plan 2 slice 5), which over-claims by this rule. Suggested split:
  - Time Sensitive: a deadline today, or a deurwaarder at the door
  - Active: Verder mail and a new proposal
  - Passive: the weekly digest and `autofile.digest`
  - **ME** gets per-kind toggles.

### R18 · Live Activities
- **Source:** https://developer.apple.com/design/human-interface-guidelines/live-activities
- **Rules:**
  - Only for tasks with a "defined beginning and end", no more than **8 hours**. No sensitive information.
  - Presentations: compact, minimal, expanded, Lock Screen, StandBy.
  - Animations last at most **2 s**.
  - Lock Screen margin is **14 pt**. Text is medium weight or heavier.
  - Limited-width version fits a **28 pt circle**.
  - Dimensions in pt:

| Screen | Compact (each side) | Minimal | Expanded / Lock Screen |
|---|---|---|---|
| 393×852 | 52.33×36.67 | 36.67–45 × 36.67 | 371 × 84–160 |
| 430×932 | 62.33×36.67 | 36.67–45 × 36.67 | 408 × 84–160 |

  - 402×874 is not listed (**UNVERIFIED**; design at 393 and check 430).
  - Alert only on essential updates.
  - Offer an App Shortcut to start one.
  - The Dynamic Island background is always opaque black.
- **Informs:** good fits are the **SC** upload queue draining ("3 van 5 verstuurd") and a **VJ** proposal while sending. A poor fit is "things waiting on Martin", which has no end: that is a widget, not a Live Activity. Black Dynamic Island suits the void. Use cyan for the key line and never amber, unless it waits on Martin.

### R19 · Widgets (all families)
- **Source:** https://developer.apple.com/design/human-interface-guidelines/widgets (the large page; includes the new Apple HomeView / "paper vs glass" sections).
- **Appearances:** On the iPhone Home Screen there are light, dark, **clear** and **tinted** appearances. In clear and tinted the system desaturates the widget. The **Lock Screen is monochrome with no tint ("vibrant")**. StandBy at night uses a red tint.
- **Rendering modes:**
  - *fullColor*
  - *accented*: views are grouped into accent and primary with `widgetAccentable`, and both are tinted white on iPhone
  - *vibrant*: use opaque grayscale. White or light gray marks the most prominent content.
- **Rules:**
  - Margins are **16 pt** (tight: **11 pt**). Use `ContainerRelativeShape` for concentric corners.
  - Text is at least **11 pt**. Never rasterize text.
  - Update animations last at most **2 s**. Let the system render relative dates.
  - The placeholder uses semi-opaque shapes. The gallery description starts with a verb.
  - Deep-link to the exact place. An inline accessory has **one tap target**.
  - Lock Screen widgets carry information and are not launchers.
  - Support Always-On.
  - "**Avoid mirroring your widget's appearance within your app**."
  - "Let people know when authentication adds value."
- **iPhone dimensions (pt), nearest to the 16 Pro:**

| Screen | Small | Medium | Large | Circular | Rectangular | Inline |
|---|---|---|---|---|---|---|
| 393×852 | 158 | 338×158 | 338×354 | 72 | 160×72 | 234×26 |
| 430×932 | 170 | 364×170 | 364×382 | 76 | 172×76 | 257×26 |

  - 402×874 is not in the table (**UNVERIFIED**).
- **Informs:**
  - **WI** small: the amber count plus one line, e.g. "3 wachten op jou".
  - **WI** medium: the top two **VJ** items with deep links.
  - **WI** rectangular lock: count plus the oldest item's age, in grayscale.
  - **WI** circular: count in a ring.
  - **WI** inline: "verder · 3 voor jou".
  - Amber disappears in tinted, clear and lock appearances, so meaning must ride on **words and the number**.
  - **OV** must not be a copy of the widget.

### R20 · Controls (Control Center, Lock Screen, Action button)
- **Source:** https://developer.apple.com/design/human-interface-guidelines/controls
- **Rules:**
  - A control has a symbol, a title and an optional value. On the Lock Screen only the symbol shows.
  - Animate while an action runs.
  - Action-button hint text uses verbs.
  - "Hide sensitive information when the device is locked."
- **Informs:** a "Scan" control that launches **SC** and a "Snel vastleggen" control on the Action button for **VQ**. Neither needs a value, so nothing sensitive is shown.

### R21 · App Shortcuts and Siri
- **Source:** https://developer.apple.com/design/human-interface-guidelines/app-shortcuts (change log: **2026-06-08** app schemas).
- **Rules:**
  - Phrases are short and must include the app name.
  - One optional parameter at most.
  - Responses work on audio-only devices: put critical information in the spoken dialogue.
  - Responses can be a snippet or a Live Activity.
  - Make shortcuts discoverable with `SiriTipUIView`.
  - Prefer app schemas where a domain fits.
- **Informs:** **VQ**: "Leg vast in verder" opens dictation and confirms with a snippet. **WS**: "Wat wacht er in verder?" speaks the count.

### R22 · Activity views and share extensions
- **Source:** https://developer.apple.com/design/human-interface-guidelines/activity-views
- **Rules:**
  - Prefer the system composition view. Keep it to a few steps.
  - "Avoid placing a modal view above your extension."
  - "Use your main app to denote the progress of a lengthy operation."
  - The extension uses the app icon automatically.
- **Informs:** **SH** offers one screen (title, optional note) and "Versturen" trailing. The upload continues in the background and shows in the **SC** queue, not inside the extension.

### R23 · Charting data
- **Source:** https://developer.apple.com/design/human-interface-guidelines/charting-data
- **Rules:**
  - Prefer common chart types (bar, line). Keep it simple and reveal detail on demand.
  - A headline or summary text tells the takeaway.
  - Make every chart accessible.
  - Keep charts of the same data consistent.
- **Informs:** **MO** uses the same per-account bars as the web `/money` page. A one-line headline ("Juli: € 3.556,42 binnen") carries the takeaway, and the disclosures stay visible. Hatched or "geen data" states need text labels, not only pattern.

### R24 · Alerts and feedback
- **Sources:** https://developer.apple.com/design/human-interface-guidelines/alerts, https://developer.apple.com/design/human-interface-guidelines/feedback
- **Rules:**
  - Alerts are sparing and actionable. Never show one at app start.
  - No alerts for common undoable actions. Up to three buttons, with verb titles and no "OK" unless purely informational.
  - Warn only for unexpected, irreversible loss. Confirm significant completions. Integrate status near the item.
- **Informs:** **DO** purge is the one alert-worthy destructive action. **VJ** "Door verder gedaan" undo uses inline undo, not an alert. **OV** shows offline or sync status inline instead of an alert.

### R25 · Privacy: permission pre-prompts
- **Source:** https://developer.apple.com/design/human-interface-guidelines/privacy
- **Rules:**
  - Ask only when the feature is used.
  - Purpose strings are one active, specific sentence, e.g. "The app records during the night to detect snoring sounds", and never "…for a better experience".
  - A pre-alert screen has **only one button, which must clearly open the system alert**. The button must not be titled "Allow". There must be no cancel or close.
- **Informs:** **PP**:
  - Camera: before the first scan.
  - Microphone and speech: before the first **VQ**.
  - Notifications: after sign-in, explaining that Verder mail and questions arrive here.
  - Each gets one button, "Ga verder", plus Dutch purpose strings, e.g. "verder gebruikt de camera om brieven te scannen voor je dossier."

### R26 · Managing accounts: sign-in
- **Source:** https://developer.apple.com/design/human-interface-guidelines/managing-accounts
- **Rules:**
  - Name the method ("Sign In with Face ID", not "Sign In").
  - Refer only to available methods.
  - "Avoid offering an app-specific setting for opting in to biometric authentication."
  - Never say "passcode" for account authentication.
- **Informs:** **LK** buttons read "Inloggen met passkey" and "Inloggen met wachtwoord". The Face ID lock should not need its own on/off setting in **ME**, which slightly conflicts with an optional lock. Decide deliberately.

### R27 · Launching and onboarding
- **Sources:** https://developer.apple.com/design/human-interface-guidelines/launching, https://developer.apple.com/design/human-interface-guidelines/onboarding
- **Rules:**
  - "Launch instantly." The launch screen is nearly identical to the first screen, with **no text, no logo**. A solid colour is fine.
  - Restore the previous state.
  - Onboarding is optional, brief and interactive. Ask for permissions in context.
- **Informs:** **LK** and **OV**: the launch screen is plain `--color-void`, not the mark. Measured cold launch is about 205 ms, so there is no splash. Restore the last tab and scroll position.

### R28 · App icons
- **Source:** https://developer.apple.com/design/human-interface-guidelines/app-icons (change log: 2026-06-08 Liquid Glass refined, **2026-10-28** icon format options).
- **Rules:**
  - Use layered Icon Composer icons with default, dark, clear and tinted appearances, keeping core features the same across them.
  - Do not bake in glows, shadows, bevels or blur, because the system adds them.
  - Foreground layers need clear edges.
- **Informs:** the current icon from `make-app-icon.swift` should become a layered Icon Composer file. Drop any baked glow from the nav-rail mark.

### R29 · Design principles (2026)
- **Source:** https://developer.apple.com/design/human-interface-guidelines/design-principles (change log: 2026-06-08 reintroduced).
- **Useful lines:**
  - "Stay out of the way."
  - "**Help people recover from mistakes** … Build forgiveness into your design."
  - "Be fully transparent about what your product does and why."
  - "Don't mistake delight for decoration."
- **Informs:** **VJ** "Door verder gedaan" with one-tap undo, and **WS** stating plainly what verder did on its own. These are textbook applications.

### R30 · Designing for iOS
- **Source:** https://developer.apple.com/design/human-interface-guidelines/designing-for-ios
- **Rules:**
  - Limit onscreen controls.
  - Controls are easier to reach in the middle or bottom of the screen.
  - Swipe to go back and swipe actions in rows.
  - Adapt to Dynamic Type and Dark Mode.
- **Informs:** primary actions on **VJ** detail sit in the bottom half (bottom toolbar or safe-area inset button), not in the top-right only.

---

## 2. Per-screen checklist (derived from the references above)

| Screen | Checks |
|---|---|
| **OV** Overzicht | Large title "Overzicht". Panels are custom fills, not glass (R1). Counts survive AX5 (R9). Ambient motion off under Reduce Motion (R10, R12). Status inline, no launch alert (R24, R27). Not a copy of the widget (R19). Counts-only before unlock is consistent with R16 and R18's no-sensitive-data rule. |
| **VJ** list | Grouped list (R8). Amber plus a word or shape per waiting row (R2). Swipe actions with fill symbols (R8, R14). 44 pt rows (R10). One VoiceOver element per row (R11). |
| **VJ** detail | One trailing or bottom prominent "Versturen" (R5, R15, R30). Edit in a large sheet with Annuleren leading and confirm-on-swipe (R7). Success haptic on send (R13). Undo for verder's own actions (R29). |
| **SC** Scan + queue | Camera full-screen (R7). Pre-prompt with one button (R25). Queue progress in the tab bar's bottom accessory (R4) or a Live Activity while draining (R18). Pulse symbol while uploading (R14). Failure haptic and inline retry (R13, R24). |
| **DO** Dossier | Middle truncation of file titles (R8). Search as a trailing search tab or a toolbar search (R4). Purge is the one destructive alert, never a primary button (R15, R24). Offline state shown inline (R24). |
| **MO** Money glance | Bar chart plus a headline sentence (R23). VoiceOver description and audio graph (R11). Hatched and "geen data" labelled in text (R2). Selection haptic on month scrub (R13). |
| **ME** Meer | No appearance toggle (R3). No biometric opt-in toggle, or a deliberate exception (R26). Per-kind notification settings (R17). Titles under 15 characters (R5). |
| **VQ** Voice quick-log | Medium sheet with grabber (R7). Microphone pre-prompt (R25). App Shortcut and Action-button control (R20, R21). No haptics while recording (R13). Recording indicator in the tab accessory (R4). |
| **WS** Weekly summary | Passive notification (R17). Plain statement of what verder did (R29). Readable at AX sizes (R9). |
| **NO** notifications | No creditor or amount in the preview (R16). At most 4 actions, no open-only action (R16). Interruption levels per R17. Badge semantics: see §3. |
| **WI** widgets | All families. Meaning survives the vibrant and tinted appearances without amber (R19). 16 pt margins, text 11 pt or larger (R19). Deep links (R19). |
| **SH** share extension | One screen, no modal on top, progress in the app (R22). |
| **LK** sign-in/lock | Method-named buttons (R26). Plain-void launch screen (R27). Face ID copy only where available (R26). |
| **PP** pre-prompts | One button that opens the system alert, not titled "Allow", no close (R25). Active Dutch purpose strings (R25). |

---

## 3. Where Holodek or current verder behaviour conflicts with the HIG (decide, don't drift)

1. **App icon badge = "waiting count" (498 measured).** HIG R16 says "Use a badge only to show people how many unread notifications they have. Don't use a badge to convey numeric information that isn't related to notifications". It also says zeroing the badge "removes all related notifications from Notification Center". verder's badge counts open work, not unread notifications. Options:
   - accept the deviation knowingly (it is a private, unpublished app)
   - narrow the badge to items that arrived by push and are unopened
   
   Also, 498 in a badge is not glanceable.
2. **Red tab and badge vs the amber law.** The HIG describes the badge as red. UIKit allows a custom tab badge colour (`UITabBarItem.badgeColor`; from API knowledge, **UNVERIFIED** in the HIG text). The app-icon badge colour cannot be changed. So the icon badge will be red regardless.
3. **Time Sensitive for every Verder mail** over-claims by R17's "now or within an hour" rule. Martin may also get the system's first-time explainer for Time Sensitive.
4. **Glass panels in content.** R1 forbids Liquid Glass in the content layer. Holodek "glass" panels must be translated to custom translucent fills or standard materials on iOS.
5. **Contrast of small text tokens on `--color-void` (#04070d), computed:**

   | Token | Ratio | Verdict |
   |---|---|---|
   | ink-bright | 18.64 | passes 7:1 |
   | ink | 15.95 | passes 7:1 |
   | ink-mute | 8.24 | passes 7:1 |
   | ink-label | 5.09 | passes 4.5:1, below R3's 7:1 target |
   | ink-dim | 4.42 | **fails 4.5:1** for text 17 pt or smaller |
   | ink-faint | 3.29 | **fails** except at 18 pt or larger, or bold |
   | signal | 11.56 | passes 7:1 |
   | attn | 9.56 | passes 7:1 |
   | okay | 11.99 | passes 7:1 |
   | steel | 12.52 | passes 7:1 |

   On glass panels the background is lighter, so ratios drop further. `ink-dim` (dates, mono micro) and `ink-faint` need brighter iOS variants, and Increase Contrast variants.
6. **Corner radii.** Holodek uses 2–3 px. System sheets, glass controls, widgets (`ContainerRelativeShape`) and Live Activities ("concentric") are rounded and concentric. Square-cornered content inside rounded system containers will look misaligned. Choose: keep the sharp chips inside content only, and let all containers follow system concentricity.
7. **Infinite ambient animations** (breathe, spin-slow, drift, sweep, halo) conflict with R10 and R12 unless they are fully disabled under Reduce Motion. They are also not allowed in widgets or Live Activities (2 s maximum, no animation on Always-On).
8. **Custom fonts** (Saira, IBM Plex Mono) are allowed, but R9 and R19 put the burden of Dynamic Type and Bold Text on us. Widgets "prefer the system font", so consider SF in widgets and Live Activities, with Saira only for the number.
9. **Face ID lock setting** vs R26's "avoid an app-specific biometric opt-in setting".

## 4. Unverified items (summary)
- iPhone 16 Pro 402×874 pt is third-party only, and the widget and Live Activity tables in the HIG do not include this size.
- Caption 2 at Large = 11/13 pt (extraction truncated).
- `UITabBarItem.badgeColor` is not stated in the HIG text.
- iOS 27 rounder status-bar glyphs and layered icon details are press only.
- No HIG screenshots were viewed. All "descriptions" are the HIG's adjacent prose.
