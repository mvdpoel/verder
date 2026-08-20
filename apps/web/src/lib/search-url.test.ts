import { describe, expect, it } from "vitest";
import {
  PAGE_SIZE, buildSearchHref, parseSearchParams, semanticNotice, toQueryInput,
} from "./search-url";

describe("parseSearchParams", () => {
  it("reads repeated type params and drops unknown ones", () => {
    const p = parseSearchParams({ q: " opzegging ", type: ["document", "task", "nonsense"] });
    expect(p.q).toBe("opzegging");
    expect(p.entityTypes).toEqual(["document", "task"]);
  });

  it("accepts a single type param as a string", () => {
    expect(parseSearchParams({ type: "debt" }).entityTypes).toEqual(["debt"]);
  });

  it("keeps a well-formed date and drops a malformed one", () => {
    const p = parseSearchParams({ from: "2026-08-01", to: "gisteren" });
    expect(p.from).toBe("2026-08-01");
    expect(p.to).toBe("");
  });

  it("drops a status the router would reject", () => {
    expect(parseSearchParams({ status: "to-cancel" }).status).toBe("to-cancel");
    expect(parseSearchParams({ status: "verzonnen" }).status).toBe("");
  });

  it("treats empty strings as absent filters", () => {
    const p = parseSearchParams({ q: "", party: "", status: "", cursor: "" });
    expect(p).toEqual({ q: "", entityTypes: [], from: "", to: "",
      partyId: "", status: "", cursor: "" });
  });
});

describe("buildSearchHref", () => {
  it("round-trips every filter and replaces the cursor", () => {
    const p = parseSearchParams({
      q: "ziggo", type: ["document", "task"], from: "2026-08-01",
      party: "p1", status: "open", cursor: "b2Zmc2V0OjIw",
    });
    const href = buildSearchHref(p, { cursor: "b2Zmc2V0OjQw" });
    expect(href).toContain("type=document&type=task");
    expect(href).toContain("cursor=b2Zmc2V0OjQw");
    const again = parseSearchParams(
      Object.fromEntries(new URL(href, "http://x").searchParams.entries()));
    expect(again.q).toBe("ziggo");
    expect(again.status).toBe("open");
    expect(again.from).toBe("2026-08-01");
  });

  it("drops the cursor when told to, so a filter change starts at page one", () => {
    const p = parseSearchParams({ q: "ziggo", cursor: "b2Zmc2V0OjIw" });
    expect(buildSearchHref(p, { cursor: null })).toBe("/search?q=ziggo");
  });
});

describe("toQueryInput", () => {
  it("omits empty filters instead of sending empty strings to the router", () => {
    expect(toQueryInput(parseSearchParams({ q: "ziggo" }))).toEqual({
      q: "ziggo", entityTypes: undefined, from: undefined, to: undefined,
      partyId: undefined, status: undefined, cursor: undefined,
      limit: PAGE_SIZE, mode: "fast",
    });
  });

  it("forwards the filters that are set, in the router's flat shape", () => {
    const input = toQueryInput(parseSearchParams({
      q: "ziggo", type: ["debt"], from: "2026-01-01", to: "2026-08-01",
      party: "5a1c4e11-0000-4000-8000-000000000001", status: "settled",
      cursor: "b2Zmc2V0OjIw",
    }));
    expect(input).toEqual({
      q: "ziggo", entityTypes: ["debt"], from: "2026-01-01", to: "2026-08-01",
      partyId: "5a1c4e11-0000-4000-8000-000000000001", status: "settled",
      cursor: "b2Zmc2V0OjIw", limit: PAGE_SIZE, mode: "fast",
    });
  });
});

describe("semanticNotice", () => {
  it("says nothing when the semantic half ran", () => {
    expect(semanticNotice({ semanticAvailable: true })).toBeNull();
  });

  it("is explicit when the semantic half could not run", () => {
    expect(semanticNotice({ semanticAvailable: false }))
      .toContain("Semantic search is unavailable");
  });
});
