import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { MINER_BASE_URL } from "./src/config";

// Dev server proxies /api/* to the live Render miner so the frontend talks
// to the same origin contract as production (see vercel.json rewrites).
// The proxy target is the single source of truth in src/config.ts —
// vercel.json carries the same origin as static JSON (see the consistency
// test in src/deploy-contract.test.ts).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: MINER_BASE_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
