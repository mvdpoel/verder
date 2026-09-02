/**
 * Is a piece of extracted text language at all?
 *
 * Two callers, one definition. The naming pass refuses to show a model text
 * that is not language, and the OCR path uses the same score to decide whether
 * a page came out upside down — if those two ever disagreed, a page could be
 * rotated into a state the namer still refuses.
 */

/**
 * Words frequent enough in Dutch and English that prose cannot avoid them.
 * Counting them is a cheap, language-agnostic-enough test for "is this text
 * at all", which is the only question being asked.
 */
export const STOPWORDS = [
  "de", "het", "een", "van", "en", "in", "op", "te", "dat", "die", "voor",
  "met", "zijn", "wordt", "aan", "bij", "the", "of", "and", "to", "for",
  "is", "that", "this", "shall", "will", "any",
];

/**
 * Minimum share of words that are stopwords. MEASURED across all 138 texts on
 * the Workspace share, not guessed: garbled OCR runs 0.7%-3.3% and every
 * readable document is 4.7% or above, so the threshold sits in a real gap. It
 * is deliberately far below the 21.8% median, because the sparse end of "real"
 * is a payslip (4.9%) or a passport MRZ (5.3%) — documents that are tables,
 * not prose, and must not be refused.
 */
export const MIN_STOPWORD_SHARE = 0.04;

/** Fewer words than this and the share is noise, not a measurement. */
export const MIN_WORDS = 40;

/** Words a scorer can see: letters only, so page furniture does not inflate it. */
export function wordCount(text: string): number {
  return text.toLowerCase().split(/[^a-zÀ-ɏ]+/).filter(Boolean).length;
}

/**
 * Share of words that are stopwords, 0..1.
 *
 * Measured per WORD, not per character: a per-character ratio rewards garbled
 * text for being dense in short junk tokens, which is exactly backwards.
 * Returns 0 for text too short to judge.
 */
export function stopwordShare(text: string): number {
  const words = text.toLowerCase().split(/[^a-zÀ-ɏ]+/).filter(Boolean);
  if (words.length < MIN_WORDS) return 0;
  return words.filter((w) => STOPWORDS.includes(w)).length / words.length;
}

/**
 * Whether extracted text is worth acting on.
 *
 * asml.pdf was scanned UPSIDE DOWN, so OCR returned 3082 characters of
 * mirrored gibberish ("uorpoIpsin[ SAISN[9Xe BABY [IM LNOD YIJNG" is "Dutch
 * COURT will have exclusive jurisdiction" reversed). Asked to name it, a model
 * invented "Beschikking.UWV" — a plausible Dutch document type with no basis
 * in the document at all.
 */
export function looksLikeProse(text: string): boolean {
  return stopwordShare(text) >= MIN_STOPWORD_SHARE;
}

/** Nothing at all: rotating a blank page cannot make it readable. */
export const BLANK_WORDS = 5;

/**
 * Share of words with four or more letters.
 *
 * The fallback for text too short to score stopwords on. Junk OCR is dense in
 * one- and two-character fragments — page 1 of the ASML Code of Conduct read
 * as "HL Ee 1H Di 1 3 OD an ET! meme x i D Ngo" at 0 degrees and as
 * "principles We opera We commit people" at -90 — while a genuinely short
 * real text ("Bonnetje 4,50") is made of whole words.
 */
export function longWordShare(text: string): number {
  const words = text.toLowerCase().split(/[^a-zÀ-ɏ]+/).filter(Boolean);
  if (words.length === 0) return 0;
  return words.filter((w) => w.length >= 4).length / words.length;
}

/** Below this, short text is fragments rather than words, and worth rotating. */
export const MIN_LONG_WORD_SHARE = 0.3;

/**
 * Whether a page is worth OCRing at other orientations.
 *
 * Short text is the hard case, and getting it wrong costs either three wasted
 * OCR passes on every receipt or a page left unreadable forever. A page with
 * almost no words is blank; a short page made of whole words is a real short
 * document; a short page made of fragments is a page the scanner fed sideways.
 */
export function worthRotating(text: string): boolean {
  if (looksLikeProse(text)) return false;
  const words = wordCount(text);
  if (words < BLANK_WORDS) return false;
  if (words >= MIN_WORDS) return true;
  return longWordShare(text) < MIN_LONG_WORD_SHARE;
}
