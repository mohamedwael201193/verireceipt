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
    // Lazy route chunks can take seconds to load when the suite runs in
    // parallel on a loaded machine; the 5s default killed tests that
    // were only waiting on a chunk. (setup.ts raises the matching
    // async-util timeout to the same value.)
    testTimeout: 10_000,
  },
});
