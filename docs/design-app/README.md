# Grip voor iPhone — functies per scherm

Deze map beschrijft wat de iPhone-app van Grip **doet**: per scherm of oppervlak alle functies, toestanden, regels en randgevallen. Het gaat hier om de functies, niet om het visuele ontwerp. Elke map bevat een `FEATURES.md` en de definitieve ontwerpframes uit Figma (`frames/`, alleen synthetische gegevens).

Elke functie heeft een status:

- **Gebouwd**: bestaat en werkt in de code (het bestand wordt genoemd);
- **Deels gebouwd**: bestaat, maar er ontbreekt nog iets (dat staat erbij);
- **Nog te bouwen**: ontworpen en gespecificeerd, maar nog niet in de code (wat ervoor nodig is staat erbij).

Bovenaan elke `FEATURES.md` staat een korte **Stand van de bouw** met de aantallen en de drie belangrijkste punten die nog gebouwd moeten worden. Samen vormen die de werklijst voor de volgende bouwronde.

## Schermen

| Map | Scherm | Gebouwd | Deels | Nog te bouwen |
|---|---|---:|---:|---:|
| [01-inloggen-en-vergrendeling](01-inloggen-en-vergrendeling/FEATURES.md) | Inloggen, vergrendeling (Face ID) en toestemmingsvragen | 21 | 11 | 13 |
| [02-overzicht](02-overzicht/FEATURES.md) | Overzicht, het scherm waarop de app opent | 48 | 4 | 6 |
| [03-voor-jou](03-voor-jou/FEATURES.md) | Voor jou: alles wat op Martin wacht, en Door Grip gedaan | 25 | 8 | 22 |
| [04-voorstel](04-voorstel/FEATURES.md) | Voorstel (antwoord of herinnering) en de bewerker | 22 | 11 | 21 |
| [05-vraag-suggestie-taak](05-vraag-suggestie-taak/FEATURES.md) | Vraag, suggestie en taak | 26 | 19 | 19 |
| [06-scan-en-wachtrij](06-scan-en-wachtrij/FEATURES.md) | Scannen en de uploadwachtrij | 28 | 27 | 5 |
| [07-dossier](07-dossier/FEATURES.md) | Dossier (zakdossier) en de documentviewer | 24 | 11 | 16 |
| [08-tijdlijn](08-tijdlijn/FEATURES.md) | Tijdlijn: de zaak als kaart | 32 | 18 | 16 |
| [09-geld](09-geld/FEATURES.md) | Geld: leefgeld deze week en per rekening | 12 | 7 | 12 |
| [10-meer-en-instellingen](10-meer-en-instellingen/FEATURES.md) | Meer en de instellingen | 19 | 13 | 15 |
| [11-gesprek-vastleggen](11-gesprek-vastleggen/FEATURES.md) | Gesprek vastleggen (spraak) | 27 | 11 | 19 |
| [12-weekoverzicht](12-weekoverzicht/FEATURES.md) | Weekoverzicht op zondag | 17 | 13 | 8 |
| [13-meldingen](13-meldingen/FEATURES.md) | Meldingen en hun acties | 26 | 5 | 11 |
| [14-widgets](14-widgets/FEATURES.md) | Widgets: beginscherm, toegangsscherm en StandBy | 33 | 5 | 10 |
| [15-delen-naar-grip](15-delen-naar-grip/FEATURES.md) | Delen naar Grip (deelextensie) | 33 | 6 | 14 |
| **Totaal** | | **393** | **169** | **207** |

Stand op 3 november 2026, branch `feat/iphone-app`.

## Herkomst

- **Ontwerp:** Figma-bestand "verder iPhone" (zo heette het vóór de hernoeming naar Grip), pagina **Final** (https://www.figma.com/design/QDRL5zHNEOjPzLZqzd19Ii). Elk scherm is in zes iteraties ontworpen en door zes onafhankelijke beoordelaars getoetst; de pagina's Iteration 1 t/m 6 blijven bewaard.
- **Functies:** beschreven aan de hand van de code (`apps/ios`, `apps/web/src/app/api/mobile/v1`, `packages/api`, `apps/worker`), de spec `docs/superpowers/specs/2026-10-28-iphone-app-design.md`, de ontwerpbrief `docs/superpowers/specs/2026-11-01-iphone-design-brief.md` en plan 3. Daarna is elke beschrijving tegen de code gecontroleerd en gecorrigeerd.
- **Gegevens:** alle frames gebruiken de synthetische zaak uit `docs/superpowers/specs/2026-11-01-iphone-synthetic-data.md`. Er staan geen echte namen, bedragen of organisaties in.
