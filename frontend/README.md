# VeriReceipt frontend — deploy contract

Vite + React 19 + TypeScript single-page app. The app shell (nav, footer,
theme, health pill) lives here; page content comes from the page workers.

## Vercel deploy contract (do not drift — the suite enforces the origin)

- **Root Directory MUST be `frontend`** (the Vercel project root is the repo
  root; this directory holds `package.json`, `vite.config.ts`, `vercel.json`).
- **Framework preset:** Vite.
- **Build command:** `npm run build` (`tsc` typecheck + `vite build`).
- **Output directory:** `dist` (Vite default).
- **Environment variables:** none required. The app calls the miner through
  the same-origin `/api` prefix only; there are no `VITE_*` variables.
- **`/api` proxy rewrite:** `vercel.json` rewrites `/api/:path*` to the live
  Render miner (`https://verireceipt.onrender.com/:path*`). The dev server
  proxies the same prefix in `vite.config.ts`, and both read the origin from
  the single source of truth, `MINER_BASE_URL` in `src/config.ts`
  (`vercel.json` is static JSON so it carries the literal origin; the
  consistency test in `src/deploy-contract.test.ts` fails the suite if the
  three files disagree).

## Local development

```sh
npm install
npm run dev      # vite dev server, /api proxied to the live Render miner
npm test         # vitest (jsdom)
npm run typecheck
npm run build
```

Node >= 20.18.0. `node:crypto` is imported by the receipt tests, so
`@types/node` is a declared devDependency — do not rely on a transitive or
walk-up copy (the merged tree has none and `tsc` fails without it).

## Notes

- The Google Fonts stylesheet loads non-blockingly (`preload` + `media=print`
  `onload` swap in `index.html`); the render-blocking form must not return.
- The landing page's Probe section must carry `id="probe"`, and the
  Roadmap/Manifesto sections `id="sprint-matrix"` / `id="manifesto"` — the
  nav CTA and footer sitemap link to those anchors. Those sections belong to
  the landing page worker; confirm the ids at integration.
