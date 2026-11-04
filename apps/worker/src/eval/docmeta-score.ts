import { docTypeKey } from "@grip/api/src/doc-type";

// The docmeta eval's scorer. Pure: no DB, no model, so the arithmetic that
// decides whether verder may file on its own (plan 3, Task 13) is unit-tested
// rather than trusted.

export interface DocMetaScore {
  /** The soort, compared through the same fold the files tree groups on. */
  docTypeExact: boolean;
  /** Information only. A free-form title almost never matches a human's exactly. */
  titleExact: boolean;
  /**
   * THE GATE IS THE SOORT AND NOTHING ELSE, because the soort (plus status
   * `filed`) is all auto-apply writes: the title stays auto-name's, with its
   * own guards. Gating on the title would measure something nothing applies
   * and put precision near zero.
   */
  gate: boolean;
}

export function scoreDocMeta(
  out: { title: string; docType: string | null },
  expected: { title: string; docType: string | null },
): DocMetaScore {
  // docTypeKey folds null and "" to the same key, which is also how the tree
  // shows them: one "Zonder soort" branch.
  const docTypeExact = docTypeKey(out.docType) === docTypeKey(expected.docType);
  return { docTypeExact, titleExact: out.title === expected.title, gate: docTypeExact };
}

export type DocMetaOutcome =
  | { kind: "answered"; confident: boolean; score: DocMetaScore }
  /** The 120 s Ollama timeout. In production this lands as needs-manual and never applies. */
  | { kind: "timeout" }
  /** Any other failure, unparseable JSON included. Also needs-manual in production. */
  | { kind: "error" };

export interface DocMetaRunSummary {
  n: number;
  answered: number;
  timeouts: number;
  errors: number;
  nConfident: number;
  /** Soort precision among `confident: true` — the number auto-apply rests on. Null when none. */
  gatePrecisionConfident: number | null;
  /** Soort precision among every answered sample, comparable to the history acceptance rate. */
  gatePrecisionAll: number | null;
  /** Information only. */
  titleExactRate: number | null;
}

const rate = (hits: number, of: number): number | null => (of === 0 ? null : hits / of);

export function summarizeDocMetaRun(outcomes: DocMetaOutcome[]): DocMetaRunSummary {
  const done = outcomes.filter((o): o is Extract<DocMetaOutcome, { kind: "answered" }> =>
    o.kind === "answered");
  const confident = done.filter((o) => o.confident);
  return {
    n: outcomes.length,
    answered: done.length,
    timeouts: outcomes.filter((o) => o.kind === "timeout").length,
    errors: outcomes.filter((o) => o.kind === "error").length,
    nConfident: confident.length,
    gatePrecisionConfident: rate(confident.filter((o) => o.score.gate).length, confident.length),
    gatePrecisionAll: rate(done.filter((o) => o.score.gate).length, done.length),
    titleExactRate: rate(done.filter((o) => o.score.titleExact).length, done.length),
  };
}

/**
 * Task 13's decision rule, written down before anything was measured. Auto-apply
 * is enabled only if EVERY one of three completed runs passes this; one run
 * passing decides nothing.
 */
export const AUTO_APPLY_RULE = { minConfident: 20, minPrecision: 0.9 } as const;

export function passesAutoApplyRule(s: DocMetaRunSummary): boolean {
  return s.nConfident >= AUTO_APPLY_RULE.minConfident
    && s.gatePrecisionConfident !== null
    && s.gatePrecisionConfident >= AUTO_APPLY_RULE.minPrecision;
}
