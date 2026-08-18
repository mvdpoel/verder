import { cache } from "react";
import { headers } from "next/headers";
import { appRouter, createContext } from "@verder/api";
import { schema } from "@verder/db";
import { eq } from "drizzle-orm";
import { getAuth } from "./auth";
import { getDb } from "./db";

export const serverCaller = cache(async () => {
  const { db } = getDb();
  const session = await getAuth().api.getSession({ headers: await headers() });
  const userId = session ? await appUserId(session.user.email) : null;
  return appRouter.createCaller(createContext({ db, userId }));
});

async function appUserId(email: string): Promise<string | null> {
  const { db } = getDb();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  return u?.id ?? null;
}
