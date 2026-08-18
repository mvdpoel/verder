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
