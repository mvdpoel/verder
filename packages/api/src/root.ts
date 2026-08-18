import { router } from "./trpc";
import { partiesRouter } from "./routers/parties";
import { entriesRouter } from "./routers/entries";
import { documentsRouter } from "./routers/documents";
import { suggestionsRouter } from "./routers/suggestions";

export const appRouter = router({
  parties: partiesRouter,
  entries: entriesRouter,
  documents: documentsRouter,
  suggestions: suggestionsRouter,
});
export type AppRouter = typeof appRouter;
export { createContext, type Context } from "./trpc";
