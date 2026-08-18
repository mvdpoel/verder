export const PROMPT_VERSION = "entry-v1";

export function buildEntryPrompt(email: {
  from: string; subject: string; sentAt: Date; bodyText: string;
}): string {
  return [
    "You are helping maintain a legal-grade contact log for a Dutch debt-restructuring (WSNP/bewindvoering) case.",
    "The email below may be in Dutch. Extract a log entry as strict JSON with keys:",
    `summary (string, <=100 chars, in the email's language), details (string, 1-3 sentences),`,
    `direction ("inbound" or "outbound"), actionItems (array of {description, clarity}),`,
    `where clarity is "clear" if the request is unambiguous, "ambiguous" otherwise.`,
    "Only include actionItems actually requested. Reply with JSON only.",
    "",
    `From: ${email.from}`,
    `Date: ${email.sentAt.toISOString()}`,
    `Subject: ${email.subject}`,
    "",
    email.bodyText.slice(0, 6000),
  ].join("\n");
}

export const REGISTRY_PROMPT_VERSION = "registry-v1";
export function buildRegistryPrompt(candidate: {
  counterpartyName: string | null; counterpartyIban: string | null;
  mandateId: string | null; cadence: string; typicalAmountCents: number;
  chargeCount: number;
}): string {
  const euros = (Math.abs(candidate.typicalAmountCents) / 100).toFixed(2);
  return [
    "A recurring charge was found on a Dutch bank statement in a debt-restructuring (WSNP/bewindvoering) dossier.",
    "Identify the payee. Reply with strict JSON only, keys:",
    `name (string: clean display name of the company, e.g. "Ziggo" not "SEPA Incasso ZIGGO BV 12345"),`,
    `category (one of "energy","insurance","telecom","streaming","software","housing","other"),`,
    "isDebtCollector (boolean: true when the payee is a debt collection party — Dutch: incasso,",
    "incassobureau, deurwaarder, gerechtsdeurwaarder — otherwise false).",
    "",
    `Counterparty: ${candidate.counterpartyName ?? "(unknown)"}`,
    `IBAN: ${candidate.counterpartyIban ?? "(none)"}`,
    `Direct-debit mandate: ${candidate.mandateId ?? "(none)"}`,
    `Cadence: ${candidate.cadence}, ${candidate.chargeCount} charges of ~EUR ${euros}`,
  ].join("\n");
}

export const RECEIPT_PROMPT_VERSION = "receipt-v1";
export function buildReceiptPrompt(receipt: { subject: string; bodyText: string }): string {
  return [
    "An Apple or PayPal receipt email from a Dutch debt-restructuring (WSNP/bewindvoering) dossier.",
    "Extract the purchased subscription/product line items. Reply with strict JSON only:",
    `{ "items": [{ "name": string, "amountCents": integer }] }`,
    `name is the clean product/subscription name (e.g. "iCloud+ 50 GB"); amountCents is the`,
    "line amount in integer euro cents (EUR 2,99 -> 299). List actual line items only, no totals,",
    "no taxes. Empty items array when the email contains no purchase line items.",
    "",
    `Subject: ${receipt.subject}`,
    "",
    receipt.bodyText.slice(0, 6000),
  ].join("\n");
}

export const DOCMETA_PROMPT_VERSION = "docmeta-v1";
export function buildDocMetaPrompt(filename: string, text: string): string {
  return [
    "A scanned document for a Dutch debt-administration dossier. From the filename and extracted text,",
    `reply with strict JSON: { "title": string (short, descriptive, keep language), "docType": one of`,
    `"contract","payslip","invoice","letter","bank-statement","id-document","other" }.`,
    `Filename: ${filename}`,
    "Extracted text:", text.slice(0, 4000),
  ].join("\n");
}
