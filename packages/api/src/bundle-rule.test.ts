import { describe, expect, it } from "vitest";
import { describeRule, parseBundleRule } from "./bundle-rule";

describe("parseBundleRule", () => {
  it("accepts the tree's own vocabulary", () => {
    const r = parseBundleRule({ docType: "loonstrook", source: "email-attachment" });
    expect(r.ok).toBe(true);
  });

  // The row is hand-editable in psql. A rule bundle whose JSON went bad must
  // render as a broken bundle with a readable message, never as a page that
  // throws — which is why this is parsed on READ as well as on write.
  it("refuses nonsense without throwing", () => {
    const r = parseBundleRule({ docType: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/docType/);
  });

  it("refuses a key nobody defined", () => {
    expect(parseBundleRule({ kleur: "blauw" }).ok).toBe(false);
  });

  it("refuses an empty rule, which would silently mean everything", () => {
    expect(parseBundleRule({}).ok).toBe(false);
  });
});

describe("describeRule", () => {
  it("says the rule in Dutch, for the card", () => {
    expect(describeRule({ docType: "loonstrook" }, {})).toBe("soort = loonstrook");
  });

  it("names the party rather than printing its uuid", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(describeRule({ partyId: id }, { [id]: "Woonhave" })).toBe("van Woonhave");
  });
});
