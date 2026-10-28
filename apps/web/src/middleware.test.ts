import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "./middleware";

describe("middleware", () => {
  it("lets the association file through without a cookie", () => {
    const res = middleware(
      new NextRequest("https://verder.vanderpoel.pro/.well-known/apple-app-site-association"),
    );
    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still redirects /dashboard without a cookie", () => {
    const res = middleware(new NextRequest("https://verder.vanderpoel.pro/dashboard"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://verder.vanderpoel.pro/login");
  });
});
