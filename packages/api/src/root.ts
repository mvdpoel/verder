import { router } from "./trpc";
import { partiesRouter } from "./routers/parties";
import { entriesRouter } from "./routers/entries";

export const appRouter = router({
  parties: partiesRouter,
  entries: entriesRouter,
});
export type AppRouter = typeof appRouter;
export { createContext, type Context } from "./trpc";
