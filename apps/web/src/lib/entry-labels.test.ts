import { describe, expect, it } from "vitest";
import {
  CHANNEL_LABEL, CLARITY_LABEL, DIRECTION_LABEL, DOC_SOURCE_LABEL, ENTRY_SOURCE_LABEL,
} from "@/lib/entry-labels";
import { DOC_SOURCES } from "@verder/db/doc-sources";

// The enum members as the database declares them (packages/db/src/schema.ts).
// Spelled out here on purpose: if a value is added there and not here, this
// test says so — which is cheaper than finding "inbound" in a report that has
// already been handed to the bewindvoerder. Document sources are the
// exception: DOC_SOURCES IS the enum's definition (schema.ts builds the pgEnum
// from it, and doc-source-phone.test.ts checks it against the database).
const CHANNELS = ["call", "meeting", "email", "whatsapp", "voicemail", "letter", "other"];
const DIRECTIONS = ["inbound", "outbound", "internal"];
const CLARITIES = ["clear", "ambiguous", "already-provided"];
const ENTRY_SOURCES = ["manual", "gmail-watch", "nas-watch"];

describe("entry labels", () => {
  it.each([
    ["channel", CHANNELS, CHANNEL_LABEL],
    ["direction", DIRECTIONS, DIRECTION_LABEL],
    ["clarity", CLARITIES, CLARITY_LABEL],
    ["entry source", ENTRY_SOURCES, ENTRY_SOURCE_LABEL],
    ["doc source", [...DOC_SOURCES], DOC_SOURCE_LABEL as Record<string, string>],
  ])("covers every %s the database can hold", (_name, values, labels) => {
    for (const v of values) expect(labels[v]).toBeTruthy();
  });

  it("translates rather than echoing the identifier", () => {
    expect(CHANNEL_LABEL.call).toBe("telefoon");
    expect(DIRECTION_LABEL.inbound).toBe("inkomend");
    expect(CLARITY_LABEL.ambiguous).toBe("onduidelijk");
  });
});
