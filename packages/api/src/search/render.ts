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
