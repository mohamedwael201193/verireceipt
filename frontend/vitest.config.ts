import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config";

// NOTE: this file is intentionally excluded from both tsconfigs. Vitest 2
// bundles its own nested copy of Vite, so type-checking this file against
// the top-level Vite types produces spurious dual-Vite errors. The build
// (tsc + vite build) never touches this file; Vitest transpiles it with
// esbuild at test time.
export default defineConfig({
  ...viteConfig,
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
