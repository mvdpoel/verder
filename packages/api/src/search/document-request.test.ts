import { describe, expect, it } from "vitest";
import { documentRequestText } from "./document-request";

describe("documentRequestText", () => {
  it("returns the action-item text when an entry suggestion asks for a document", () => {
    expect(documentRequestText("log-entry", {
      summary: "VerderGroep vraagt stukken",
      actionItems: [
        { description: "Even terugbellen", clarity: "clear" },
        { description: "Kopie paspoort opsturen", clarity: "clear" },
      ],
    })).toBe("Kopie paspoort opsturen");
  });

  it("treats an already-provided action item as a document request", () => {
    expect(documentRequestText("log-entry", {
      actionItems: [{ description: "Loonstroken juni en juli", clarity: "already-provided" }],
    })).toBe("Loonstroken juni en juli");
  });

  it("uses title + details for a task suggestion that asks for a document", () => {
    expect(documentRequestText("task", {
      title: "Huurcontract opsturen", details: "Voor vrijdag aanleveren.",
    })).toBe("Huurcontract opsturen Voor vrijdag aanleveren.");
  });

  it("returns null when nothing asks for a document", () => {
    expect(documentRequestText("log-entry", {
      actionItems: [{ description: "Even terugbellen", clarity: "clear" }],
    })).toBeNull();
    expect(documentRequestText("task", { title: "Bellen met bewindvoerder" })).toBeNull();
    expect(documentRequestText("registry-item", { name: "Ziggo" })).toBeNull();
    expect(documentRequestText("log-entry", null)).toBeNull();
  });
});
