import { router } from "./trpc";
import { partiesRouter } from "./routers/parties";
import { entriesRouter } from "./routers/entries";
import { documentsRouter } from "./routers/documents";

export const appRouter = router({
  parties: partiesRouter,
  entries: entriesRouter,
  documents: documentsRouter,
});
export type AppRouter = typeof appRouter;
export { createContext, type Context } from "./trpc";
