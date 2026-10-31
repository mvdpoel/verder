import { cache } from "react";
import { headers } from "next/headers";
import { appRouter, createContext } from "@verder/api";
import { schema } from "@verder/db";
import { eq } from "drizzle-orm";
import { getAuth } from "./auth";
import { getDb } from "./db";

/**
 * Validates the session cookie server-side and resolves the app user id.
 * Returns null for missing/invalid sessions. Route handlers that do work
 * outside tRPC (e.g. writing to the vault) MUST check this first — the
 * middleware only checks cookie presence, not validity.
 */
export const getSessionUserId = cache(async (): Promise<string | null> =>
  (await getSessionIdentity())?.userId ?? null);

/**
 * The same validation, plus the better-auth session id it was made under.
 * A push device is bound to that session so a revoke in /settings/security
 * (a lost phone) stops its pushes; the id is read here, from the validated
 * cookie, and never taken from a request body.
 */
export const getSessionIdentity = cache(
  async (): Promise<{ userId: string; sessionId: string } | null> => {
    const session = await getAuth().api.getSession({ headers: await headers() });
    if (!session) return null;
    const userId = await appUserId(session.user.email);
    return userId === null ? null : { userId, sessionId: session.session.id };
  });

export const serverCaller = cache(async () => {
  const { db } = getDb();
  const userId = await getSessionUserId();
  return appRouter.createCaller(createContext({ db, userId }));
});

async function appUserId(email: string): Promise<string | null> {
  const { db } = getDb();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  return u?.id ?? null;
}
