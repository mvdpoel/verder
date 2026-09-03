import { defineConfig } from "vitest/config";

// Test files share one dev postgres. verify.test.ts truncates the evidence
// tables to get a coherent chain for whole-chain verification, so files must
// not run concurrently against the shared database.
// The timeout is not padding, and 5 s is not enough for two of these files.
// The shared dev database is never truncated, so runFullVerification walks the
// whole accumulated chain — every event this project's test suites have ever
// appended, re-hashed and re-read from disk — and documents.browse asks the
// tree for the true total of every branch over the same accumulated corpus.
// Both grow with the machine's history rather than with the code. Without this
// they fail the documented `pnpm -r test` and pass only for whoever knows to
// type --testTimeout=30000, which nothing records.
export default defineConfig({
  test: { fileParallelism: false, testTimeout: 30_000 },
});
