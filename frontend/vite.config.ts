import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server proxies /api/* to the live Render miner so the frontend talks
// to the same origin contract as production (see vercel.json rewrites).
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
});
