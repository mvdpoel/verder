export interface ManifestRow {
  name: string; title: string; docType: string | null; partyName: string | null;
  receivedAt: Date; sizeBytes: number; sha256: string; discarded: boolean;
}

const D = (d: Date) => d.toLocaleDateString("nl-NL", {
  timeZone: "Europe/Amsterdam", day: "2-digit", month: "2-digit", year: "numeric" });
const KB = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * The first entry in every archive.
 *
 * In Dutch, because the person opening this zip is Verder, the gemeente or the
 * rechtbank — the same instinct /registry/export follows. The sha256 on every
 * line is what ties each file back to the ledger, so the receiver can be told
 * exactly which bytes they were given.
 */
export function buildManifest(rows: ManifestRow[], now: Date): string {
  const lines = [
    "Inhoudsopgave",
    "=============",
    "",
    `Samengesteld op ${D(now)} · ${rows.length} ${rows.length === 1 ? "bestand" : "bestanden"}`,
    "",
  ];
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.name}`);
    lines.push(`   Titel:    ${r.title}`);
    lines.push(`   Soort:    ${r.docType ?? "geen soort vastgelegd"}`);
    lines.push(`   Van:      ${r.partyName ?? "onbekend"}`);
    lines.push(`   Datum:    ${D(r.receivedAt)}`);
    lines.push(`   Grootte:  ${KB(r.sizeBytes)}`);
    lines.push(`   sha256:   ${r.sha256}`);
    if (r.discarded) lines.push("   Let op:   dit stuk is weggelegd en bewust meegestuurd");
    lines.push("");
  });
  return lines.join("\n");
}
