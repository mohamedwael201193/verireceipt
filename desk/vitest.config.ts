import { defineConfig } from "vitest/config";

// The Desk suite only; the miner suite lives in ../tests and the frontend
// suite in ../frontend.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
