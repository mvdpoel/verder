import { router } from "./trpc";
import { partiesRouter } from "./routers/parties";
import { entriesRouter } from "./routers/entries";
import { documentsRouter } from "./routers/documents";
import { suggestionsRouter } from "./routers/suggestions";
import { verifyRouter } from "./routers/verify";

export const appRouter = router({
  parties: partiesRouter,
  entries: entriesRouter,
  documents: documentsRouter,
  suggestions: suggestionsRouter,
  verify: verifyRouter,
});
export type AppRouter = typeof appRouter;
export { createContext, type Context } from "./trpc";
