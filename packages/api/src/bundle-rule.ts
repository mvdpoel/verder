import { z } from "zod";

/**
 * A rule bundle's membership, in the same vocabulary the tree filters on.
 *
 * `.strict()` and the non-empty check are both load-bearing: an unknown key
 * would be silently ignored (so a typo'd rule would quietly match everything it
 * was meant to narrow), and an EMPTY rule means "every document in the vault",
 * which is never what anyone typed on purpose.
 */
export const bundleRuleSchema = z.object({
  docType: z.string().min(1).optional(),
  partyId: z.string().uuid().optional(),
  source: z.enum(["upload", "nas-scan", "email-attachment"]).optional(),
  status: z.enum(["inbox", "filed", "discarded"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
}).strict().refine((r) => Object.keys(r).length > 0, {
  message: "Een regel zonder voorwaarden zou alles bevatten",
});

export type BundleRule = z.infer<typeof bundleRuleSchema>;

export function parseBundleRule(raw: unknown):
  { ok: true; rule: BundleRule } | { ok: false; message: string } {
  const parsed = bundleRuleSchema.safeParse(raw);
  if (parsed.success) return { ok: true, rule: parsed.data };
  const first = parsed.error.issues[0];
  return { ok: false,
    message: first ? `${first.path.join(".") || "regel"}: ${first.message}` : "onleesbare regel" };
}

const NL_SOURCE: Record<string, string> = {
  upload: "geüpload", "nas-scan": "gescand", "email-attachment": "uit de mail",
};
const NL_STATUS: Record<string, string> = {
  inbox: "te sorteren", filed: "opgeborgen", discarded: "weggelegd",
};
const D = (d: Date) => d.toLocaleDateString("nl-NL", { timeZone: "Europe/Amsterdam" });

/** The rule in words, for the card. A rule nobody can read is a rule nobody trusts. */
export function describeRule(rule: BundleRule, partyNames: Record<string, string>): string {
  const parts: string[] = [];
  if (rule.docType) parts.push(`soort = ${rule.docType}`);
  if (rule.partyId) parts.push(`van ${partyNames[rule.partyId] ?? "onbekende partij"}`);
  if (rule.source) parts.push(NL_SOURCE[rule.source]);
  if (rule.status) parts.push(NL_STATUS[rule.status]);
  if (rule.from) parts.push(`vanaf ${D(rule.from)}`);
  if (rule.to) parts.push(`tot ${D(rule.to)}`);
  return parts.join(" · ");
}
