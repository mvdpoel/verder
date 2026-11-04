import { describe, expect, it } from "vitest";
import { parseBriefStoreArgs } from "./briefs-store";

const ID = "00000000-0000-4000-8000-0000000000c1";

describe("parseBriefStoreArgs", () => {
  it("store and failed modes", () => {
    expect(parseBriefStoreArgs(["--party", ID, "--model", "claude-cli 2.1"]))
      .toEqual({ mode: "store", partyId: ID, model: "claude-cli 2.1" });
    expect(parseBriefStoreArgs(["--party", ID, "--model", "m", "--failed", "claude-exit-124"]))
      .toEqual({ mode: "failed", partyId: ID, model: "m", reason: "claude-exit-124" });
  });
  it.each([
    [["--party", "x", "--model", "m"], "--party must be a uuid"],
    [["--party", ID, "--model", "é"], "--model must be 1-120 printable ASCII characters"],
    [["--party", ID, "--model", "m", "--failed", "Bad Reason"], "--failed must be a short [a-z0-9-] reason"],
    [["--id", ID], 'unknown flag "--id"'],
    [["--party"], "--party needs a value"],
  ])("refuses %j", (args, message) => {
    expect(() => parseBriefStoreArgs(args)).toThrow(message);
  });
});
