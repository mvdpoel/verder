import { mergeRouters, router } from "./trpc";
import { partiesRouter } from "./routers/parties";
import { entriesRouter } from "./routers/entries";
import { documentsRouter } from "./routers/documents";
import { suggestionsRouter } from "./routers/suggestions";
import { verifyRouter } from "./routers/verify";
import { registryRouter } from "./routers/registry";
import { registryImportRouter } from "./routers/registry-import";
import { milestonesRouter } from "./routers/milestones";
import { tracksRouter } from "./routers/tracks";
import { tasksRouter } from "./routers/tasks";
import { dashboardRouter } from "./routers/dashboard";
import { pushRouter } from "./routers/push";
import { searchRouter } from "./routers/search";
import { moneyRouter } from "./routers/money";

export const appRouter = router({
  parties: partiesRouter,
  entries: entriesRouter,
  documents: documentsRouter,
  suggestions: suggestionsRouter,
  verify: verifyRouter,
  // Task 5 keeps import separate from registry.ts; merged here so procedures
  // surface as registry.import.* (the path later tasks depend on).
  registry: mergeRouters(registryRouter, router({ import: registryImportRouter })),
  milestones: milestonesRouter,
  tracks: tracksRouter,
  tasks: tasksRouter,
  dashboard: dashboardRouter,
  push: pushRouter,
  search: searchRouter,
  money: moneyRouter,
});
export type AppRouter = typeof appRouter;
export { createContext, type Context } from "./trpc";
