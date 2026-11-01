# verder iPhone — the synthetic dataset

One fictional case, used in THREE places that must agree: the Figma file
"verder iPhone", the DEBUG `-fixtures <name>` launch argument in the app
(`apps/ios/Verder/Fixtures/`), and the simulator screenshots compared against
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

1. **proposal · verder-priority** — "Antwoord aan Bewindkantoor Noordkust: loonstrook oktober" · trigger: "Ilse vraagt om je loonstrook van oktober" · 2 nov · draft body 4 lines, 1 attachment `Loonstrook.2026-10.pdf`.
2. **question** — "Hoort deze brief bij de vordering van Kade & Partners?" · options: "Ja, koppel hem" / "Nee" / "Weet ik niet" · 1 nov.
3. **suggestion (log-entry)** — "Telefoongesprek met Woonstichting Lindehof over de betalingsregeling" · 31 okt.
4. **task · open, due tomorrow** — "Formulier bijzondere bijstand ondertekenen" · due 3 nov.

`voorjou-many`: the same four plus 494 generated rows (titles cycle through
`Brief van <org> over <onderwerp> <n>`), count 498 — the live production
count on 2026-10-31, so the list's density is tested at the real scale.

`voorjou-long`: item 1's title becomes "Antwoord aan Bewindkantoor Noordkust over de aanvullende stukken voor de aanvraag bijzondere bijstand en de vraag om een kopie van de beschikking van de rechtbank" (long Dutch).

Door verder gedaan (3): "Opgeborgen als bankafschrift: Afschrift september" · "Hernoemd: Scan 2026-10-30 → Brief Gemeente Westerlaan 30 okt" · "Opgeborgen als brief: Herinnering Duinzorg".

## Overzicht

- Headline ("waar het nu op wacht"): stop "Stukken aanleveren bij Team Startdossier" on track "Opstart bewind", 28 okt, note "Loonstroken en polissen nog sturen."
- Tasks: 6 open · 1 te laat · 2 wacht op een ander.
- Scans today: "2 verstuurd · 1 in de wachtrij".

## Money (fixtures `money-complete`, `money-partial`, `money-geen-data`)

Two accounts, never summed:
- `NL00TEST0123456789` (beheerrekening) — months jun–nov, jun–sep complete, okt partial (hatched), nov `geen data`. Income line € 2.400,00/month from Atelier Sterrenwacht; one incidental € 85,00 "teruggave".
- `NL00TEST9876543210` (leefgeldrekening) — weekly credit € 100,00 every Thursday.
- Leefgeld week (`money-complete`): week from Mon 26 okt, budget € 100,00, spent € 62,40 (rows: "Supermarkt" € 41,20, "Bakker" € 6,70, "Apotheek" € 14,50), received € 100,00, left € 37,60.
- `money-partial`: covered t/m do 29 okt.
- `money-geen-data`: newest booking 18 okt → "geen data — laatste afschrift t/m 18 okt".
- `money-empty`: zero transactions — production's real state on 2026-11-01.

## Dossier (fixture `dossier`)

12 documents: Beschikking Rechtbank Westerlaan (filed, letter) · Loonstrook 2026-09 / 2026-10 (payslip) · Polis Duinzorg 2026 (contract) · Huurcontract Lindehof (contract) · Sommatie Kade & Partners 14 okt (letter) · Afschrift september (bank-statement) · Brief Gemeente Westerlaan 30 okt (letter) · ID-kaart (id-document) · Jaaropgaaf 2025 · Bevestiging aanmelding Noordkust · Formulier bijzondere bijstand (inbox).
Open tasks under it: 6. Search "bijstand" finds 2.

## Weekly summary (fixture `weekly`)

Week 2026-W44: 3 verstuurd · 7 binnen · 5 opgeborgen (3 door jou, 2 door verder) · 2 taken klaar · 4 wachten op jou; top 3 = Voor jou items 1–3.

## Voice quick-log (fixture `voice`)

Transcript: "Gebeld met Woonstichting Lindehof. Ze gaan akkoord met de regeling van vijftig euro per maand, de eerste betaling is op één december." Party picker recent: Woonstichting Lindehof, Bewindkantoor Noordkust, Kade & Partners.

## States every screen gets

loading (skeleton) · empty · one item · many (498) · long Dutch titles · error (server) · offline · unauthorized (sessie verlopen) · locked (Overzicht only: counts, no titles) · largest accessibility text size (AX5) · smallest iPhone (iPhone SE 3rd gen / 375×667 pt) · iPhone 17 Pro (402×874 pt) as the reference frame.
