import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { Db } from "@verder/db";

export interface Context { db: Db; userId: string | null }
export function createContext(input: Context): Context { return input; }

const t = initTRPC.context<Context>().create({ transformer: superjson });
export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.userId) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});
