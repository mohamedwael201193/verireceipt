import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Same-origin /api proxy: Vite dev server forwards to the live Render miner.
// In production Vercel rewrites /api/* to the same upstream (see vercel.json).
// The frontend never calls the Render origin directly, so no CORS is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "https://verireceipt.onrender.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
