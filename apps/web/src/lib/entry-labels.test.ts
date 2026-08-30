import { describe, expect, it } from "vitest";
import {
  CHANNEL_LABEL, CLARITY_LABEL, DIRECTION_LABEL, DOC_SOURCE_LABEL, ENTRY_SOURCE_LABEL,
} from "@/lib/entry-labels";

// The enum members as the database declares them (packages/db/src/schema.ts).
// Spelled out here on purpose: if a value is added there and not here, this
// test says so — which is cheaper than finding "inbound" in a report that has
// already been handed to the bewindvoerder.
const CHANNELS = ["call", "meeting", "email", "whatsapp", "voicemail", "letter", "other"];
const DIRECTIONS = ["inbound", "outbound", "internal"];
const CLARITIES = ["clear", "ambiguous", "already-provided"];
const ENTRY_SOURCES = ["manual", "gmail-watch", "nas-watch"];
const DOC_SOURCES = ["upload", "nas-scan", "email-attachment"];

describe("entry labels", () => {
  it.each([
    ["channel", CHANNELS, CHANNEL_LABEL],
    ["direction", DIRECTIONS, DIRECTION_LABEL],
    ["clarity", CLARITIES, CLARITY_LABEL],
    ["entry source", ENTRY_SOURCES, ENTRY_SOURCE_LABEL],
    ["doc source", DOC_SOURCES, DOC_SOURCE_LABEL],
  ])("covers every %s the database can hold", (_name, values, labels) => {
    for (const v of values) expect(labels[v]).toBeTruthy();
  });

  it("translates rather than echoing the identifier", () => {
    expect(CHANNEL_LABEL.call).toBe("telefoon");
    expect(DIRECTION_LABEL.inbound).toBe("inkomend");
    expect(CLARITY_LABEL.ambiguous).toBe("onduidelijk");
  });
});
