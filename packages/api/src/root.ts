import { mergeRouters, router } from "./trpc";
import { partiesRouter } from "./routers/parties";
import { entriesRouter } from "./routers/entries";
import { documentsRouter } from "./routers/documents";
import { suggestionsRouter } from "./routers/suggestions";
import { verifyRouter } from "./routers/verify";
import { registryRouter } from "./routers/registry";
import { registryImportRouter } from "./routers/registry-import";
import { dashboardRouter } from "./routers/dashboard";
import { pushRouter } from "./routers/push";

export const appRouter = router({
  parties: partiesRouter,
  entries: entriesRouter,
  documents: documentsRouter,
  suggestions: suggestionsRouter,
  verify: verifyRouter,
  // Task 5 keeps import separate from registry.ts; merged here so procedures
  // surface as registry.import.* (the path later tasks depend on).
  registry: mergeRouters(registryRouter, router({ import: registryImportRouter })),
  dashboard: dashboardRouter,
  push: pushRouter,
});
export type AppRouter = typeof appRouter;
export { createContext, type Context } from "./trpc";
