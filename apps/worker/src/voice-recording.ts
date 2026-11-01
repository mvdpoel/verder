import type { ExtractedText } from "./extract";

/**
 * A recording Martin kept with a voice quick-log (`phone-voice`, Plan 3 Task
 * 24) reaches `suggest.docmeta` through the docmeta sweep like any document
 * without a `document_texts` row. It has no text to read — its transcript is
 * the voice suggestion's `details` — so it is stored with extractor `none`
 * (which is what stops the sweep from picking it up again) and gets no
 * auto-name, no docmeta suggestion and no letter check: a docmeta suggestion
 * on it would only sit in Voor jou asking him to file an audio file.
 */
export function isVoiceRecording(mime: string): boolean {
  return mime.toLowerCase().startsWith("audio/");
}

/** The extraction of a recording: nothing, without starting an OCR port. */
export async function noTextExtraction(): Promise<ExtractedText> {
  return { text: "", extractor: "none", charCount: 0, truncated: false };
}
