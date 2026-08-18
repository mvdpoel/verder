import { describe, expect, it } from "vitest";
import { createAuth } from "./index";
import { createDb } from "@verder/db";

describe("auth", () => {
  it("builds a better-auth instance with email/password enabled", () => {
    const { db } = createDb(process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder");
    const auth = createAuth({ db, secret: "test-secret", baseURL: "http://localhost:3000" });
    expect(auth.handler).toBeTypeOf("function");
    expect(auth.api.signInEmail).toBeTypeOf("function");
  });
});
