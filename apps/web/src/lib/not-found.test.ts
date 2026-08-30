import { describe, expect, it } from "vitest";
import { isNotFoundError } from "@/lib/not-found";

describe("isNotFoundError", () => {
  it("recognises the router's NOT_FOUND without instanceof", () => {
    // Shaped like a TRPCError from a SECOND copy of @trpc/server: instanceof
    // would miss this, and every missing record would crash instead of 404.
    expect(isNotFoundError({ code: "NOT_FOUND", message: "Document not found" })).toBe(true);
  });

  it("leaves every other failure alone", () => {
    // These must reach the error boundary. Rendering them as "does not exist"
    // would hide a dead database behind a tidy 404.
    expect(isNotFoundError({ code: "UNAUTHORIZED" })).toBe(false);
    expect(isNotFoundError({ code: "BAD_REQUEST" })).toBe(false);
    expect(isNotFoundError({ code: "INTERNAL_SERVER_ERROR" })).toBe(false);
    expect(isNotFoundError(new Error("connection refused"))).toBe(false);
  });

  it("survives the shapes a catch block actually receives", () => {
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
    expect(isNotFoundError("NOT_FOUND")).toBe(false);
    expect(isNotFoundError({})).toBe(false);
  });
});
