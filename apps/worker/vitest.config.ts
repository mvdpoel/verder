import { defineConfig } from "vitest/config";

// Test files share one dev postgres, and the search triggers mean a write in one
// file shows up in another file's outbox, so files must not run concurrently —
// same reason packages/api/vitest.config.ts sets this.
//
// The timeout is not padding: extraction tests do the real work rather than
// mocking it. pdf-parse on a cold start is ~4 s, poppler rasterizing a page is
// ~3.5 s, and tesseract OCR on top of that is slower again — comfortably past
// vitest's 5 s default, and slower still when the whole suite is running.
export default defineConfig({
  test: { fileParallelism: false, testTimeout: 60_000 },
});
