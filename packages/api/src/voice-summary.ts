/**
 * The summary line of a voice quick-log (Plan 3 Task 24): the first sentence
 * of what Martin dictated without its closing full stop, cut at {@link VOICE_SUMMARY_MAX} characters on a
 * word boundary. Pure and deterministic — no model writes this line, so the
 * suggestion's `model` (`apple-speech-on-device`) stays the whole truth about
 * where its text came from, and the full transcript goes into `details`.
 */

export const VOICE_SUMMARY_MAX = 120;

/** Shown when the transcript is empty: a summary can never be blank. */
const EMPTY_SUMMARY = "Gesprek (spraaknotitie)";

/**
 * A sentence ends at `.`, `!` or `?` FOLLOWED BY whitespace or the end, so
 * "€ 12.50" and "www.cak.nl" do not end one.
 */
const SENTENCE_END = /[.!?](?=\s|$)/;

export function voiceSummary(transcript: string): string {
  const text = transcript.replace(/\s+/g, " ").trim();
  if (text === "") return EMPTY_SUMMARY;
  const end = text.search(SENTENCE_END);
  let sentence = end === -1 ? text : text.slice(0, end + 1);
  // A title, not a sentence: its closing full stop goes (the iPhone's
  // "staat in Voor jou" frame). "?" and "!" stay, they carry meaning; an
  // ellipsis stays whole.
  if (sentence.length > 1 && sentence.endsWith(".") && !sentence.endsWith("..")) {
    sentence = sentence.slice(0, -1);
  }
  if (sentence.length <= VOICE_SUMMARY_MAX) return sentence;
  // Leave room for the ellipsis, then step back to the last whole word.
  const room = sentence.slice(0, VOICE_SUMMARY_MAX - 1);
  const space = room.lastIndexOf(" ");
  // One word longer than the limit is cut hard rather than emptied.
  const kept = space > 0 ? room.slice(0, space) : room;
  return `${kept.replace(/[\s,;:]+$/, "")}…`;
}
