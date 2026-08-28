import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { createAuth } from "./index";
import { TRUST_HEADER } from "./session-trust";

const url = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";
const email = `trust-test-${crypto.randomUUID()}@example.test`;
const password = "a-long-enough-password";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("auth", () => {
  let db: ReturnType<typeof createDb>["db"];
  let pool: ReturnType<typeof createDb>["pool"];
  let auth: ReturnType<typeof createAuth>;

  beforeAll(async () => {
    ({ db, pool } = createDb(url));
    // Sign-ups are disabled in the app; the test needs one to create its user.
    process.env.ALLOW_SIGNUP = "1";
    auth = createAuth({ db, secret: "test-secret", baseURL: "http://localhost:3000" });
    await auth.api.signUpEmail({ body: { email, password, name: "Trust Test" } });
  });

  afterAll(async () => {
    await db.delete(schema.user).where(eq(schema.user.email, email)); // cascades to sessions
    await pool.end();
  });

  async function latestSessionExpiry(): Promise<Date> {
    const [u] = await db.select().from(schema.user).where(eq(schema.user.email, email));
    const [s] = await db.select().from(schema.session)
      .where(eq(schema.session.userId, u.id))
      .orderBy(desc(schema.session.createdAt)).limit(1);
    return s.expiresAt;
  }

  it("builds a better-auth instance with email/password and passkeys enabled", () => {
    expect(auth.handler).toBeTypeOf("function");
    expect(auth.api.signInEmail).toBeTypeOf("function");
    expect(auth.api.generatePasskeyRegistrationOptions).toBeTypeOf("function");
  });

  it("gives a sign-in carrying the trust header a 30-day session", async () => {
    const before = Date.now();
    await auth.api.signInEmail({
      body: { email, password },
      headers: new Headers({ [TRUST_HEADER]: "1" }),
    });
    const expiry = (await latestSessionExpiry()).getTime();
    expect(expiry - before).toBeGreaterThan(29 * DAY);
    expect(expiry - before).toBeLessThan(31 * DAY);
  });

  it("gives a sign-in without the header a 12-hour session", async () => {
    const before = Date.now();
    await auth.api.signInEmail({ body: { email, password }, headers: new Headers() });
    const expiry = (await latestSessionExpiry()).getTime();
    expect(expiry - before).toBeGreaterThan(11 * HOUR);
    expect(expiry - before).toBeLessThan(13 * HOUR);
  });
});
