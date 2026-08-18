import { router } from "./trpc";
import { partiesRouter } from "./routers/parties";
import { entriesRouter } from "./routers/entries";
import { documentsRouter } from "./routers/documents";
import { suggestionsRouter } from "./routers/suggestions";
import { verifyRouter } from "./routers/verify";
import { dashboardRouter } from "./routers/dashboard";
import { pushRouter } from "./routers/push";

export const appRouter = router({
  parties: partiesRouter,
  entries: entriesRouter,
  documents: documentsRouter,
  suggestions: suggestionsRouter,
  verify: verifyRouter,
  dashboard: dashboardRouter,
  push: pushRouter,
});
export type AppRouter = typeof appRouter;
export { createContext, type Context } from "./trpc";
