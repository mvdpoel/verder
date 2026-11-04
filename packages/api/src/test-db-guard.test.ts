import { describe, expect, it } from "vitest";
import { assertSafeToTruncate } from "./test-db-guard";

describe("assertSafeToTruncate", () => {
  it("allows localhost hosts", () => {
    expect(() => assertSafeToTruncate("postgres://grip:grip@localhost:5432/grip")).not.toThrow();
    expect(() => assertSafeToTruncate("postgres://grip:grip@127.0.0.1:5432/grip")).not.toThrow();
    expect(() => assertSafeToTruncate("postgres://grip:grip@[::1]:5432/grip")).not.toThrow();
  });

  it("refuses non-local hosts so tests can never truncate a remote database", () => {
    expect(() => assertSafeToTruncate("postgres://grip:pw@db.homelab.lan:5432/grip"))
      .toThrow(/refusing to truncate/i);
    expect(() => assertSafeToTruncate("postgres://grip:pw@10.0.0.5:5432/grip"))
      .toThrow(/refusing to truncate/i);
    expect(() => assertSafeToTruncate("postgres://u:p@prod.example.com/grip"))
      .toThrow(/refusing to truncate/i);
  });

  it("refuses unparseable URLs rather than guessing", () => {
    expect(() => assertSafeToTruncate("not-a-url")).toThrow(/refusing to truncate/i);
  });
});
