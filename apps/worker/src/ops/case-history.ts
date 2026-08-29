// The case as it actually ran, reconstructed from the mailbox and written onto
// the map and the task list.
//
//   pnpm --filter worker case-history
//
// In production it runs inside the worker container, like extract-texts:
//   docker compose --env-file .env.prod -f docker-compose.prod.yml \
//     exec -T worker pnpm --filter worker case-history
//
// WHY A SCRIPT AND NOT A MIGRATION. Nothing here changes the schema, so there
// is nothing for `migrate` to do; and `ensureCaseMap` must stay the SKELETON it
// documents itself as, because verify.test.ts calls it after a TRUNCATE and a
// forty-stop seed there would make every run of that suite pay for this.
// This is case DATA, and case data belongs in a backfill.
//
// IDEMPOTENT, by title, at four levels: a party with the same email, a track
// with the same title under the same parent, a stop with the same title on the
// same track, and a task with the same title are all left exactly as they are.
// A second run creates nothing and reports zeros — with ONE deliberate
// exception: a stop or task whose document link is still null gets it filled in
// if the document exists NOW. That is what makes the order below safe to get
// wrong. Run the Gmail backfill first and the links land on the first pass; run
// it second and this script picks them up on the next pass.
//
// LEDGER FOOTPRINT, stated plainly because this writes evidence:
//   - parties      → one `party.created` each (only for parties that are new)
//   - tasks        → NONE. `tasks.create` appends no ledger event.
//   - task status  → one `task.status` each, and ONLY for tasks that are not
//                    plain open. An open task carries no status row at all,
//                    exactly as tasks.create leaves it.
//   - tracks/stops → NONE, ever. Neither table is evidence (migration 0023).
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { createDb, ensureCaseMap, schema, type Db } from "@verder/db";
import { appendLedgerEvent } from "@verder/api/src/ledger";
import { setTaskStatus } from "@verder/api/src/task-decide";
import { recordRun } from "../heartbeat";

// --- the source material ------------------------------------------------------

/** Amsterdam wall-clock → instant. Every date below is a date from a mail
 *  header, and the header is what the app is allowed to claim. */
const at = (iso: string) => new Date(`${iso}T12:00:00+02:00`);

type StopState = (typeof schema.stopStateEnum.enumValues)[number];
type StopKind = (typeof schema.timelineEventKindEnum.enumValues)[number];
type TrackStatus = (typeof schema.trackStatusEnum.enumValues)[number];
type TaskStatus = "open" | "in-progress" | "waiting" | "done" | "dropped";

export interface StopSeed {
  orderIndex: number;
  title: string;
  kind: StopKind;
  state: StopState;
  happenedAt?: Date;
  note?: string;
  /** Filename of the vault document that evidences this stop, if there is one. */
  doc?: string;
  /** Title of the task this stop stands for, if there is one. */
  task?: string;
}

export interface TrackSeed {
  title: string;
  status: TrackStatus;
  note: string;
  /**
   * Title of the root stop this track branches at.
   *
   * THREE-VALUED, and the difference is load-bearing. ABSENT means the seed has
   * no opinion: whatever is in the row stays, including an origin Martin
   * recorded by hand in the spoor editor. `null` means the seed asserts there
   * is none and rewires the column to NULL. A title means that stop.
   *
   * It used to be two-valued, and absent meant NULL — so a run of this script
   * silently reverted the merge point he had just recorded and reported it in
   * `rewired`. Structure is the seed's; an origin he typed is content.
   */
  branchesAt?: string | null;
  /** Title of the root stop this track merges back into. Three-valued, as above. */
  mergesAt?: string | null;
  stops: StopSeed[];
}

/** The two spoor pointers, as the seed may or may not have an opinion about them. */
export interface TrackPointers {
  branchesAtStopId: string | null;
  mergesAtStopId: string | null;
}

/**
 * What to rewire on a spoor that already exists — THE one-way door in this
 * script, kept shut.
 *
 * STRUCTURE is the seed's to own; CONTENT is Martin's, and a branch or merge
 * point he set by hand in the spoor editor is content: nobody else knows that
 * Schuldregeling rejoins the line at the beschikking. So an ABSENT field is
 * "no opinion" and produces no key at all; an explicit value — a stop id, or
 * `null` for "this spoor has no recorded origin" — rewires when it differs.
 *
 * The two are distinguishable because nothing between the seed and here
 * collapses `undefined` into `null`. That collapse is the regression: with it,
 * every run of `pnpm --filter worker case-history` erased a pointer he had just
 * recorded and reported the erasure as `rewired`.
 */
export function trackPointerPatch(
  existing: TrackPointers,
  wanted: { branchesAtStopId?: string | null; mergesAtStopId?: string | null },
): Partial<TrackPointers> {
  const patch: Partial<TrackPointers> = {};
  if (wanted.branchesAtStopId !== undefined
    && wanted.branchesAtStopId !== existing.branchesAtStopId) {
    patch.branchesAtStopId = wanted.branchesAtStopId;
  }
  if (wanted.mergesAtStopId !== undefined
    && wanted.mergesAtStopId !== existing.mergesAtStopId) {
    patch.mergesAtStopId = wanted.mergesAtStopId;
  }
  return patch;
}

/**
 * The parties this case has, that the app did not know about yet.
 *
 * NOT cosmetic. `pollGmail` builds its relevance filter from RELEVANT_SENDERS
 * PLUS every `parties.email`, so a creditor that is not a party is a creditor
 * whose mail is never ingested. That is not a hypothetical: the Stam vonnis of
 * 14-07-2026 sat unread in Gmail and reached no surface of this app, because
 * stamdeurwaarders.nl matched nothing. Adding them here closes that hole for
 * everything they send from now on.
 */
export const PARTY_SEED = [
  { kind: "person", name: "D. van Horssen", organization: "Verder Bewind Midden",
    email: "regio3@verderbewindmidden.nl",
    notes: "Dagelijks contact regio 3 sinds augustus 2026: leefgeld, bijzondere bijstand." },
  { kind: "organization", name: "Hafkamp Gerechtsdeurwaarders", organization: "Hafkamp",
    email: "info@hafkamp.nl",
    notes: "Deurwaarder namens Woonhave. Ontruiming aangezegd 29-07-2026, opgeschort 06-08-2026." },
  { kind: "organization", name: "Stam Gerechtsdeurwaarders", organization: "Stam",
    email: "info@stamdeurwaarders.nl",
    notes: "Namens Het CAK. Dossiers 3805606 en 3900757, € 1.141,61. Er ligt een vonnis." },
  { kind: "organization", name: "Trust and Law Incassoservices",
    organization: "Trust and Law", email: "info@collections.trustandlaw.nl",
    notes: "Namens PLM Investments II B.V. Kenmerk 26TNL-001031, € 2.623,15 " +
      "(hoofdsom € 2.197,89 op naam van OpsMate). Vordering gecedeerd door Qred." },
] as const satisfies readonly {
  kind: (typeof schema.partyKindEnum.enumValues)[number];
  name: string; organization: string; email: string; notes: string;
}[];

/**
 * Stops the map already carries under a title that is no longer the right one.
 * Applied FIRST, so every guard below (all of which key on the title) sees the
 * new name and adopts the existing row instead of inserting a second copy.
 *
 * `stops` has INSERT and UPDATE and deliberately NO DELETE, so restructuring
 * the map is always a rename or a move, never a delete-and-recreate. That is
 * the whole reason this table is safe to reorganise at all.
 */
export const STOP_RENAMES = [
  // Migration 0023 copied this off the retired key-events timeline under the
  // wording of the mail's subject line. It is the aanmelding — the first stop
  // of the application, not a station on the main line.
  { from: "Ontvangstbevestiging WSNP aanvraag van Verder Groep.",
    to: "Aanmelding bij Verder" },
  // Split from the leefgeld stop it used to be fused with: the pas going out
  // and the money starting are two dates, and the mail gives both.
  { from: "Betaalpas en leefgeld geregeld", to: "Betaalpas per spoedpost verstuurd" },
] as const;

/**
 * Tracks under a title that is no longer right, renamed before anything else.
 *
 * EMPTY, and the mechanism stays. It carried one entry —
 * "Bijzondere bijstand en inkomenstoeslag" → "Opstart en stukken" — and the
 * target of that rename is a track migration 0026 deleted: its stops are on the
 * spine now. A rename onto a title no seed claims strands the row under a name
 * nothing manages, which is exactly what the test below refuses, so the entry
 * comes out rather than staying as a harmless-looking no-op.
 */
export const TRACK_RENAMES: readonly { from: string; to: string }[] = [];

/**
 * The main line carries the bewindvoering story: aanmelding, de gang naar de
 * rechtbank, de beschikking, de opstart.
 *
 * This reverses the earlier bare-trunk correction, and the reason is that the
 * trunk changed meaning. It used to run to `Einde bewindvoering`; migration
 * 0026 deletes that goal because the map shows history only, so the root is no
 * longer a destination — it is the spine of the story so far. A spine with two
 * stops and nine sporen hanging off it is not a story.
 */
export const SPINE_SEED: StopSeed[] = [
  { orderIndex: 100, title: "Aanmelding bij Verder", kind: "mail", state: "done",
    happenedAt: at("2026-04-16"),
    note: "Bevestiging binnen een dag, met de toezegging binnen twee werkdagen " +
      "te bellen." },
  { orderIndex: 200, title: "Intakegesprek bewindvoering", kind: "meeting", state: "done",
    happenedAt: at("2026-04-22"),
    note: "Stadhuis Almere, Sociaal Domein, 10:00, met Demi Willemse. Eén dag na " +
      "het eerste telefoongesprek ingepland." },
  { orderIndex: 300, title: "Ondernemingen uitgeschreven bij de KvK", kind: "document",
    state: "done", happenedAt: at("2026-04-24"),
    task: "Ondernemingen uitschrijven bij de KvK",
    note: "OpsMate, MP Hold BV en CloudSupport BV ontbonden." },
  { orderIndex: 400, title: "Verzoek onderbewindstelling ingediend", kind: "process",
    state: "done", happenedAt: at("2026-04-24"), doc: "Plan van aanpak bewind.pdf",
    task: "Verzoek onderbewindstelling indienen bij de rechtbank",
    note: "Met plan van aanpak, aanvullend plan van aanpak en toestemmingsverklaring." },
  { orderIndex: 500, title: "Poststukken ingeleverd", kind: "meeting", state: "done",
    happenedAt: at("2026-04-29"), task: "Poststukken aanleveren voor het schuldenoverzicht",
    note: "Alle enveloppen geopend en als doos afgegeven bij de balie Sociaal Domein. " +
      "Zwaarder werk dan het klinkt." },
  { orderIndex: 600, title: "Rechtbank vraagt een verklaring", kind: "process", state: "done",
    happenedAt: at("2026-06-01"),
    note: "Een uitgebreide verklaring over het ontstaan van de schulden, als aanvulling " +
      "op het ingediende verzoek." },
  { orderIndex: 700, title: "Verklaring ontstaan schulden aangeleverd", kind: "mail",
    state: "done", happenedAt: at("2026-06-09"),
    task: "Verklaring over het ontstaan van de schulden schrijven",
    note: "Diezelfde middag door Demi doorgezet naar de rechtbank. Ditzelfde stuk gaat " +
      "op 04-08 opnieuw mee als 'eigen verhaal' voor het moratorium." },
  { orderIndex: 800, title: "Beschikking: onder bewind gesteld", kind: "process",
    state: "done", happenedAt: at("2026-07-14"), doc: "Beschikking M.P. van der Poel.pdf",
    note: "Zaak NLTZ2612548IVB. Dossier bij Verder: 25.04052. Toegewezen." },
  { orderIndex: 900, title: "Dossier naar Team Opstart", kind: "process", state: "done",
    happenedAt: at("2026-07-20"),
    note: "Demi draagt over aan het opstartteam. Hiermee is de aanvraag afgerond " +
      "en komt de lijn weer samen." },
  { orderIndex: 1000, title: "Team Opstart vraagt de opstartstukken", kind: "mail",
    state: "done", happenedAt: at("2026-07-27"),
    note: "Afschriften en inkomensspecificaties van drie maanden, zorgpolis 2026, " +
      "voorschotbeschikking toeslagen, huurverhoging, jaarafrekening water en energie." },
  { orderIndex: 1100, title: "Heen en weer over de bestandsformaten", kind: "mail",
    state: "done", happenedAt: at("2026-07-31"),
    task: "Bankafschriften in een leesbaar formaat aanleveren",
    note: "Vier pogingen — xlsx, pdf, opnieuw xlsx, en ten slotte het PDF-afschrift " +
      "dat direct uit ABN AMRO komt. Zes mails over één bestand." },
  { orderIndex: 1200, title: "Opstart van het dossier afgerond", kind: "document",
    state: "done", happenedAt: at("2026-07-31"), task: "Opstartstukken aanleveren" },
  { orderIndex: 1300, title: "Stukken opgevraagd door Regio 3", kind: "mail", state: "done",
    happenedAt: at("2026-08-12"),
    note: "Acht categorieën, voor de bijzondere bijstand en de individuele " +
      "inkomenstoeslag. Het meeste ligt er al; nieuw zijn de jaaropgaven " +
      "van de afgelopen vijf jaar." },
  { orderIndex: 1400, title: "Regio 3 vraagt de laatste drie loonstroken",
    kind: "mail", state: "done", happenedAt: at("2026-08-25"),
    note: "Van de acht categorieën stond dit nog open." },
  // `done`, not `open`, and the two seeds have to agree on this: `writeStop`
  // never touches `state` on an existing stop, so a stop this seed calls `open`
  // and `ensureCaseMap` calls `done` produces two different maps depending on
  // which one ran after the last truncation. Production is the authority and
  // says done, 28-08 — Martin marked it himself. What is still outstanding
  // hangs on the linked task, which is where "waar wacht het op MIJ" belongs.
  { orderIndex: 1500, title: "Stukken aanleveren", kind: "document", state: "done",
    happenedAt: at("2026-08-28"),
    task: "Stukken aanleveren voor bijzondere bijstand en individuele inkomenstoeslag" },
];

export const TRACK_SEED: TrackSeed[] = [
  {
    title: "Ontruiming Woonhave",
    status: "ended",
    note: "De ontruiming die is afgewend. Geëindigd — en dat is een goede afloop, " +
      "geen mislukking: de dreiging is weg, de achterstand loopt verder op het spoor " +
      "Schuldregeling.",
    stops: [
      { orderIndex: 100, title: "Deurwaarder zegt de ontruiming aan", kind: "process",
        state: "done", happenedAt: at("2026-07-29"),
        note: "Aan de deur, zonder dat er iets van bij Verder bekend was. Eruit per " +
          "18 augustus. Diezelfde ochtend met de grootste spoed om terugbellen gevraagd." },
      { orderIndex: 200, title: "Verder verzoekt de deurwaarder om opschorting", kind: "mail",
        state: "done", happenedAt: at("2026-07-30"), doc: "Beschikking M.P. van der Poel.pdf",
        task: "Deurwaarder aanschrijven met de beschikking en om opschorting verzoeken",
        note: "Regio 3 aan Hafkamp, met de beschikking erbij. Dit is de brief die de " +
          "zaak keert." },
      { orderIndex: 300, title: "Minnelijk voorstel via de deurwaarder", kind: "process",
        state: "done", happenedAt: at("2026-08-04"),
        task: "Minnelijk voorstel doen aan Woonhave via de deurwaarder" },
      { orderIndex: 400, title: "Woonhave akkoord — ontruiming geannuleerd", kind: "process",
        state: "done", happenedAt: at("2026-08-06"),
        note: "Voorwaarde: de lopende huur wordt betaald. In de mail van André staat " +
          "19 augustus als ontruimingsdatum, de deurwaarder zei 18 augustus." },
    ],
  },
  {
    title: "Moratorium",
    status: "ended",
    note: "Het tweede spoor dat naast het minnelijke traject werd ingezet. Nooit " +
      "ingediend — het akkoord van 6 augustus maakte het overbodig.",
    stops: [
      { orderIndex: 100, title: "Spoedverzoek: stukken vóór maandag", kind: "mail",
        state: "done", happenedAt: at("2026-07-31"),
        note: "Vijftien documenten, deadline maandag 3 augustus, over een weekend." },
      { orderIndex: 200, title: "Moratoriumpakket aangeleverd", kind: "document", state: "done",
        happenedAt: at("2026-08-03"), task: "Stukken voor het moratorium aanleveren",
        note: "Zestien bijlagen in één mail, binnen de deadline. Alleen de loonstrook " +
          "van mei ontbrak." },
      { orderIndex: 300, title: "Aanvullende stukken aan André", kind: "mail", state: "done",
        happenedAt: at("2026-08-04"),
        task: "Kopie ID, huurspecificatie en eigen verhaal aanleveren" },
      { orderIndex: 400, title: "Niet ingediend — niet meer nodig", kind: "process",
        state: "done", happenedAt: at("2026-08-06"),
        task: "Moratoriumverzoek indienen bij de rechtbank",
        note: "Het minnelijke akkoord bereikte hetzelfde resultaat zonder rechtbank." },
    ],
  },
  {
    title: "Schuldhulpverlening Almere",
    status: "ended",
    note: "Het crisisdossier bij de gemeente. Geopend en binnen twee dagen weer " +
      "gesloten, met een positieve beëindiging: de crisis waarin zij een rol " +
      "speelden was voorbij.",
    stops: [
      { orderIndex: 100, title: "Toegelaten tot de schuldhulpverlening", kind: "document",
        state: "done", happenedAt: at("2026-08-04"),
        doc: "M.P._van der Poel_04-08-2026 10:56:50.pdf",
        task: "Afspraak sociaal domein Stadhuis Almere" },
      { orderIndex: 200, title: "Dossier gesloten — positief beëindigd", kind: "document",
        state: "done", happenedAt: at("2026-08-06"),
        doc: "SHV-ALMEREWGSbeschikkingbeëindigingPOSITIEF_M.P._vanderPoel_06-08-202610:38:36.pdf",
        note: "Bij een nieuwe aanmelding start het dossier opnieuw op. Dat is precies " +
          "wat er straks moet gebeuren voor de schuldregeling." },
    ],
  },
  {
    title: "Bankrekening en leefgeld",
    status: "open",
    note: "De overname van de ABN-rekening. Het geld loopt weer — de klacht over " +
      "hoe het ging staat nog open.",
    stops: [
      { orderIndex: 100, title: "Rekening overgenomen zonder aankondiging", kind: "process",
        state: "done", happenedAt: at("2026-08-05"),
        note: "Pas geblokkeerd, inloggen onmogelijk, geen geld voor boodschappen. " +
          "Eén berichtje vooraf had dit voorkomen." },
      // `done`, not `open`: indienen IS gebeurd. Het antwoord dat uitblijft
      // hangt aan de gekoppelde taak, die `waiting` staat — en dat is ook waar
      // het hoort, want de headline van de kaart beantwoordt "waar wacht het op
      // MIJ", en dit wacht op Verder. Een open halte hier zou die kop kapen van
      // de stukken voor de bijzondere bijstand, die er wél echt op wachten.
      { orderIndex: 200, title: "Klacht over de bejegening", kind: "mail", state: "done",
        happenedAt: at("2026-08-06"),
        task: "Reactie op de klacht over de geblokkeerde rekening",
        note: "Netjes en zakelijk ingediend bij Demi en André. Er kwam een weerwoord " +
          "over de huurbetaling, geen antwoord op de klacht zelf. Nog steeds onbeantwoord." },
      // Two facts, two stops, because the mail of 18-08 gives both dates and
      // fusing them lost one. The pas went on the spoedpost that morning; the
      // € 50 only starts once it is activated.
      { orderIndex: 300, title: "Betaalpas per spoedpost verstuurd", kind: "process",
        state: "done", happenedAt: at("2026-08-18"),
        note: "Verwachte bezorging binnen twee werkdagen." },
      { orderIndex: 400, title: "Leefgeld loopt: € 50 per week", kind: "process", state: "done",
        happenedAt: at("2026-08-18"), task: "Betaalpas leefgeldrekening activeren",
        note: "Elke maandag, vanaf de activering van de pas. Dertien dagen na de blokkade." },
    ],
  },
  {
    title: "Schuldregeling",
    status: "open",
    note: "Het spoor waar het naartoe moet: eerst het financiële beeld compleet, " +
      "dan een minnelijke regeling met alle schuldeisers. Lukt dat niet, dan pas WSNP.",
    stops: [
      { orderIndex: 100, title: "Verder Almere wacht op de aanmelding", kind: "process",
        state: "done", happenedAt: at("2026-08-06"),
        note: "André, 6 augustus: zodra het dossier zover is dat er een schuldregeling " +
          "kan worden opgestart, zien zij die graag tegemoet." },
      { orderIndex: 200, title: "Financieel beeld compleet, vaste lasten stabiel",
        kind: "process", state: "open",
        task: "Financieel beeld compleet maken en vaste lasten stabiliseren" },
      // The four expected stops this spoor used to carry are gone: migration
      // 0026 deleted every `expected` stop, because the map shows history and
      // the current situation only. What still has to happen lives on the
      // tasks they pointed at, which TASK_SEED keeps — a task is a commitment,
      // a stop was a drawing of a future nobody had lived yet.
    ],
  },
  {
    title: "Schuldeisers buiten het dossier",
    status: "open",
    note: "Drie schuldeisers die je dit voorjaar hebben aangeschreven en die in de " +
      "correspondentie met Verder nergens terugkomen. Bij twee ervan loopt al een " +
      "executietraject.",
    stops: [
      { orderIndex: 100, title: "KvK — aanmaning op OpsMate", kind: "mail", state: "open",
        happenedAt: at("2026-05-26"), task: "KvK-aanmaning OpsMate melden bij de bewindvoerder",
        note: "Factuur 260194200, KVK 77463102 — op een onderneming die op 22 april " +
          "al was uitgeschreven." },
      { orderIndex: 200, title: "Trust and Law — PLM Investments, € 2.623,15", kind: "mail",
        state: "open", happenedAt: at("2026-06-11"),
        doc: "Informatieblad vordering (nieuw).pdf",
        task: "Vordering Trust and Law / PLM Investments melden bij de bewindvoerder",
        note: "Zes aanmaningen tussen 13 mei en 16 juni. Op 12 juni naar Verder verwezen; " +
          "sinds de beschikking is er niets meer op gevolgd." },
      { orderIndex: 300, title: "Stam — Het CAK, € 1.141,61, er ligt een vonnis", kind: "mail",
        state: "open", happenedAt: at("2026-07-14"),
        task: "Vonnis Stam Gerechtsdeurwaarders / Het CAK melden bij de bewindvoerder",
        note: "De sommatie spreekt over het voorkomen van verdere uitvoering van de " +
          "veroordeling. Deze mail is nooit doorgestuurd naar Verder." },
    ],
  },
];

export interface TaskSeed {
  title: string;
  details: string;
  /** Party email to assign to; the party must exist or be in PARTY_SEED. */
  assignee?: string;
  dueAt?: Date;
  doc?: string;
  /** Terminal status, if the task is not simply open. Recorded with its note. */
  status?: Exclude<TaskStatus, "open">;
  statusNote?: string;
}

export const TASK_SEED: TaskSeed[] = [
  // --- afgerond -------------------------------------------------------------
  { title: "Ondernemingen uitschrijven bij de KvK",
    details: "OpsMate, MP Hold BV en CloudSupport BV. Gevraagd bij de intake van 22 april.",
    assignee: "dwillemse@verderbewindmidden.nl", status: "done",
    statusNote: "24-04-2026: KvK bevestigt dat beide BV's zijn ontbonden." },
  { title: "Verzoek onderbewindstelling indienen bij de rechtbank",
    details: "Met plan van aanpak, aanvullend plan van aanpak en toestemmingsverklaring.",
    assignee: "dwillemse@verderbewindmidden.nl", doc: "Plan van aanpak bewind.pdf",
    status: "done", statusNote: "24-04-2026 bevestigd verzonden naar de rechtbank." },
  { title: "Poststukken aanleveren voor het schuldenoverzicht",
    details: "Alle ongeopende post openen en inleveren, als grondslag voor het " +
      "voorlopige schuldenoverzicht.",
    assignee: "dwillemse@verderbewindmidden.nl", status: "done",
    statusNote: "29-04-2026 om 14:00 afgegeven bij de balie Sociaal Domein." },
  { title: "Verklaring over het ontstaan van de schulden schrijven",
    details: "Gevraagd door de rechtbank als aanvulling op het ingediende verzoek. " +
      "Hetzelfde stuk is op 04-08 opnieuw gebruikt als eigen verhaal voor het moratorium.",
    assignee: "dwillemse@verderbewindmidden.nl", status: "done",
    statusNote: "09-06-2026 aangeleverd, diezelfde dag doorgezet naar de rechtbank." },
  { title: "Betalingsoverzicht Woonhave aanleveren",
    details: "Overzicht van alle huurbetalingen sinds 30-01-2025.",
    assignee: "regio3@verderbewindmidden.nl", status: "done",
    statusNote: "29-07-2026 aangeleverd als Woonhave_payments.xlsx." },
  { title: "Opstartstukken aanleveren",
    details: "Afschriften en inkomensspecificaties van drie maanden, zorgpolis 2026, " +
      "voorschotbeschikking toeslagen, huurverhoging, jaarafrekening water en energie. " +
      "Toeslagen bleken niet van toepassing — je hebt er geen.",
    assignee: "teamopstart@verderbewindmidden.nl", status: "done",
    statusNote: "30-07-2026 aangeleverd." },
  { title: "Bankafschriften in een leesbaar formaat aanleveren",
    details: "Team Opstart kreeg het bestand vier keer niet open. Uiteindelijk werkte " +
      "het PDF-afschrift dat direct uit ABN AMRO komt.",
    assignee: "teamopstart@verderbewindmidden.nl", status: "done",
    statusNote: "31-07-2026 gelukt, in de vierde poging." },
  { title: "Stukken voor het moratorium aanleveren",
    details: "Vijftien documenten met een deadline over het weekend: ID, loonstroken, " +
      "afschriften, betaalbewijs huur, aanzegging ontruiming, vonnis, beschikking, " +
      "huurspecificatie, zorgpolis, toeslagen, BKR-overzicht en het eigen verhaal.",
    assignee: "dwillemse@verderbewindmidden.nl", dueAt: at("2026-08-03"), status: "done",
    statusNote: "03-08-2026 geleverd, zestien bijlagen in één mail, binnen de deadline. " +
      "Alleen de loonstrook van mei ontbrak." },
  { title: "Vragen over kinderen, ondernemingen en eerder bewind beantwoorden",
    details: "Onderdeel van het moratoriumverzoek: twee kinderen (13 en 14), ingeschreven " +
      "bij moeder, omgangsregeling om het weekend; meerdere ondernemingen gehad; " +
      "niet eerder onder bewind gestaan.",
    assignee: "dwillemse@verderbewindmidden.nl", status: "done",
    statusNote: "03-08-2026 beantwoord." },
  { title: "Kopie ID, huurspecificatie en eigen verhaal aanleveren",
    details: "Aanvulling die André nodig had om het moratoriumverzoek compleet te maken.",
    assignee: "abruinsma@verdergroep.nl", status: "done",
    statusNote: "04-08-2026, de ochtend na het verzoek." },
  { title: "Afspraak sociaal domein Stadhuis Almere",
    details: "9:30 uur, met André Bruinsma, over het moratorium en de schuldhulpverlening.",
    assignee: "abruinsma@verdergroep.nl", dueAt: at("2026-08-04"), status: "done",
    statusNote: "04-08-2026 gehouden. Diezelfde dag volgde de toelatingsbeschikking." },
  { title: "Deurwaarder aanschrijven met de beschikking en om opschorting verzoeken",
    details: "Regio 3 aan Hafkamp Gerechtsdeurwaarders, met de beschikking als bijlage " +
      "en het verzoek de uithuiszetting op te schorten.",
    assignee: "regio3@verderbewindmidden.nl", doc: "Beschikking M.P. van der Poel.pdf",
    status: "done", statusNote: "30-07-2026 verzonden. Dit is de brief die de zaak keert." },
  { title: "Minnelijk voorstel doen aan Woonhave via de deurwaarder",
    details: "Voorstel voor de huurachterstand, als alternatief voor het moratorium.",
    assignee: "abruinsma@verdergroep.nl", status: "done",
    statusNote: "06-08-2026: Woonhave akkoord, ontruiming geannuleerd." },
  { title: "Betaalpas leefgeldrekening activeren",
    details: "Per spoedpost verstuurd op 18-08. Leefgeld staat op € 50 per week, " +
      "elke maandag.",
    assignee: "regio3@verderbewindmidden.nl", status: "done",
    statusNote: "18-08-2026 verstuurd." },

  // --- vervallen ------------------------------------------------------------
  { title: "Moratoriumverzoek indienen bij de rechtbank",
    details: "Zou uiterlijk donderdag 6 augustus worden ingediend als de deurwaarder " +
      "niet zou reageren.",
    assignee: "abruinsma@verdergroep.nl", status: "dropped",
    statusNote: "06-08-2026: niet meer nodig. Het minnelijke akkoord bereikte hetzelfde " +
      "resultaat zonder rechtbank. Geen mislukking — een kortere weg." },

  // --- open, bij jou --------------------------------------------------------
  { title: "Stukken aanleveren voor bijzondere bijstand en individuele inkomenstoeslag",
    details: "Gevraagd door D. van Horssen op 12-08-2026. Nodig: geldig ID; " +
      "bankafschriften van alle betaal- en spaarrekeningen over 3 maanden (geen " +
      "screenshots); loonstroken van 3 maanden; jaaropgaven van de afgelopen 5 jaar; " +
      "voorschotbeschikking Toeslagen 2026; huurovereenkomst plus laatste huurverhoging; " +
      "polissen (zorg, auto, inboedel). Het meeste ligt er al — op 03-08 bij Demi en " +
      "op 30-07 bij Team Opstart. Nieuw zijn alleen de jaaropgaven van vijf jaar. " +
      "Toeslagen heb je niet; dat is op 30-07 al met screenshot gemeld.",
    assignee: "regio3@verderbewindmidden.nl" },
  { title: "Loonstrook juli 2026 nasturen",
    details: "Toegezegd aan Team Opstart (30-07) en aan Demi (03-08); stond toen nog " +
      "niet in de tool van de werkgever." },
  { title: "Loonstrook mei 2026 opvragen bij TrueFullstaq",
    details: "Ontbrak in het moratoriumpakket omdat je geen toegang meer hebt tot hun " +
      "portaal. Contact liep eerder via Larissa van Woudenberg." },
  { title: "Vonnis Stam Gerechtsdeurwaarders / Het CAK melden bij de bewindvoerder",
    details: "€ 1.141,61, dossiers 3805606 en 3900757, sommatie van 14-07-2026. De brief " +
      "spreekt over het voorkomen van verdere uitvoering van de veroordeling — er ligt " +
      "dus al een vonnis. Deze mail is nooit doorgestuurd naar Verder en komt in geen " +
      "enkel schuldenoverzicht voor. Van de drie gaten is dit de dringendste.",
    assignee: "info@stamdeurwaarders.nl" },
  { title: "Vordering Trust and Law / PLM Investments melden bij de bewindvoerder",
    details: "€ 2.623,15 inclusief rente en kosten, hoofdsom € 2.197,89 op naam van " +
      "OpsMate, kenmerk 26TNL-001031, factuur 24227501. Overgenomen van Qred. Zes " +
      "aanmaningen tussen 13 mei en 16 juni. Op 12 juni heb je ze naar Verder verwezen; " +
      "sinds de beschikking van 14 juli is er niets meer op gevolgd.",
    assignee: "info@collections.trustandlaw.nl", doc: "Informatieblad vordering (nieuw).pdf" },
  { title: "KvK-aanmaning OpsMate melden bij de bewindvoerder",
    details: "Factuur 260194200, KVK 77463102, aanmaning van 26-05-2026 — op een " +
      "onderneming die op 22 april al was uitgeschreven. Waarschijnlijk klein, maar " +
      "het hoort in het schuldenoverzicht." },
  { title: "Ontruimingsdatum controleren: 18 of 19 augustus",
    details: "De deurwaarder zei je 18 augustus, André schreef 19 augustus. Niet meer " +
      "relevant nu de ontruiming van de baan is, wel het rechtzetten waard in het dossier." },

  // --- loopt / ligt bij een ander -------------------------------------------
  { title: "Lopende huur blijft betaald",
    details: "De harde voorwaarde onder het akkoord met Woonhave van 06-08-2026. Zonder " +
      "dit herleeft de ontruiming. Loopt nu via het bewind, maar de voorwaarde staat " +
      "op jouw naam.",
    status: "in-progress",
    statusNote: "Doorlopend, zolang de achterstand niet geregeld is." },
  { title: "Aanvraag bijzondere bijstand kosten bewindvoering indienen",
    details: "Regio 3 dient in zodra de stukken binnen zijn. Deze aanvraag betaalt de " +
      "kosten van de bewindvoering.",
    assignee: "regio3@verderbewindmidden.nl", status: "waiting",
    statusNote: "Wacht op de stukken." },
  { title: "Aanvraag individuele inkomenstoeslag indienen",
    details: "Zelfde stukken, zelfde aanvrager, aparte aanvraag.",
    assignee: "regio3@verderbewindmidden.nl", status: "waiting",
    statusNote: "Wacht op de stukken." },
  { title: "Financieel beeld compleet maken en vaste lasten stabiliseren",
    details: "Toegezegd aan Hafkamp op 30-07-2026 als grond voor het uitstel van de " +
      "ontruiming. Dit is de voorwaarde waaronder de deurwaarder heeft ingestemd.",
    assignee: "regio3@verderbewindmidden.nl", status: "in-progress",
    statusNote: "Loopt sinds de overdracht aan Team Opstart." },
  { title: "Betalingsregeling huurachterstand uitwerken met Hafkamp",
    details: "Het akkoord van 6 augustus schortte de ontruiming op; de regeling voor de " +
      "achterstand zelf moet er nog komen. In de mail is daar niets over terug te vinden.",
    assignee: "info@hafkamp.nl", status: "waiting",
    statusNote: "Ligt bij de bewindvoerder. Nog niet zichtbaar in de correspondentie." },
  { title: "Alle schuldeisers aanschrijven met de beschikking",
    details: "Alleen Hafkamp heeft de beschikking gehad, op 30-07. Trust and Law, Stam " +
      "en de KvK weten formeel nog van niets, terwijl het bewind sinds 14 juli loopt.",
    assignee: "regio3@verderbewindmidden.nl" },
  { title: "Nieuwe aanmelding schuldhulpverlening zodra er een regeling kan starten",
    details: "André, 06-08-2026: bij een nieuwe aanmelding starten zij het dossier weer " +
      "op. Dit is de volgende echte stap op de hoofdlijn.",
    assignee: "abruinsma@verdergroep.nl", status: "waiting",
    statusNote: "Wacht tot het financiële beeld compleet is." },
  { title: "Reactie op de klacht over de geblokkeerde rekening",
    details: "Verstuurd op 06-08-2026 aan Demi en André: dat één berichtje vooraf een week " +
      "zonder eten had gescheeld. Er kwam een weerwoord over de huurbetaling, geen " +
      "antwoord op de klacht zelf.",
    assignee: "dwillemse@verderbewindmidden.nl", status: "waiting",
    statusNote: "Onbeantwoord sinds 06-08-2026." },
];

// --- apply --------------------------------------------------------------------

export interface CaseHistoryResult {
  parties: string[];
  spineStops: string[];
  tracks: string[];
  stops: string[];
  tasks: string[];
  statuses: string[];
  /** Links filled in on a later run, once the document had been ingested. */
  docLinksFilled: string[];
  /** Documents named in the seed that are not in the vault (yet). */
  missingDocs: string[];
  /** Rows adopted under a new title rather than duplicated under it. */
  renamed: string[];
  /** Stops carried from the track they were on to the one the seed names. */
  moved: string[];
  /** Existing tracks whose branch or merge point the seed moved. */
  rewired: string[];
  /** Stops still on the main line that the seed does not account for. */
  strandedOnSpine: string[];
}

export async function applyCaseHistory(
  db: Db, userId: string
): Promise<CaseHistoryResult> {
  const out: CaseHistoryResult = {
    parties: [], spineStops: [], tracks: [], stops: [],
    tasks: [], statuses: [], docLinksFilled: [], missingDocs: [],
    renamed: [], moved: [], rewired: [], strandedOnSpine: [],
  };

  // --- parties ---------------------------------------------------------------
  for (const p of PARTY_SEED) {
    const [seen] = await db.select().from(schema.parties)
      .where(eq(schema.parties.email, p.email)).limit(1);
    if (seen) continue;
    await db.transaction(async (tx) => {
      const [row] = await tx.insert(schema.parties).values({ ...p }).returning();
      await appendLedgerEvent(tx, {
        eventType: "party.created", entityType: "party", entityId: row.id,
        payload: { id: row.id, kind: row.kind, name: row.name,
          organization: row.organization, email: row.email, phone: row.phone,
          notes: row.notes },
      });
    });
    out.parties.push(p.name);
  }
  const parties = await db.select().from(schema.parties);
  const partyIdByEmail = new Map(
    parties.filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p.id]));

  // --- documents, by filename ------------------------------------------------
  // Title is the filename the mail carried, and ingestion copies it verbatim.
  // Oldest wins, so a file mailed twice resolves to the first copy filed —
  // the same rule the rest of this app resolves duplicates with.
  const documents = await db.select().from(schema.documents)
    .orderBy(asc(schema.documents.createdAt), asc(schema.documents.id));
  const docIdByTitle = new Map<string, string>();
  for (const d of documents) if (!docIdByTitle.has(d.title)) docIdByTitle.set(d.title, d.id);
  const wantedDocs = new Set<string>();
  for (const s of SPINE_SEED) if (s.doc) wantedDocs.add(s.doc);
  for (const t of TRACK_SEED) for (const s of t.stops) if (s.doc) wantedDocs.add(s.doc);
  for (const t of TASK_SEED) if (t.doc) wantedDocs.add(t.doc);
  for (const title of wantedDocs) if (!docIdByTitle.has(title)) out.missingDocs.push(title);

  // --- tasks first: a stop can point at a task, never the other way round ----
  const taskIdByTitle = new Map<string, string>();
  for (const seed of TASK_SEED) {
    const docId = seed.doc ? docIdByTitle.get(seed.doc) ?? null : null;
    let [task] = await db.select().from(schema.tasks)
      .where(eq(schema.tasks.title, seed.title))
      .orderBy(asc(schema.tasks.createdAt), asc(schema.tasks.id)).limit(1);
    if (!task) {
      [task] = await db.insert(schema.tasks).values({
        title: seed.title,
        details: seed.details,
        assigneePartyId: seed.assignee
          ? partyIdByEmail.get(seed.assignee.toLowerCase()) ?? null : null,
        dueAt: seed.dueAt ?? null,
        documentId: docId,
        createdBy: userId,
      }).returning();
      out.tasks.push(seed.title);
    } else if (!task.documentId && docId) {
      // The document was ingested after the first run. Fill the link in; this
      // is the one thing a second run is allowed to change.
      await db.update(schema.tasks).set({ documentId: docId })
        .where(eq(schema.tasks.id, task.id));
      out.docLinksFilled.push(`task:${seed.title}`);
    }
    taskIdByTitle.set(seed.title, task.id);

    // Status is recorded ONCE. A task that already has any status change is
    // left alone entirely — Martin may have moved it on since, and this script
    // must never walk that back.
    if (!seed.status) continue;
    const [existing] = await db.select({ id: schema.taskStatusChanges.id })
      .from(schema.taskStatusChanges)
      .where(eq(schema.taskStatusChanges.taskId, task.id)).limit(1);
    if (existing) continue;
    await db.transaction((tx) => setTaskStatus(tx, userId, {
      taskId: task.id, status: seed.status!, note: seed.statusNote,
    }));
    out.statuses.push(`${seed.title} → ${seed.status}`);
  }

  // --- the map ---------------------------------------------------------------
  await ensureCaseMap(db);
  const [root] = await db.select().from(schema.tracks)
    .where(isNull(schema.tracks.parentTrackId));
  if (!root) throw new Error("no root track after ensureCaseMap — refusing to guess");

  // Renames BEFORE anything else, because every guard below keys on the title.
  // A rename that ran late would leave the old row untouched and insert a
  // second one under the new name — two stops for one fact, and no way to
  // delete either.
  for (const r of TRACK_RENAMES) {
    const res = await db.update(schema.tracks).set({ title: r.to })
      .where(eq(schema.tracks.title, r.from)).returning({ id: schema.tracks.id });
    if (res.length) out.renamed.push(`track:${r.from} → ${r.to}`);
  }
  for (const r of STOP_RENAMES) {
    const res = await db.update(schema.stops).set({ title: r.to })
      .where(eq(schema.stops.title, r.from)).returning({ id: schema.stops.id });
    if (res.length) out.renamed.push(`stop:${r.from} → ${r.to}`);
  }

  const stopOn = async (trackId: string, title: string) => {
    const [s] = await db.select().from(schema.stops)
      .where(and(eq(schema.stops.trackId, trackId), eq(schema.stops.title, title)))
      .orderBy(asc(schema.stops.createdAt), asc(schema.stops.id)).limit(1);
    return s;
  };

  /**
   * Find a stop by title ANYWHERE on the map, not just on the track the seed
   * puts it on.
   *
   * This is what lets the seed be declarative about structure. The first run
   * hung ten stations off the main line; this one moves them onto their own
   * tracks, and it can only do that by recognising the row it already wrote.
   * A track-scoped lookup would not find them, would insert duplicates, and
   * `stops` has no DELETE to clean up after that mistake.
   */
  const stopAnywhere = async (title: string) => {
    const [s] = await db.select().from(schema.stops)
      .where(eq(schema.stops.title, title))
      .orderBy(asc(schema.stops.createdAt), asc(schema.stops.id)).limit(1);
    return s;
  };

  /**
   * STRUCTURE is the seed's to own; CONTENT is Martin's.
   *
   * On an existing stop this writes track membership, position and the two
   * evidence links, and touches nothing else — not state, not kind, not the
   * note, not the date. Those are the fields the editor lets him change, and a
   * backfill that reverted his edits every time it ran would be worse than no
   * backfill at all.
   */
  const writeStop = async (trackId: string, seed: StopSeed) => {
    const docId = seed.doc ? docIdByTitle.get(seed.doc) ?? null : null;
    const taskId = seed.task ? taskIdByTitle.get(seed.task) ?? null : null;
    const existing = await stopAnywhere(seed.title);
    if (existing) {
      const patch: Record<string, unknown> = {};
      if (existing.trackId !== trackId) patch.trackId = trackId;
      if (existing.orderIndex !== seed.orderIndex) patch.orderIndex = seed.orderIndex;
      if (!existing.documentId && docId) patch.documentId = docId;
      if (!existing.taskId && taskId) patch.taskId = taskId;
      if (Object.keys(patch).length) {
        await db.update(schema.stops).set(patch)
          .where(eq(schema.stops.id, existing.id));
        if (patch.trackId) out.moved.push(seed.title);
        else if (patch.documentId || patch.taskId) out.docLinksFilled.push(`stop:${seed.title}`);
      }
      return { ...existing, ...patch, id: existing.id };
    }
    const [row] = await db.insert(schema.stops).values({
      trackId, orderIndex: seed.orderIndex, title: seed.title, kind: seed.kind,
      state: seed.state, happenedAt: seed.happenedAt ?? null, note: seed.note ?? null,
      documentId: docId, taskId,
    }).returning();
    out.stops.push(seed.title);
    return row;
  };

  for (const seed of SPINE_SEED) {
    const before = out.stops.length;
    await writeStop(root.id, seed);
    if (out.stops.length > before) out.spineStops.push(seed.title);
  }
  out.stops = out.stops.filter((t) => !out.spineStops.includes(t));

  // Tracks first, ALL of them, before any of their stops: a track's branch
  // point must exist and must still be on the root, and re-pointing an existing
  // track is the other half of the restructure — the side tracks used to branch
  // at "Beschikking: onder bewind gesteld", which is now a stop on the Aanvraag
  // track and no longer a legal branch point for a child of the root.
  const trackByTitle = new Map<string, typeof schema.tracks.$inferSelect>();
  for (const seed of TRACK_SEED) {
    // A spoor with no recorded origin is the normal case now: the map draws its
    // branch from the spine at its own oldest stop, so the pointer is semantic
    // only and NULL honestly means "nobody wrote down what this came out of".
    //
    // `wantedPointer` keeps the three values apart all the way to the UPDATE:
    // undefined stays undefined (no opinion), null stays null (the seed says
    // there is none). Never `?? null` here — that is exactly the collapse that
    // turned "don't touch" into "erase".
    const wantedPointer = async (
      title: string | null | undefined, what: "branches" | "merges",
    ): Promise<string | null | undefined> => {
      if (title === undefined) return undefined;
      if (title === null) return null;
      const stop = await stopOn(root.id, title);
      if (!stop) throw new Error(
        `track "${seed.title}" ${what} at "${title}", which is not on the root`);
      return stop.id;
    };
    const branchId = await wantedPointer(seed.branchesAt, "branches");
    const mergeId = await wantedPointer(seed.mergesAt, "merges");

    let [track] = await db.select().from(schema.tracks)
      .where(and(eq(schema.tracks.title, seed.title),
        eq(schema.tracks.parentTrackId, root.id)))
      .orderBy(asc(schema.tracks.createdAt), asc(schema.tracks.id)).limit(1);
    if (!track) {
      // A brand new row has nothing to preserve, so "no opinion" and "none"
      // land on the same value here — and only here.
      [track] = await db.insert(schema.tracks).values({
        title: seed.title, status: seed.status, parentTrackId: root.id,
        branchesAtStopId: branchId ?? null, mergesAtStopId: mergeId ?? null,
        note: seed.note,
      }).returning();
      out.tracks.push(seed.title);
    } else {
      const patch = trackPointerPatch(track, {
        branchesAtStopId: branchId, mergesAtStopId: mergeId,
      });
      if (Object.keys(patch).length > 0) {
        await db.update(schema.tracks).set(patch).where(eq(schema.tracks.id, track.id));
        out.rewired.push(seed.title);
      }
    }
    trackByTitle.set(seed.title, track);
  }
  for (const seed of TRACK_SEED) {
    const track = trackByTitle.get(seed.title)!;
    for (const stop of seed.stops) await writeStop(track.id, stop);
  }

  // Nothing may be left stranded on the main line. The spine is exactly what
  // SPINE_SEED names, so any other stop still sitting on the root is one this
  // seed forgot to re-home.
  const SPINE_ANCHORS = SPINE_SEED.map((s) => s.title);
  const strays = (await db.select({ title: schema.stops.title }).from(schema.stops)
    .where(eq(schema.stops.trackId, root.id)))
    .map((s) => s.title).filter((t) => !SPINE_ANCHORS.includes(t));
  out.strandedOnSpine = strays;

  return out;
}

// --- entry point ---------------------------------------------------------------

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL
    ?? "postgres://verder:verder@localhost:5432/verder";
  const { db, pool } = createDb(url);
  try {
    // Everything recorded here is recorded AS Martin: these are his tasks and
    // his case. There is exactly one user in this app, but resolve by email
    // rather than "the first row" so a second account never silently inherits
    // authorship of the whole history.
    const email = process.env.CASE_HISTORY_USER ?? "martin@vanderpoel.pro";
    const [user] = await db.select({ id: schema.users.id }).from(schema.users)
      .where(sql`lower(${schema.users.email}) = lower(${email})`).limit(1);
    if (!user) throw new Error(`no user ${email} — set CASE_HISTORY_USER`);

    const result = await applyCaseHistory(db, user.id);
    console.log("case-history:", JSON.stringify(result, null, 2));
    if (result.missingDocs.length) {
      console.log(
        `\n${result.missingDocs.length} document(s) named in the seed are not in the ` +
        "vault yet. Run the Gmail backfill, then run this again to fill the links in.");
    }
    await recordRun(db, "case-history", "ok", result);
  } finally {
    await pool.end();
  }
}
