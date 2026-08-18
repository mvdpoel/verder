import { defineConfig } from "vitest/config";

// Test files share one dev postgres. verify.test.ts truncates the evidence
// tables to get a coherent chain for whole-chain verification, so files must
// not run concurrently against the shared database.
export default defineConfig({
  test: { fileParallelism: false },
});
