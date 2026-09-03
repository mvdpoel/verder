import { describe, expect, it } from "vitest";
import { buildFilesHref, decodeBranch, encodeBranch, parseFilesParams } from "./files-url";

describe("branch encoding", () => {
  it("round-trips every branch kind", () => {
    for (const b of [
      { kind: "alles" as const },
      { kind: "bundels" as const },
      { kind: "bundel" as const, id: "11111111-1111-4111-8111-111111111111" },
      { kind: "soort" as const, key: "loonstrook" },
      // "Zonder soort" — the empty key is a real branch (documents.tree sorts
      // it last on purpose and it is the biggest one in dev). It used to
      // decode to "alles", so it could not be selected at all.
      { kind: "soort" as const, key: "" },
      { kind: "party" as const, id: "22222222-2222-4222-8222-222222222222" },
      { kind: "party" as const, id: null },
      { kind: "periode" as const, month: "2026-08" },
      { kind: "bron" as const, source: "email-attachment" as const },
      { kind: "status" as const, status: "discarded" as const },
      { kind: "status" as const, status: "purged" as const },
    ]) {
      expect(decodeBranch(encodeBranch(b))).toEqual(b);
    }
  });

  it("survives a soort with a colon in it", () => {
    const b = { kind: "soort" as const, key: "brief: aanmaning" };
    expect(decodeBranch(encodeBranch(b))).toEqual(b);
  });

  // Everything in a URL is typed by strangers, including Martin's own typos.
  it("falls back to everything for nonsense", () => {
    expect(decodeBranch("soort")).toEqual({ kind: "alles" });
    expect(decodeBranch("kleur:blauw")).toEqual({ kind: "alles" });
    expect(decodeBranch("periode:augustus")).toEqual({ kind: "alles" });
    expect(decodeBranch("bundel:not-a-uuid")).toEqual({ kind: "alles" });
  });
});

describe("parseFilesParams", () => {
  it("defaults to everything, newest first", () => {
    expect(parseFilesParams({})).toEqual({
      branch: { kind: "alles" }, sort: "datum", dir: "desc", sel: "" });
  });

  it("drops a sort nobody defined", () => {
    expect(parseFilesParams({ sort: "kleur" }).sort).toBe("datum");
  });
});

describe("buildFilesHref", () => {
  it("keeps the branch while changing the sort", () => {
    const p = parseFilesParams({ tak: "soort:loonstrook", sel: "abc" });
    expect(buildFilesHref(p, { sort: "grootte", dir: "asc" }))
      .toBe("/files?tak=soort%3Aloonstrook&sort=grootte&dir=asc&sel=abc");
  });

  it("writes no query string at all for the default view", () => {
    expect(buildFilesHref(parseFilesParams({}), {})).toBe("/files");
  });
});
