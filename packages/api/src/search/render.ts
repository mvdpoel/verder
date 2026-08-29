/**
 * Per-entity text rendering for the search index. Pure: no DB, no network, no
 * imports at all. The caller (loadAndRender) passes plain rows plus the values
 * it already resolved — effective status, party names, extracted document text —
 * and gets back { title, body, occurredAt, status }, so one Dutch query hits
 * prose (documents, e-mails) and structured records (items, debts, tasks) alike.
 */

export type Rendered = {
  title: string;
  body: string;
  occurredAt: Date | null;
  /** Written to the denormalized search_chunks.status column; null when the
   *  entity has no status in SEARCH_STATUSES. */
  status: string | null;
};

// Both the stored value and a Dutch label are rendered: Martin searches in
// Dutch ("op te zeggen"), the stored enum values are English ("to-cancel").
const NL: Record<string, string> = {
  identified: "geïdentificeerd", mandatory: "noodzakelijk", allowed: "toegestaan",
  requested: "aangevraagd", "to-cancel": "op te zeggen", canceled: "opgezegd",
  acknowledged: "erkend", disputed: "betwist", "in-settlement": "in regeling",
  settled: "afgewikkeld",
  "in-progress": "in behandeling", waiting: "wachtend", done: "afgerond",
  dropped: "vervallen",
  // track_status. "geëindigd" is a clean outcome — the side track was handled
  // and closed — so it is labelled, never left as a bare English token that
  // Martin's Dutch query cannot reach.
  ended: "geëindigd",
  application: "aanvraag", accepted: "toegelaten", onboarding: "intake",
  "wsnp-start": "start WSNP", settlement: "regeling", "clean-slate": "schone lei",
  call: "telefoon", meeting: "gesprek", email: "e-mail", voicemail: "voicemail",
  letter: "brief", other: "overig", process: "proces", mail: "post",
  inbound: "inkomend", outbound: "uitgaand", internal: "intern",
  person: "persoon", organization: "organisatie",
  monthly: "per maand", quarterly: "per kwartaal", yearly: "per jaar",
  irregular: "onregelmatig", "direct-debit": "automatische incasso",
  invoice: "factuur", inbox: "postvak in", filed: "gearchiveerd",
  discarded: "weggegooid",
};

export function nlLabel(value: string): string {
  const label = NL[value];
  return label && label !== value ? `${value} (${label})` : value;
}

/** "€ 42,50" — integer math only, never parseFloat. */
export function euro(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}€ ${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

function field(label: string, value: string | null | undefined): string | null {
  return value === null || value === undefined || value === "" ? null : `${label}: ${value}.`;
}

function lines(...parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n");
}

function day(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

// First line of a quoted reply tail, Dutch and English clients.
const QUOTE_MARKERS: RegExp[] = [
  /^>/,
  /^-{2,}\s*(oorspronkelijk bericht|original message)\s*-{2,}$/i,
  /^_{10,}$/,
  /^op\s.+\sschreef\b/i,
  /^on\s.+\swrote:?$/i,
  /^(van|from|verzonden|sent):\s/i,
];

/**
 * Drops the quoted tail of a reply so the index holds what was actually
 * written, not the same thread five times over. If the very first line is a
 * marker the body is kept whole — stripping everything would erase the record.
 */
export function stripQuotedReply(body: string): string {
  const rows = body.split(/\r?\n/);
  const cut = rows.findIndex((l) => QUOTE_MARKERS.some((re) => re.test(l.trim())));
  if (cut <= 0) return body.trim();
  return rows.slice(0, cut).join("\n").trim();
}

export function renderDocument(doc: {
  title: string; docType: string | null; mime: string; receivedAt: Date;
}, ctx: { status: string; text: string }): Rendered {
  // title/docType are the EFFECTIVE values and ctx.status is the effective status:
  // document_status_changes wins over documents, and resolving that is the loader's
  // job (Task 5), not this function's. ctx.text is document_texts.text, or "" when
  // extraction has not run yet — the document is still indexed on title + metadata.
  return {
    title: doc.title,
    body: lines(
      field("Document", doc.title),
      field("Documentsoort", doc.docType ?? "onbekend"),
      field("Status", nlLabel(ctx.status)),
      field("Bestandstype", doc.mime),
      ctx.text.trim() || null),
    occurredAt: doc.receivedAt,
    status: ctx.status,
  };
}

export function renderEntry(entry: {
  summary: string; details: string | null; channel: string; direction: string; occurredAt: Date;
}, ctx: { participantNames: string[]; documentTitles: string[] }): Rendered {
  return {
    title: entry.summary,
    body: lines(
      field("Logboekregel", entry.summary),
      field("Kanaal", nlLabel(entry.channel)),
      field("Richting", nlLabel(entry.direction)),
      field("Betrokkenen", ctx.participantNames.join(", ")),
      field("Documenten", ctx.documentTitles.join(", ")),
      entry.details?.trim() || null),
    occurredAt: entry.occurredAt,
    status: null,
  };
}

export function renderEmail(email: {
  subject: string; fromAddr: string; toAddr: string; bodyText: string; sentAt: Date;
}): Rendered {
  return {
    title: email.subject,
    body: lines(
      field("E-mail", email.subject),
      field("Van", email.fromAddr),
      field("Aan", email.toAddr),
      stripQuotedReply(email.bodyText) || null),
    occurredAt: email.sentAt,
    status: null,
  };
}

export function renderFinancialItem(item: {
  name: string; category: string; amountCents: number; billingCycle: string;
  paymentChannel: string; noticePeriod: string | null; cancellationMethod: string | null;
  cancellationDetails: string | null; accountNumber: string | null; createdAt: Date;
}, ctx: { status: string; providerName: string | null }): Rendered {
  const cycle = NL[item.billingCycle] ?? item.billingCycle;
  return {
    title: item.name,
    body: lines(
      field("Naam", item.name),
      field("Categorie", item.category),
      field("Status", nlLabel(ctx.status)),
      field("Bedrag", `${euro(item.amountCents)} ${cycle}`),
      field("Betaalwijze", nlLabel(item.paymentChannel)),
      field("Leverancier", ctx.providerName),
      field("Opzegtermijn", item.noticePeriod),
      field("Opzeggen via", item.cancellationMethod),
      field("Klantnummer", item.accountNumber),
      item.cancellationDetails?.trim() || null),
    occurredAt: item.createdAt,
    status: ctx.status,
  };
}

export function renderDebt(debt: {
  creditorName: string; claimedCents: number | null; principalCents: number | null;
  references_: string | null; origin: string | null; originStory: string | null; createdAt: Date;
}, ctx: { status: string; creditorPartyName: string | null }): Rendered {
  return {
    title: debt.creditorName,
    body: lines(
      field("Schuldeiser", debt.creditorName),
      field("Schuldeiser (partij)", ctx.creditorPartyName),
      field("Status", nlLabel(ctx.status)),
      field("Gevorderd bedrag", debt.claimedCents === null ? null : euro(debt.claimedCents)),
      field("Hoofdsom", debt.principalCents === null ? null : euro(debt.principalCents)),
      field("Kenmerk", debt.references_),
      field("Herkomst", debt.origin),
      debt.originStory?.trim() || null),
    occurredAt: debt.createdAt,
    status: ctx.status,
  };
}

export function renderTask(task: {
  title: string; details: string | null; dueAt: Date | null; createdAt: Date;
}, ctx: { status: string; assigneeName: string | null }): Rendered {
  return {
    title: task.title,
    body: lines(
      field("Taak", task.title),
      field("Status", nlLabel(ctx.status)),
      field("Toegewezen aan", ctx.assigneeName),
      field("Deadline", day(task.dueAt)),
      task.details?.trim() || null),
    // Dated by its deadline where there is one: a task's place on a timeline is
    // when it is due, not when it was typed in.
    occurredAt: task.dueAt ?? task.createdAt,
    status: ctx.status,
  };
}

export function renderTrack(t: {
  title: string; status: string; note: string | null;
  mergesBack: boolean;
  /** The map REFUSED this track's merge (it pointed backwards) and draws the
   *  track as ending. buildTrackMap decides it; this function is told. */
  droppedMerge: boolean;
}): Rendered {
  // A merges_at_stop_id that the map dropped is a pointer, not a drawn line:
  // the track renders as ending on /timeline. Indexing it as "teruggekomen op
  // de hoofdlijn" would make one Dutch query contradict the picture next to it,
  // so the DRAWN outcome wins over the stored pointer.
  const mergesBack = t.mergesBack && !t.droppedMerge;
  return {
    title: t.title,
    body: lines(
      field("Spoor", t.title),
      field("Status", nlLabel(t.status)),
      // A track that ended is a clean outcome — handled and closed — and the
      // indexed text must not read as an unfinished one.
      field("Verloop", mergesBack
        ? "teruggekomen op de hoofdlijn (was een voorwaarde voor het einddoel)"
        : "geëindigd op zichzelf"),
      t.note?.trim() || null),
    occurredAt: null,
    status: null,
  };
}

export function renderStop(s: {
  title: string; kind: string; state: string; note: string | null;
  happenedAt: Date | null; expectedAt: Date | null; stage: string | null;
  trackTitle: string;
}): Rendered {
  const at = s.happenedAt ?? s.expectedAt;
  return {
    title: s.title,
    body: lines(
      field("Halte", s.title),
      field("Spoor", s.trackTitle),
      field("Soort", nlLabel(s.kind)),
      field("Status", s.state === "expected" ? "verwacht" : nlLabel(s.state)),
      field("Fase", s.stage ? nlLabel(s.stage) : null),
      field("Datum", day(at)),
      s.note?.trim() || null),
    occurredAt: at,
    // done/open/expected are not SEARCH_STATUSES: they stay prose in the body
    // so a status filter cannot half-match them. Same rule milestones followed.
    status: null,
  };
}

export function renderParty(p: {
  name: string; kind: string; organization: string | null; email: string | null;
  phone: string | null; notes: string | null; createdAt: Date;
}): Rendered {
  return {
    title: p.name,
    body: lines(
      field("Naam", p.name),
      field("Soort", nlLabel(p.kind)),
      field("Organisatie", p.organization),
      field("E-mail", p.email),
      field("Telefoon", p.phone),
      p.notes?.trim() || null),
    occurredAt: p.createdAt,
    status: null,
  };
}
