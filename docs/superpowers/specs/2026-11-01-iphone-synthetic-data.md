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

- Headline ("waar het nu op wacht"): stop "Stukken aanleveren bij Team Startdossier" on track "Opstart en stukken" (the spoor that runs into it — the name the map uses), 28 okt, note "Loonstroken en polissen nog sturen."
- Tasks: 6 open · 1 te laat · 2 wacht op een ander.
- Scans today: "2 verstuurd · 1 in de wachtrij".

## Money (fixtures `money-complete`, `money-partial`, `money-geen-data`, `money-empty`, `money-no-account`, `money-unrecognised`, `money-no-budget`, `money-overspent`)

Two accounts, never summed:
- `NL00TEST0123456789` (beheerrekening) — months jun–nov, jun–sep complete, okt partial (hatched), nov `geen data`. Income line € 2.400,00/month from Atelier Sterrenwacht; out jun € 2.150,00 · jul € 2.300,00 · aug € 2.050,00 · sep € 2.200,00 · okt (t/m za 24 okt) € 1.210,35 — the Geld frames' figures; one incidental € 85,00 "teruggave"; and its 21 weekly € 100,00 transfers to the leefgeldrekening (every Thursday, 4 jun t/m 22 okt, € 2.100,00 in `internalRows`, added 2026-11-03 so "Wat niet in de balken zit" reads "2 posten" as the Geld frames do — money-geen-data stops them at 15 okt with its statement). Its own newest booking is za 24 okt (`newestBooking` per account, 2026-11-03).
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

Added 2026-11-03 for the "weekly · final" frames. The case's today for every
`weekly*` fixture is **Mon 2 nov 09:41** (manifest `today`), past the Sunday
18:00 that closed week 44, and their Voor jou's oldest item is from **31 okt**
(item 4 at 31 okt 09:00).

- `history` (earlier summaries; steps = verstuurd + door jou opgeborgen + taken klaar):
  W37 3 · W38 6 · W39 4 · W40 5 · W41 7 · W42 4 · W43 5 (average 5); W43 is
  1 verstuurd · 9 ontvangen · 4 opgeborgen (2/2) · 2 taken klaar · 6 wachtten.
  This week 8 steps. `renamedByVerder`: 1 ("1 scan een naam gegeven").
- `weekly-rustig`: 0 verstuurd · 2 ontvangen · 2 opgeborgen (0/2) · 1 taak klaar ·
  0 wachtten; nothing waits now, last dealt with vr 30 okt 16:10.
- `weekly-tweede`: only W43 before it (1 · 3 · 2 (2/0) · 1 · 3 = 4 steps);
  this week 2 · 5 · 3 (2/1) · 2 · 4 = 6 steps.
- `weekly-eerste`: 404 — the first summary comes zo 8 nov 18:00 (W45).
- `weekly-loading`: nothing answers (the skeleton, "WEEK 44").
- `weekly-offline-kept`: read at zo 1 nov 19:02, then offline.
- `weekly-offline-missing`: read at zo 1 nov 17:40 when the server still held W43, then offline.
- `weekly-fout`: `/weekly` 503; Voor jou read at 17:40, then 503.

## Voice quick-log (fixture `voice`)

Transcript: "Gebeld met Woonstichting Lindehof. Ze gaan akkoord met de regeling van vijftig euro per maand, de eerste betaling is op één december." Party picker recent: Woonstichting Lindehof, Bewindkantoor Noordkust, Kade & Partners (the parties route names the debt collector "Kade & Partners", as the picker frame draws it). The voice log's suggestion title drops the first sentence's closing full stop ("Gebeld met Woonstichting Lindehof").

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
- **Dossier** (dates, soorten and statuses follow the "dossier · final" frames, 2026-11-04): Brief Gemeente Westerlaan 30 okt (letter, filed, the frame's two-page letter), Formulier bijzondere bijstand 29 okt (other, inbox), Loonstrook 2026-10 28 okt, Sommatie Kade & Partners 14 okt, Afschrift september 2 okt, Loonstrook 2026-09 26 sep, Bevestiging aanmelding Noordkust 18 sep (letter), ID-kaart 12 sep (id-document, `source: "phone-scan"`, a drawn card with no text), Polis Duinzorg 2026 4 sep, Beschikking Rechtbank Westerlaan 14 aug (three pages), Jaaropgaaf 2025 (other), Huurcontract Lindehof (2025). Chips: Alles 12 · Brief 4 · Contract 2 · Loonstrook 2 · Overig 2 · Bankafschrift 1 · Id-bewijs 1. The `dossier` clock reads 14:02 (`keptAt`). Server search "bijstand" (`_shared/search.json`) answers the two documents plus a mail from "Ilse, Noordkust" (28 okt), the task "Formulier bijzondere bijstand ondertekenen" (open, 3 nov), "Besluit bijzondere bijstand" (waiting on Gemeente Westerlaan) and the log entry "Telefoongesprek met Gemeente Westerlaan" (phone, 27 okt); `from`, `assigneeName`, `channel` and the delta's `total`/`totalBytes` and `source` are not served yet. State fixtures: `dossier-offline`, `dossier-bijwerken` (nine held, then three new; the third never arrives; the later delta says `total: 12`, so the label counts 12 while it runs), `dossier-eerste-sync` (12 documents, 9,8 MB, 3 s per file, listed in the server's order rather than by date — the two newest, then Beschikking, Huurcontract and Loonstrook 2026-09 come in, 4,1 MB, and the sixth, Loonstrook 2026-10, never answers; the list keeps a skeleton in each place still on its way), `dossier-onderbroken` (the same order; the sixth has no network), `dossier-server-bezig` (search never answers), `dossier-server-leeg`, `dossier-niet-binnen` (Loonstrook 2026-10, 0,4 MB, answers 503) and `dossier-niet-binnen-offline`.
- **Dossier files**: every document is a real PDF of a few KB, written
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

Meer → Account reads `GET /api/mobile/v1/me`: `{"email": "jij@thuis.example", "name": null, "passkeys": 1, "sessionExpiresAt": "2026-12-01T09:00:00.000Z", "devices": 3}` ("sessie tot 1 dec", "3 ingelogd"; the two later fields added 2026-11-03 for the "meer · final" frames). The person stays unnamed.

## Meer (added 2026-11-03, the "meer · final" frames)

- Meldingen reads `GET /api/mobile/v1/push/preferences`: `{"muted": ["FILING"]}` in every fixture — "8 van 9 soorten aan", Opgeborgen off. A POST answers `{}`.
- `meer-no-passkey`: the account holds no toegangssleutel (`passkeys: 0`), so Account offers to add one.
- `meer-offline`: the base case fetched at 14:02 (`keptAt`), then no network from two seconds in (`offlineAfter`): every Meer screen keeps its stand and says "offline · bijgewerkt 14:02". No toegangssleutel, as the offline Account frame draws it.
- `meer-account-fails`: `/me` answers 503 from the start — "Account niet opgehaald. · verder was niet bereikbaar".
- `meer-save-fails`: Opgeborgen and Post van een schuldeiser muted; every save answers 503 ("Niet opgeslagen · verder niet bereikbaar.").

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
- "Aanvraag bewindvoering" · done · branches at Aanmelding, MERGES at Beschikking · note "Het was nodig om onder bewind te komen." — stops: "Intake" (19 mei), "Verzoek naar de rechtbank" (26 mei)
- "Opstart en stukken" · open · branches at Beschikking — stops: "Team Startdossier vraagt stukken" (5 jun), "Loonstroken gestuurd" (20 jun), "Stukken aanleveren bij Team Startdossier" is the open stop on the hoofdlijn it feeds
- "Vordering Kade & Partners" · open · branches at the sommatie — stops: "Kade & Partners — verwerkt als vordering" (done, 15 okt), "Kade & Partners — melden bij Noordkust" (open, undated)
- "Huurachterstand Lindehof" · ended (clean) · note "De huurachterstand is geregeld." · stops: "Betalingsregeling afgesproken" (done, 8 sep), "Regeling loopt" (done, 1 okt)

Filter: "Schuldeisers verbergen" hides the Kade & Partners spoor AND its trigger on the hoofdlijn (structurally, via the spoor's branch pointer — never by title).

Lanes (2026-11-03, the "tijdlijn · it6" frames): Aanvraag bewindvoering and Opstart en stukken on lane 1, Kade & Partners and Huurachterstand Lindehof on lane 2 (3 lanes), so Opstart en stukken — running, with no open stop — is drawn dashed up to NU. The NU stop's evidence: the task "Loonstroken en polissen sturen naar Team Startdossier" (due 30 okt), "Loonstrook 2026-10" and "Polis Duinzorg 2026"; "Verzoek naar de rechtbank" carries "Beschikking Rechtbank Westerlaan".
- `timeline-vier`: the same case with each spoor on its own lane (Opstart 1, Kade 2, Huurachterstand 3): the "vier sporen (maattest)" frame.
- `timeline-offline`: the case map gets no answer (`offlinePaths`); the phone kept it from 09:20 (`timelineCachedAt`). The dossier syncs, but Polis Duinzorg 2026 answers 503, so the NU sheet says it opens with a connection.
- `timeline-fout`: the case map answers 503 from the first request, at 14:05 (`today`): "De tijdlijn kon niet laden".

## Vraag, suggestie en taak (fixtures `detail`, `detail-offline`, `detail-fout`, `detail-na-vraag`, `detail-verlopen`, added 2026-11-04, the "detail · final" frames)
Today Mon 2 nov 14:02 (Amsterdam). Ids `00000000-f1c5-4000-8000-0000000000xx`, the data in `_shared` so all three folders see it; each folder has its own `inbox.json` (the voorjou-few four, with the question, the log-entry suggestion and the task swapped for these) and `tasks.json`.
- Questions `b1`…`b4`: "Hoort deze brief bij Stroomnet Energie?", trigger the Kade & Partners scan of zo 1 nov, verder's own `why` ("Op 1 nov kwam een brief van Kade & Partners binnen als scan. …"); options "Ja, koppel hem" (`link-document-to-debt`), "Nee" and "Weet ik niet" (`none`, "Brief blijft los"). `b1` pending; `b2` answered "Ja" at 14:02, `b3` in own words ("Alleen de eerste bladzijde hoort erbij; de tweede is van Duinzorg.") at 14:06, `b4` answered "Nee" — `answer` and `decidedAt` are fields `proposals.get` does not serve yet.
- Suggestions `c1` log entry from the voice note of za 31 okt (Telefoongesprek met Woonstichting Lindehof, vijftig euro per maand), `c2` document "Brief Gemeente Westerlaan 30 okt" (soort brief, van Gemeente Westerlaan, from the scan of vr 30 okt), `c3` Stroomnet Energie claiming € 420,00 (sommatie of 14 okt) collected by Incassobureau Kade & Partners, `c4` the same without a total and collected by Incassobureau Kade & Partners, `c5` task "Formulier bijzondere bijstand ondertekenen" due di 3 nov 17:00 from the Gemeente Westerlaan letter. `c1` names its party (`proposed.partyName` Woonstichting Lindehof, for the Gesprek card) and its kept recording (`origin.documentId`, for "Bekijk spraaknotitie"). `origin`, `origin.documentId`, `proposed.partyName`, `document.partyName` and `collectorName` are not served yet.
- Tasks `d1`…`d4`: "Formulier bijzondere bijstand ondertekenen" (due di 3 nov 17:00) open, bezig, wacht and gedaan, each linked to "Formulier bijzondere bijstand" (DOSSIER · TE SORTEREN) and "Bevestiging aanmelding Noordkust" (DOSSIER · BRIEF) — `links` is not served yet.
- `detail-offline`: the network goes 1 s after the first answers. `detail-fout`: POST `proposals/b1/answer`, `suggestions/c1/approve` and `tasks/d1/status` answer 503.
- `detail-na-vraag` (2026-11-04): the world AFTER the question was answered, which the frames that follow an answer count in — Voor jou holds the other three (the proposal, `c1`, `d1`; count 3), so "Volgende in Voor jou" reads · 3 on an answered question and · 2 on a task just done. `detail-verlopen`: POST `suggestions/c1/approve` answers 401 (the session expired with two edits on screen). No detail fixture carries "Door verder gedaan" rows: the detail frames draw Voor jou without that section.
- `b2`'s "Ja, koppel hem" names its `debtId` (`…300000000001`), which `proposals.get` does not serve yet; "Brief losmaken" opens that vordering on the website.

## Meldingen (fixtures `meldingen`, `meldingen-offline`, `meldingen-verlopen`, `meldingen-afgerond`, `meldingen-afgehandeld`, and the pushes in `apps/ios/scripts/pushes/`, added 2026-11-04, the "notifications · final" frames)

- The app side is the base case: the Kade & Partners question (`…000000000002`) and the bijstand task (`…000000000004`, "Formulier bijzondere bijstand ondertekenen") are the two things a notification action can reach. `meldingen` answers both actions; `meldingen-offline` has no network for `tasks/…04/status` and `proposals/…02/answer` ("Gedaan kwam niet door", "Keuze kwam niet door"); `meldingen-verlopen` answers the status POST 401 ("Opnieuw inloggen nodig"); `meldingen-afgerond` answers it 400 and lists the task as `done` ("Taak al afgerond"); `meldingen-afgehandeld` answers the question 409 ("Vraag al afgehandeld").
- The pushes are `simctl push` payloads with the frames' own words (Noordkust/Ilse, Gemeente Westerlaan sinds 21 okt, "De schuldeiser" sinds 16 okt, "Morgen: bijstand tekenen", "Klopt deze koppeling?" over de brief van 14 okt and the energy claim, "2 opgeborgen · 1 hernoemd", "Mislukt: hersteltest mail", "Je week in verder"). These are the FRAMES' wording, which the worker does not send yet (see 13-meldingen FEATURES, "De woorden"); the task-due push carries the real link `verder://task/<id>`.
- `question.apns` names the category `q.…02` itself: the simulator never runs the notification service extension for `simctl push`, so `-fixtures-notify-allow` registers that category through the same `QuestionCategories.merged` the extension runs, with the three options "Ja, koppel hem" / "Nee" / "Weet ik niet".
