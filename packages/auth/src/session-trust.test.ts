import { describe, expect, it } from "vitest";
import {
  TRUST_HEADER, TRUSTED_SESSION_SECONDS, UNTRUSTED_SESSION_SECONDS,
  isTrustedRequest, sessionExpiryFor,
} from "./session-trust";

const NOW = new Date("2026-08-28T12:00:00.000Z");

describe("session trust", () => {
  it("trusts a request carrying the header", () => {
    expect(isTrustedRequest(new Headers({ [TRUST_HEADER]: "1" }))).toBe(true);
  });

  it("does not trust a request without it", () => {
    expect(isTrustedRequest(new Headers())).toBe(false);
  });

  it("does not trust absent headers — the safe default is the short session", () => {
    expect(isTrustedRequest(null)).toBe(false);
    expect(isTrustedRequest(undefined)).toBe(false);
  });

  it("treats any value other than 1 as untrusted, so a stray header cannot extend a session", () => {
    expect(isTrustedRequest(new Headers({ [TRUST_HEADER]: "0" }))).toBe(false);
    expect(isTrustedRequest(new Headers({ [TRUST_HEADER]: "true" }))).toBe(false);
    expect(isTrustedRequest(new Headers({ [TRUST_HEADER]: "" }))).toBe(false);
  });

  it("gives a trusted request 30 days and an untrusted one 12 hours", () => {
    expect(TRUSTED_SESSION_SECONDS).toBe(60 * 60 * 24 * 30);
    expect(UNTRUSTED_SESSION_SECONDS).toBe(60 * 60 * 12);
    expect(sessionExpiryFor(new Headers({ [TRUST_HEADER]: "1" }), NOW).toISOString())
      .toBe("2026-09-27T12:00:00.000Z");
    expect(sessionExpiryFor(new Headers(), NOW).toISOString())
      .toBe("2026-08-29T00:00:00.000Z");
  });
});
