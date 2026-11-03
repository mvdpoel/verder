# verder iPhone — the synthetic dataset

One fictional case, used in THREE places that must agree: the Figma file
"verder iPhone", the DEBUG `-fixtures <name>` launch argument in the app
(`apps/ios/Verder/Fixtures/` reading the JSON in `apps/ios/Verder/FixtureData/`), and the simulator screenshots compared against
the Figma frames. Figma is an outside service, and simulator screenshots are
published as an artifact: NOTHING here may be a real name, amount,
organisation, IBAN, case number or letter. Every organisation below is
invented; every amount is round and invented; IBANs use the reserved test
range `NL00TEST…`.

## Cast (all fictional)

| Role | Name | Mail domain |
|---|---|---|
| Bewindvoerder (the "Verder" role) | Bewindkantoor Noordkust — contact "Ilse" | `@noordkust.example` |
| Its team for paperwork | Team Startdossier | `@noordkust.example` |
| Landlord | Woonstichting Lindehof | `@lindehof.example` |
| Debt collector | Incassobureau Kade & Partners | `@kade.example` |
| Claimant behind it | Stroomnet Energie | — |
| Municipality | Gemeente Westerlaan | `@westerlaan.example` |
| Health insurer | Zorgverzekeraar Duinzorg | — |
| Employer | Atelier Sterrenwacht | — |

The person the app is for is addressed as "je" and never named.

## Voor jou (fixture `voorjou-few`, 4 items, server order)

1. **proposal · verder-priority** — "Antwoord aan Bewindkantoor Noordkust: loonstrook oktober" · trigger: "Ilse vraagt om je loonstrook van oktober" · 2 nov (the inbox row's `at` is 1 nov 09:30, "vandaag" on the case's today) · draft body 4 lines, 1 attachment `Loonstrook.2026-10.pdf`.
2. **question** — "Hoort deze brief bij de vordering van Kade & Partners?" · options: "Ja, koppel hem" / "Nee" / "Weet ik niet" · 1 nov.
3. **suggestion (log-entry)** — "Telefoongesprek met Woonstichting Lindehof over de betalingsregeling" · 31 okt.
4. **task · open, due tomorrow** — "Formulier bijzondere bijstand ondertekenen" · due 3 nov.

`voorjou-many`: the same four plus 494 generated rows (titles cycle through
`Brief van <org> over <onderwerp> <n>`), count 498 — the live production
count on 2026-10-31, so the list's density is tested at the real scale.

`voorjou-long`: item 1's title becomes "Antwoord aan Bewindkantoor Noordkust over de aanvullende stukken voor de aanvraag bijzondere bijstand en de vraag om een kopie van de beschikking van de rechtbank" (long Dutch).

Door verder gedaan (3): "Opgeborgen als bankafschrift: Afschrift september" · "Hernoemd: Scan 2026-10-30 → Brief Gemeente Westerlaan 30 okt" · "Opgeborgen als brief: Herinnering Duinzorg".

## Overzicht

The inbox rows' `subtitle` is what `waiting.ts` serves: the party for a
proposal or question ("Bewindkantoor Noordkust", "Incassobureau Kade &
Partners"), the suggestion's kind label ("Logboekregel") — so the preview's
meta line reads `VOORSTEL · BEWINDKANTOOR NOORDKUST · VANDAAG`. The phone never
shortens a name it was served (the Figma frames' `NOORDKUST` / `LINDEHOF` are
not data the server has): when the line does not fit, kind and age stay
together on the first line and the party takes the second
(`VOORSTEL · VANDAAG ·` / `BEWINDKANTOOR NOORDKUST`), so the age is never left
alone on a line (decided 2026-11-03, `HomeSummary.previewMeta`).

Overzicht's own fixtures (added 2026-11-03, the Figma "overzicht · final" states):
- `calm` — nothing waits (count 0), no open tasks, 2 waiting on someone else; Door verder gedaan still 3; `lastClearedAt` 08:20 today → "JIJ WAS KLAAR · VANDAAG 08:20" (the frame's 11:20 is after the case clock's 09:41). The server does not serve `lastClearedAt` yet, so in production the line is absent.
- `one-item` — only item 1 waits; no open tasks, 2 waiting on someone else.
- `loading` — no request is ever answered: the skeleton.
- `server-error` — 503 on inbox, dashboard summary and money from the first request (no board to keep).
- `server-error-cached` — the base case once, then 503 for every request (`"thenFail": 503`): a board kept through a failure, retried every minute.
- `offline-cached` — the base case once, then no connection (`"thenFail": "offline"`); its leefgeld week is covered t/m za 31 okt (Supermarkt + Bakker + Apotheek = € 62,40 spent, zo: nog geen afschrift).
- Launch flags: `-fixtures-scans` seeds the phone's queue with today's "2 verstuurd · 1 in de wachtrij"; `-fixtures-scroll <waiting|leefgeld|rest|end>` opens Overzicht scrolled for the lower parts of a "hele pagina" frame.
- The case's clock in every fixture run is Sun 1 nov 2026 09:41 Amsterdam, running on from launch.

- Headline ("waar het nu op wacht"): stop "Stukken aanleveren bij Team Startdossier" on track "Opstart bewind", 28 okt, note "Loonstroken en polissen nog sturen."
- Tasks: 6 open · 1 te laat · 2 wacht op een ander.
- Scans today: "2 verstuurd · 1 in de wachtrij".

## Money (fixtures `money-complete`, `money-partial`, `money-geen-data`, `money-empty`, `money-no-account`, `money-unrecognised`, `money-no-budget`, `money-overspent`)

Two accounts, never summed:
- `NL00TEST0123456789` (beheerrekening) — months jun–nov, jun–sep complete, okt partial (hatched), nov `geen data`. Income line € 2.400,00/month from Atelier Sterrenwacht; out jun € 2.150,00 · jul € 2.300,00 · aug € 2.050,00 · sep € 2.200,00 · okt (t/m za 24 okt) € 1.210,35 — the Geld frames' figures; one incidental € 85,00 "teruggave". Its own newest booking is za 24 okt (`newestBooking` per account, 2026-11-03).
- `NL00TEST9876543210` (leefgeldrekening, `isLeefgeldAccount: true` wherever LEEFGELD_IBAN is set or the week recognised it) — weekly credit € 100,00 every Thursday; in/out jun € 400,00/€ 372,10 · jul € 500,00/€ 481,60 · aug € 400,00/€ 391,60 · sep € 400,00/€ 405,20 · okt € 500,00/€ 468,30; nov `geen data` (no rows yet — never a covered € 0,00). Its newest booking is the table's newest, capped at vr 30 okt where November has no rows.
- Leefgeld week (`money-complete`): week from Mon 26 okt, budget € 100,00, spent € 62,40 (rows: "Supermarkt" € 41,20, "Bakker" € 6,70, "Apotheek" € 14,50), received € 100,00, left € 37,60.
- `money-partial`: covered t/m do 29 okt.
- `money-geen-data`: newest booking 18 okt → "geen data — laatste afschrift t/m 18 okt".
- `money-empty`: a configured leefgeldrekening (LEEFGELD_IBAN set) over zero transactions → "geen data — nog geen afschriften".
- `money-no-account`: zero transactions AND LEEFGELD_IBAN unset — production's real state once P3-D3 sets the budget (2026-11-01: 0 transactions, no IBAN) → "Nog geen afschriften", never "niet herkend".
- `money-unrecognised`: the shared accounts, but both are weekly-income candidates and no IBAN is configured → "Leefgeldrekening niet herkend" with "2 rekeningen krijgen wekelijks geld binnen; verder kiest er niet zelf een."
- `money-no-budget`: LEEFGELD_WEEKLY_CENTS unset → the leefgeld card is hidden; the account cards and the Overzicht per-account lines stay.
- `money-overspent`: `money-complete`'s week plus "Fietsenmaker" € 50,00 on za 31 okt → spent € 112,40, "€ 12,40 meer uitgegeven dan het weekbedrag" (never amber). Its month bars are the shared ones and do not include that row.

## Dossier (fixture `dossier`)

12 documents: Beschikking Rechtbank Westerlaan (filed, letter) · Loonstrook 2026-09 / 2026-10 (payslip) · Polis Duinzorg 2026 (contract) · Huurcontract Lindehof (contract) · Sommatie Kade & Partners 14 okt (letter) · Afschrift september (bank-statement) · Brief Gemeente Westerlaan 30 okt (letter) · ID-kaart (id-document) · Jaaropgaaf 2025 · Bevestiging aanmelding Noordkust · Formulier bijzondere bijstand (inbox).
Open tasks under it: 6. Search "bijstand" finds 2.

## Weekly summary (fixture `weekly`)

Week 2026-W44: 3 verstuurd · 7 binnen · 5 opgeborgen (3 door jou, 2 door verder) · 2 taken klaar · 4 wachten op jou; top 3 = Voor jou items 1–3.

## Voice quick-log (fixture `voice`)

Transcript: "Gebeld met Woonstichting Lindehof. Ze gaan akkoord met de regeling van vijftig euro per maand, de eerste betaling is op één december." Party picker recent: Woonstichting Lindehof, Bewindkantoor Noordkust, Kade & Partners.

## A call (talking points, `_shared/parties/<id>/talking-points.json`, added 2026-11-03)

The synthetic call: Martin is about to ring **Bewindkantoor Noordkust** (`…600000000002`) on the case's today (Sun 1 nov, 09:41). Their last request was Team Startdossier's mail of 28 okt asking for the stukken (mail `…900000000001`). Both files are the REAL DTO, generated by `apps/web/src/lib/mobile-talking-points.fixture.test.ts` (`WRITE_FIXTURES=1` regenerates them) — never edit them by hand.

- **Vraag:** "Nog geen antwoord op je mail van 20 okt: Vraag over leefgeld november" (mail `…900000000002`, silent twelve days) · "Bespreek: Stukken aanleveren bij Team Startdossier" (the open stop `…500000000006` of the case map).
- **Vertel:** "Opgestuurd op 30 okt: Loonstrook 2026-10" (`…200000000104`) · "Opgestuurd op 30 okt: Loonstrook 2026-09" (`…200000000105`) · "Gemaild op 30 okt: Loonstroken september en oktober" (mail `…900000000003`, under 48 h old, so a tell and not a chase).
- **Samenvatting door AI** (`ready`, `brief-v1`, model "claude-cli 2.1.0 (Claude Code)", made 30 okt 11:05): "Team Startdossier vroeg op 28 okt om je loonstroken; die heb je op 30 okt gestuurd, een antwoord is er nog niet." — sources mails 1 and 3.

The second file is the no-AI state: **Incassobureau Kade & Partners** (`…600000000003`), brief still `pending`, so `summary` is null. Vraag: "Vraag naar: Reactie Kade & Partners op de sommatie" (task `…300000000016`, waiting) · "Vraag het gevorderde bedrag: Stroomnet Energie (KP-2026-0114)" (debt `…a00000000001`, amount unknown). Vertel: empty.

Mail ids use the `9…` prefix and debt ids the `a…` prefix; neither has a fixture screen of its own, so their points link to `verder://dossier`.

### The phone's call sheet (fixture `call`, `-route call:<partyId>`, added 2026-11-03)

The fixture `call` holds no files of its own: `-fixtures call -route call:00000000-f1c5-4000-8000-600000000002` opens "Gesprek voorbereiden" for Noordkust from the two shared files above (`-route call:…600000000003` for Kade & Partners). Two invented details, both in the generated DTO:

- **Noordkust's number: `06 0000 0002`.** Invented, and in the 06-0 block, which no Dutch mobile number is issued from, so "Bel" in a capture dials nobody. The sheet's button reads "Bel 06 0000 0002" and hands `tel:0600000002` to the Phone app.
- **Kade & Partners has no number** (`phone: null`): the sheet shows "Geen telefoonnummer bekend in verder." instead of "Bel", and still offers "Toon tijdens het gesprek".

During the synthetic call Martin ticks the first two Vertel points, so the Live Activity reads **"2 van 5 besproken"** with "Gemaild op 30 okt: Loonstroken september en oktober" as the next point (expanded Dynamic Island only; the lock screen shows the count alone). When the call ends, "Gesprek vastleggen" opens the voice log with:

```
Besproken:
- Opgestuurd op 30 okt: Loonstrook 2026-10
- Opgestuurd op 30 okt: Loonstrook 2026-09
```

and Bewindkantoor Noordkust preselected.

### A call recording (fixture `opname`, `-route opname`, added 2026-11-03)

The same synthetic call, recorded by the Phone app and shared from Notes as **"Gesprek met Noordkust.m4a"** (the bytes are `fixture-call-recording`, never audio). `-fixtures opname -route opname` opens "Opname uitschrijven" with it already written out, dated the case's today (Sun 1 nov, 09:41), as:

"Gebeld met Bewindkantoor Noordkust, Team Startdossier. De loonstroken van september en oktober zijn binnen. Ze laten weten of er nog iets ontbreekt; zo niet, dan gaat het dossier deze week naar de bewindvoerder."

No call sheet was active in the capture, so the party is the voice log's usual default (Woonstichting Lindehof, most recent contact) and no "Besproken:" prefill shows; the tests (`CallRecordingImportTests`) cover the prefilled case with Noordkust.

## Fields the fixtures needed beyond the above (added 2026-11-01, Task FX)

The JSON in `apps/ios/Verder/FixtureData/` holds everything above, plus these
invented details the screens' contracts require. `_shared/` is the base case;
each fixture folder holds only what differs, and a `fixture.json` describing it.

- **Ids** are synthetic UUIDs `00000000-f1c5-4000-8000-…`: the four Voor jou
  items end in `…0001` (reply), `…0002` (question), `…0003` (suggestion),
  `…0004` (task), so `-route proposal:00000000-f1c5-4000-8000-000000000001`
  opens item 1. Generated `voorjou-many` rows use `…-9000-<n>`.
- **Times**: the case's "today" is Sun 1 nov 2026; dates are whole Amsterdam
  days, dues at 17:00 Amsterdam (so "due 3 nov" reads 3-11, never 4-11).
- **Item 1** comes from "Ilse <ilse@noordkust.example>", subject "Loonstrook
  oktober"; the draft goes to `ilse@noordkust.example`, subject "Re: Loonstrook
  oktober". **Item 2** is triggered by the document "Sommatie Kade & Partners
  14 okt"; "Ja, koppel hem" links it to Stroomnet Energie's claim. **Item 3**
  proposes the summary above with details "Afgesproken: vijftig euro per maand,
  eerste betaling op 1 december."
- **Door verder gedaan**: the rename is NOT undoable ("naam staat ook op de
  NAS"); the two filings are.
- **Tasks (8)**: open — Formulier bijzondere bijstand ondertekenen (3 nov),
  Loonstroken en polissen sturen naar Team Startdossier (30 okt, the one te
  laat), Polis Duinzorg 2026 opzoeken (6 nov), Huurcontract Lindehof scannen,
  Jaaropgaaf 2025 aanvragen bij Atelier Sterrenwacht (10 nov), Betalingsregeling
  Lindehof bevestigen; waiting — Reactie Kade & Partners op de sommatie, Besluit
  bijzondere bijstand (Gemeente Westerlaan).
- **Money**: the incidental € 85,00 "teruggave" is from Zorgverzekeraar
  Duinzorg on 19 aug. Beheerrekening costs are invented round figures split
  over huur / zorg / energie / leefgeld / overig; the leefgeldrekening's
  income is € 100,00 × the Thursdays of each month. Leefgeld rows: Supermarkt
  di 27 okt, Bakker wo 28 okt, Apotheek vr 30 okt; deposit € 100,00 from
  Bewindkantoor Noordkust on do 29 okt (so `money-partial`, covered t/m do
  29 okt, has spent € 47,90 and € 52,10 left). The previous week (19–25 okt):
  Supermarkt € 52,30, Drogist € 14,20, Markt € 25,00, deposit € 100,00 on
  22 okt, € 8,50 left. The leefgeldrekening is `configured` (LEEFGELD_IBAN).
  `money-empty` answers `geen-data` with no newest booking for both weeks and
  no accounts (a configured IBAN over an empty table).
- **Dossier**: every document is a real one-page PDF of under 1 KB, written
  by `apps/ios/scripts/make-dossier-fixtures.swift` into
  `_shared/documents/<id>/file.pdf`; `sha256` and `sizeBytes` in `sync.json`
  are that file's own (the phone checks every download against its sha), and
  the script writes `sync.json` and `texts.json` in the same run. All but
  ID-kaart have text. The second "bijstand" hit is "Bevestiging aanmelding
  Noordkust", whose text mentions it. Sync cursor 412.
- **Voice**: the three recent parties are organisations; the POST answers a
  new suggestion with no kept recording.

## States every screen gets

loading (skeleton) · empty · one item · many (498) · long Dutch titles · error (server) · offline · unauthorized (sessie verlopen) · locked (Overzicht only: counts, no titles) · largest accessibility text size (AX5) · smallest iPhone (iPhone SE 3rd gen / 375×667 pt) · iPhone 17 Pro (402×874 pt) as the reference frame.

## Account (`me`, all fixtures)

Meer → Account reads `GET /api/mobile/v1/me`: `{"email": "jij@thuis.example", "name": null, "passkeys": 1}`. The person stays unnamed.

## Tijdlijn / de zaak (fixture `timeline`, added 2026-11-03)

The case map, as `tracks.map` / `buildTrackMap` serves it: newest at the TOP, month bands down the screen, the hoofdlijn as the leftmost lane, sporen as lanes to its right. A spoor either MERGES back (it was a prerequisite) or ENDS — and `ended` is a CLEAN outcome, never drawn or worded as a failure. All invented.

Hoofdlijn "Bewindvoering" (stops, newest first):
- nu · open — "Stukken aanleveren bij Team Startdossier" (headline: waar het nu op wacht)
- 30 okt · done — "Brief Gemeente Westerlaan over bijzondere bijstand" (trigger)
- 14 okt · done — "Sommatie Kade & Partners namens Stroomnet Energie" (trigger)
- 2 okt · done — "Rekening overgenomen door Bewindkantoor Noordkust" (trigger)
- 3 jun · done — "Beschikking: onder bewind gesteld"
- 12 mei · done — "Aanmelding bij Bewindkantoor Noordkust"

Sporen:
- "Aanvraag bewindvoering" · done · branches at Aanmelding, MERGES at Beschikking — stops: "Intake" (19 mei), "Verzoek naar de rechtbank" (26 mei)
- "Opstart en stukken" · open · branches at Beschikking — stops: "Team Startdossier vraagt stukken" (5 jun), "Loonstroken gestuurd" (20 jun), "Stukken aanleveren bij Team Startdossier" is the open stop on the hoofdlijn it feeds
- "Vordering Kade & Partners" · open · branches at the sommatie — stops: "Kade & Partners — verwerkt als vordering" (done, 15 okt), "Kade & Partners — melden bij Noordkust" (open, undated)
- "Huurachterstand Lindehof" · ended (clean) · stops: "Betalingsregeling afgesproken" (done, 8 sep), "Regeling loopt" (done, 1 okt)

Filter: "Schuldeisers verbergen" hides the Kade & Partners spoor AND its trigger on the hoofdlijn (structurally, via the spoor's branch pointer — never by title).
