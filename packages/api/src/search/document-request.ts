/**
 * Does this suggestion ask Martin for a document? Deterministic and pure — it
 * decides whether a queue card spends a deep-retrieval (rerank) call, so it
 * must be cheap, and it must never be the model's own guess: `clarity:
 * "already-provided"` is exactly the field the miner guesses at today, and
 * that guess is what the panel exists to answer with evidence.
 *
 * Dutch + English vocabulary, deliberately narrow: a false negative costs a
 * missing panel, a false positive costs a 20 s rerank on every queue render.
 */
const DOC_WORDS = [
  "kopie", "kopieën", "afschrift", "bewijs", "bewijsstuk", "document", "documenten",
  "stukken", "loonstrook", "loonstroken", "jaaropgave", "bankafschrift",
  "bankafschriften", "huurcontract", "contract", "polis", "paspoort", "identiteitsbewijs",
  "id-kaart", "beschikking", "aanslag", "specificatie", "factuur", "rekening",
  "opsturen", "aanleveren", "toesturen", "upload", "uploaden", "aanvullen",
  "attachment", "payslip", "statement", "copy of",
];

function mentionsDocument(text: string): boolean {
  const lower = text.toLowerCase();
  return DOC_WORDS.some((w) => lower.includes(w));
}

export function documentRequestText(kind: string, proposed: unknown): string | null {
  if (proposed === null || typeof proposed !== "object") return null;
  const p = proposed as Record<string, unknown>;
  if (kind === "log-entry") {
    const items = Array.isArray(p.actionItems) ? p.actionItems : [];
    for (const raw of items) {
      if (raw === null || typeof raw !== "object") continue;
      const item = raw as { description?: unknown; clarity?: unknown };
      const description = typeof item.description === "string" ? item.description : "";
      if (!description) continue;
      if (item.clarity === "already-provided" || mentionsDocument(description))
        return description;
    }
    return null;
  }
  if (kind === "task") {
    const title = typeof p.title === "string" ? p.title : "";
    const details = typeof p.details === "string" ? p.details : "";
    const text = [title, details].filter(Boolean).join(" ");
    return text && mentionsDocument(text) ? text : null;
  }
  return null;
}
