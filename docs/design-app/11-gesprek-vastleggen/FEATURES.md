# Gesprek vastleggen (spraaknotitie): functies

## Stand van de bouw

Gecontroleerd tegen de code op 2026-11-03 (branch `feat/iphone-app`, inclusief de niet-gecommitte working tree; het gespreksblad en de Live Activity op branch `feat/iphone-calls`). Dit document beschrijft de **volledige** functieset van dit scherm: wat de code doet en wat de definitieve frames, de spec (§7.4) en de design brief (§2.5, §3) daaraan toevoegen. Elke functie heeft één statusregel.

| Status | Aantal |
|---|---|
| Gebouwd | 44 |
| Deels gebouwd | 11 |
| Nog te bouwen | 19 |
| Niet mogelijk op iOS | 1 |

De drie belangrijkste dingen die nog gebouwd moeten worden:

1. **Vragen voordat een niet-verstuurde notitie wordt weggegooid** ([Bevestiging voor weggooien](#bevestiging-voor-weggooien-bij-sluiten)). Nu gooit "Sluiten" de tekst en de opname direct weg, zonder vraag. Dat is de enige plek waar Martin een gesprek dat hij net heeft ingesproken kan kwijtraken.
2. **De ontworpen opname zelf**: [tikken om te starten en te stoppen](#tikken-om-te-starten-en-tikken-om-te-stoppen), een [live transcript](#live-transcript-tijdens-het-praten), de [timer](#opnametimer-en-weergave-op-het-toestel) en [annuleren door van de knop af te schuiven](#een-opname-annuleren-van-de-knop-af-schuiven-of-annuleer). Het begint met de meting die nog openstaat: zet iOS 27.2 Nederlands überhaupt op de telefoon om in tekst (plan 3 Task 25 stap 1)?
3. **Met wie het was, zonder zoeken**: [partij en kanaal uit de tekst gelezen](#partij-en-kanaal-uit-de-tekst-gelezen) plus het [doorzoekbare partijblad](#partijkiezer-zoeken-recent-az), zodat het doel van de brief van twee stappen (vasthouden, praten, loslaten, versturen) overeind blijft.

Alles wat nog niet gebouwd is, staat onder [Ontworpen, nog niet gebouwd](#ontworpen-nog-niet-gebouwd). De functies die bestaan, staan onder [Functies](#functies), elk met hun status.

"Gesprek vastleggen" is de spraaknotitie van de iPhone-app. Direct na een telefoongesprek houdt Martin een knop ingedrukt en zegt hij met wie hij sprak en wat er is afgesproken. De telefoon zet de opname zelf om in tekst; Martin controleert de tekst, kiest de partij, het kanaal en het tijdstip, en verstuurt het. Op de server wordt het een **openstaande suggestie voor een logboekregel**. Het is geen logboekregel: het komt pas in het logboek als Martin het goedkeurt in Voor jou, zoals elke andere suggestie. Alleen Martin gebruikt de app.

Dit document beschrijft wat de functie doet. Het visuele ontwerp staat in Figma: bestand `QDRL5zHNEOjPzLZqzd19Ii`, sectienode `333:12132` ("Voice quick-log"). De 27 frames in `frames/` zijn op 2026-11-03 opnieuw uit die sectie geëxporteerd. Elke schermafbeelding gebruikt de synthetische fixture-dataset (Woonstichting Lindehof, Bewindkantoor Noordkust, Kade & Partners, …), geen echte dossiergegevens. UI-teksten staan tussen aanhalingstekens in het Nederlands, precies zoals de app ze toont.

> **Het ontwerp loopt voor op de code.** Het ontwerp noemt het blad "Spraaknotitie". Op branch `feat/iphone-app` (`apps/ios/Verder/Voice/`) is het een eenvoudiger blad met de titel "Gesprek vastleggen". De grootste verschillen:
> - **Geen live transcript, geen timer, geen annuleren door af te schuiven.** Het ontwerp schrijft de tekst terwijl Martin praat ("0:14 NEDERLANDS · OP JE IPHONE") en laat hem van de knop af schuiven om te annuleren. De code neemt eerst op en zet pas om nadat de vinger loslaat. Een vinger die meer dan 80 pt wegbeweegt *beëindigt* de opname bovendien, en die opname wordt nog steeds omgezet, niet weggegooid.
> - **Geen tikken om te starten.** Het ontwerp zegt "of tik één keer om te starten en weer om te stoppen". In de code is een druk korter dan 0,6 s geen opname ("Houd de knop ingedrukt zolang je praat."). Alleen VoiceOver en Switch Control krijgen een aan/uit-knop.
> - **Geen ontleding van de tekst.** Het ontwerp onderstreept "Gebeld" en de naam van de partij in de tekst, en de partijrij zegt "MET WIE · UIT JE TEKST". De code leest niets uit het transcript. De partij begint als degene met wie Martin het laatst contact had, en het kanaal begint als `call`.
> - **De partijkiezer.** Het ontwerp heeft een blad "Met wie sprak je?" met zoeken, de secties "RECENT" en "ALLE PARTIJEN · A–Z", en per rij een rol en "laatst 31 okt". De code gebruikt een gewoon iOS-menu met namen, op volgorde van meest recent contact.
> - **Kanalen.** Het ontwerp heeft Telefoon / Bezoek / Anders…. De code heeft Telefoon, Gesprek, Voicemail, WhatsApp en Anders.
> - **Aparte toestandsschermen.** Het ontwerp geeft "Niets gehoord", "Omzetten lukte niet", "Microfoon staat uit", "Spraakherkenning staat uit" en de modeldownload (met "38 VAN 61 MB") elk een eigen blad-vullende layout. De code toont elk als een zin binnen de gewone opname- of editorlayout (zie [Toestanden](#toestanden)). De code kent helemaal geen toestand voor *toestemming* voor spraakherkenning, en geen downloadvoortgang.
> - **Vergrendeling, inloggen en bevestiging.** Het ontwerp houdt de notitie zichtbaar achter "Ontgrendel met Face ID", toont een balk "Je bent uitgelogd · Log opnieuw in" en vraagt "Weggooien?" voordat er iets wordt weggegooid. In de code vervangt een vergrendeling het hele blad door het vergrendelscherm. Een 401 vervangt de hele app door het inlogscherm "Je sessie is verlopen.", en de notitie komt daarna terug. "Weggooien" gooit direct weg, zonder bevestiging.
> - **Na het versturen.** Het ontwerp toont de suggestie als kaart met "Bekijk in Voor jou". De code toont een bevestigingsregel, "Nog een gesprek" en "Klaar". Er is geen link naar Voor jou.
>
> **[Functies](#functies) beschrijft de code** en noemt elk verschil waar het van toepassing is. Elk verschil is ook een eigen functie, met status, onder [Ontworpen, nog niet gebouwd](#ontworpen-nog-niet-gebouwd). De [frametabel](#frames) aan het eind zegt per frame hoe ver de code ermee overeenkomt.

![Idle sheet over Overzicht (design)](frames/Voice_quick-log_idle.jpg)

## Doel

- **Een gesprek vastleggen terwijl het vers is.** Telefoongesprekken met Verder, een schuldeiser of een deurwaarder laten geen mail achter, dus zonder notitie komen ze nooit in het dossier. De spraaknotitie maakt van "wie, wanneer, wat is afgesproken" een paar seconden praten.
- **Niets komt vanzelf in het logboek.** Het resultaat is een suggestie (`kind = 'log-entry'`, `status = 'pending'`, `prompt_version = 'voice-v1'`) die Martin in Voor jou goedkeurt, bewerkt of afwijst. Versturen schrijft niet in het logboek. Zonder bewaarde opname voegt versturen helemaal niets aan het ledger toe.
- **De stem blijft op de telefoon.** Het omzetten gebeurt op het toestel (spec §7.4: "no audio leaves the phone, no GPU contention on the homelab"). De audio gaat alleen naar verder als Martin "Bewaar opname" aanzet.

## Toegang en vervolg

**Erin:**

- **Snelle actie op het beginscherm.** Houd het app-icoon ingedrukt en kies "Gesprek vastleggen" (symbool `mic`, type `pro.vanderpoel.verder.voice`). Die is statisch gedeclareerd in `project.yml` / Info.plist en bestaat dus al voordat de app ooit heeft gedraaid. `QuickAction.link(forType:)` maakt er `DeepLink.voice` van. Bij een koude start komt het item binnen via `SceneDelegate.scene(_:willConnectTo:)`, bij een warme via `windowScene(_:performActionFor:)`. (De working tree voegt een tweede item toe, "Scan een brief"; het spraakitem is ongewijzigd.)
  **Status:** Gebouwd — `apps/ios/Verder/App/QuickAction.swift`, `apps/ios/project.yml`
- **Meer → "Gesprek vastleggen"** (sectie "DOSSIER", een "+" in plaats van een chevron). Roept `voice.open()` aan (zie `../10-meer-en-instellingen/FEATURES.md`).
  **Status:** Gebouwd — `apps/ios/Verder/More/MoreMenu.swift`, `apps/ios/Verder/App/RootView.swift`
- **Deep link `verder://voice`.** Dit is een strikte parse: `verder://voice/<anything>` is `.none`. Hij opent het blad over het tabblad dat op dat moment zichtbaar is (`LinkDestination(tab: nil, stack: nil, opensVoice: true)`). De app registreert geen `verder://`-URL-schema, dus alleen de snelle actie (en verders eigen widget of een push, die deze link geen van beide nu gebruiken) kan hem afleveren.
  **Status:** Gebouwd — `apps/ios/Verder/Push/DeepLink.swift`
- **Actieknop en "Leg vast in verder" (Siri / Opdrachten).** Het doel van de brief voor dit scherm is twee stappen: druk op de Actieknop (of zeg "Leg vast in verder"), houd vast om te praten, laat los, verstuur. Beide hebben een App Intent nodig die de spraaknotitie opent (een `OpenIntent` die `DeepLink.voice` aflevert), plus een App Shortcut-zin in het Nederlands. Geen van beide bestaat: de app heeft helemaal geen App Intents.
  **Status:** Nog te bouwen — een `AppIntent` + `AppShortcutsProvider` in het app-target dat via `DeepLinkInbox` naar `DeepLink.voice` routeert; een test dat de intent `.voice` oplevert; geen serverwijziging
- **Fixture-opname (alleen DEBUG):** `-fixtures voice -route voice` opent de echte spraaknotitie met een nep-recorder en het transcript uit het manifest, al opgenomen, zodat de opname de editor toont.
  **Status:** Gebouwd — `apps/ios/Verder/Fixtures/`, `apps/ios/Verder/FixtureData/voice/`

**Eruit:** het blad sluit altijd terug naar het tabblad waarover het geopend werd. Na een verzending sluit "Klaar" het en start "Nog een gesprek" een nieuwe notitie. Bij een geweigerde microfoon verlaat "Open Instellingen" de app richting iOS-Instellingen. De suggestie zelf wordt beoordeeld in **Voor jou** (`../03-voor-jou/FEATURES.md`, `../05-vraag-suggestie-taak/FEATURES.md`), maar het blad linkt daar niet naartoe.

## Functies

### Een notitie openen

`VoiceLogSession.open()` hergebruikt de notitie die in behandeling is als er een is, en maakt anders een nieuw `VoiceLogModel` met een **nieuwe `clientId`**. De initializer van het model leegt de opnamemap (`tmp/voice/`), wat alles verwijdert wat een crash heeft achtergelaten. Als het blad verschijnt, draait `prepare()`:

1. **Partijen.** `GET /api/mobile/v1/parties?recent=1` geeft `id, kind, name, organization, lastContactAt` terug, met de hand gevormd door de route (geen e-mail, geen notitie). Ze staan op volgorde van de nieuwste `log_entries.occurred_at` waaraan elke partij deelnam (via `entry_participants`), daarna op naam. Partijen zonder regel komen achteraan. De eerste is voorgeselecteerd.
2. **Nederlandse spraak.** `OnDeviceTranscriber.availability()` vraagt of `SpeechTranscriber` `nl_NL` ondersteunt en of het model geïnstalleerd is (`AssetInventory.status`). Ontbreekt het model, dan wordt het **meteen** gedownload en geïnstalleerd (`assetInstallationRequest(...).downloadAndInstall()`), zodat een download bij eerste gebruik nooit plaatsvindt terwijl Martin op een transcript wacht.

Het blad opent op de middelste detent met een grabber en kan naar groot worden getrokken.

**Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceLogSession.swift`, `VoiceLogModel.swift` (`prepare`), `VoiceLogView.swift` (`VoiceLogSheet`), `apps/web/src/app/api/mobile/v1/parties/route.ts`

### Ingedrukt houden om op te nemen

De ronde knop (`HoldToRecord`) begint met opnemen als de vinger neergaat en stopt als die omhoogkomt. De eerste druk vraagt om toestemming voor de microfoon (`NSMicrophoneUsageDescription`: "verder neemt je stem op om een gesprek vast te leggen."). Laat de vinger los terwijl de toestemmingsmelding nog openstaat, dan wordt er niets opgenomen.

- **Formaat:** AAC in een `.m4a`, mono, 16 kHz, 32 kbit/s (`AudioRecorder.settings`). Dat is ongeveer 14 MB per uur, ruim onder de uploadlimiet van 50 MB van de server.
- **Het tijdstip van het gesprek** wordt gezet op het moment dat de opname begon, tenzij Martin al met de hand een tijd heeft ingesteld.
- **Korter dan 0,6 s** telt als tik: de opname wordt verwijderd en het blad zegt "Houd de knop ingedrukt zolang je praat."
- **VoiceOver / Switch Control:** de knop leest "Neem op" / "Stop opname", met de hint "Houd ingedrukt zolang je praat.". De activeeractie schakelt aan en uit, omdat vasthouden geen gebaar is dat deze gebruikers kunnen uitvoeren.
- De faseregel luidt "Houd ingedrukt en vertel wat er besproken is." in rust en "Opnemen — laat los om te stoppen." tijdens het opnemen. De knop bestaat alleen zolang Nederlandse spraak klaarstaat (`canRecord`): terwijl spraak nog wordt gecontroleerd, het model wordt geïnstalleerd of spraak niet beschikbaar is, is de knop verborgen en luidt de rustregel "Typ wat er besproken is."
- **Geen haptiek** tijdens het opnemen, en ook nergens anders in het blad (brief §2.5: stoor nooit de microfoon). Zie [Haptiek](#haptiek-buiten-de-opname) voor de ene die de brief wel vraagt.

**Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceLogView.swift` (`HoldToRecord`), `VoiceLogModel.swift` (`startRecording`, `stopRecording`), `VoiceRecorder.swift`

![Recording (design, with a live transcript the code does not have)](frames/Voice_quick-log_opname.jpg)

### Omzetten op de telefoon

Als de vinger loslaat, wordt de fase "Omzetten naar tekst, op je telefoon…" en verschijnt een spinner. `SpeechAnalyzer` + `SpeechTranscriber(locale: nl_NL, preset: .transcription)` lezen het bestand en geven de hele tekst terug, bijgesneden. **Er is geen terugval op een server**: de spec koos voor omzetten op het toestel zodat er geen audio de telefoon verlaat, en plan 3 Task 25 verbiedt een serverterugval zonder Martins toestemming. Elke manier waarop het kan mislukken is een toestand, nooit een doodlopend pad (zie [Toestanden](#toestanden)), omdat Martin altijd kan typen wat er gezegd is.

De spec vraagt "Transcribe on-device… in Dutch". Het live transcript en de ontlede voorvertoning van het ontwerp (brief §3: "Live on-device transcript, then a parsed preview") zijn niet gebouwd; zie [Live transcript](#live-transcript-tijdens-het-praten) en [Partij en kanaal uit de tekst gelezen](#partij-en-kanaal-uit-de-tekst-gelezen).

**Status:** Gebouwd — `apps/ios/Verder/Voice/Transcriber.swift` (`OnDeviceTranscriber`). Nog niet gemeten op de telefoon (zie [Bekende beperkingen](#bekende-beperkingen-en-wat-nog-niet-gemeten-is)).

### Typen in plaats van spreken

"Typ zelf", in rust onder de knop, opent de editor met een lege tekst en de tijd op nu. Dit is ook het enige pad als Nederlandse spraak niet beschikbaar is. Het ontwerp noemt deze knop "Typ je notitie".

**Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceLogModel.swift` (`typeInstead`)

![Typing (design)](frames/Voice_quick-log_typen.jpg)

### De editor

De faseregel luidt "Controleer de tekst. Er gaat niets naar het logboek tot jij het goedkeurt in Voor jou." Daaronder:

- **"TEKST"**: het transcript in een bewerkbaar tekstveld ("Tekst van het gesprek" voor VoiceOver).
  **Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceLogView.swift` (`editor`)
- **"MET WIE"**: het partijmenu. Zolang er geen antwoord is binnengekomen, toont het in plaats daarvan "Partijen laden…". De ontworpen kiezer is een eigen blad ([Partijkiezer](#partijkiezer-zoeken-recent-az)).
  **Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceLogView.swift` (`partyPicker`), `VoiceLogModel.swift` (`loadParties`)
- **"HOE"**: de kanaalchips Telefoon (`call`, de standaard), Gesprek (`meeting`), Voicemail, WhatsApp en Anders (`other`): de woorden uit `apps/web/src/lib/entry-labels.ts` (dat ze in kleine letters schrijft) met een hoofdletter. De route accepteert ook `email` en `letter`, maar die spreekt niemand in, dus worden ze niet aangeboden. Het ontwerp biedt Telefoon, Bezoek en "Anders…", wat suggereert dat de rest achter nog één tik zit. Elk kanaal is hoe dan ook bereikbaar.
  **Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceModels.swift` (`VoiceChannel`)
- **"Gesprek was om"**: een compacte datum-en-tijdkiezer in Amsterdamse tijd (Nederlandse locale), met nu als uiterste. `setOccurredAt` begrenst op nu en `send` begrenst opnieuw, zodat een gesprek nooit in de toekomst kan worden vastgelegd. Een met de hand ingestelde tijd blijft staan bij een nieuwe opname.
  **Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceLogView.swift` (`occurredPicker`), `VoiceLogModel.swift` (`setOccurredAt`)
- **"Opnieuw opnemen"**: alleen aangeboden als de tekst leeg is (na "niets verstaan" of een mislukte omzetting), Nederlandse spraak klaarstaat **en er nog geen verzending is geprobeerd**. Het verwijdert de opname en gaat terug naar de recorder met **dezelfde** `clientId`. Na een verzendpoging wordt het nooit aangeboden, omdat de server dat id dan misschien al heeft (het antwoord kan verloren zijn gegaan nadat de suggestie was opgeslagen). Een andere opname onder hetzelfde id zou dan met `duplicate` worden beantwoord en stilzwijgend vervallen, en een nieuw id zou het gesprek twee keer kunnen opslaan. Het ontwerp toont "Opnieuw opnemen" onder een transcript met tekst. De code doet dat nooit.
  **Status:** Deels gebouwd — alleen aangeboden bij een lege tekst. Opnieuw opnemen over een transcript met tekst (het ontwerp, elke editorframe) ontbreekt. Vóór de eerste verzendpoging is dat veilig onder dezelfde `clientId`, en het vraagt om een regel voor wat er met Martins bewerkingen gebeurt (vervangen, of eerst vragen) en een test.
- **"Bewaar opname"**: een schakelaar, alleen zichtbaar zolang er een opname bestaat, standaard uit, met "Alleen dan gaat de opname naar verder. Anders wordt ze na het versturen gewist."
  **Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceLogView.swift`, `VoiceLogModel.swift` (`keepRecording`)
- **"Verstuur als voorstel"**: alleen actief tijdens het bewerken, met een gekozen partij en een tekst die na bijsnijden niet leeg is en hoogstens 20 000 tekens telt (`VoiceDraft.transcriptMax`, de eigen `TRANSCRIPT_MAX` van de route).
  **Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceLogModel.swift` (`canSend`, `send`)
- **"Weggooien"**: verwijdert de opname en zet de notitie direct terug (een nieuwe `clientId`, kanaal terug naar `call`, weer de bovenste partij). Het is uitgeschakeld zolang er verstuurd wordt. Er is geen bevestigingsdialoog, anders dan het blad "Weggooien?" in het ontwerp ([Bevestiging voor weggooien](#bevestiging-voor-weggooien-bij-sluiten)).
  **Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceLogModel.swift` (`discard`)

Tijdens het versturen luiden de faseregel en de verstuurknop allebei "Versturen…".

![Preview / editor (design)](frames/Voice_quick-log_voorbeeld.jpg)

### Versturen: wat er van begin tot eind gebeurt

`VoiceLogModel.send()` bouwt één multipart `POST /api/mobile/v1/entries/voice` (`VoiceDraft`) met `clientId` (UUID v4 in kleine letters), `occurredAt` (ISO 8601), `partyId`, `channel` en `transcript`. Het voegt **alleen** een bestandsdeel `audio` toe (`Gesprek YYYY-MM-DD.m4a`, `audio/mp4`, datum volgens de Amsterdamse kalender) als "Bewaar opname" aan staat. Voor het versturen controleert de telefoon alleen de opname zelf: een bewaarde opname die verdwenen is geeft "De opname is niet meer op je telefoon. Zet 'bewaar opname' uit en verstuur alleen de tekst.", en een van meer dan 50 MB geeft "De opname is te groot om te bewaren. Zet 'bewaar opname' uit en verstuur alleen de tekst." De limiet van 50 MB op de server geldt voor het hele verzoek, dus een opname net onder 50 MB plus de tekst kan nog steeds met 413 worden beantwoord, wat het blad toont als het algemene "verder weigerde dit voorstel…".

De route (`apps/web/src/app/api/mobile/v1/entries/voice/route.ts`):

1. **Eerst 401**, voordat de body wordt gelezen. Het antwoord is JSON (`unauthorized`), nooit een redirect, en elk antwoord is `cache-control: no-store`.
2. Een groottebewaking (`readGuardedForm`: 413 boven `MAX_UPLOAD_BYTES` = 50 MB, 411 zonder lengte). Daarna veldvalidatie, waarbij elke fout een 400 is: `clientId` moet een UUID v4 zijn, `occurredAt` moet ISO 8601 zijn, `partyId` moet een UUID zijn, `channel` moet een van de zeven zijn (standaard `call`), het transcript moet niet leeg zijn en hoogstens 20 000 tekens tellen, en een `audio`-deel moet `audio/*` zijn.
3. **De partij wordt gecontroleerd voordat er audio wordt opgeslagen** (`parties.get`; een onbekende partij is een 400), omdat een opgeslagen opname een gelegerde `document.ingested` is en nooit kan worden teruggedraaid.
4. **Een bewaarde opname** wordt eerst opgezocht op `source = 'phone-voice'`, `sourceRef = 'phone:<clientId>'`. Wordt die niet gevonden, dan worden de bytes in de kluis geschreven (`storeFile`) en geregistreerd (`documents.registerUpload`, titel uit de bestandsnaam, `receivedAt` = het tijdstip van het gesprek). Dit voegt **één `document.ingested`-ledgergebeurtenis** toe (`ingestDocument` ontdubbelt op sha256, dus bytes die de kluis al heeft voegen niets toe). Een nieuwe poging vindt het bestaande document en slaat niets twee keer op.
5. **`suggestions.createVoice`** controleert de partij (en het audiodocument, als dat is meegegeven) opnieuw en voegt dan de suggestie in: `kind 'log-entry'`, `status 'pending'`, `model 'apple-speech-on-device'`, `prompt_version 'voice-v1'`, en `proposed = { clientId, occurredAt, channel, direction: "inbound", summary, details: transcript, participantPartyIds: [party], participantNames: [name], attachmentDocumentIds: [audio?], actionItems: [] }`. `summary` is `voiceSummary()`: de eerste zin, afgekapt op 120 tekens op een woordgrens, deterministisch, zonder model; een afgekapte samenvatting eindigt op "…". "€ 12.50" of "www.cak.nl" beëindigt geen zin. De insert is `ON CONFLICT … DO NOTHING` tegen de gedeeltelijke unieke index `suggestions_voice_client_uq` (migratie 0041), zodat twee gelijktijdige nieuwe pogingen nog steeds één rij opleveren en de tweede met `duplicate: true` wordt beantwoord. **Dit schrijft geen ledgergebeurtenis.**
6. Het antwoord is `{ suggestionId, audioDocumentId, duplicate }`.

**Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceModels.swift` (`VoiceDraft`), `apps/web/src/app/api/mobile/v1/entries/voice/route.ts`, `packages/api/src/routers/suggestions.ts` (`createVoice`), `packages/db/drizzle/0041_doc_source_phone_voice.sql`. Uitgerold (P3-D3).

Bij succes wordt de lokale opname verwijderd (een bewaarde staat nu in de kluis) en zegt het blad "Verstuurd als voorstel. Keur het goed in Voor jou." Bij een duplicaat zegt het "Dit gesprek was al verstuurd. Je vindt het in Voor jou."

![Sent (design: the code shows a line, "Nog een gesprek" and "Klaar")](frames/Voice_quick-log_staat_in_Voor_jou.jpg)

**Wat de worker met een bewaarde opname doet.** Die komt via de docmeta-sweep bij `suggest.docmeta`, zoals elk nieuw document. `isVoiceRecording` (`apps/worker/src/voice-recording.ts`) beslist alleen op het mimetype (elk `audio/*`-document, niet alleen `phone-voice`), geeft het een `document_texts`-rij met extractor `none` en slaat OCR, auto-name, de docmeta-suggestie en de briefcontrole over. Zonder die overslag zou Voor jou Martin vragen een audiobestand op te bergen. De opname verschijnt in Files onder het bronlabel "Spraak". Het blijft een gewoon inboxdocument, dus de synchronisatie van het zakdossier (`../07-dossier/FEATURES.md`) toont en bewaart het zoals elk ander.

**Status:** Gebouwd — `apps/worker/src/voice-recording.ts`, `apps/worker/src/index.ts` (`suggest.docmeta`)

**Goedkeuren (in Voor jou, niet hier).** De wachtrijkaart op het web en de goedkeurroute van de telefoon bouwen de regel allebei met `entryFromProposed` en geven die door aan `suggestions.approveEntry`. Voor een `voice-v1`-suggestie zet dat `source = 'manual'` en neemt het de partij mee die Martin koos (een gedolven suggestie stelt alleen namen voor, dus de deelnemers daarvan beginnen leeg). `approveEntry` lost de bijlagen opnieuw op (een opname die sindsdien is weggegooid of definitief verwijderd valt weg), voegt de regel in met **één `entry.created`-ledgergebeurtenis** en legt het oordeel vast: `approved` als samenvatting en toelichting ongewijzigd zijn, anders `edited`, met de definitieve payload (gouden regel). `direction` wordt altijd voorgesteld als `inbound`, en noch de webkaart noch de telefoon biedt een richtingveld (beide bewerken alleen Samenvatting en Toelichting), dus een gesprek dat Martin zelf startte, wordt nu als `inbound` vastgelegd.

**Status:** Gebouwd — `packages/api/src/entry-from-proposed.ts`, `packages/api/src/routers/suggestions.ts` (`approveEntry`)

### Opnieuw proberen

Een mislukte verzending houdt de tekst en de opname vast en keert terug naar de editor. Martin probeert het opnieuw door weer op "Verstuur als voorstel" te tikken, wat **dezelfde `clientId`** gebruikt, zodat een verloren antwoord het gesprek nooit twee keer kan opslaan. Er is geen automatische nieuwe poging en geen wachtrij: anders dan scans wacht een spraaknotitie alleen in het geheugen, in het open blad.

**Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceLogModel.swift` (`send`, `copy(for:)`)

### Een opgenomen gesprek uitschrijven (toegevoegd 2026-11-03)

Martin: "it would be perfect if i can also record phone calls and transcribe them". verder kan zelf geen telefoongesprek opnemen: iOS geeft geen enkele app van derden het geluid van een gesprek, en `CXCallObserver` zegt alleen *dat* een gesprek begon of eindigde, nooit met wie of wat er gezegd werd. De Telefoon-app kan het wél (tijdens het gesprek: Meer › "Gesprek opnemen"); de opname komt als audiobijlage in Notities. Of Apple dat in het Nederlands en in Nederland aanbiedt, is niet bevestigd. Daarom komt de opname bínnen in verder, en wordt ze daar op de telefoon uitgeschreven.

- **Delen vanuit Notities.** De deelextensie herkent audio (`.m4a`, `.aac`, `.wav`, `.caf`, of elk `audio/*`-type) en uploadt die **niet** als document. Ze laat een `IncomingDrop` van soort `audio` achter in de App Group en zegt "Open verder om het gesprek uit te schrijven."; het blad sluit niet vanzelf, zodat Martin dat kan lezen. Een opname gaat alleen, zonder andere bestanden erbij ("Deel een opname los, één tegelijk, zonder andere bestanden erbij."), en mag groter zijn dan een document (tot 300 MB, gekopieerd en nooit in het geheugen gelezen), omdat ze op de telefoon wordt uitgeschreven. De uploadwachtrij slaat audiodrops over (`importIncoming`).
  **Status:** Gebouwd — `apps/ios/Verder/Upload/IncomingDrop.swift`, `IncomingImport.swift`, `ShareModel.swift`, `apps/ios/VerderShare/ShareViewController.swift`
- **De app opent "Opname uitschrijven".** Bij het openen en bij elke terugkeer naar de voorgrond (ingelogd, en niet over het gespreksblad heen) opent de oudste wachtende opname de spraaknotitie in de modus "Opname uitschrijven". Een notitie waaraan Martin werkt wordt nooit vervangen; de opname wacht dan tot de volgende keer. Dezelfde opname wordt niet twee keer geopend.
  **Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceLogSession.swift` (`openPendingRecording`, `openImport`), `apps/ios/Verder/App/RootView.swift`
- **Een opname die niet te openen is, komt niet steeds terug.** Lukt het kopiëren niet (een volle schijf, een kapotte drop), dan zegt het blad "Deze opname kon niet worden geopend. …" en hoort de drop toch bij deze notitie: dezelfde terugkeer opent hem niet opnieuw, en "Sluiten" of wegvegen wist hem uit de App Group (het origineel blijft in Notities). Een drop waarvan de bytes ontbreken telt niet als wachtend en wordt opgeruimd, en een drop die langer dan een week wacht (`IncomingDrop.audioMaxAge`) verloopt. Een week, en niet de 24 uur van een half geschreven upload: delen vanuit Notities opent verder niet, dus een dag de app niet openen mag een opname niet kosten.
  **Status:** Gebouwd — `VoiceLogModel.importRecording` (de drop wordt vóór het kopiëren geclaimd), `IncomingDrop.pendingAudio`; tests `aDropWhoseCopyFailsIsClosedForGood`, `swipingAwayAFailedDropDeletesIt`, `aDropWithoutItsBytesIsNotPendingAndIsRemoved`, `anOldAudioDropAgesOut` in `CallRecordingImportTests`.
- **Uitschrijven van een bestand, met voortgang.** `SpeechAnalyzer` + `SpeechTranscriber` in `nl_NL`, op het toestel, op verders eigen kopie van het bestand (Complete-beveiliging, met een echte extensie zodat `AVAudioFile` het leest). Een lang gesprek toont een voortgangsbalk en "Opname uitschrijven, op je telefoon… 40%". Dezelfde foutzinnen als bij inspreken (niets verstaan, omzetten lukte niet, Nederlands niet beschikbaar, model ontbreekt met "Opnieuw proberen"); bij een mislukte poging staat "Opnieuw uitschrijven" klaar, en typen werkt altijd. Daarna de gewone editor: tekst bewerkbaar, partij, kanaal, tijdstip, "Verstuur als voorstel" naar dezelfde `POST /api/mobile/v1/entries/voice` — een suggestie, nooit een logboekregel. Een geïmporteerd gesprek biedt geen "Opnieuw opnemen".
  **Status:** Gebouwd — `apps/ios/Verder/Voice/Transcriber.swift` (`transcribe(_:progress:)`), `VoiceLogModel.swift` (`importRecording`, `retryTranscription`). Niet gemeten op de telefoon: of iOS 27.2 `nl_NL` uitschrijft, en hoe lang een gesprek van een uur duurt.
- **"Opname kiezen".** Een knop in het opnamescherm opent de documentkiezer voor audio (Bestanden, Dictafoon-export). Het gekozen bestand wordt gekopieerd; het origineel wordt nooit aangeraakt. Daaronder staat waar de Telefoon-app zijn opnames bewaart.
  **Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceLogView.swift` (`fileImporter`), `VoiceLogModel.importPicked`
- **Bewaar opname, of wissen.** Alleen met "Bewaar opname" aan gaat het geluid mee (als `phone-voice`-document, met het eigen type en de eigen extensie: "Gesprek 2026-11-01.caf", `audio/x-caf`). Anders wist verder zijn kopie én de drop in de App Group na het versturen of na "Sluiten"/"Weggooien"; het origineel in Notities blijft staan. Een mislukte verzending, een vergrendeling of een nieuwe inlog houdt de drop vast, zodat zelfs een afgesloten app de opname opnieuw aanbiedt — onder hetzelfde `clientId` (dat van de drop zelf), zodat een herhaalde verzending na een herstart als `duplicate` terugkomt en nooit een tweede voorstel maakt.
  **Status:** Gebouwd — `VoiceLogModel.send`, `discard`, `VoiceDraft.audioMime`/`audioExtension`
- **De aangevinkte punten van het gespreksblad.** Was er in het laatste uur een gespreksblad actief, dan staat die partij voorgeselecteerd, staan de aangevinkte punten ("Besproken: …") boven de uitgeschreven tekst en is het tijdstip het begin van dat gesprek. iOS zegt niet van welk gesprek een opname is, dus dit is de beste gok en Martin past alles aan voor hij verstuurt. Alleen in het geheugen; uitloggen vergeet het. Zonder recent gespreksblad krijgt de opname het moment van delen als tijdstip.
  **Status:** Gebouwd — `apps/ios/Verder/Call/RecentCallSheet.swift`, `CallSession` (`noteActive`)
- **Fixture:** `-fixtures opname -route opname` toont het uitgeschreven synthetische gesprek met Bewindkantoor Noordkust (gegevensdocument, "A call recording").
  **Status:** Gebouwd — `apps/ios/Verder/FixtureData/opname/`, `apps/ios/Verder/Fixtures/FixtureEnvironment.swift`
- **verder neemt het gesprek zelf op.** Niet mogelijk: iOS laat geen app van derden een telefoongesprek horen of opnemen.
  **Status:** Niet mogelijk op iOS

## Toestanden

De toestanden die de code nu toont. De ontworpen blad-vullende layouts voor een aantal ervan zijn eigen functies onder [Ontworpen, nog niet gebouwd](#ontworpen-nog-niet-gebouwd).

**Status:** Gebouwd — elke rij hieronder; `apps/ios/Verder/Voice/VoiceLogModel.swift` (`Copy`, `speechLine`, `partiesLine`, `phaseLine`)

| Toestand | Wat de code toont | Wat Martin kan doen |
|---|---|---|
| Spraak controleren | "spraakherkenning controleren…" onder de titel; opnameknop verborgen | wachten, of "Typ zelf" |
| Model downloaden (eerste gebruik) | "Nederlands spraakmodel wordt geïnstalleerd…" (geen voortgangscijfer); opnameknop verborgen | "Typ zelf" |
| Model kon niet worden geïnstalleerd (offline, geen ruimte, geweigerd) | "Het Nederlandse spraakmodel is nog niet op je telefoon. Probeer het opnieuw met internet, of typ zelf wat er besproken is."; opnameknop verborgen. Ook bereikt als het model verdwijnt tussen openen en omzetten: dan opent de editor met een lege tekst en deze regel, zonder aparte melding | "Opnieuw proberen" (controleert opnieuw en vraagt de installatie opnieuw aan), of "Typ zelf" |
| Nederlands niet ondersteund op deze iOS/dit toestel | "Nederlandse spraakherkenning is niet beschikbaar op deze iPhone. Typ zelf wat er besproken is."; opnameknop verborgen | "Typ zelf" |
| Microfoon geweigerd | "verder mag de microfoon niet gebruiken. Zet het aan in Instellingen." | "Open Instellingen", of "Typ zelf" |
| Recorder startte niet | "Opnemen lukte niet. Probeer het nog eens." | opnieuw drukken |
| Druk te kort | "Houd de knop ingedrukt zolang je praat." | indrukken en vasthouden |
| Niets gehoord | editor met een lege tekst; "Er is niets verstaan. Neem opnieuw op, of typ zelf wat er besproken is." | "Opnieuw opnemen", of typen |
| Omzetten mislukt | editor; "Omzetten naar tekst lukte niet. Typ zelf wat er besproken is; de opname blijft bewaard tot je verstuurt." | typen, of "Opnieuw opnemen" |
| Partijen laden | "Partijen laden…" (alleen vóór het eerste antwoord) | tekst bewerken; versturen is uitgeschakeld |
| Helemaal geen partijen | "Nog geen partijen in je dossier. Een gesprek leg je vast bij een partij, dus versturen kan pas als er een is. Voeg die toe in verder en probeer het opnieuw." | "Opnieuw proberen" |
| Partijen laden mislukt | "De partijen konden niet worden geladen." | "Opnieuw proberen" |
| Offline (geen HTTP-antwoord) | "Geen verbinding. Je tekst blijft staan; probeer het zo opnieuw." | opnieuw versturen |
| Serverfout / 429 | "verder kon het nu niet aannemen. Je tekst blijft staan; probeer het zo opnieuw." | opnieuw versturen |
| Geweigerd (elke andere 4xx, bijv. onbekende partij, 413, 411) | "verder weigerde dit voorstel. Controleer de tekst en de partij." | bewerken, opnieuw versturen |
| Tekst te lang | de verstuurknop blijft uitgeschakeld (de tekst `tooLong` bestaat in het model maar wordt niet door de view getoond) | de tekst inkorten |
| Sessie verlopen (401) | het scherm voor een verlopen sessie (`SessionExpiredView`, "Je sessie is verlopen.") vervangt de app. Het model zet kort "Je sessie is verlopen. Log opnieuw in; je tekst blijft staan.", wat met het blad verdwijnt | inloggen; dezelfde notitie, tekst en opname komen terug |
| Vergrendeld | het hele blad wordt vervangen door het Face ID-vergrendelscherm | ontgrendelen; de notitie is er nog |
| Grote tekst / kleine telefoon | elk lettertype schaalt mee met Dynamic Type en het blad is één scrollview, dus de verstuurknop scrolt met de inhoud mee in plaats van vast te staan | scrollen |

![Speech model downloading (design; the code has no progress bar)](frames/Voice_quick-log_spraak_laden.jpg)
![Not sent, offline (design; the code shows the sentence under the buttons, not as a banner)](frames/Voice_quick-log_niet_verstuurd.jpg)

Het frame "Spraakherkenning staat uit" (toestemming voor spraakherkenning geweigerd) heeft geen tegenhanger in de code. `NSSpeechRecognitionUsageDescription` ("verder zet je opname op je telefoon om in tekst.") is gedeclareerd, maar de app vraagt nooit om `SFSpeechRecognizer`-autorisatie en heeft geen toestand voor een weigering.

## Privacy en beveiliging

- **Achter de vergrendeling.** Het blad noemt partijen, dus het is verpakt in `.lockGated(by: lock)`. Zolang de app vergrendeld is, bestaat de inhoud van het blad niet en staat het Face ID-vergrendelscherm op zijn plek. Openen via de snelle actie bij een koude start vraagt vanzelf om Face ID (`promptOnOpen`), één keer bij openen of heropenen, zoals de rest van de app. De gedeeltelijke vergrendeling van het ontwerp ("Ontgrendel om partijen te laden", "Ontgrendel met Face ID", "Je notitie blijft staan") is niet gebouwd ([Vergrendeld met de notitie behouden](#vergrendeld-met-de-notitie-behouden)).
  **Status:** Gebouwd — `apps/ios/Verder/App/RootView.swift` (`.lockGated(by: lock)` op `VoiceLogSheet`)
- **Niets op het vergrendelscherm of in widgets.** De functie stuurt geen melding en schrijft niets naar de widget-snapshot.
  **Status:** Gebouwd — niets in `apps/ios/Verder/Voice/` roept `notify`, de widget-snapshot of `UNUserNotificationCenter` aan
- **Op de telefoon.** Alleen de opname raakt de schijf: `tmp/voice/<clientId>.m4a` met **`NSFileProtectionComplete`**, dus onleesbaar zolang de telefoon vergrendeld is. De klasse wordt op de map gezet voordat de recorder één byte schrijft, en nogmaals op het bestand. Het transcript, de partij, het kanaal en het tijdstip leven **alleen in het geheugen** (`VoiceLogSession`), nooit op schijf.
  **Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceLogModel.swift` (`protectRecording`, `startRecording`)
- **Verwijderd:** de lokale opname na elke geslaagde verzending, bij "Weggooien", bij "Sluiten", en telkens als er een nieuwe notitie opent (de map wordt geleegd, wat een crash afdekt).
  **Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceLogModel.swift` (`deleteRecording`, `clear`)
- **Audio verlaat de telefoon alleen met "Bewaar opname" aan**, en wordt dan een permanent, gelegerd document (`phone-voice`). Definitief verwijderen ("Definitief verwijderen" op `/files/[id]` op het web, sub-project 11; nooit aangeboden op de telefoon) is de enige manier om het later te vernietigen.
  **Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceModels.swift` (`VoiceDraft`), `apps/web/src/app/api/mobile/v1/entries/voice/route.ts`
- **Uitloggen wist het.** "Uitloggen" in Meer roept `forgetVoice` → `VoiceLogSession.close()` aan, wat de notitie en de opname weggooit. Een sessie die de server *weigerde* (401) houdt de notitie in het geheugen voor de volgende keer inloggen. Dat is bewust: Martin koos er niet voor om weg te gaan.
  **Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceLogSession.swift` (`close`, `sessionEnded`), `apps/ios/Verder/App/RootView.swift` (`forgetVoice`)

## Wie de notitie bezit, en wanneer die blijft bestaan

`VoiceLogSession` (vastgehouden door `VerderApp`, boven de vergrendeling en het inlogscherm) bezit het model. Het blad heeft zelf geen toestand. De regels:

- **Alleen expliciet sluiten gooit weg:** "Sluiten", "Klaar", een veeg over een notitie waar niets in staat, of uitloggen.
- **Een veeg kan geen werk weggooien.** `interactiveDismissDisabled` staat aan zolang de notitie niet-verstuurd werk bevat (opnemen, omzetten, versturen, of bewerken met tekst of een opname).
- **Een blad dat vanzelf verdwijnt, houdt de notitie vast.** Dat geldt voor opnieuw vergrendelen, een 401 of naar de achtergrond gaan. Een lopende opname wordt gestopt en omgezet, nooit weggegooid (`sheetDisappeared`). Opnieuw "Gesprek vastleggen" openen, of opnieuw inloggen, brengt dezelfde notitie terug met dezelfde `clientId`. Een lege notitie wordt gewoon gesloten, zodat er na het inloggen geen leeg blad opduikt.
- **Geforceerd afsluiten van de app verliest de tekst.** Die leeft alleen in het geheugen. De achtergebleven opname wordt verwijderd zodra de volgende notitie opent.

**Status:** Gebouwd — `apps/ios/Verder/Voice/VoiceLogSession.swift`, `VoiceLogView.swift` (`holdsUnsentWork`); tests in `apps/ios/VerderTests/VoiceLogSessionTests.swift`. Let op: "Sluiten" telt als expliciet sluiten en gooit dus niet-verstuurd werk weg zonder te vragen; zie [Bevestiging voor weggooien](#bevestiging-voor-weggooien-bij-sluiten).

## Ontworpen, nog niet gebouwd

Functies die de definitieve frames, de spec of de design brief definiëren en die de code niet heeft, of maar gedeeltelijk. Elke beschrijft wat ze doet en wat ze nodig heeft. Niets hiervan verandert de wetten: wat het blad er ook bij krijgt, het resultaat blijft een openstaande suggestie die Martin in Voor jou goedkeurt.

### Opnemen

#### Tikken om te starten en tikken om te stoppen

Het rustframe zegt "Houd vast om te praten · of tik één keer om te starten en weer om te stoppen", en "Niets gehoord" herhaalt het ("of tik één keer om te starten"). Eén tik start een opname die handsfree doorloopt tot de volgende tik; dat is van belang als Martin de telefoon nog vasthoudt om een gesprek af te ronden of een brief hardop voorleest. Nu wordt een druk korter dan 0,6 s verwijderd met "Houd de knop ingedrukt zolang je praat.", en krijgen alleen VoiceOver en Switch Control een aan/uit-knop.

**Status:** Nog te bouwen — `VoiceLogModel`: een aan/uit-modus naast het vasthouden, beslist op de duur van de druk (een korte druk start en laat hem doorlopen); `HoldToRecord`: gebaar voor tikken vs. vasthouden; tests dat een tik een lopende opname start, een tweede tik hem stopt en omzet, en dat vasthouden nog werkt zoals nu. Geen serverwijziging.

#### Live transcript tijdens het praten

Terwijl Martin praat, verschijnen zijn woorden boven de knop zodra ze herkend worden (frame "opname"). Bij loslaten wordt diezelfde tekst de tekst van de editor, zodat hij tijdens het gesprek ziet dat het begrepen wordt. Brief §3: "Live on-device transcript, then a parsed preview". Nu verschijnt de tekst pas nadat de vinger loslaat, uit het opgenomen bestand.

**Status:** Nog te bouwen — `Transcribing`: een streamingmodus die `SpeechAnalyzer` live microfoonbuffers voert (een `AVAudioEngine`-tap die ook de `.m4a` schrijft, zodat "Bewaar opname" blijft werken) en voorlopige en definitieve resultaten publiceert; `VoiceLogModel`: een `liveTranscript`; UI boven de knop; tests met een nep-streamingtranscriber. Vereist eerst de meting van Nederlands op het toestel (plan 3 Task 25 stap 1). Nog steeds geen serverterugval.

#### Opnametimer en weergave op het toestel

Tijdens het opnemen toont een weergave de verstreken tijd en waar de spraak verwerkt wordt: "0:14 · NEDERLANDS · OP JE IPHONE". Dat vertelt Martin dat de opname loopt, hoe lang die is, en dat de stem op de telefoon blijft.

**Status:** Nog te bouwen — verstreken tijd in `VoiceLogModel` (vanaf de start van de recorder), de weergave in de view, een test op het starten en stoppen van de timer. Geen serverwijziging.

#### Een opname annuleren: van de knop af schuiven, of "Annuleer"

Tijdens een opname annuleert het van de knop af schuiven van de vinger die ("Schuif van de knop af om te annuleren."), en een knop "Annuleer" doet hetzelfde. Een geannuleerde opname wordt verwijderd, nooit omgezet en nooit verstuurd. Nu *beëindigt* meer dan 80 pt wegbewegen de opname en wordt die nog steeds omgezet, en annuleren bestaat helemaal niet.

**Status:** Nog te bouwen — een sleepvolgend gebaar in `HoldToRecord` in plaats van `onLongPressGesture(maximumDistance: 80)`; `VoiceLogModel.cancelRecording()` (recorder `cancel`, bestand verwijderen, terug naar rust met dezelfde `clientId`); een knop "Annuleer"; tests dat annuleren geen bestand en geen transcript achterlaat.

#### Opname loopt door met het blad omlaag

Martin kan het blad tijdens een (met een tik gestarte) opname omlaag trekken en de app blijven gebruiken. De opname loopt door, en het onderste accessoire van de tabbalk toont "Opname loopt 0:14 Stop" (frame "opname · blad omlaag"; brief §3: "Recording state in the tab accessory"). Tikken op het accessoire opent het blad weer, en "Stop" beëindigt de opname en zet die om.

**Status:** Nog te bouwen — vereist eerst [tikken om te starten](#tikken-om-te-starten-en-tikken-om-te-stoppen) (vasthouden kan het blad niet overleven); `RootView`: een `tabViewBottomAccessory` aangestuurd door `VoiceLogSession` (de Scan-wachtrij tekent zijn strip nu zelf, zie `apps/ios/Verder/Scan/QueueViews.swift`); `VoiceLogSession`: het blad omlaag trekken houdt de opname vast in plaats van die in `sheetDisappeared` te stoppen; tests voor beide.

### De tekst en het gesprek

#### Partij en kanaal uit de tekst gelezen

Na het omzetten leest verder de tekst op een partijnaam die het kent en op woorden die het kanaal noemen ("Gebeld", "langs geweest"), en selecteert beide voor. De gevonden woorden worden in de tekst onderstreept, en de partijrij zegt waar de waarde vandaan komt: "MET WIE · UIT JE TEKST" als die uit de tekst gelezen is, "MET WIE · LAATST GESPROKEN" als het de meest recente partij is (frame "typen"). Terwijl de tekst nog wordt omgezet, tonen de gespreksrijen een laadtoestand (frame "omzetten naar tekst"). Elke waarde blijft een voorstel dat Martin kan wijzigen: er wordt nooit een partij verzonnen, alleen namen die al in zijn dossier staan worden herkend. Brief §3: "a parsed preview (party, channel `call`, date)".

**Status:** Nog te bouwen — een pure matcher op het toestel (partijnamen en organisaties uit `/parties`; een kleine Nederlandse lijst met kanaaltrefwoorden) in `apps/ios/Verder/Voice/`; `VoiceLogModel`: de match, de bron ervan ("uit je tekst" / "laatst gesproken") en de woordbereiken om te markeren; UI; unittests met een fixture van bijna-gelijke namen, zodat een verkeerde match nooit wint van "laatst gesproken". Geen serverwijziging; er wordt niets verstuurd tot Martin op versturen tikt.

#### "Aangepast": wat gehoord is naast wat verstuurd is bewaren

Als Martin het transcript bewerkt, luidt het label "WAT JE ZEI · AANGEPAST" (frame "tekst bewerken"). Volgens de gouden regel (modeluitvoer, oordeel en bewerkingsverschil worden altijd vastgelegd) worden het transcript van de machine en Martins bewerking allebei bewaard, zodat de server kan onderscheiden wat het spraakmodel hoorde en wat hij veranderde. Nu verstuurt de telefoon alleen de definitieve tekst, en gaat het transcript zoals herkend verloren.

**Status:** Nog te bouwen — `VoiceLogModel`: de herkende tekst naast de bewerkte bewaren en een vlag "aangepast" beschikbaar maken; `VoiceDraft` + route `entries/voice` + `suggestions.createVoice`: een optioneel veld `recognizedTranscript`, opgeslagen in `proposed` (geen ledgerwijziging, de suggestie is geen bewijs); tests aan beide kanten.

#### Partijkiezer: zoeken, recent, A–Z

Tikken op de partijrij opent "Met wie sprak je?": een zoekveld ("Zoek een partij"), een sectie "RECENT" met de partijen met wie Martin het laatst contact had, een sectie "ALLE PARTIJEN · A–Z", een vinkje bij de huidige keuze en "Annuleer" (frame "met wie"). Nu toont een gewoon iOS-menu elke naam op volgorde van meest recent contact, zonder zoeken.

**Status:** Nog te bouwen — alleen UI: een blad over `model.parties` met lokaal zoeken en de twee secties (de route geeft al `lastContactAt` terug, dus "recent" kan bestaan uit de partijen met een contactdatum); tests voor het zoeken en de splitsing.

#### Laatste contact per partij

Elke partijrij in de kiezer toont wanneer Martin hen het laatst sprak ("laatst 31 okt").

**Status:** Deels gebouwd — de server geeft het al terug (`lastContactAt` in `apps/web/src/app/api/mobile/v1/parties/route.ts`, gedecodeerd in `PartyDTO`); de app toont niets. Vereist het kiezerblad en een notatie per Amsterdamse dag.

#### De rol van de partij per rij

Elke partijrij zegt wat de partij voor Martin is: "VERHUURDER", "BEWINDVOERDER", "INCASSO", "WERKGEVER", "GEMEENTE", "SCHULDEISER", "ZORGVERZEKERAAR".

**Status:** Nog te bouwen — het model heeft zo'n veld niet: `parties.kind` is alleen `person` / `organization`, en rollen bestaan alleen per schuld (`debt_parties.role`: `eiser`, `incasso`, `deurwaarder`, `gemachtigde`). Vereist een besluit over de bron (afleiden uit `debt_parties`, of een nieuwe nullable kolom en een migratie), een veld op de route `/parties`, het label in de kiezer, en tests. Het mag nooit worden geraden.

#### Laadtoestanden van partijen in de kiezer

Het kiezerblad heeft eigen toestanden "Nog geen partijen" en "Partijen laden lukt niet", elk met "Opnieuw proberen", en beide zeggen "je notitie blijft staan" (frames "met wie · geen partijen", "met wie · laden lukt niet").

**Status:** Deels gebouwd — beide toestanden en hun nieuwe poging bestaan inline in de editor (`partiesLine`, `retryParties` in `VoiceLogModel.swift`); het kiezerblad waar ze bij horen niet, en de tekst mist "je notitie blijft staan".

### Versturen

#### Waarom de verstuurknop uitgeschakeld is, en wat versturen doet

Onder de verstuurknop zegt een regel wat er gaat gebeuren ("Komt als suggestie in Voor jou. Na jouw akkoord staat het in je logboek."). Als versturen nog niet kan, zegt de regel in plaats daarvan waarom ("Schrijf eerst wat er besproken is.", frame "typen"); brief §2.4: acties worden uitgeschakeld met de reden erbij, nooit stilzwijgend.

**Status:** Deels gebouwd — de uitleg bestaat als faseregel van de editor ("Controleer de tekst. Er gaat niets naar het logboek tot jij het goedkeurt in Voor jou."); een uitgeschakelde knop geeft geen reden (geen tekst, geen partij, of meer dan 20 000 tekens, waarvan de tekst `tooLong` in het model bestaat maar nooit wordt getoond). Vereist een `sendBlockedReason` in het model, de regel in de view en een test per reden.

#### Verstuurknop altijd bereikbaar

De verstuurknop blijft onderaan het blad vastgezet terwijl de inhoud scrolt, ook bij de grootste toegankelijkheidstekstgrootte in een venster van één scherm hoog en op een iPhone SE (frames "voorbeeld", "AX5 · 874-venster", "iPhone SE").

**Status:** Nog te bouwen — alleen UI: de verstuuractie uit de `ScrollView` halen en in een onderste inset plaatsen (`safeAreaInset(edge: .bottom)`); controleren tegen de drie frames.

#### Bevestiging voor weggooien bij sluiten

Het blad sluiten (✕) of tikken op "Weggooien…" terwijl een notitie niet verstuurd is, vraagt eerst: "Deze notitie is nog niet verstuurd." met "Verstuur als voorstel", "Weggooien" (destructief) en "Verder bewerken" (frame "weggooien?"). Nu telt "Sluiten" als expliciet sluiten en gooit het de tekst en de opname direct weg, en doet "Weggooien" hetzelfde. Een veeg is al geblokkeerd zolang de notitie werk bevat, dus de sluitknop is de enige manier om een ingesproken gesprek per ongeluk kwijt te raken.

**Status:** Nog te bouwen — UI: een `confirmationDialog` op Sluiten en Weggooien bij `holdsUnsentWork`, met versturen / weggooien / verder bewerken; `.warning`-haptiek bij de destructieve keuze (brief §2.5 "destructive confirm"); tests dat een niet-verstuurde notitie "Verder bewerken" overleeft en dat sluiten zonder inhoud nog steeds direct sluit.

#### Mislukte verzending met oorzaak en één nieuwe poging

Een mislukte verzending toont bovenaan het blad een melding met titel ("Niet verstuurd" met de oorzaak: "Geen verbinding. Je tekst blijft staan; probeer het zo opnieuw.") en maakt van de hoofdknop "Opnieuw proberen", met "Weggooien…" eronder (frame "niet verstuurd").

**Status:** Deels gebouwd — de oorzaakzinnen en de nieuwe poging met dezelfde `clientId` bestaan (`VoiceLogModel.copy(for:)`, `send`); de melding staat onder de knoppen zonder titel, en de nieuwe poging is dezelfde knop "Verstuur als voorstel". Vereist de plaatsing van de melding en een label voor de nieuwe poging in de view.

#### Opname te groot: versturen zonder

Als de bewaarde opname te groot is om te versturen, zegt de melding dat ("Niet verstuurd · opname te groot … Verstuur alleen de tekst; de opname blijft op je iPhone.") en doet één knop precies dat: "Verstuur zonder opname" (frame "niet verstuurd · verder weigert").

**Status:** Deels gebouwd — de groottecontrole vóór het versturen bestaat (`VoiceDraft.audioMaxBytes`); Martin moet "Bewaar opname" zelf uitzetten en opnieuw versturen. Vereist een actie `sendWithoutRecording()` (zet de schakelaar uit en verstuurt), de knop, en een test. Een 413 van de server zou hier ook naartoe moeten leiden in plaats van naar het algemene "verder weigerde dit voorstel…".

#### Sessie verlopen binnen het blad

Als de sessie tijdens het versturen verloopt, blijft het blad staan: een melding "Je bent uitgelogd · Je sessie is verlopen. Log opnieuw in; je tekst blijft staan." en een hoofdknop "Log opnieuw in" (frame "niet verstuurd · opnieuw inloggen").

**Status:** Deels gebouwd — de notitie overleeft de 401 en komt terug na het inloggen (`VoiceLogSession.sessionEnded` / `sessionStarted`); maar het app-brede scherm "Je sessie is verlopen." vervangt het blad, dus de melding en knop in het blad verschijnen nooit.

#### Vergrendeld met de notitie behouden

Als de app vergrendelt terwijl een notitie open is, blijft de tekst van de notitie zichtbaar, luidt de partijrij "Ontgrendel om partijen te laden · NA FACE ID", en wordt de hoofdknop "Ontgrendel met Face ID" ("Je notitie blijft staan. Na ontgrendelen kun je hem meteen versturen.", frame "voorbeeld · vergrendeld").

**Status:** Nog te bouwen — nu vervangt het vergrendelscherm het hele blad. Vereist een vergrendelingsbewust blad in plaats van `.lockGated`, dat de partijen en de verstuuractie verbergt tot Face ID; het vereist ook een besluit, omdat een transcript meestal de partij noemt ("Gebeld met …"), dus de tekst tonen terwijl de app vergrendeld is, toont precies wat de vergrendeling elders verbergt.

### Na het versturen

#### De suggestiekaart en "Bekijk in Voor jou"

Na een verzending luidt het blad "Staat in Voor jou · Het staat als suggestie in Voor jou. Keur het goed, dan komt het in je logboek." en toont het de nieuwe suggestie als rij ("Gebeld met Woonstichting Lindehof · SUGGESTIE · NU · WACHT OP JOU"). "Bekijk in Voor jou" opent die suggestie; "Klaar" sluit (frame "staat in Voor jou").

**Status:** Deels gebouwd — de server antwoordt met de `suggestionId` en de app heeft al `verder://suggestion/<id>`, dat op de suggestie in Voor jou uitkomt (`apps/ios/Verder/Push/DeepLink.swift`); het model decodeert het id en laat het vallen, en het blad toont een regel met "Nog een gesprek" en "Klaar". Vereist dat het id in `.sent` bewaard wordt, de kaart (titel uit dezelfde afkapping op de eerste zin als `voiceSummary`), de knop, en een test dat die naar de suggestie routeert.

#### Wat er met de opname gebeurde

Na een verzending zegt één regel wat er van de opname geworden is: "OPNAME GEWIST · ALLEEN DE TEKST IS VERSTUURD", of dat die in het dossier bewaard is.

**Status:** Nog te bouwen — alleen UI: het model kent `keepRecording` en `audioDocumentId`; een regel in de verzonden toestand en een test per geval.

#### Het aantal dat wacht op jou werkt meteen bij

Achter het blad gaat "WACHT OP JOU" in Overzicht met één omhoog zodra de suggestie is opgeslagen (4 → 5 in de frames), en Voor jou toont hem.

**Status:** Nog te bouwen — het blad laat niets herladen: Overzicht en Voor jou pakken de suggestie bij hun eigen volgende verversing op, en de badge op het icoon bij de volgende tik van `badge.sync` (tot 5 minuten). Vereist een verversing van `InboxStore` en de samenvatting van het beginscherm na een geslaagde verzending, en een test.

### Spraak- en toestemmingstoestanden

#### Modeldownload met voortgang

De download van Nederlandse spraak bij eerste gebruik toont de voortgang ("Nederlandse spraak laden · Dit gebeurt één keer. Daarna werkt inspreken ook zonder internet.", een balk, "EENMALIG · 38 VAN 61 MB", "Inspreken kan zodra het geladen is.") met "Typ je notitie" als weg verder (frame "spraak laden").

**Status:** Nog te bouwen — de download zelf bestaat (`OnDeviceTranscriber.install`), met alleen de regel "Nederlands spraakmodel wordt geïnstalleerd…". Vereist dat de `progress` van het installatieverzoek via `Transcribing` wordt gepubliceerd, de balk en de cijfers, en een test met nepvoortgang.

#### Download gaat vanzelf verder als er weer verbinding is

Een download die stopt door gebrek aan internet zegt waar hij stopte ("Geen internet. Het laden gaat vanzelf verder zodra je weer online bent. · GESTOPT BIJ 38 VAN 61 MB") en gaat vanzelf verder als de verbinding terugkomt, met "Opnieuw proberen" nog steeds beschikbaar (frame "spraak laden lukt niet").

**Status:** Nog te bouwen — nu is de fout één zin ("Het Nederlandse spraakmodel is nog niet op je telefoon…") en start alleen "Opnieuw proberen" (`retrySpeech`) het opnieuw. Vereist een netwerkpadbewaking die `install()` opnieuw probeert zolang het blad open is, het cijfer waar het stopte, en tests.

#### Spraakherkenning staat uit

Als spraakherkenning voor verder geweigerd is, zegt het blad dat ("Spraakherkenning staat uit · verder zet je stem op je iPhone om in tekst. Zet Spraakherkenning aan in Instellingen → verder.") met "Open Instellingen" en "Typ je notitie" (frame "spraakherkenning uit").

**Status:** Nog te bouwen — `NSSpeechRecognitionUsageDescription` is gedeclareerd, maar de app vraagt of leest nooit de autorisatie voor spraakherkenning. Meet eerst op de telefoon of `SpeechTranscriber` die autorisatie op iOS 27.2 überhaupt nodig heeft; zo ja, voeg dan het verzoek toe, een spraaktoestand `denied`, het scherm en een test. Zo nee, dan is het frame overbodig en moet het vervallen.

#### Uitleg vóór de microfoonvraag

Voordat iOS om de microfoon vraagt, legt verder op één scherm uit waarom het die wil, met één knop "Ga verder" en geen sluitknop; daarna volgt de systeemmelding (brief §3, "Permission pre-prompts": één scherm per toestemming, bij eerste gebruik).

**Status:** Nog te bouwen — de eerste keer vasthouden gaat direct naar de systeemmelding. De working tree heeft hetzelfde patroon voor de camera (`CameraPrePrompt` in het niet-gecommitte `apps/ios/Verder/Scan/ScanPermissionViews.swift`) om te volgen; vereist een microfoonvariant, een controle op eerste gebruik vóór `requestPermission`, en een test.

#### Blad-vullende toestanden met één volgende stap

"Microfoon staat uit", "Niets gehoord" en "Omzetten lukte niet" hebben elk een eigen blad: een symbool, een titel, één zin, een primaire actie en "Typ je notitie" (frames "microfoon uit", "niets gehoord", "omzetten lukt niet"). "Niets gehoord" begint met "Opnieuw opnemen" ("Te zacht of te kort? …"), "Omzetten lukte niet" begint met "Typ je notitie" en bewaart de opname tot het versturen.

**Status:** Deels gebouwd — elke toestand en zijn acties bestaan, als een zin in de opnamelayout (microfoon, met "Open Instellingen") of in de editor (niets gehoord, omzetten mislukt); zie [Toestanden](#toestanden). Vereist de eigen layouts in de view; geen modelwijziging.

#### Waar de stem heen gaat, vooraf gezegd

Het rustblad zegt "Je stem wordt op je iPhone omgezet. De opname gaat niet mee, tenzij je hem bewaart.", en de omzettoestand zegt "Dit gebeurt op je iPhone. Er gaat niets naar verder tot je verstuurt."

**Status:** Deels gebouwd — de omzetregel zegt "Omzetten naar tekst, op je telefoon…" en de schakelaar legt de opname uit ("Alleen dan gaat de opname naar verder…"); het rustblad zegt er niets over. Alleen UI-tekst.

### Tijdens het gesprek: wat vertellen, wat vragen (toegevoegd 2026-11-03)

Martin vroeg op 2026-11-03: "as for voice, it would be perfect if i can also record phone calls and transcribe them" en "maybe show tips / reminders to tell or ask about live while in the call, on screen in the app". Zijn keuze: gesprekspunten uit de **dossiergegevens** plus **één samenvattingsregel van AI**, nu bouwen.

#### Een telefoongesprek opnemen en uitschrijven

Wat iOS toelaat, online nagegaan vóór de bouw: een app van derden kan een telefoongesprek **niet opnemen en niet meeluisteren**. De Telefoon-app heeft een eigen opname (Meer → "Gesprek opnemen", bewaard in Notities), maar die hangt af van regio en taal, en of die in het Nederlands beschikbaar is, is niet bevestigd. `CXCallObserver` vertelt een app alleen *dat* een gesprek begint of eindigt, nooit met wie of wat er gezegd wordt. verder luistert dus niet mee; het zet het dossier voor Martin klaar (hieronder), en na het gesprek legt hij het vast met de gewone spraaknotitie.

**Status:** Niet mogelijk op iOS — geen API; de opname van de Telefoon-app zelf is niet gemeten op Martins toestel.

#### Gesprekspunten per partij: "Vertel" en "Vraag"

Martin kiest met wie hij belt en ziet twee korte lijsten, elk hoogstens zes punten, elk met een link naar het stuk waar het vandaan komt. **Vraag**: taken die wachten op die partij ("Vraag naar: …", vroegste deadline eerst), mail die hij hun stuurde en waarop na twee dagen nog geen antwoord kwam ("Nog geen antwoord op je mail van 20 okt: …", langste stilte eerst, niet ouder dan 30 dagen), vorderingen waarbij ze betrokken zijn en waarvan het bedrag onbekend is ("Vraag het gevorderde bedrag: …"), en open haltes op een spoor dat over hen gaat ("Bespreek: …"). **Vertel**: wat hij deed sinds hun laatste mail (anders de laatste 30 dagen), nieuwste eerst: afgeronde taken ("Gedaan: …"), mail die te vers is om na te vragen ("Gemaild op 30 okt: …"), stukken die hij hun stuurde ("Opgestuurd op 30 okt: …") en stukken van hen die zijn opgeborgen. Een contactpersoon telt mee voor haar organisatie. Alles is af te leiden uit het dossier, zonder model; weggegooide en vernietigde documenten verschijnen nooit (effectieve status, twee keer gecontroleerd).

**Status:** Gebouwd — server: `GET /api/mobile/v1/parties/[id]/talking-points` (JSON 401 eerst, `no-store`, 400/404), pure `buildTalkingPoints` en de loader `loadTalkingPoints` (`parties.talkingPoints`); app: het blad "Gesprek voorbereiden" met de lijsten "Vertellen" en "Vragen" (zie hieronder), elk punt met een vinkje en een knop die de bron opent. Fixtures `FixtureData/_shared/parties/<id>/talking-points.json` voor Bewindkantoor Noordkust en Kade & Partners. Niet uitgerold (migraties 0042 en 0043 nog niet op de homelab).

#### De samenvattingsregel van AI

Boven de punten staat één zin, "wat ze het laatst vroegen en hoe dat ervoor staat", gemarkeerd als **"Samenvatting door AI"**. Hij wordt niet in het webverzoek en niet door Ollama gemaakt, maar door de bestaande drafter op de homelab (`ops/proposal-drafter.sh`, `claude -p --tools ""`, het token alleen in de omgeving van dat ene proces). Een nieuwe mail van een bekende partij zet haar samenvatting op `pending` (in dezelfde transactie als de mail); de drafter maakt hem binnen een paar minuten opnieuw. Het antwoord wordt **geweigerd** als het een id noemt dat niet in de verzamelde context stond, en de ruwe modeluitvoer, de prompt en de context blijven altijd bewaard (gouden regel) — niet alleen van de laatste poging: `party_briefs` wordt bij elke nieuwe versie overschreven, dus elke poging (goedgekeurd, geweigerd, mislukt of te laat) wordt ook toegevoegd aan `party_brief_drafts`, waarin niets wordt gewijzigd of verwijderd. De app krijgt de zin **alleen** als hij `ready` is; tijdens `pending`, `drafting` of na `failed` is er geen zin, ook niet de vorige. Geen bewijs: geen ledgergebeurtenis.

**Status:** Gebouwd — server en drafter (migratie 0042 `party_briefs`, migratie 0043 `party_brief_drafts` voor de geschiedenis, `briefs-pending`, `briefs-store`, `validateBrief`, de tweede lus in `proposal-drafter.sh`); in de app bovenaan het blad als kaart **"AI-samenvatting · 30 okt"** (altijd als AI gemarkeerd, met de dag waarop hij is geschreven); een tik klapt "Gebaseerd op" open met de bronnen, elk een knop naar zijn scherm (een mail of vordering opent Dossier). Geen kaart als er geen `ready`-samenvatting is. Niet gemeten: een echte samenvatting op echte mail, en de vertraging na een echte mail.

#### Een samenvatting klaarzetten bij nieuwe mail

`ingestRawEmail` markeert de afzender (en de organisatie van een contactpersoon) als `pending` zodra een mail van een bekende partij binnenkomt, behalve bij het opzoeken van bonnetjes. Tien mails geven één nieuwe samenvatting, niet tien.

**Status:** Gebouwd — `apps/worker/src/briefs/mark.ts`, `apps/worker/src/gmail.ts`; tests in `apps/worker/src/briefs/store.test.ts`.

#### Gesprek voorbereiden: het blad openen

Het blad hoort bij één partij en opent op drie plekken: de kaart **"BELLEN"** in Dossier (partijen op volgorde van laatste contact, zes zichtbaar, "Alle partijen (n)" voor de rest), lang drukken op een item in Voor jou dat een partij heeft (een voorstel of vraag; ook als VoiceOver-actie "Gesprek voorbereiden"), en de knop "Gesprek voorbereiden" onder de afzender van een voorstel. Bovenaan: "GESPREK VOORBEREIDEN", de naam van de partij, "bijgewerkt 09:41", dan de AI-kaart, "2 van 5 besproken" met een balk, "VERTELLEN" en "VRAGEN". Een lege lijst zegt "Niets om te vertellen." / "Niets om te vragen.". Een tik op een punt vinkt het af (staalkleur, doorgestreept, selectie-haptiek); het pijltje opent de bron en zet het blad opzij. Nergens amber: iets om aan een ander te vragen wacht niet op Martin. Het blad is vergrendeld achter Face ID (het noemt de partij). Onderaan, één keer: "verder luistert niet mee: iOS laat geen app een telefoongesprek opnemen. Leg het na afloop vast met je stem."

**Status:** Gebouwd — `apps/ios/Verder/Call/CallPrepSheet.swift`, `CallSession.swift`, `CallChecklist.swift`; de server geeft `partyId` mee op voorstel-items in Voor jou en op `proposals.get`. Tests in `CallPrepTests`. Fixture `call`, `-route call:<partyId>`.

#### Zonder verbinding: de laatst opgehaalde punten

Het blad toont eerst de kopie op de telefoon, dan het antwoord van de server; zonder verbinding blijven de laatste punten staan met hun leeftijd ("offline · bijgewerkt 09:41"). Nooit opgehaald en geen verbinding: "Geen verbinding, en deze punten staan nog niet op je telefoon." met "Opnieuw proberen". Vinkjes blijven staan bij een verversing (de punt-id's zijn stabiel). De kopie staat in `Application Support/calls`, `completeFileProtection`, niet in de back-up, en wordt gewist bij uitloggen.

**Status:** Gebouwd — `CallCache` in `apps/ios/Verder/Call/CallSystem.swift`, `CallPrepModel.swift`; tests in `CallPrepTests`.

#### Uitloggen terwijl de punten nog onderweg zijn

Logt Martin uit (of verloopt zijn sessie ergens in de app) terwijl de gesprekspunten nog van de server komen, dan wordt dat late antwoord weggegooid: het blad toont het niet en het wordt niet opgeslagen. Anders zou het antwoord de naam, het telefoonnummer en de punten van de partij weer op de telefoon zetten, net nadat het wissen ze had weggehaald.

**Status:** Gebouwd — `CallPrepModel.load` controleert de `SessionEpoch` na het ophalen; tests `aReplyLandingAfterTheSessionEndedIsNotWrittenBack` en `theModelIgnoresAReplyFromAnEndedSession` in `CallPrepTests`.

#### Bel

"Bel 06 0000 0002" geeft het nummer aan de Telefoon-app (`tel:`-link) en zet tegelijk de Live Activity aan; het gesprek zelf is van de Telefoon-app. Een nummer met iets anders dan cijfers, één `+` vooraan en scheidingstekens krijgt géén knop, nooit een gok. Zonder nummer: "Geen telefoonnummer bekend in verder. Bel zoals je gewend bent; zet de punten wel op je toegangsscherm."

**Status:** Gebouwd — `CallCopy.dialURL`; de server stuurt `party.phone` mee in de gesprekspunten. Niet gemeten: op Martins telefoon (alleen de simulator).

#### Live Activity tijdens het gesprek

Start bij "Bel" of met "Toon tijdens het gesprek". Op het toegangsscherm en in het compacte en minimale Dynamic Island staan **alleen aantallen** ("Gesprek · verder", "2 van 5 besproken", "2/5"), nooit de naam van de partij of de tekst van een punt: iedereen kan een toegangsscherm lezen. De naam zit niet eens in de gegevens van de Live Activity. Alleen het uitgeklapte Dynamic Island (ontgrendeld gebruik) toont "VOLGENDE" met de tekst van het eerstvolgende open punt, gemarkeerd als privacygevoelig. Afvinken in de app werkt de Live Activity direct bij. Een tik opent het blad weer (`verder://call`). "Niet meer tonen" haalt hem weg; staan Live Activities uit in Instellingen, dan zegt het blad dat.

**Status:** Gebouwd — `apps/ios/Verder/Shared/CallActivity.swift` (`CallActivityAttributes`, `CallActivityFaces`), `apps/ios/Verder/Widget/CallActivityViews.swift`, `apps/ios/VerderWidget/CallLiveActivity.swift`, `NSSupportsLiveActivities`; de privacyregel is getest (en met een mutatie gecontroleerd) in `CallPrepTests`. Niet gemeten: de Live Activity op een echt toegangsscherm en in het Dynamic Island.

#### Gesprek afgelopen: vastleggen

Als iOS (`CXCallObserver`) meldt dat een gesprek is afgelopen terwijl het blad open is of zijn Live Activity loopt, stopt de Live Activity en komt het blad terug met "Het gesprek is afgelopen.", "Gesprek vastleggen" en "Niet nu". "Gesprek vastleggen" opent de spraaknotitie met de afgevinkte punten als "Besproken: …" bovenaan (Martins eigen woorden komen eronder), de partij al gekozen en het tijdstip waarop het gesprek begon. Het blijft een **suggestie** die Martin in Voor jou goedkeurt. Een gesprek dat eindigt terwijl er geen blad actief is, doet niets; CallKit zegt niet met wie het gesprek was, dus de regel gaat over het blad, nooit over het nummer. Een notitie waar al tekst of een opname in zit, wordt nooit overschreven.

**Status:** Gebouwd — `CallSession.handle`, `logCall`, `VoiceLogModel.apply`, `VoiceLogSession.open(prefill:)`; tests in `CallPrepTests` (met een nep-observer) en `VoicePrefillTests`. Niet gemeten: een echt telefoongesprek op Martins toestel.

#### Terug uit de Telefoon-app

Na "Bel" neemt de Telefoon-app het scherm over en zet iOS verder het hele gesprek stil. Het bericht dat het gesprek is afgelopen kan dan te laat komen, samengevoegd worden of helemaal wegblijven. Daarom kijkt verder elke keer dat de app weer op de voorgrond komt bij iOS na welke gesprekken er nu nog lopen (`CXCallObserver.calls`). Een gesprek dat verder zag beginnen en dat niet meer loopt (of als afgelopen staat), is afgelopen: de Live Activity stopt en het blad komt terug met "Gesprek vastleggen", met het begintijdstip van dat gesprek. Zonder deze controle bleef de Live Activity tot uren na het gesprek op het toegangsscherm staan, en kon het einde van een later, ander gesprek voor dit gesprek worden aangezien. Alleen gesprekken die verder zag beginnen tellen: een Live Activity die Martin met de hand aanzette zonder te bellen, blijft staan als hij van app wisselt. Een gesprek dat begon terwijl er geen blad actief was, wordt bij terugkomst vergeten, zodat een later blad het niet overneemt.

**Status:** Gebouwd — `CallSession.reconcile`, `CallObserving.currentCalls` (`LiveCallObserver`), aangeroepen vanuit `RootView` bij `scenePhase == .active`; tests in `CallPrepTests` (begin gezien, geen einde, terugkomst zonder lopend gesprek; gesprek als afgelopen vermeld; nog in gesprek; handmatige Live Activity; oud gesprek van vóór het blad). Niet gemeten: op Martins toestel; dat moet één keer gebeuren voordat dit als klaar geldt.

#### Gebeld, maar het begin nooit gezien

Na "Bel" kan iOS verder al stilzetten voordat het bericht "gesprek begonnen" binnenkomt. Dan kent verder bij terugkomst geen enkel gesprek, en zou de vorige controle niets doen: de Live Activity bleef staan en het einde van een later, ander gesprek werd voor dit gesprek aangezien. Nu onthoudt het blad wanneer Martin op "Bel" tikte. Is verder daarna naar de achtergrond gegaan (de Telefoon-app nam het scherm over) en loopt er bij terugkomst geen gesprek meer, dan is het gesprek afgelopen: de Live Activity stopt, het blad komt terug met "Gesprek vastleggen", en het tijdstip van "Bel" geldt als begin. Loopt er nog een gesprek, dan blijft alles staan. Tikt Martin in de vraag "Bel …?" van iOS op Annuleer, dan ging verder nooit naar de achtergrond en wordt er niets beëindigd. Die eerste terugkomst zonder achtergrond en zonder lopend gesprek telt als geannuleerd en vergeet het "Bel" ook meteen: anders bleef het staan tot verder later wél naar de achtergrond ging (telefoon op slot, even iets opzoeken in een andere app), en beëindigde de terugkomst daarna een gesprek dat nooit plaatsvond. Loopt er bij die terugkomst wel een gesprek, dan was het geen annulering en blijft het "Bel" staan. Een gesprek eindigt zo maar één keer, ook als iOS de berichten "begonnen" en "afgelopen" van dat gesprek pas daarna aflevert (een stilgezette app krijgt ze bij het hervatten, in een volgorde die niemand heeft gemeten): wat iOS op dat moment nog als gesprek noemt, en een "begonnen" dat binnen een minuut daarna binnenkomt, horen bij het gesprek dat al is beëindigd. Zo komt "Gesprek vastleggen" niet terug nadat Martin op "Niet nu" tikte, en beëindigt een los binnengekomen "begonnen" nooit een later blad. Een nieuwe tik op "Bel" sluit die minuut meteen. Een Live Activity die Martin met de hand aanzette zonder te bellen, blijft nog steeds staan.

**Status:** Gebouwd — `CallSession.bel` onthoudt `dialledAt`, `CallSession.sceneEnteredBackground` (vanuit `RootView` bij `scenePhase == .background`), `CallSession.reconcile`; tests `aDialledCallWhoseStartWasNeverSeenEndsOnReturn`, `aDialledCallStillLiveIsKeptEvenUnseen`, `aCancelledDialPromptEndsNothing`, `aCancelledDialPromptStaysEndedNothingAfterALaterBackground`, `aReturnDuringALiveDialledCallKeepsTheDial`, `lateCallKitEventsAfterADialPathEndAreThatSameCall`, `callsListedAtADialPathEndAreSpent` en `aDialEndsOnlyOnce` in `CallPrepTests` (`CallSession.lateEchoWindow`, 60 s). Niet gemeten: op Martins toestel, en ook niet of iOS het "Bel …?"-venster echt alleen als inactief (niet als achtergrond) laat gelden; beide moeten één keer met een echt gesprek gebeuren voordat dit als klaar geldt.

### Terugkoppeling

#### Haptiek buiten de opname

Geen haptiek zolang de microfoon aan staat (brief §2.5, R13). Buiten de opname geldt de kaart van de brief: `.error` als een verzending mislukt (met de nieuwe poging inline), en `.warning` bij een destructieve bevestiging ([Bevestiging voor weggooien](#bevestiging-voor-weggooien-bij-sluiten)).

**Status:** Deels gebouwd — de helft "geen tijdens het opnemen" klopt (het blad heeft helemaal geen `.sensoryFeedback`); de `.error` bij een mislukte verzending ontbreekt, anders dan bij Overzicht, Scan en het scherm voor een verlopen sessie, die hem al gebruiken. Vereist een `.sensoryFeedback(.error, …)` op de melding van een mislukte verzending.

## Regels die het volgt

- **AI-uitvoer is een suggestie.** Het transcript is machine-uitvoer (`model 'apple-speech-on-device'`). Het komt binnen als openstaande suggestie, en niets komt in het logboek zonder Martins goedkeuring in Voor jou. Het oordeel (`approved` / `edited`) en de definitieve payload worden vastgelegd.
- **Bewijs is alleen-toevoegen.** De suggestie is geen bewijs en voegt geen gebeurtenis toe. Een bewaarde opname is een `document.ingested`, en een goedkeuring is een `entry.created`. Migratie 0041 *voegt* alleen een enumwaarde en een gedeeltelijke index toe.
- **Amber alleen voor wat wacht op Martin.** Het blad gebruikt geen amber. De nieuwe suggestie wacht wel op hem, dus die telt mee in `loadWaiting` (Voor jou, de badge op het icoon, "WACHT OP JOU" in Overzicht).
- **Verzin nooit een feit.** Het tijdstip is standaard het begin van de opname, kan worden gewijzigd en ligt nooit in de toekomst. De samenvatting is een afkapping van zijn eigen woorden, geen parafrase van een model.

## Meldingen, haptiek, synchronisatie

- **Meldingen:** geen vanuit het blad. De nieuwe openstaande suggestie verhoogt de badge bij de volgende tik van `badge.sync` (elke 5 minuten, en alleen bij een wijziging).
- **Haptiek:** geen (de brief vraagt `.error` bij een mislukte verzending; zie [Haptiek](#haptiek-buiten-de-opname)).
- **Offline:** partijen kunnen niet laden (met "Opnieuw proberen"). Een model dat niet geïnstalleerd is, kan niet worden gedownload. Eenmaal geïnstalleerd werken opnemen en omzetten zonder internet. Een verzending mislukt met de offlinezin en houdt alles vast voor een handmatige nieuwe poging. Er is geen achtergrondwachtrij.

## Bekende beperkingen en wat nog niet gemeten is

- **Nederlandse spraak op het toestel is NIET GEMETEN op de telefoon** (plan 3 Task 25 stap 1, nog open, en als openstaand genoemd in het P3-D3-verslag). Niemand heeft gecontroleerd of iOS 27.2 `nl_NL` vermeldt voor `SpeechTranscriber` of het asset ervan installeert. Zo niet, dan toont het blad de toestand "niet beschikbaar" en werkt typen nog steeds. Meet dit voordat erop wordt vertrouwd.
- **Nog geen echt gesprek vastgelegd** (Task 25 stap 4). Het verwachte effect is één openstaande suggestie en **geen** ledgergebeurtenis (of +1 `document.ingested` met "Bewaar opname"), en daarna +1 `entry.created` met `source = 'manual'` bij goedkeuring.
- De serverhelft is **uitgerold** (P3-D3, 2026-11-01: migratie 0041, `/api/mobile/v1/{entries/voice,parties}` live, JSON 401 eerst).
- Niet gebouwd: live transcript, timer, afschuiven om te annuleren, tikken om aan/uit te zetten, het opnameaccessoire in de tabbalk ("Opname loopt 0:14 Stop" in het frame "blad omlaag"), partij en kanaal uit de tekst halen, het doorzoekbare partijblad, de bevestiging "Weggooien?", de link naar Voor jou na het versturen, de downloadvoortgang, de Actieknop en App Intent. Elk ervan, met wat het nodig heeft, staat onder [Ontworpen, nog niet gebouwd](#ontworpen-nog-niet-gebouwd).
- `participantNames` is een momentopname van de naam van de partij op het moment van versturen.
- **Gesprekspunten (2026-11-03): serverhelft gebouwd, NIET uitgerold.** Volgorde bij uitrollen (dezelfde valkuil als 0020–0041, met een ergere fout): rsync, dan `pnpm --filter @verder/db migrate` vanaf de homelab-HOST, pas daarna web+worker opnieuw bouwen. Een worker met deze code laat anders de hele ontvangst van elke mail van een bekende partij mislukken op `relation "party_briefs" does not exist`, en die mail wordt dan elke poll opnieuw geprobeerd en komt nooit binnen.

## Waar in de code

**iOS (`apps/ios/`)**
- Gesprek voorbereiden (2026-11-03): `Verder/Call/` (`TalkingPoints.swift`, `CallChecklist.swift`, `CallPrepModel.swift`, `CallSession.swift`, `CallSystem.swift`, `CallPrepSheet.swift`), `Verder/Shared/CallActivity.swift`, `Verder/Widget/CallActivityViews.swift`, `VerderWidget/CallLiveActivity.swift`; tests `VerderTests/CallPrepTests.swift`
- `Verder/Voice/VoiceLogModel.swift`: alle toestand, elke Nederlandse tekst, versturen, nieuwe poging en bestandsbeveiliging
- `Verder/Voice/VoiceLogView.swift`: het blad (alleen layout), `HoldToRecord`, `VoiceLogFactory`, `holdsUnsentWork`
- `Verder/Voice/VoiceLogSession.swift`: eigendom boven de vergrendeling en het inloggen
- `Verder/Voice/Transcriber.swift`: `Transcribing`, `OnDeviceTranscriber` (SpeechAnalyzer, AssetInventory)
- `Verder/Voice/VoiceRecorder.swift`: `VoiceRecording`, `AudioRecorder`
- `Verder/Voice/VoiceModels.swift`: `PartyDTO`, `VoiceEntryAnswer`, `VoiceChannel`, `VoiceDraft`
- `Verder/App/QuickAction.swift` (+ `SceneDelegate`), `Verder/Push/DeepLink.swift` (`.voice`), `Verder/App/RootView.swift` (blad, vergrendeling, sessiehooks), `Verder/App/VerderApp.swift` (factory), `Verder/More/MoreTab.swift` / `MoreMenu.swift` (ingang, `forgetVoice`)
- `project.yml`: gebruiksteksten, `UIApplicationShortcutItems`
- Tests: `VerderTests/VoiceLogModelTests.swift`, `VoiceLogSessionTests.swift`, `QuickActionTests.swift`, `LinkDestinationTests.swift`, `MoreMenuTests.swift`, `FixtureTests.swift`; fixture `Verder/FixtureData/voice/`

**Server**
- `apps/web/src/app/api/mobile/v1/entries/voice/route.ts` (+ `route.test.ts`)
- `apps/web/src/app/api/mobile/v1/parties/route.ts` (+ `route.test.ts`)
- `apps/web/src/lib/vault-upload.ts` (`readGuardedForm`, `readFormFile`), `apps/web/src/lib/upload-limit.ts`
- `packages/api/src/routers/suggestions.ts` (`createVoice`), `packages/api/src/routers/suggestions-voice.test.ts`
- `packages/api/src/routers/parties.ts` (`recent`, `get`)
- `packages/api/src/voice-summary.ts` (+ test), `packages/api/src/entry-from-proposed.ts` (`VOICE_PROMPT_VERSION`, `source: manual`, gekozen partij)
- `packages/db/drizzle/0041_doc_source_phone_voice.sql`, `packages/db/src/doc-source-voice.test.ts`
- `apps/worker/src/voice-recording.ts` (+ test)
- Gesprekspunten (2026-11-03): `apps/web/src/app/api/mobile/v1/parties/[id]/talking-points/route.ts` (+ test), `apps/web/src/lib/mobile-talking-points.ts` (+ `.fixture.test.ts`), `packages/api/src/talking-points.ts` en `talking-points-load.ts` (+ tests), `packages/db/drizzle/0042_party_briefs.sql`, `packages/db/src/party-briefs-grants.test.ts`, `apps/worker/src/briefs/` (`mark`, `context`, `prompt`, `validate`, `store` + tests), `apps/worker/src/ops/briefs-pending.ts`, `briefs-store.ts` (+ test), `ops/proposal-drafter.sh`

**Documentatie:** spec `docs/superpowers/specs/2026-10-28-iphone-app-design.md` §7.4; plan `docs/superpowers/plans/2026-10-31-iphone-app-plan-3.md` Tasks 24, 25, 27; design brief `docs/superpowers/specs/2026-11-01-iphone-design-brief.md` §3.

## Frames

| Frame | Getoonde toestand | In de code |
|---|---|---|
| [idle](frames/Voice_quick-log_idle.jpg) | blad over Overzicht, klaar om op te nemen | ja, maar met de titel "Gesprek vastleggen", "Typ zelf" in plaats van "Typ je notitie", geen privacyregel, geen tikken om te starten |
| [opname](frames/Voice_quick-log_opname.jpg) | opname met timer en live tekst | opnemen ja; timer, live tekst en "Annuleer" nee |
| [opname · blad omlaag](frames/Voice_quick-log_opname_blad_omlaag.jpg) | blad omlaag, opname in het accessoire van de tabbalk | nee |
| [niets gehoord](frames/Voice_quick-log_niets_gehoord.jpg) | niets gehoord | als zin in de editor, met "Opnieuw opnemen" |
| [omzetten naar tekst](frames/Voice_quick-log_omzetten_naar_tekst.jpg) | omzetten, voorvertoning laadt | een spinner en "Omzetten naar tekst, op je telefoon…" |
| [voorbeeld](frames/Voice_quick-log_voorbeeld.jpg) | editor: tekst, partij, tijd, kanaal, "Bewaar opname" | ja, met een gewoon menu en vijf kanaalchips; geen ontleding |
| [voorbeeld · vergrendeld](frames/Voice_quick-log_voorbeeld_vergrendeld.jpg) | vergrendeld, notitie behouden, partijen verborgen | het vergrendelscherm vervangt het hele blad |
| [tijd wijzigen](frames/Voice_quick-log_tijd_wijzigen.jpg) | het tijdstip van het gesprek wijzigen | ja, als compacte kiezer "Gesprek was om" |
| [tekst bewerken](frames/Voice_quick-log_tekst_bewerken.jpg) | het transcript bewerken, toetsenbord omhoog | ja |
| [met wie](frames/Voice_quick-log_met_wie.jpg) | partijblad met zoeken, recent en A–Z | een gewoon menu met namen, meest recente eerst |
| [met wie · geen partijen](frames/Voice_quick-log_met_wie_geen_partijen.jpg) | geen partijen | ja, inline met "Opnieuw proberen" |
| [typen](frames/Voice_quick-log_typen.jpg) | typen in plaats van praten | ja ("Typ zelf") |
| [weggooien?](frames/Voice_quick-log_weggooien.jpg) | weggooien van een niet-verstuurde notitie bevestigen | nee; "Weggooien" gooit direct weg |
| [staat in Voor jou](frames/Voice_quick-log_staat_in_Voor_jou.jpg) | verstuurd, suggestiekaart, "Bekijk in Voor jou" | een bevestigingsregel, "Nog een gesprek", "Klaar" |
| [spraakherkenning uit](frames/Voice_quick-log_spraakherkenning_uit.jpg) | toestemming voor spraakherkenning uit | zo'n toestand bestaat niet |
| [microfoon uit](frames/Voice_quick-log_microfoon_uit.jpg) | toestemming voor microfoon uit | ja, als zin met "Open Instellingen" |
| [spraak laden](frames/Voice_quick-log_spraak_laden.jpg) | Nederlands model downloaden, met voortgang | alleen de regel, geen voortgang |
| [spraak laden lukt niet](frames/Voice_quick-log_spraak_laden_lukt_niet.jpg) | modeldownload mislukt | ja, met "Opnieuw proberen" |
| [niet verstuurd](frames/Voice_quick-log_niet_verstuurd.jpg) | verzending mislukt, offline | ja, dezelfde zin, niet als balk |
| [niet verstuurd · opnieuw inloggen](frames/Voice_quick-log_niet_verstuurd_opnieuw_inloggen.jpg) | sessie verlopen tijdens het versturen | inloggen vervangt de app; de notitie komt daarna terug |
| [voorbeeld · AX5](frames/Voice_quick-log_voorbeeld_AX5.jpg) | grootste toegankelijkheidstekst, volledige lengte | Dynamic Type ja; niet gecontroleerd tegen dit frame |
| [voorbeeld · AX5 · 874-venster](frames/Voice_quick-log_voorbeeld_AX5_874-venster.jpg) | idem, één scherm hoog, vastgezette verstuurknop | de verstuurknop van de code scrolt met de inhoud mee |
| [voorbeeld · iPhone SE](frames/Voice_quick-log_voorbeeld_iPhone_SE.jpg) | kleine telefoon | één scrollview; niet gecontroleerd tegen dit frame |
| [omzetten lukt niet](frames/Voice_quick-log_omzetten_lukt_niet.jpg) | omzetten mislukt | als zin in de editor |
| [voorbeeld · partijen laden lukt niet](frames/Voice_quick-log_voorbeeld_partijen_laden_lukt_niet.jpg) | partijen mislukt in de editor | ja, "De partijen konden niet worden geladen." met "Opnieuw proberen" |
| [met wie · laden lukt niet](frames/Voice_quick-log_met_wie_laden_lukt_niet.jpg) | partijen mislukt in de kiezer | dezelfde inline regel (er is geen kiezerblad) |
| [niet verstuurd · verder weigert](frames/Voice_quick-log_niet_verstuurd_verder_weigert.jpg) | opname te groot, "Verstuur zonder opname" | gecontroleerd vóór het versturen; de zin vraagt Martin "Bewaar opname" uit te zetten |
