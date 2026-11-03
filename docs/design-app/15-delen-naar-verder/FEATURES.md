# Delen naar verder: de deelextensie

Dit document beschrijft wat de deelextensie van verder doet: wat ze accepteert, waar ze een gedeeld item in omzet, hoe het bestand in het dossier komt en wat elke toestand betekent. Het beschrijft de code op branch `feat/iphone-app` (`apps/ios`, target `VerderShare`, bundle `pro.vanderpoel.verder.share`). Het beschrijft niet het visuele ontwerp. De frames komen uit de Figma-sectie `share · final` (node 348:16604) en gebruiken de synthetische dataset (`docs/superpowers/specs/2026-11-01-iphone-synthetic-data.md`). Ze bevatten geen echte dossiergegevens.

> **De frames gaan verder dan de code.** Dit document beschrijft de VOLLEDIGE functieset van het scherm zoals ontworpen (definitieve frames, spec §7.8, design brief §2 en §3) en zegt per functie of de code die heeft. Elke functie heeft precies één statusregel: **Gebouwd** (bestaat in de code, bestand genoemd), **Deels gebouwd** (wat ontbreekt wordt genoemd) of **Nog te bouwen** (wat ervoor nodig is wordt genoemd). De ontworpen maar ontbrekende functies staan onder "Ontworpen, nog niet gebouwd". De status is bepaald door de code te lezen op 2026-11-03, inclusief de niet-gecommitte working tree op `feat/iphone-app`.

## Stand van de bouw

| Status | Functies |
|---|---|
| Gebouwd | 33 |
| Deels gebouwd | 6 |
| Nog te bouwen | 14 |

De drie belangrijkste dingen die nog gebouwd moeten worden:

1. **Een laadtimeout met "Opnieuw proberen"** (frame `Laden_fout`). Nu laat een deelbron die nooit antwoordt het blad eeuwig op "Even laden…" staan: de enige doodlopende weg op dit scherm, terwijl de brief uitgaat van 0 doodlopende wegen.
2. **Eerlijk zeggen waarom een gedeeld item het dossier nog niet bereikte**: de uitgelogde toestand, herkend vóór Versturen (frame `Niet ingelogd`, daarna `Bewaard`), en de reden op het scherm voor later bewaren (`offline · in wachtrij`, `groot bestand · in wachtrij`). Nu leveren offline, uitgelogd, boven 8 MB en de grens van 20 s allemaal dezelfde regel op.
3. **Gedeeltelijk meenemen in plaats van weigeren**: de eerste 10 van een grotere deling meenemen (frame `Meer_dan_10`) en de overige bestanden versturen als er één boven 48 MB zit (frame `Meerdere_bestanden_deels`), met één rij per bestand zodat Martin ziet wat meegaat en wat niet. Nu weigeren beide gevallen de hele deling.

---

## Doel

Met de deelextensie zet Martin een document in zijn dossier **vanuit elke andere app**, zonder eerst verder te openen. Typische gevallen zijn een pdf-bijlage in Mail, foto's van een brief in Foto's, of een bestand in Bestanden of WhatsApp. Ze is er alleen voor Martin.

Ze doet één ding: ze zet de gedeelde items in **dezelfde uploadwachtrij** die een telefoonscan gebruikt, met bron `phone-share` (spec §7.8, plan 3 Task 22). Op het web verschijnt het resultaat onder Files, bron **"Gedeeld"** (`apps/web/src/components/files-tree.tsx`), en in labels als "gedeeld" (`apps/web/src/lib/entry-labels.ts`).

De extensie beslist nooit iets over het document. Ze geeft het geen soort, archiveert het niet en koppelt het niet aan een schuld of logboekregel. Alles na de upload is de gewone serverpijplijn (zie "Wat er op de server gebeurt").

![Het systeemdeelblad, met verder tussen de apps](frames/Share_extension_Deelblad_systeem.jpg)

---

## Hoe je er komt, en waar het heen leidt

- **In:** het iOS-deelblad van elke app → **"verder"** (`CFBundleDisplayName` in `VerderShare/Info.plist`). Er is geen tab, deep link, widget, melding of snelle actie die de extensie opent. Ze bestaat alleen binnen het deelblad van een andere app.
  **Status:** Gebouwd (`apps/ios/VerderShare/Info.plist`, target `VerderShare` in `apps/ios/project.yml`).
- **Waardoor verder in het blad verschijnt:** de activatieregel in `project.yml`: `NSExtensionActivationSupportsFileWithMaxCount: 10` en `NSExtensionActivationSupportsImageWithMaxCount: 10`. iOS telt bestanden en afbeeldingen onder aparte sleutels, dus een gemengde deling kan meer dan 10 items aanleveren. Dat is niet gemeten (plan 3 Task 22). De regel heeft geen sleutel voor web-URL's, dus een deling van alleen een link zou verder helemaal niet moeten aanbieden.
  **Status:** Gebouwd (`apps/ios/project.yml`, `NSExtensionActivationRule`). De ontworpen linktoestand (hieronder) vraagt om een ruimere regel.
- **Het scherm:** één blad met de kop **"Naar verder"**, met "Annuleren" aan de beginkant en "Versturen" (later "Sluiten") aan de eindkant. Een pdf uit Mail staat er in **2 tikken na het deelblad** in (verder → Versturen), het doel uit §3 van de brief.
  **Status:** Gebouwd (`ShareView` in `apps/ios/VerderShare/ShareViewController.swift`).
- **Uit:** de extensie sluit zichzelf, of Martin sluit haar. Ze opent nooit de app. Het bestand gaat door naar het dossier, rechtstreeks vanuit de extensie of later vanuit de wachtrij van de app; zie "Versturen, van begin tot eind".
  **Status:** Gebouwd (`ShareViewController.finish`).

---

## Wat ze accepteert en wat ze ervan maakt

`ShareViewController.load` leest elke `NSItemProvider`, en `SharePreparation.prepare` maakt van het resultaat de bestanden die verstuurd worden.

- **Foto's (elke afbeelding die geen pdf is) worden ÉÉN pdf.** Elke afbeelding in één deling wordt een pagina van één pdf, in de volgorde waarin iOS ze aanleverde. De pdf wordt gebouwd met dezelfde `PDFAssembler` als een scan: lange zijde hoogstens 2200 px, grijswaarden als een pagina geen kleur heeft. Er is **geen `PageCleaner`-stap**, omdat een gedeelde foto niet per se een pagina is. Twee foto's van een brief van twee pagina's worden één brief.
  **Status:** Gebouwd (`SharePreparation.prepare` in `apps/ios/Verder/Upload/SharePreparation.swift`; `PDFAssemblerTests.swift`). Nog niet op de telefoon geprobeerd (plan 3 Task 22 Step 3).
  - De pdf heet **`Foto's <yyyy-MM-dd HH.mm>.pdf`** volgens de Amsterdamse klok (`SharePreparation.photosTitle`). Auto-name hernoemt hem zodra de tekst gelezen is.
    **Status:** Deels gebouwd — de code noemt hem `Foto's 2026-11-01 14.05.pdf`; de frames noemen hem `Gedeeld 1 nov 14.02.pdf` (Nederlandse dag en korte maand, het woord "Gedeeld", gelijk aan de bron). Vraagt om een nieuwe `photosTitle` met test.
  - Elke foto wordt op schijf klaargezet en **al verkleind** gedecodeerd (`PhotoPage.page(at:)`, ImageIO-thumbnail met de EXIF-oriëntatie toegepast). Een decodering op volle grootte van een foto van 24 MP kost ongeveer 96 MB, en een extensie wordt bij ongeveer 120 MB beëindigd. Een zijwaarts opgeslagen foto komt rechtop uit (getest).
    **Status:** Gebouwd (`PhotoPage` in `SharePreparation.swift`; `PhotoPageTests.swift`). Het piekgeheugen op de telefoon is niet gemeten.
  - Een afbeelding die geen JPEG/HEIC is en groter dan 16 MP (`PhotoPage.maxFullDecodePixels`) kan niet goedkoop verkleind worden. Die gaat mee als het **bestand** dat het is, met eigen naam en mime, en wordt geen pagina.
    **Status:** Gebouwd (`PhotoPage.maxFullDecodePixels`).
  - Een afbeelding die de pdf niet kan coderen, telt als niet meegenomen (zie de waarschuwing voor gedeeltelijk meenemen hieronder).
    **Status:** Gebouwd (`SharePreparation.prepare`, `leftOut`).
- **Pdf's en alle andere bestanden gaan byte voor byte door**, met hun eigen naam en mediatype. Een naam zonder extensie krijgt de extensie van het type. Een bestand zonder naam heet "Gedeeld bestand". De server bewaart het type dat hij krijgt.
  **Status:** Gebouwd (`ShareViewController.load`, `fileName(_:type:)`).
- **Een bron die alleen een bestands-URL aanbiedt** (sommige apps doen dat) wordt via die URL gelezen, met security-scoped toegang.
  **Status:** Gebouwd (`ShareViewController.loadFileURL`).
- **Bestanden worden gemeten voordat ze gelezen worden**, en daarna gekopieerd naar een privé klaarzetmap (`ShareStaging.stage`). Ze worden nooit in het geheugen gelezen. Eén uitzondering: een foto waarvan de bron geen bestandsvorm aanbiedt, wordt als data overgenomen en staat dus één keer in het geheugen; die wordt boven 48 MB geweigerd en meteen naar de klaarzetmap geschreven. De klaarzetmap wordt verwijderd als de extensie sluit (annuleren of sluiten). Als de klaarzetmap niet aangemaakt kan worden, telt elk item als onleesbaar.
  **Status:** Gebouwd (`ShareStaging` in `SharePreparation.swift`; tests voor klaargezette bestanden in `IncomingDropTests.swift`).

Grenzen (`ShareModel`):

| Grens | Waarde | Wat er daarboven gebeurt |
|---|---|---|
| Items per deling | 10 (`maxItems`) | De hele deling wordt geweigerd voordat er iets geladen is: "Dat zijn er 12. verder neemt er maximaal 10 tegelijk mee; deel ze in delen." |
| Bytes per bestand | 48 MB (`maxFileBytes`, onder de 50 MB `MAX_UPLOAD_BYTES` van de server) | De hele deling wordt geweigerd: "Dit is te groot voor verder (max. 48 MB per bestand)." Het bestand wordt niet gekopieerd. |
| Eigen upload van de extensie | 8 MB per bestand (`ShareSender.foregroundLimit`) | Niet geprobeerd vanuit de extensie. De wachtrij van de app verstuurt het. |
| Eigen poging van de extensie | 20 s in totaal (`sendBound`), 30 s per verzoek | De poging wordt afgebroken en de wachtrij van de app verstuurt het. |

**Status:** Gebouwd (`ShareModel.maxItems`, `maxFileBytes`, `sendBound`; `ShareSender.foregroundLimit`, `timeout`). Het ontwerp vervangt de eerste twee weigeringen door gedeeltelijk meenemen; zie "Ontworpen, nog niet gebouwd".

![Eén pdf uit Mail, klaar om te versturen (ontwerp)](frames/Share_extension_E_n_PDF.jpg)

### Wat het scherm over een deling zegt

- **Titel:** de bestandsnaam bij één bestand (hoogstens twee regels, in het midden ingekort), anders "N bestanden" (`ShareModel.title`). De foto-pdf telt als één bestand.
  **Status:** Gebouwd (`ShareModel.title`).
- **Detail** (`ShareModel.detail`): één pdf leest "PDF · 312 kB" (de extensie van het bestand in hoofdletters, of "Bestand" als er geen is; er is **geen paginatelling**). Eén foto leest "1 foto als PDF · …", meerdere "3 foto's als één PDF · 1,8 MB". Foto's plus bestanden lezen bijvoorbeeld "2 foto's als één PDF · 1 bestand · 1,4 MB". Meerdere bestanden zonder foto's tonen alleen de totale grootte.
  **Status:** Gebouwd (`ShareModel.detail`). De paginatelling en de rijen per bestand die de frames toevoegen, zijn aparte functies hieronder.
- **Thumbnail:** de eerste pagina van het eerste voorbereide bestand als dat een pdf is, anders een documentsymbool.
  **Status:** Gebouwd (`Thumbnail` in `ShareViewController.swift`).
- **Elk bestand wordt een eigen document.** Alleen afbeeldingen worden samengevoegd; pdf's en andere bestanden worden nooit samengevoegd.
  **Status:** Gebouwd (één drop per bestand in `ShareModel.commit`; `ShareModelTests.swift`).

![Foto's worden één pdf (ontwerp)](frames/Share_extension_Foto_s_n_PDF.jpg)

![Drie bestanden (ontwerp)](frames/Share_extension_Meerdere_bestanden.jpg)

---

## Versturen, van begin tot eind

Een tik op **"Versturen"** (`ShareModel.commit`) doet drie dingen, in deze volgorde.

1. **Ze schrijft een drop per bestand** in de App Group, in `<group>/uploads/incoming/` (`IncomingDrop.write`). Eerst de bytes (`<uuid>.bin`), als laatste de beschrijving (`<uuid>.json`), zodat de app nooit een halve drop ziet. Vanaf dat moment is de deling veilig: de app **gaat** hem versturen, wat er daarna ook gebeurt. Mislukt een schrijfactie, dan worden de al geschreven drops weer verwijderd en zegt het scherm "Dit kon niet worden bewaard. Probeer het opnieuw." Niets van die deling bereikt het dossier. Ontbreekt de App Group zelf (een verkeerd geconfigureerde build), dan weigert deze stap met "verder kan hier niet bij zijn eigen map. Open de app en probeer het opnieuw."
   **Status:** Gebouwd (`IncomingDrop.write` in `apps/ios/Verder/Upload/IncomingDrop.swift`, `ShareModel.commit`).
2. **Ze doet één begrensde eigen uploadpoging** (`ShareSender.send`) voor elke drop tot 8 MB, de een na de ander. Ze gebruikt de sessiecookie van de app uit het gedeelde Keychain-item (`keychain-access-groups`). Het verzoek is hetzelfde dat de wachtrij bouwt (`UploadRequest.build`): `POST /api/mobile/v1/documents`, multipart met `clientId` = de UUID van de drop, `source` = `phone-share`, `capturedAt`, en het bestand met eigen naam en mime. Alleen een 2xx met de JSON van het endpoint schrijft `<uuid>.sent`. Al het andere (offline, geen sessie, een trage 4G-verbinding, de grens van 20 s) laat de drop over aan de app.
   **Status:** Gebouwd (`apps/ios/Verder/Upload/ShareSender.swift`). Of een bestand van 5 MB op 4G binnen de grens klaar is, is niet gemeten.
3. **Ze meldt de uitkomst.** Heeft de server elk bestand binnen de grens bevestigd, dan toont ze "Staat in je dossier." Anders toont ze "Bewaard. Het gaat mee zodra je verder opent." De knop aan de eindkant wordt "Sluiten". Zonder waarschuwing op het scherm sluit de extensie zichzelf na 1,2 s. Met een waarschuwing blijft ze open tot Martin op "Sluiten" tikt.
   **Status:** Gebouwd (`ShareModel.message`, `closesByItself`; `ShareViewController.send`). Het ontworpen eindscherm is rijker; zie "Ontworpen, nog niet gebouwd".

**`capturedAt` is het moment van Versturen**, niet de eigen datum van het bestand. Het wordt de `receivedAt` van het document, dus een pdf van vorig jaar die vandaag gedeeld wordt, staat in het dossier op vandaag.
**Status:** Gebouwd (`ShareModel.commit` geeft `now()` door).

**De helft van de app** (`UploadQueue.importIncoming`, vanuit `UploadCenter.start()`): elke keer dat de app start of naar voren komt **terwijl er iemand ingelogd is** (`RootView`), importeert ze elke complete drop als wachtrij-item waarvan de id de UUID van de drop **is**, oudste `capturedAt` eerst. Een drop met een `.sent`-markering wordt meteen als verstuurd vastgelegd en niet opnieuw geüpload. De rest gaat door de gewone wachtrij: achtergrond-`URLSession`, backoff 30 s / 2 min / 10 min / 1 u, `failed` bij de vijfde mislukking, een 401 (of welke redirect ook) houdt al het versturen tegen tot er ingelogd is. Het scandocument beschrijft dit volledig (`../06-scan-en-wachtrij/FEATURES.md`). Importeren is idempotent. Opruimen verwijdert eerst de `.json`. Een `.bin` of `.sent` zonder `.json`, een `.json` zonder `.bin` en een onleesbare `.json` worden opgeruimd zodra ze ouder zijn dan 24 u.
**Status:** Gebouwd (`apps/ios/Verder/Upload/IncomingImport.swift`, aangeroepen vanuit `UploadCenter.start()`; `IncomingDropTests.swift`).

**Een dubbel document is onmogelijk.** De poging van de extensie en die van de app dragen dezelfde `clientId`, en de server beantwoordt de tweede met `duplicate: true`. Dat dekt ook de race waarin de upload van de extensie binnenkomt nadat de app de drop al geïmporteerd heeft.
**Status:** Gebouwd (clientId = drop-UUID in `IncomingImport.swift`; `bySourceRef` in de route; `route.test.ts`).

**De extensie schrijft nooit `queue.json`.** `UploadQueue` laadt dat bestand één keer en houdt het in het geheugen, dus twee processen die erin schrijven zouden de items van één kant kwijtraken.
**Status:** Gebouwd (de extensie schrijft alleen `IncomingDrop`s).

**De voortgang loopt door in de wachtrij van de app** (brief §3, R22). Na import verschijnt een gedeeld bestand in de wachtrij van de Scan-tab onder zijn eigen bestandsnaam (een scan leest "Scan 14:32 · 2 pagina's"), met dezelfde rijen voor wachtend, mislukt en verstuurd als een scan. De extensie zelf toont na het sluiten geen voortgang.
**Status:** Gebouwd (`ScanScreen.title` in `apps/ios/Verder/Scan/ScanScreen.swift`, niet-gecommitte working tree). De scan-specifieke delen van die wachtrij (het duplexvenster, de notitiechip, de regels "Je scan staat veilig op dit toestel") filteren op `phone-scan` en spreken niet over gedeelde items.

### Wat er op de server gebeurt

`apps/web/src/app/api/mobile/v1/documents/route.ts`, dezelfde route als een telefoonscan:

1. De sessie wordt gecontroleerd voordat er één byte gelezen is (JSON `401 {"error":"unauthorized"}` zonder sessie).
2. Groottebewaking (`readGuardedFile`): geen `Content-Length` geeft 411, een body of bestandsdeel boven 50 MB geeft 413, geen `file`-deel geeft 400.
3. Validatie: `clientId` een UUID v4, `source` `phone-scan` of `phone-share`, en `capturedAt` ISO 8601. Al het andere geeft 400.
4. Idempotentie op `source` + `sourceRef = "phone:<clientId>"` (`documents.bySourceRef`), opgezocht **voordat** er iets bewaard wordt. Een treffer geeft `{id, duplicate: true}`.
5. `storeFile` schrijft de bytes in de kluis onder hun sha256. `documents.registerUpload` → `ingestDocument` voegt de `documents`-rij toe (titel = de naam van het gedeelde bestand, mime = het mediatype van het deel of `application/octet-stream`, `receivedAt` = `capturedAt`) en voegt in dezelfde transactie **één `document.ingested`-ledgerevent** toe. Staan identieke bytes al in de kluis (dezelfde pdf kwam eerder per mail binnen), dan wordt dat document teruggegeven met `duplicate: true` en wordt er **geen** rij of event geschreven.

**Status:** Gebouwd (`apps/web/src/app/api/mobile/v1/documents/route.ts`, `packages/api/src/routers/documents.ts`; `route.test.ts`). Op het web staat het resultaat onder bron "Gedeeld" (`apps/web/src/components/files-tree.tsx`, `apps/web/src/lib/entry-labels.ts`; enumwaarde in `packages/db/src/doc-sources.ts`).

Daarna neemt de gewone pijplijn het over. Niets daarvan is specifiek voor delen:

- `docmeta.sweep` (elke minuut, in porties van 5) vindt het document omdat het nog geen tekst heeft en zet `suggest.docmeta` in de rij. Die taak doet, in volgorde: de tekst uitlezen en bewaren (`pdf-parse`, OCR of `sheet`), auto-name uitvoeren, de documentmeta-suggestie schrijven en de briefcontrole uitvoeren.
- Auto-name kan het hernoemen. Die hernoeming is verders eigen wijziging (`actor = 'verder'`, één `document.updated`-event), vermeld onder "Door verder gedaan".
- Een documentmeta-**suggestie** (soort, naam) verschijnt in Voor jou. Het is alleen een suggestie. Automatisch archiveren zou verder het zelf laten archiveren, maar dat **staat bij levering uit** (`DOCMETA_AUTO_APPLY` niet gezet; zie CLAUDE.md, eval baselines).
- **Status:** Gebouwd (`apps/worker/src/docmeta-sweep.ts`, `suggest.docmeta` in `apps/worker/src/index.ts`, `apps/worker/src/auto-name.ts`). Niets daarin is specifiek voor delen.
- `phone-share` is een van de **briefbronnen** (`LETTER_SOURCES` in `apps/worker/src/proposals/letters.ts`). Een gedeeld document waarvan de tekst eruitziet als een brief van Verder, krijgt een tijdgevoelige push "Brief lijkt van Verder" en een voorstel. Een document van een schuldeiser, alleen herkend aan het e-mailadres, krijgt een actieve push "Brief lijkt van <naam>" en een voorstel. De afzender is een gok op basis van de tekst en wordt op het voorstel bewaard, nooit op het document. De controle schrijft geen ledgerevent. Er wordt niets verstuurd zonder dat Martin de definitieve tekst goedkeurt.
  **Status:** Gebouwd (`LETTER_SOURCES` in `apps/worker/src/proposals/letters.ts` bevat `phone-share`).

![Verstuurd: de server heeft het bevestigd (ontwerp)](frames/Share_extension_Verstuurd.jpg)

![Bewaard voor later, offline (ontwerp)](frames/Share_extension_Bewaard_offline.jpg)

---

## Toestanden

| Toestand | Wat het scherm toont | Wat Martin kan doen |
|---|---|---|
| Laden | "Even laden…", "Versturen" uitgeschakeld | "Annuleren" |
| Klaar | Thumbnail, titel, detail; "Versturen" actief | "Versturen" of "Annuleren" |
| Deel van de deling onleesbaar | Het klaar-paneel plus "1 van 3 kon niet worden meegenomen." ("2 van 12 konden …" bij meer) | De rest versturen, of annuleren |
| Versturen | "Wordt verstuurd…"; "Annuleren" is **weg**, "Versturen" uitgeschakeld | Wachten (hoogstens ongeveer 20 s) |
| Afgeleverd | "Staat in je dossier.", "Sluiten" | Sluit zichzelf na 1,2 s; met een waarschuwing tikt Martin op "Sluiten" |
| Bewaard, nog niet afgeleverd (offline, geen sessie, > 8 MB, traag) | "Bewaard. Het gaat mee zodra je verder opent.", "Sluiten" | Hetzelfde als afgeleverd; verder later openen |
| Meer dan 10 items | "Dat zijn er N. verder neemt er maximaal 10 tegelijk mee; deel ze in delen." | "Annuleren", in kleinere groepen delen |
| Een bestand boven 48 MB | "Dit is te groot voor verder (max. 48 MB per bestand)." De hele deling wordt geweigerd, ook als de andere items in orde zijn | "Annuleren" |
| Niets kon gelezen worden | "verder kon hier niets uit lezen. Er is niets verstuurd." | "Annuleren" |
| Er is niets aangeleverd | "Hier zit niets in dat verder kan bewaren." | "Annuleren" |
| Schrijven van de drop mislukt | "Dit kon niet worden bewaard. Probeer het opnieuw." Al geschreven drops worden verwijderd | "Annuleren", opnieuw delen |
| App Group ontbreekt (verkeerd geconfigureerde build) | Pas na "Versturen": "verder kan hier niet bij zijn eigen map. Open de app en probeer het opnieuw." | "Annuleren" |
| Niet ingelogd / sessie verlopen | **Geen eigen toestand.** De poging krijgt een 401, en het scherm leest "Bewaard. Het gaat mee zodra je verder opent." De drop wacht tot er in de app weer ingelogd is | verder openen en inloggen |
| App vergrendeld (Face ID) | Niet van toepassing: de extensie heeft geen appvergrendeling (zie Privacy) | — |
| Grote tekst | Alle tekst gebruikt Dynamic Type (`relativeTo:`). De weergave heeft **geen scrollview**, dus bij de grootste maten kunnen de onderste regels van het blad af geduwd worden | — |
| Kleine telefoon (SE) | Dezelfde ene lay-out | — |

**Status van de tabel:** elke rij hierboven is Gebouwd (`ShareModel.Phase`, `ShareModel.Copy`; `ShareModelTests.swift`), behalve "Grote tekst", die Deels gebouwd is (Dynamic Type wel, scrollen niet; zie hieronder). De frames veranderen een aantal van deze rijen; die wijzigingen staan onder "Ontworpen, nog niet gebouwd".

In elke weigertoestand blijft "Versturen" zichtbaar maar uitgeschakeld.

Waarom "Annuleren" verdwijnt: vanaf "Versturen" is elke drop geschreven en gaat de app hem versturen, en elke drop wordt een blijvend `document.ingested`. Annuleren zou op dat punt niets annuleren, dus de knop wordt alleen getoond zolang hij waar is (`ShareModel.canCancel`).
**Status:** Gebouwd (`ShareModel.canCancel`; getest in `ShareModelTests.swift`).

Waarom een gedeeltelijke deling niet vanzelf sluit: een waarschuwing moet gelezen worden, dus "1 van 3 kon niet worden meegenomen." blijft vóór en na "Versturen" op het scherm (`closesByItself`). De waarschuwing voor gedeeltelijk meenemen dekt alleen items die niet gelezen konden worden en afbeeldingen die de pdf niet kon coderen. **Eén bestand boven 48 MB laat de hele deling weigeren**, en meer dan 10 items worden geweigerd in plaats van ingekort.
**Status:** Gebouwd (`ShareModel.warning`, `closesByItself`).

![Te groot (ontwerp)](frames/Share_extension_Te_groot.jpg)

---

## Privacy en beveiliging

- **Geen Face ID in de extensie.** De appvergrendeling geldt niet voor een extensie. Er wordt niets uit het dossier getoond: het scherm tekent alleen wat Martin op dat moment deelt. Het leest de inbox, het dossier, het geld en de widget-snapshot niet.
- **De sessie** is de better-auth-cookie van de app, gelezen uit het gedeelde Keychain-item (`AfterFirstUnlockThisDeviceOnly`). De extensie heeft `VerderKeychainAccessGroup` nodig in **haar eigen** Info.plist, omdat `KeychainSessionStore` `Bundle.main` leest. Ze schrijft de sessie nooit. Redirects worden nooit gevolgd (zie het scandocument), dus een 307 naar /login kan nooit als afgeleverd tellen.
- **Op de telefoon:** klaargezette kopieën staan in de eigen tijdelijke map van de extensie en worden verwijderd als ze sluit. Drops en `.sent`-markeringen staan in de App Group (`group.pro.vanderpoel.verder`, `uploads/incoming/`), geschreven met `.completeFileProtectionUntilFirstUserAuthentication`. Ze zijn versleuteld tot de eerste ontgrendeling na een herstart, waardoor de wachtrij kan versturen terwijl de telefoon vergrendeld is. Na import worden ze gewone wachtrij-items, en de wachtrij verwijdert een bestand zodra de server het bevestigt.
- **Wat de telefoon verstuurt:** het mediatype van een deel dat geen eenvoudig `type/subtype` is, gaat uit als `application/octet-stream` (`Multipart`). Een bestandsextensie wordt nooit als pad vertrouwd (`UploadItem.safeExtension`: 1–10 kleine letters/cijfers, nooit `body`, `json`, `sent` of `partial`; al het andere wordt bewaard als `bin`).
- **Niets op het vergrendelscherm of in widgets** komt van de extensie.
- **Bij uitloggen:** `forgetLocally` wist de sessie en de widget-snapshot en beëindigt de sessie-epoch, maar **niet `uploads/`**. Drops en gedeelde items in de wachtrij blijven op de telefoon en gaan mee met de volgende sessie. Dat is bewust (een gedeeld item mag nooit verdwijnen), maar geen test legt het vast.
- **Aan de serverkant:** als bij een scan. De sessie wordt gecontroleerd voordat er een byte gelezen is, de grootte wordt bewaakt en de velden worden gevalideerd.

**Status:** Gebouwd (`KeychainSessionStore` met `VerderKeychainAccessGroup` in `VerderShare/Info.plist`; bestandsbescherming in `IncomingDrop.swift`; `UploadItem.safeExtension`; `Multipart.swift`). Het gedrag bij uitloggen (drops blijven bestaan) is Gebouwd maar niet vastgelegd in een test.

---

## De regels die ze volgt

- **Bewijs is alleen-toevoegen.** Een deling voegt precies één `document.ingested` toe per nieuw document, en geen voor een dubbel (dezelfde `clientId`, of bytes die al in de kluis staan). Niets in de extensie schrijft rechtstreeks naar de ledger.
- **AI-uitvoer is een suggestie.** Over de suggestie voor soort en naam die volgt, beslist Martin in Voor jou. Automatisch archiveren (de archiveringsuitzondering) staat in productie uit. Hernoemingen door auto-name zijn verders eigen wijzigingen en staan onder "Door verder gedaan".
- **Er wordt niets verstuurd zonder dat Martin de definitieve tekst goedkeurt.** Een gedeelde brief die eruitziet als een brief van Verder of van een schuldeiser kan tot een voorstel leiden, maar versturen vraagt altijd Martins goedkeuring.
- **Nooit stilletjes een item kwijtraken.** Van elk aangeleverd item wordt rekenschap gegeven: geweigerd met een reden, gemeld als niet meegenomen, of verstuurd.

## Meldingen en haptiek

- De extensie geeft zelf **geen melding en geen haptiek**. Dat past bij de haptiekkaart van de brief voor succes (§2.5: "Upload succeeded: none in the foreground"). De `.error`-haptiek die de kaart geeft aan een mislukking met inline opnieuw proberen, is een aparte functie hieronder.
  **Status:** Gebouwd (geen haptiek- of meldingscode in `apps/ios/VerderShare/`).
- Verderop in de keten kan een gedeelde brief de push "Brief lijkt van Verder" (tijdgevoelig) of "Brief lijkt van <naam>" (actief) van de server opleveren. Zie `../13-meldingen/FEATURES.md`.

## Offline gedrag en synchronisatie

- Offline werkt "Versturen" nog steeds. De drop wordt geschreven, de poging mislukt en het scherm zegt "Bewaard. Het gaat mee zodra je verder opent."
- **De drop beweegt alleen als de app draait.** Hij wordt geïmporteerd wanneer verder de volgende keer start of naar voren komt terwijl er ingelogd is. Een deling terwijl de app nooit geopend wordt, blijft op de telefoon. De extensie start zelf geen achtergrondupload.

**Status:** Gebouwd (`ShareModel.commit`, `IncomingImport.swift`, `RootView`). Het leeglopen na de vliegtuigmodus is alleen met unittests getest.

## Bekende grenzen en wat niet gemeten is

- **Plan 3 Task 22 Step 3 is nog niet afgevinkt.** Niets hiervan is al op de telefoon gedaan: een pdf uit Mail en twee foto's uit Foto's delen (verwacht: twee documenten onder bron "Gedeeld", geen dubbel, ledger +2 `document.ingested` plus hoogstens één `document.updated` van auto-name per document), of de eigen upload van de extensie van een bestand van 5 MB op 4G binnen de grens klaar is, en het piekgeheugen van de extensie met drie of meer foto's van 24/48 MP (verwacht ruim onder 120 MB). De weigering van een bestand boven 48 MB is alleen met unittests getest; die hoort niet bij Step 3 en is ook nog niet op de telefoon geprobeerd.
- Een gemengde deling (bestanden plus afbeeldingen) kan meer dan 10 items aanleveren. De code weigert boven 10, maar het geval zelf is niet gemeten.
- **De optionele notitie van één regel uit de spec is uitgesteld** (spec §7.8). `POST /api/mobile/v1/documents` heeft geen notitieveld en `documents` heeft geen notitiekolom.
- Geen laadtimeout: een bron die nooit antwoordt, laat het scherm op "Even laden…" staan tot Martin annuleert.
- De paginavolgorde van een foto-pdf is de volgorde waarin iOS de bronnen aanlevert; of dat altijd de volgorde is waarin Martin ze koos, is niet gecontroleerd.
- Geen scrollview, dus de grootste Dynamic Type-maten kunnen de onderkant van het blad afsnijden.
- De regel "Bewaard…" zegt niet waarom een bestand niet afgeleverd is: offline, geen sessie, boven 8 MB en de grens van 20 s lezen allemaal hetzelfde.
- **De bytes van een definitief verwijderd document delen zet ze terug op schijf.** De route roept `storeFile` aan vóór de sha256-dedup van `ingestDocument`, dus het bestand wordt opnieuw geschreven onder de hash van de tombstone, terwijl er geen nieuwe rij of event geschreven wordt. `/verify` meldt het als restant van een verwijdering en een herhaalde verwijdering haalt het weg. Dit volgt uit de code en is niet getest; het geldt voor elke uploadroute, niet alleen voor delen.

## Ontworpen, nog niet gebouwd

De definitieve frames, de spec (§7.8) en de design brief (§2.4 toestanden, §2.5 haptiek, §2.7 toegankelijkheid, §3 flowrij) leggen deze vast. Elke functie wordt beschreven als wat ze doet; het frame dat haar toont, staat tussen haken.

### Vóór Versturen: wat het scherm Martin vertelt

- **"Waar het heen gaat": waar de deling terechtkomt.** Onder de deling één korte uitleg van wat er daarna gebeurt, afgestemd op de deling: "Komt in je dossier onder Gedeeld. Daarna zet verder een suggestie voor naam en soort klaar in Voor jou." bij één bestand; "Komen alle drie in je dossier onder Gedeeld, elk als eigen document." bij meerdere; "eerst met deze tijdelijke naam" bij een foto-pdf; "De twee die meegaan …" bij een gedeeltelijke deling; "Na het inloggen" bij uitgelogd. Het vat de pijplijn verderop samen in één zin, zodat een deling nooit lijkt te verdwijnen. [`E_n_PDF`, `Foto_s_n_PDF`, `Meerdere_bestanden`, `Meerdere_bestanden_deels`, `Meer_dan_10`, `Niet_ingelogd`, `Laden`]
  **Status:** Nog te bouwen — tekst per geval in `ShareModel.Copy` (een berekende `explanation`), de kaart in `ShareView`, tests per geval.
- **Paginatelling in de detailregel.** "PDF · 2 pagina's · 312 kB", "PDF van 3 foto's · 3 pagina's · 1,8 MB", "1 pagina" in het enkelvoud. Met een paginatelling ziet Martin in één oogopslag dat de hele brief er is. [`E_n_PDF`, `Foto_s_n_PDF`, `Meerdere_bestanden`]
  **Status:** Nog te bouwen — een `pages`-waarde op `PreparedShare` (PDFKit `pageCount` op het klaargezette bestand; de foto-pdf kent `photoPages` al), het nieuwe detailformaat in `ShareModel.detail`, tests. Bestanden die geen pdf zijn, tonen geen telling.
- **Eén rij per bestand bij meerdere bestanden.** De kop "3 bestanden" met "PDF · samen 1,1 MB", daarna een rij per bestand met eigen thumbnail, naam (twee regels, in het midden ingekort) en detailregel. Een bestand dat niet meegaat, staat gedimd in zijn rij met de reden ("Gaat niet mee · 62 MB, max. 48 MB"). [`Meerdere_bestanden`, `Meerdere_bestanden_deels`]
  **Status:** Nog te bouwen — een rijmodel per bestand (naam, detail, meegenomen of de reden waarom niet) in `ShareModel`, de lijst in `ShareView`, tests. Nu worden alleen de thumbnail van het eerste bestand en één gecombineerde titel getoond.
- **De foto-pdf noemt zijn foto's en hun volgorde.** Een badge "3 FOTO'S" (of "FOTO 1–10 VAN 14") op een gestapelde thumbnail, en de regel "Pagina's in de volgorde waarin je ze koos." zodat Martin weet dat de paginavolgorde zijn keuzevolgorde is. [`Foto_s_n_PDF`, `Meer_dan_10`]
  **Status:** Nog te bouwen — de badge en regel in `ShareView`; EERST een meting op de telefoon dat de volgorde van de bronnen echt de keuzevolgorde is (nu niet geverifieerd), anders belooft de regel iets wat de code niet weet.

### Gedeeltelijk meenemen in plaats van weigeren

- **De eerste 10 van een grotere deling meenemen.** "Dat zijn er 14; verder neemt er de eerste 10 mee. Deel foto 11–14 daarna opnieuw." De eerste tien gaan mee; de rest wordt genoemd zodat Martin die in een tweede ronde kan delen. Er wordt niets stilletjes weggelaten. [`Meer_dan_10`, `Meer_dan_10_AX5`]
  **Status:** Nog te bouwen — `ShareModel.handedOver(count:)` en `loaded` moeten de eerste `maxItems` houden in plaats van te weigeren, het bereik "11–14" in de tekst, tests die de huidige weigertests vervangen. De geheugengrens (één foto tegelijk gedecodeerd) houdt al stand voor tien.
- **De andere bestanden versturen als er één boven 48 MB zit.** "verder neemt er 2 van de 3 mee. Jaaropgaaf 2025 scan.pdf is te groot (62 MB, max. 48 MB). Scan de brief met verder, of deel later een kleinere versie." Het te grote bestand wordt bij naam weggelaten, de rest gaat mee, en de waarschuwing blijft na Versturen op het scherm, zoals de huidige waarschuwing voor gedeeltelijk meenemen. [`Meerdere_bestanden_deels`]
  **Status:** Nog te bouwen — `loaded` moet alleen het te grote bestand weglaten (nu weigert `tooLarge > 0` alles), met naam en grootte bewaard voor de tekst en de rij, tests. Alleen een deling waarin ELK bestand te groot is, wordt geweigerd.

### Weigeringen, mislukkingen en doodlopende wegen

- **Te groot: een scherm dat zegt wat te doen.** "Te groot om mee te nemen. Dat is meer dan verder per bestand meeneemt. Scan de brief met verder, of deel een kleinere versie." met de gedimde thumbnail van het bestand, de naam en "62 MB · max. 48 MB". De knop aan de beginkant leest "Sluiten" en er is geen uitgeschakeld Versturen. [`Te_groot`]
  **Status:** Deels gebouwd — de weigering en haar regel van 48 MB bestaan (`ShareModel.loaded`, `Copy.tooLarge`); er ontbreken het advies, de weergave van het bestand met zijn grootte, en "Sluiten" in plaats van "Annuleren" plus een uitgeschakeld "Versturen" (dezelfde wijziging geldt voor elke weigertoestand).
- **Laden toont de vorm van wat er komt.** Een skeleton in de vorm van de thumbnail en de twee tekstregels, met "Versturen" uitgeschakeld. (Brief §2.4: een skeleton, nooit een spinner of een kale regel.) [`Laden`]
  **Status:** Deels gebouwd — de laadfase bestaat met "Versturen" uitgeschakeld (`ShareModel.Phase.loading`); ze toont de tekst "Even laden…" in plaats van het skeleton.
- **Laden dat blijft hangen, eindigt met een oorzaak en opnieuw proberen.** Als de bron-app het bestand niet binnen 10 seconden aanlevert: "Bestand laden lukt niet. Mail gaf het bestand niet binnen 10 seconden door. Probeer het opnieuw; lukt het dan nog niet, bewaar het eerst in Bestanden en deel het van daaruit." met "Opnieuw proberen", dat dezelfde bronnen opnieuw laadt. De bron-app wordt genoemd als iOS zegt welke het is. [`Laden_fout`]
  **Status:** Nog te bouwen — een grens van 10 s rond `SharePreparation.collect` in `ShareViewController.viewDidLoad`, een `loadFailed`-fase met opnieuw proberen dat het laden opnieuw uitvoert, de naam van de bron-app (of een neutrale terugval als die niet bekend is), tests. Nu laat een bron die nooit antwoordt het blad op "Even laden…" staan tot Martin annuleert.
- **Een mislukte opslag noemt de oorzaak en biedt opnieuw proberen.** "Opslaan lukte niet. Er is te weinig ruimte vrij op je iPhone. Maak ruimte en probeer het opnieuw; er is nog niets verstuurd." met de naam en het detail van de deling, en "Opnieuw proberen", dat Versturen opnieuw uitvoert. [`Versturen_fout`]
  **Status:** Deels gebouwd — de mislukking wordt afgehandeld en teruggedraaid zodat er niets half geschreven blijft staan (`ShareModel.commit`, `Copy.saveFailed`); er ontbreken de oorzaak (`NSFileWriteOutOfSpaceError` en andere vertalen naar een Nederlandse regel), de geruststelling "er is nog niets verstuurd", de weergave van de deling en de knop voor opnieuw proberen (nu moet Martin annuleren en opnieuw delen).
- **Een gedeelde link krijgt een eigen antwoord.** "Hier zit geen bestand in. Je deelde een link. verder bewaart alleen bestanden, geen links. Open de link, bewaar de pagina als PDF en deel die met verder." met de link zelf onder "Wat je deelde · link", en alleen "Sluiten". [`Niet_ondersteund`]
  **Status:** Nog te bouwen — de activatieregel (`project.yml`) moet OOK een web-URL accepteren, anders biedt iOS verder nooit aan voor een link en is dit scherm onbereikbaar; daarna een deling van alleen een URL herkennen in `ShareViewController.load`, een `link`-weigering met de URL in `ShareModel`, tests. Een ruimere regel mag een link niet als bestand laten meereizen.
- **De `.error`-haptiek bij een mislukking met opnieuw proberen.** Brief §2.5: "Upload failed / action failed → `.error`, with the inline retry." Ze hoort bij de schermen voor mislukt laden en mislukt opslaan hierboven, niet bij weigeringen waar Martin niets aan kan doen, en wordt overgeslagen als systeemhaptiek uit staat.
  **Status:** Nog te bouwen — `.sensoryFeedback(.error, trigger:)` op de twee toestanden met opnieuw proberen in `ShareView`. Hangt af van het bestaan van die toestanden.

### Uitgelogd, en waarom een deling wacht

- **Uitgelogd, herkend vóór Versturen.** Als de gedeelde Keychain geen sessie bevat, zegt het blad dat meteen: "Je bent niet ingelogd. Tik op Bewaar en open daarna verder om in te loggen. Dan gaat het bestand vanzelf naar je dossier." De knop aan de eindkant leest "Bewaar" (die schrijft de drop en doet geen uploadpoging), en daarna: "Bewaard in verder. Open verder en log in; daarna gaat het bestand vanzelf naar je dossier." [`Niet_ingelogd`, `Bewaard`]
  **Status:** Nog te bouwen — een controle op een aanwezige sessie via `KeychainSessionStore` bij het laden, een `signedOut`-vlag in `ShareModel` die de knop hernoemt en `ShareSender` overslaat, de twee teksten, tests. Nu wordt een ontbrekende sessie pas ontdekt door de 401 en leest die als elke andere "Bewaard…". Een verlopen maar aanwezige cookie eindigt nog steeds in het 401-pad, dat blijft zoals het nu is.
- **Het scherm voor later bewaren zegt waarom.** "Bewaard in verder. Hij gaat mee zodra je verder opent." met een weergave van de reden en het bestand: "offline · in wachtrij", "groot bestand · in wachtrij" (met de grootte), en bij uitgelogd de inlogregel hierboven. [`Bewaard_offline`, `Bewaard_groot_bestand`, `Bewaard`]
  **Status:** Nog te bouwen — `ShareSender.send` moet per drop een reden teruggeven (offline, boven 8 MB, 401, grens bereikt) in plaats van alleen de afgeleverde ids, `Phase.done` moet die meedragen, de weergave in `ShareView`, tests.
- **Een eindscherm dat de deling afsluit.** Na Versturen toont het blad een bevestigingssymbool, een kop, één uitlegregel en de weergave van het bestand, met "Klaar" als enige knop: "Staat in de wachtrij van verder. Hij komt in je dossier onder Gedeeld. De voortgang zie je in verder." als hij verstuurd is, of "Bewaard in verder" als hij wacht. [`Verstuurd`, `Verstuurd_AX5`, `Bewaard_*`]
  **Status:** Deels gebouwd — de eindfase, het onderscheid afgeleverd/in wachtrij en het zelf sluiten na 1,2 s bestaan (`ShareModel.Phase.done`, `ShareViewController.send`); er ontbreken de bevestigingslay-out, de uitleg en de weergave van het bestand, het knopwoord "Klaar" (code: "Sluiten") en de koptekst (code: "Staat in je dossier." / "Bewaard. Het gaat mee zodra je verder opent.").

### Tijdens het versturen

- **Zichtbare voortgang, inclusief het maken van de pdf.** Tijdens het versturen wordt de knop aan de eindkant een voortgangssymbool en loopt er onder de deling een balk met de stap: "PDF maken · foto 2 van 3", daarna de upload. "Annuleren" blijft beschikbaar zolang de foto-pdf nog gemaakt wordt, want tot de drops geschreven zijn, is annuleren nog waar. [`Versturen`]
  **Status:** Nog te bouwen — de foto-pdf wordt nu bij het LADEN gebouwd (`SharePreparation.prepare` vanuit `ShareModel.loaded`), dus een stap "PDF maken" na Versturen vraagt dat het samenstellen achter Versturen komt (of dat de stap in het frame een andere naam krijgt), een voortgangswaarde per pagina uit `PDFAssembler`, `canCancel` waar tot de eerste drop geschreven is, de balk in `ShareView`, tests. Nu toont het scherm "Wordt verstuurd…" en verbergt het "Annuleren".

### De optionele notitie van één regel

- **Eén regel voor Martins context.** Spec §7.8 en brief §3: een optionele notitie van één regel reist mee met de deling ("iets bijzonders?"), zodat een bestand aankomt met de reden waarom het gedeeld is. [geen frame]
  **Status:** Nog te bouwen — UITGESTELD door de spec (2026-11-01): `POST /api/mobile/v1/documents` leest geen `note`-veld en `documents` heeft er geen plek voor (een `document_status_changes`-rij heeft de verkeerde vorm, een logboekregel is bewijs). Vraagt eerst om een ontworpen plek op de server, daarna een `note` in de JSON van `IncomingDrop`, een veld in `ShareView`, en tests. De helft van het transport bestaat al in de niet-gecommitte working tree: `UploadItem.note` en `UploadRequest.build` sturen al een `note`-deel mee als een item er een heeft (alleen bij scans); de route negeert het.

### Grote tekst en toegankelijkheid

- **Het blad scrolt bij de grootste tekstmaten.** Bij AX5 blijft elk element leesbaar en scrolt het hele blad, met de kop vast, zodat er niets van de onderkant af geduwd wordt. [`E_n_PDF_AX5`, `E_n_PDF_AX5_doorgescrold`, `Verstuurd_AX5`, `Verstuurd_AX5_doorgescrold`, `Meer_dan_10_AX5`]
  **Status:** Nog te bouwen — een `ScrollView` rond de inhoud in `ShareView`, met de koprij erbuiten. Dynamic Type zelf is Gebouwd (elk lettertype is `relativeTo:`).
- **iPhone SE.** Dezelfde ene lay-out op 375 × 667. [`E_n_PDF_iPhone_SE`]
  **Status:** Gebouwd (`ShareView` heeft één lay-out die niet van de breedte afhangt). Niet gecontroleerd in een simulator op SE-formaat.
- **VoiceOver.** De kop "Naar verder" is een kop, de deling leest als één element (titel, dan detail), de decoratieve thumbnail wordt overgeslagen, en elke toestand wordt als tekst aangekondigd, nooit alleen met kleur (brief §2.7).
  **Status:** Deels gebouwd — de thumbnail is verborgen voor VoiceOver en elke toestand is een tekstregel (`ShareViewController.swift`); er ontbreken `.accessibilityAddTraits(.isHeader)` op de kop en `.accessibilityElement(children: .combine)` op het delingspaneel.

### Verwant, elders belegd

De "Scan"-bediening van de brief in Bedieningspaneel / de Actieknop en de Live Activity van de uploadwachtrij (3+ items die leeglopen, R18) zijn functies van de Scan- en wachtrijschermen (`../06-scan-en-wachtrij/FEATURES.md`), niet van deze extensie. Een deling van meerdere bestanden zou die Live Activity voeden zodra die bestaat; niets daarvan wordt hier meegeteld.

---

## Waar in de code

**iOS**

- `apps/ios/VerderShare/ShareViewController.swift`: het laden van de `NSItemProvider`s, klaarzetten, het ene scherm (`ShareView`), thumbnail, sluiten/annuleren.
- `apps/ios/Verder/Upload/ShareModel.swift`: fasen, teksten, grenzen, `commit`, de begrensde poging, `canCancel`, waarschuwingen.
- `apps/ios/Verder/Upload/SharePreparation.swift`: `SharedInput`, `PreparedShare`, `SharePreparation` (foto's naar één pdf, doorgeven), `ShareStaging`, `PhotoPage`.
- `apps/ios/Verder/Upload/ShareSender.swift`: de ene voorgrondupload van de extensie en de `.sent`-markering.
- `apps/ios/Verder/Upload/IncomingDrop.swift`: het dropformaat in `<group>/uploads/incoming/`.
- `apps/ios/Verder/Upload/IncomingImport.swift`: `UploadQueue.importIncoming`, de helft van de app, plus het opruimen na 24 u.
- `apps/ios/Verder/Upload/UploadRequest.swift`, `UploadItem.swift`, `Multipart.swift`: het gedeelde verzoek, item en de multipart-body.
- `apps/ios/Verder/Upload/UploadCenter.swift` (`start()`) en `apps/ios/Verder/App/RootView.swift`: import bij starten en naar voren komen, alleen als er ingelogd is.
- `apps/ios/Verder/Scan/PDFAssembler.swift`, `ScanNaming.swift`: het samenstellen van pagina's en de naam volgens de Amsterdamse klok.
- `apps/ios/Verder/Shared/AppGroup.swift`; `apps/ios/project.yml` (target `VerderShare`, activatieregel, entitlements, lettertypen).

**Server**

- `apps/web/src/app/api/mobile/v1/documents/route.ts` (`POST`), `apps/web/src/lib/vault-upload.ts`, `apps/web/src/lib/upload-limit.ts`.
- `packages/api/src/routers/documents.ts` (`registerUpload` → `ingestDocument`, `bySourceRef`), `packages/api/src/storage.ts`.
- `apps/worker/src/docmeta-sweep.ts`, de `suggest.docmeta`-taak in `apps/worker/src/index.ts`, `apps/worker/src/auto-name.ts`, `apps/worker/src/proposals/letters.ts` (briefbronnen bevatten `phone-share`).

**Tests**

- `apps/ios/VerderTests/ShareModelTests.swift`: één drop per bestand, de grens, weigeringen, titels, onleesbare items, meer dan 10, annuleerregels, teruggedraaide mislukte opslag, klaargezette bestanden.
- `apps/ios/VerderTests/IncomingDropTests.swift`: zichtbaarheid van drops, idempotente import, clientId = drop-UUID, afhandeling van `.sent`, opruimen van wezen, klaarzetten, de voorgrondgrens van 8 MB, en `oldQueueJsonStillDecodes` (fixture `Fixtures/queue-before-share.json`).
- `apps/ios/VerderTests/PhotoPageTests.swift`, `PDFAssemblerTests.swift`: verkleind decoderen, één pagina tegelijk, zijwaartse foto's rechtop, pagina's pas geteld als ze geschreven zijn.
- `apps/ios/VerderTests/UploadQueueTests.swift`, `MultipartTests.swift`.
- `apps/web/src/app/api/mobile/v1/documents/route.test.ts`.

---

## Frames

Frames gemarkeerd met *niet gebouwd* tonen een toestand die de code niet heeft (zie "Ontworpen, nog niet gebouwd"). Frames zonder die markering verschillen nog steeds van de code in de details die daar staan (uitlegkaart, paginatelling, lay-out van het eindscherm).

| Frame | Toestand die het toont |
|---|---|
| `Share_extension_Deelblad_systeem.jpg` | Het iOS-deelblad in Mail, met verder in de rij apps |
| `Share_extension_Laden.jpg` | Laden |
| `Share_extension_Laden_fout.jpg` | Mislukt laden met opnieuw proberen (*niet gebouwd*) |
| `Share_extension_E_n_PDF.jpg` | Eén pdf, klaar om te versturen |
| `Share_extension_Foto_s_n_PDF.jpg` | Drie foto's als één pdf |
| `Share_extension_Meerdere_bestanden.jpg` | Drie bestanden |
| `Share_extension_Meerdere_bestanden_deels.jpg` | Drie bestanden, één te groot en weggelaten (*niet gebouwd*: de code weigert de hele deling) |
| `Share_extension_Meer_dan_10.jpg` | 14 foto's, de eerste 10 meegenomen (*niet gebouwd*: de code weigert de deling) |
| `Share_extension_Versturen.jpg` | Versturen |
| `Share_extension_Versturen_fout.jpg` | Mislukte opslag met opnieuw proberen (*niet gebouwd*) |
| `Share_extension_Verstuurd.jpg` | Verstuurd |
| `Share_extension_Bewaard_offline.jpg` | Bewaard voor later, offline |
| `Share_extension_Bewaard_groot_bestand.jpg` | Bewaard voor later, groot bestand (boven de uploadgrens van 8 MB van de extensie) |
| `Share_extension_Niet_ingelogd.jpg` | Niet ingelogd, vooraf herkend (*niet gebouwd*) |
| `Share_extension_Bewaard.jpg` | Bewaard na de melding over uitgelogd zijn (*niet gebouwd*) |
| `Share_extension_Niet_ondersteund.jpg` | Een gedeelde link (*niet gebouwd*) |
| `Share_extension_Te_groot.jpg` | Een bestand boven 48 MB, geweigerd |
| `Share_extension_E_n_PDF_iPhone_SE.jpg` | Eén pdf op de iPhone SE (375 × 667) |
| `Share_extension_E_n_PDF_AX5.jpg` | Eén pdf bij de grootste toegankelijkheidstekstmaat |
| `Share_extension_E_n_PDF_AX5_doorgescrold.jpg` | Hetzelfde, doorgescrold (*niet gebouwd*: geen scrollview) |
| `Share_extension_Meer_dan_10_AX5.jpg` | Meer dan 10 bij de grootste tekstmaat |
| `Share_extension_Verstuurd_AX5.jpg` | Verstuurd bij de grootste tekstmaat |
| `Share_extension_Verstuurd_AX5_doorgescrold.jpg` | Hetzelfde, doorgescrold (*niet gebouwd*: geen scrollview) |
