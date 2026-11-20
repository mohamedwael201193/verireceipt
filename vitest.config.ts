// A0 infra (2026-11-20): pin the test gate to this repo's own suite.
// Without `include`, `vitest run` from the repo root uses the default
// glob (**/*.{test,spec}.*) and can sweep test files outside tests/
// (e.g. a co-located frontend tree), which fail without jsdom and mask
// the real gate. Only *.test.ts files under tests/ are the miner suite;
// helpers, fixtures, or other files under tests/ are not collected.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
