import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter, createContext } from "@verder/api";
import { schema } from "@verder/db";
import { eq } from "drizzle-orm";
import { getAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";

const handler = async (req: Request) => {
  const { db } = getDb();
  const session = await getAuth().api.getSession({ headers: req.headers });
  let userId: string | null = null;
  if (session) {
    const [u] = await db.select().from(schema.users)
      .where(eq(schema.users.email, session.user.email));
    userId = u?.id ?? null;
  }
  return fetchRequestHandler({ endpoint: "/api/trpc", req, router: appRouter,
    createContext: () => createContext({ db, userId }) });
};
export { handler as GET, handler as POST };
