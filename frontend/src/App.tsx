import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import ScrollToHash from "./components/ScrollToHash";

const Landing = lazy(() => import("./pages/Landing"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Desk = lazy(() => import("./pages/Desk"));
const Receipts = lazy(() => import("./pages/Receipts"));
const Benchmarks = lazy(() => import("./pages/Benchmarks"));
const Status = lazy(() => import("./pages/Status"));
const Docs = lazy(() => import("./pages/Docs"));
const NotFound = lazy(() => import("./pages/NotFound"));

export default function App() {
  return (
    <>
      {/* Outside <Suspense> so it mounts immediately and can catch the
          hash even while the lazy route chunk is still loading. */}
      <ScrollToHash />
      <Suspense fallback={<div className="route-fallback mono">loading…</div>}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Landing />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="desk" element={<Desk />} />
          <Route path="receipts" element={<Receipts />} />
          <Route path="benchmarks" element={<Benchmarks />} />
          <Route path="status" element={<Status />} />
          <Route path="docs" element={<Docs />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      </Suspense>
    </>
  );
}
