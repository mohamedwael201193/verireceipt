import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import ScrollToHash from "./components/ScrollToHash";
import Benchmarks from "./pages/Benchmarks";
import Dashboard from "./pages/Dashboard";
import Docs from "./pages/Docs";
import Landing from "./pages/Landing";
import NotFound from "./pages/NotFound";
import Receipts from "./pages/Receipts";
import Status from "./pages/Status";
import Buyer from "./pages/Buyer";
import Research from "./pages/Research";
import ResearchDesk from "./pages/ResearchDesk";

/** App shell routes.
 *
 * Routes are STATIC imports, not React.lazy (2026-11-20 browser
 * click-test fix). The old lazy setup failed in production: React Router
 * v7 wraps navigations in startTransition, so while a route chunk is
 * pending the old page stays on screen by design — and the chunk fetch
 * is same-origin, so it queues behind the page's own slow /api calls
 * (6-connection browser limit; Render answers in seconds to minutes).
 * Reproduced live: Status → Docs took 8.1s to render. A failed chunk
 * fetch was separately shown to unmount the whole app to a blank page
 * (chunk-404 experiment). Static imports load every route with the
 * initial bundle, so a nav click renders its target immediately with no
 * network fetch and no transition stall, whatever the API is doing.
 * Cost is a larger initial bundle: a single 567KB JS file (170KB gzip),
 * vs 273KB (87KB gzip) before — the six pages add ~287KB JS (~82KB
 * gzip). Accepted: this is a proof hub whose users click through pages
 * immediately, and a nav that never renders is a worse cost than a
 * heavier first load.
 * Route errors are contained by ErrorBoundary, which lives inside
 * Layout around <Outlet/> with resetKeys={[location.pathname]} (see
 * Layout.tsx) — NOT here: an earlier version wrapped <Routes> with
 * key={pathname}, which remounted Layout on every navigation and reset
 * the health pill to "checking…" for 20–60s after each click (J2 R2 B1),
 * and a page error killed the nav and footer too (J2 R2 B2).
 * The receipts/:id route (Gemini line-by-line verdict 2026-11-20)
 * renders the same Receipts page as a deep link into the session
 * ledger: an id matching a receipt in this browser session opens
 * that entry; any other id shows an honest not-found notice. No
 * backend fetch is attempted by this route. The API now serves
 * /receipts/:id and /receipts/:id/raw (live check 2026-11-21: HTTP 200,
 * direct and via /api; the 2026-11-20 check was a 404), but loading a
 * receipt from another session here is out of scope for this build.
 * Raw-byte verification lives in lib/verifyReceipt.ts (see the
 * Receipts.tsx header) — not in this route.
 */
export default function App() {
  return (
    <>
      <ScrollToHash />
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Landing />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="receipts" element={<Receipts />} />
          <Route path="receipts/:id" element={<Receipts />} />
          <Route path="benchmarks" element={<Benchmarks />} />
          <Route path="status" element={<Status />} />
          <Route path="docs" element={<Docs />} />
          <Route path="research" element={<Research />} />
          <Route path="research/desk" element={<ResearchDesk />} />
          <Route path="buyer" element={<Buyer />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </>
  );
}
