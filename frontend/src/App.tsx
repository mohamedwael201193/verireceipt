import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";

const Landing = lazy(() => import("./pages/Landing"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Receipts = lazy(() => import("./pages/Receipts"));
const Benchmarks = lazy(() => import("./pages/Benchmarks"));
const Status = lazy(() => import("./pages/Status"));
const Docs = lazy(() => import("./pages/Docs"));

export default function App() {
  return (
    <Suspense fallback={<div className="route-fallback mono">loading…</div>}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Landing />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="receipts" element={<Receipts />} />
          <Route path="benchmarks" element={<Benchmarks />} />
          <Route path="status" element={<Status />} />
          <Route path="docs" element={<Docs />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
