import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  /*
   * The JSX transform, made explicit.
   *
   * apps/web sets `jsx: "preserve"` for Next, and without this line esbuild
   * falls back to the CLASSIC transform: every .tsx file a test touches then
   * needs `React` in scope, even when it never names `React` itself. That cost
   * exactly one trap — an icon file with no React import brought the layout test
   * down — and it is a trap that returns with every new component. `automatic`
   * takes it out for good.
   */
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: { environment: "node" },
});
