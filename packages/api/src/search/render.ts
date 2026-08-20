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
  application: "aanvraag", accepted: "toegelaten", onboarding: "intake",
  "wsnp-start": "start WSNP", settlement: "regeling", "clean-slate": "schone lei",
  call: "telefoon", meeting: "gesprek", email: "e-mail", voicemail: "voicemail",
  letter: "brief", other: "overig", process: "proces", mail: "post",
  inbound: "inkomend", outbound: "uitgaand", internal: "intern",
  person: "persoon", organization: "organisatie",
  monthly: "per maand", quarterly: "per kwartaal", yearly: "per jaar",
  irregular: "onregelmatig", "direct-debit": "automatische incasso",
  invoice: "factuur", inbox: "postvak in", filed: "gearchiveerd",
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
  creditorName: string; claimedCents: number; principalCents: number | null;
  references_: string | null; origin: string | null; originStory: string | null; createdAt: Date;
}, ctx: { status: string; creditorPartyName: string | null }): Rendered {
  return {
    title: debt.creditorName,
    body: lines(
      field("Schuldeiser", debt.creditorName),
      field("Schuldeiser (partij)", ctx.creditorPartyName),
      field("Status", nlLabel(ctx.status)),
      field("Gevorderd bedrag", euro(debt.claimedCents)),
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

export function renderMilestone(m: {
  title: string; stage: string; done: boolean; happenedAt: Date | null;
  expectedAt: Date | null; note: string | null;
}): Rendered {
  const at = m.happenedAt ?? m.expectedAt;
  return {
    title: m.title,
    body: lines(
      field("Mijlpaal", m.title),
      field("Fase", nlLabel(m.stage)),
      field("Status", m.done ? "afgerond" : "open"),
      field("Datum", day(at)),
      m.note?.trim() || null),
    occurredAt: at,
    // A milestone's done/open flag is not one of SEARCH_STATUSES; it stays prose
    // in the body so a status filter cannot half-match it.
    status: null,
  };
}

export function renderTimelineEvent(e: {
  title: string; kind: string; note: string | null; happenedAt: Date;
}): Rendered {
  return {
    title: e.title,
    body: lines(
      field("Gebeurtenis", e.title),
      field("Soort", nlLabel(e.kind)),
      e.note?.trim() || null),
    occurredAt: e.happenedAt,
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
