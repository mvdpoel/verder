import { describe, expect, it } from "vitest";
import { isVoiceRecording, noTextExtraction } from "./voice-recording";

describe("voice recordings in suggest.docmeta", () => {
  it("an audio mime is a recording, whatever its subtype or case", () => {
    for (const mime of ["audio/mp4", "audio/x-m4a", "AUDIO/MPEG", "audio/wav"])
      expect(isVoiceRecording(mime)).toBe(true);
  });

  it("documents are not recordings", () => {
    for (const mime of ["application/pdf", "image/jpeg", "video/mp4", "application/octet-stream", ""])
      expect(isVoiceRecording(mime)).toBe(false);
  });

  it("a recording is stored with extractor none and no text, without touching OCR", async () => {
    expect(await noTextExtraction()).toEqual({ text: "", extractor: "none", charCount: 0, truncated: false });
  });
});
