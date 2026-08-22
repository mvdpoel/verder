import { describe, expect, it } from "vitest";
import { euro, nlLabel, stripQuotedReply } from "./render";
import {
  renderDebt, renderDocument, renderEmail, renderEntry, renderFinancialItem,
  renderParty, renderStop, renderTask, renderTrack,
} from "./render";

describe("stripQuotedReply", () => {
  it("cuts a Dutch reply tail", () => {
    const body = [
      "Beste heer Van der Poel,",
      "Bijgaand de bevestiging van de opzegging.",
      "",
      "Op 19 augustus 2026 om 10:12 schreef VerderGroep <info@verdergroep.nl>:",
      "> Kunt u de opzegging bevestigen?",
      "> Met vriendelijke groet",
    ].join("\n");
    expect(stripQuotedReply(body))
      .toBe("Beste heer Van der Poel,\nBijgaand de bevestiging van de opzegging.");
  });

  it("cuts an English reply tail and an Outlook original-message block", () => {
    expect(stripQuotedReply("Thanks, that works.\n\nOn Wed, 19 Aug 2026 at 10:12, X wrote:\n> hi"))
      .toBe("Thanks, that works.");
    expect(stripQuotedReply("Zie bijlage.\n\n-----Oorspronkelijk bericht-----\nVan: iemand"))
      .toBe("Zie bijlage.");
  });

  it("keeps a leading quote block, because cutting there would erase the record", () => {
    expect(stripQuotedReply("> Kunt u dit bevestigen?\n> Groet"))
      .toBe("> Kunt u dit bevestigen?\n> Groet");
  });

  it("leaves an unquoted body untouched apart from trimming", () => {
    expect(stripQuotedReply("  Beste Martin,\n\nGraag een kopie van uw paspoort.  "))
      .toBe("Beste Martin,\n\nGraag een kopie van uw paspoort.");
  });
});

describe("euro / nlLabel", () => {
  it("formats cents the Dutch way", () => {
    expect(euro(4250)).toBe("€ 42,50");
    expect(euro(5)).toBe("€ 0,05");
    expect(euro(-1999)).toBe("-€ 19,99");
  });

  it("renders the stored value with its Dutch label", () => {
    expect(nlLabel("to-cancel")).toBe("to-cancel (op te zeggen)");
    expect(nlLabel("open")).toBe("open");
    expect(nlLabel("iets-onbekends")).toBe("iets-onbekends");
  });
});

describe("renderers", () => {
  it("renders a document with its extracted text and its effective status", () => {
    const r = renderDocument({ title: "Brief Ziggo.pdf", docType: "brief",
      mime: "application/pdf", receivedAt: new Date("2026-08-19T10:00:00Z") },
      { status: "inbox", text: "Uw dossiernummer is 2026-VG-00412." });
    expect(r.title).toBe("Brief Ziggo.pdf");
    expect(r.body).toContain("Documentsoort: brief.");
    expect(r.body).toContain("Status: inbox (postvak in).");
    expect(r.body).toContain("Uw dossiernummer is 2026-VG-00412.");
    expect(r.occurredAt).toEqual(new Date("2026-08-19T10:00:00Z"));
    expect(r.status).toBe("inbox");
  });

  it("labels a discarded document in Dutch, like every other status", () => {
    // doc_status gained a third value; the index is built for Dutch queries
    // (to_tsvector('dutch', …)), so an untranslated status leaves the Dutch
    // word with nothing to match on the moment discarded documents become
    // browsable.
    const r = renderDocument({ title: "image.png", docType: null,
      mime: "image/png", receivedAt: new Date("2026-08-19T10:00:00Z") },
      { status: "discarded", text: "" });
    expect(r.body).toContain("Status: discarded (weggegooid).");
    expect(r.status).toBe("discarded");
  });

  it("renders a logbook entry with its participants and no status", () => {
    const r = renderEntry({ summary: "VerderGroep vraagt paspoort",
      details: "Kopie paspoort opsturen.", channel: "email", direction: "inbound",
      occurredAt: new Date("2026-08-19T09:00:00Z") },
      { participantNames: ["VerderGroep", "Martin van der Poel"],
        documentTitles: ["Brief VerderGroep.pdf"] });
    expect(r.title).toBe("VerderGroep vraagt paspoort");
    expect(r.body).toContain("Kanaal: email (e-mail).");
    expect(r.body).toContain("Richting: inbound (inkomend).");
    expect(r.body).toContain("Betrokkenen: VerderGroep, Martin van der Poel.");
    expect(r.body).toContain("Documenten: Brief VerderGroep.pdf.");
    expect(r.body).toContain("Kopie paspoort opsturen.");
    expect(r.status).toBeNull();
  });

  it("renders an e-mail without its quoted tail", () => {
    const r = renderEmail({ subject: "Opzegging bevestigd", fromAddr: "info@ziggo.nl",
      toAddr: "martin@vanderpoel.pro", sentAt: new Date("2026-08-18T08:30:00Z"),
      bodyText: "Uw abonnement is opgezegd.\n\nOp 17 augustus 2026 schreef Martin:\n> Graag opzeggen." });
    expect(r.title).toBe("Opzegging bevestigd");
    expect(r.body).toContain("Van: info@ziggo.nl.");
    expect(r.body).toContain("Uw abonnement is opgezegd.");
    expect(r.body).not.toContain("Graag opzeggen");
    expect(r.occurredAt).toEqual(new Date("2026-08-18T08:30:00Z"));
    expect(r.status).toBeNull();
  });

  it("renders a financial item as a structured Dutch record", () => {
    const r = renderFinancialItem({ name: "Ziggo", category: "telecom", amountCents: 4250,
      billingCycle: "monthly", paymentChannel: "direct-debit", noticePeriod: "1 maand",
      cancellationMethod: "online", cancellationDetails: "Via Mijn Ziggo opzeggen.",
      accountNumber: "12345678", createdAt: new Date("2026-08-01T00:00:00Z") },
      { status: "to-cancel", providerName: "Ziggo B.V." });
    expect(r.title).toBe("Ziggo");
    expect(r.body).toContain("Naam: Ziggo.");
    expect(r.body).toContain("Categorie: telecom.");
    expect(r.body).toContain("Status: to-cancel (op te zeggen).");
    expect(r.body).toContain("Bedrag: € 42,50 per maand.");
    expect(r.body).toContain("Betaalwijze: direct-debit (automatische incasso).");
    expect(r.body).toContain("Leverancier: Ziggo B.V..");
    expect(r.body).toContain("Opzegtermijn: 1 maand.");
    expect(r.body).toContain("Via Mijn Ziggo opzeggen.");
    expect(r.status).toBe("to-cancel");
  });

  it("renders a debt", () => {
    const r = renderDebt({ creditorName: "Intrum", claimedCents: 125000, principalCents: 100000,
      references_: "DOS-9912", origin: "telefoonabonnement",
      originStory: "Openstaande facturen 2024.",
      createdAt: new Date("2026-07-01T00:00:00Z") },
      { status: "disputed", creditorPartyName: "Intrum Justitia B.V." });
    expect(r.title).toBe("Intrum");
    expect(r.body).toContain("Schuldeiser: Intrum.");
    expect(r.body).toContain("Schuldeiser (partij): Intrum Justitia B.V..");
    expect(r.body).toContain("Status: disputed (betwist).");
    expect(r.body).toContain("Gevorderd bedrag: € 1250,00.");
    expect(r.body).toContain("Hoofdsom: € 1000,00.");
    expect(r.body).toContain("Kenmerk: DOS-9912.");
    expect(r.status).toBe("disputed");
  });

  it("renders a task, dated by its deadline", () => {
    const r = renderTask({ title: "Kopie paspoort opsturen", details: "Naar VerderGroep mailen.",
      dueAt: new Date("2026-09-01T00:00:00Z"), createdAt: new Date("2026-08-19T00:00:00Z") },
      { status: "in-progress", assigneeName: "Martin van der Poel" });
    expect(r.title).toBe("Kopie paspoort opsturen");
    expect(r.body).toContain("Status: in-progress (in behandeling).");
    expect(r.body).toContain("Toegewezen aan: Martin van der Poel.");
    expect(r.body).toContain("Deadline: 2026-09-01.");
    expect(r.occurredAt).toEqual(new Date("2026-09-01T00:00:00Z"));
    expect(r.status).toBe("in-progress");
  });

  it("renders a party", () => {
    const r = renderParty({ name: "VerderGroep", kind: "organization",
      organization: "VerderGroep B.V.", email: "info@verdergroep.nl", phone: "0800-1234",
      notes: "Bewindvoerder.", createdAt: new Date("2026-06-01T00:00:00Z") });
    expect(r.title).toBe("VerderGroep");
    expect(r.body).toContain("Soort: organization (organisatie).");
    expect(r.body).toContain("E-mail: info@verdergroep.nl.");
    expect(r.body).toContain("Bewindvoerder.");
    expect(r.status).toBeNull();
  });
});

describe("renderTrack / renderStop", () => {
  it("renders a track that merged back differently from one that ended", () => {
    const merged = renderTrack({
      title: "WSNP-aanvraag", status: "done", note: null,
      mergesBack: true, droppedMerge: false,
    });
    const ended = renderTrack({
      title: "Ontruiming", status: "ended", note: null,
      mergesBack: false, droppedMerge: false,
    });
    expect(merged.body).toContain("teruggekomen op de hoofdlijn");
    expect(ended.body).toContain("geëindigd");
    // A track that ended is not a failure and the text must not read as one.
    expect(ended.body).not.toMatch(/mislukt|niet afgemaakt/i);
  });

  it("indexes a REFUSED merge the way the map draws it: ending, not merged back", () => {
    // merges_at_stop_id points backwards, so buildTrackMap drops the edge and
    // /timeline draws the spoor as ending. The index has to agree, or one Dutch
    // query contradicts the picture beside it.
    const refused = renderTrack({
      title: "Ontruiming", status: "ended", note: null,
      mergesBack: true, droppedMerge: true,
    });
    expect(refused.body).toContain("geëindigd op zichzelf");
    expect(refused.body).not.toContain("teruggekomen op de hoofdlijn");
  });

  it("dates a stop by what happened, falling back to what is expected", () => {
    const done = renderStop({
      title: "Intake Almere", kind: "meeting", state: "done", note: null,
      happenedAt: new Date("2026-06-19T00:00:00Z"), expectedAt: null,
      stage: null, trackTitle: "WSNP-aanvraag",
    });
    expect(done.occurredAt?.toISOString().slice(0, 10)).toBe("2026-06-19");
    expect(done.body).toContain("WSNP-aanvraag");

    const expected = renderStop({
      title: "Uitspraak", kind: "process", state: "expected", note: null,
      happenedAt: null, expectedAt: new Date("2026-09-01T00:00:00Z"),
      stage: null, trackTitle: "WSNP-aanvraag",
    });
    expect(expected.occurredAt?.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(expected.body).toContain("verwacht");
  });

  it("gives neither a SEARCH_STATUSES status — they are display aids", () => {
    const r = renderStop({
      title: "x", kind: "other", state: "open", note: null, happenedAt: null,
      expectedAt: null, stage: null, trackTitle: "t",
    });
    expect(r.status).toBeNull();
  });
});
