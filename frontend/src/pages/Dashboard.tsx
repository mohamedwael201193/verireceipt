// VeriReceipt // Dashboard & Proof Hub.
//
// Port of verireceipt_dashboard_proof_hub.html (File B) as a React page,
// with every placeholder replaced by a live call (see DESIGN-SPEC §6 D-01…D-20
// and the decisions in the follow-up: grid is /v1/grid-price, miner id
// 774921 / slug verireceipt, bond $4.32 (lib/minerBond.ts), no $1.84/184-checks figure, no
// canned ledger/benchmarks, no fabricated M12/AAPL/TVL numbers).
//
// The page owns the session ledger: every live call from any view appends a
// real receipt here (newest first). Nothing is seeded. The four views are
// internal tabs of this page, exactly as designed.
//
// THEME (single owner): the shell Layout owns the theme via useTheme /
// ThemeToggle (localStorage key `verireceipt-theme`, dark default). This
// page keeps NO theme state and renders NO theme toggle — an earlier
// duplicate toggle desynced from the shell's. Theme-dependent drawing
// (dither ribbon, oscilloscope) reads document.documentElement's
// data-theme attribute at draw time.
// BRANCH BUILDABILITY (J2 M10, integration-owned): this branch carries
// only the dashboard pages; the app shell (Layout, ThemeToggle, useTheme),
// the data-layer lib and the vite/vitest harness live on the
// frontend/scaffold and frontend/data-layer branches. This branch is NOT
// independently buildable on its own — that is by the merge design, not a
// defect of this page; do not restructure it to be standalone.

import { useCallback, useEffect, useRef, useState } from "react";
import AuthDrawer from "./dashboard/AuthDrawer";
import Benchmarks from "./dashboard/Benchmarks";
import MissionDesk from "./dashboard/MissionDesk";
import ReceiptDrawer from "./dashboard/ReceiptDrawer";
import EscrowPurchases from "./dashboard/EscrowPurchases";
import ReceiptsLedger from "./dashboard/ReceiptsLedger";
import StatusDocs from "./dashboard/StatusDocs";
import "./dashboard/dashboard.css";
import type { AuthMode, DashboardView, LiveReceipt, ScopeSamples, ScopeSeriesKey } from "./dashboard/types";
import { DIAMOND_SHORT, LEDGER_CAP, appendToLedger, isHealthOk, persistLiveReceiptToSessionLedger, utcClock } from "./dashboard/utils";
import { readDashboardRows, writeDashboardRows } from "./dashboard/dashboardRows";
import { SESSION_RECEIPTS_GEN_KEY, SESSION_RECEIPTS_KEY } from "../lib/sessionReceipts";

/** Persist outcome of one recorded row (QA-01): "persisted" = written to
 *  the shared /receipts ledger; "skipped" = nothing to write (refusal,
 *  /health, or the ledger was cleared mid-call); "failed" = browser
 *  storage refused the write. */
export type RecordOutcome = "persisted" | "skipped" | "failed";

/** Rebuild the oscilloscope samples from restored rows (oldest first). */
function samplesFromRows(rows: LiveReceipt[]): ScopeSamples {
  const out: ScopeSamples = { tx: [], grid: [], tvl: [], route: [] };
  for (let i = rows.length - 1; i >= 0; i--) {
    const series = seriesForIntent(rows[i].intent);
    if (series) out[series].push(rows[i].latencyMs);
  }
  for (const k of Object.keys(out) as ScopeSeriesKey[]) out[k] = out[k].slice(-SCOPE_CAP);
  return out;
}

const SCOPE_CAP = 48;

const VIEW_TABS: Array<{ id: DashboardView; num: string; label: string }> = [
  { id: "desk", num: "01", label: "Mission Desk" },
  { id: "receipts", num: "02", label: "Receipts" },
  { id: "benchmarks", num: "03", label: "Benchmarks" },
  { id: "status", num: "04", label: "Status & Docs" },
];

function seriesForIntent(intent: string): ScopeSeriesKey | null {
  if (intent === "ONCHAIN_TX_LOOKUP_GENERAL") return "tx";
  if (intent === "GRID_POWER_PRICE_GENERAL") return "grid";
  if (intent === "TVL_LOOKUP_GENERAL") return "tvl";
  if (intent === "OPTIMAL_EXECUTION_ROUTE_GENERAL") return "route";
  return null;
}

export default function Dashboard() {
  const [view, setView] = useState<DashboardView>("desk");
  // QA-01: restore this tab's rows (sessionStorage, tied to the shared
  // ledger's clear generation) so leaving /dashboard or reloading no
  // longer resets the table to zero.
  const [receipts, setReceipts] = useState<LiveReceipt[]>(() => readDashboardRows());
  const [samples, setSamples] = useState<ScopeSamples>(() => samplesFromRows(receipts));
  const [inspected, setInspected] = useState<LiveReceipt | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("sponsored");
  const [toast, setToast] = useState<string | null>(null);
  const [utcNow, setUtcNow] = useState(() => utcClock());

  const toastTimer = useRef<number | null>(null);
  const scrollBarRef = useRef<HTMLDivElement | null>(null);
  const dotRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const ditherRef = useRef<HTMLCanvasElement | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  // Clear the toast timer on unmount so a pending timeout never fires
  // setState on an unmounted page.
  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  // Record a live receipt in the session ledger (+ oscilloscope sample).
  // The ledger is capped at the latest LEDGER_CAP receipts.
  // QA-01: every receipted row is ALSO written to the shared /receipts
  // ledger (the helper existed but was never called from here, so
  // Dashboard receipts never reached /receipts). The outcome is returned
  // so callers only claim "saved to the ledger" when the write happened.
  const onRecord = useCallback((receipt: LiveReceipt): RecordOutcome => {
    const outcome = persistLiveReceiptToSessionLedger(receipt);
    setReceipts((prev) => appendToLedger(prev, receipt));
    const series = seriesForIntent(receipt.intent);
    if (series) {
      setSamples((prev) => ({
        ...prev,
        [series]: [...prev[series], receipt.latencyMs].slice(-SCOPE_CAP),
      }));
    }
    return outcome;
  }, []);

  // QA-01: keep this tab's rows across route changes and reloads.
  useEffect(() => {
    writeDashboardRows(receipts);
  }, [receipts]);

  // A Clear on /receipts in ANOTHER tab bumps the shared clear
  // generation (or removes the ledger): drop this page's rows too, so a
  // cleared ledger is never shown here as still populated.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SESSION_RECEIPTS_GEN_KEY && !(e.key === SESSION_RECEIPTS_KEY && e.newValue === null)) return;
      setReceipts([]);
      setSamples({ tx: [], grid: [], tvl: [], route: [] });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Live UTC clock.
  useEffect(() => {
    const t = window.setInterval(() => setUtcNow(utcClock()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Page title (design title) while mounted.
  useEffect(() => {
    const prev = document.title;
    document.title = "VeriReceipt // Dashboard & Proof Hub";
    return () => {
      document.title = prev;
    };
  }, []);

  // Scroll progress bar.
  useEffect(() => {
    const onScroll = () => {
      const bar = scrollBarRef.current;
      if (!bar) return;
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      bar.style.width = `${Math.min(100, Math.max(0, (window.scrollY / max) * 100))}%`;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Desktop custom cursor (dot + ring), pointer:fine only.
  useEffect(() => {
    const dot = dotRef.current;
    const ring = ringRef.current;
    if (!dot || !ring || !window.matchMedia?.("(pointer: fine)").matches) return;
    let mx = -60;
    let my = -60;
    let rx = -60;
    let ry = -60;
    let shown = false;
    let raf = 0;
    const onMove = (e: MouseEvent) => {
      mx = e.clientX;
      my = e.clientY;
      if (!shown) {
        shown = true;
        dot.classList.add("on");
        ring.classList.add("on");
      }
      dot.style.transform = `translate3d(${mx - 2.5}px,${my - 2.5}px,0)`;
      const hov =
        e.target instanceof Element &&
        e.target.closest("a,button,input,tr.clickable,[data-hover]");
      ring.classList.toggle("grow", !!hov);
    };
    const onLeave = () => {
      shown = false;
      dot.classList.remove("on");
      ring.classList.remove("on");
    };
    const loop = () => {
      rx += (mx - rx) * 0.17;
      ry += (my - ry) * 0.17;
      const hr = (ring.offsetWidth || 28) * 0.5;
      ring.style.transform = `translate3d(${rx - hr}px,${ry - hr}px,0)`;
      raf = requestAnimationFrame(loop);
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseleave", onLeave);
    raf = requestAnimationFrame(loop);
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      cancelAnimationFrame(raf);
    };
  }, []);

  // Ribbon pixel-dither canvas (procedural decoration, theme-aware).
  useEffect(() => {
    const cvs = ditherRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let w = 1200;
    let h = 44;
    const resize = () => {
      const r = cvs.parentElement?.getBoundingClientRect();
      if (!r) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(300, Math.floor(r.width));
      h = Math.max(36, Math.floor(r.height));
      cvs.width = w * dpr;
      cvs.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    const draw = (now: number) => {
      const t = now * 0.001;
      const isLight = document.documentElement.getAttribute("data-theme") === "light";
      ctx.clearRect(0, 0, w, h);
      const pitch = 14;
      const sq = 10;
      const cols = Math.ceil(w / pitch);
      const rows = Math.ceil(h / pitch);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const seed = Math.abs(Math.sin(c * 19.31 + r * 47.17)) % 1;
          if (seed < 0.55) continue;
          const wave = 0.5 + 0.5 * Math.sin(t * 0.9 + c * 0.25 + r);
          const al = 0.025 + wave * 0.04;
          ctx.fillStyle =
            c === Math.floor(cols * 0.72) && r === 1
              ? `rgba(255, 87, 34, ${(0.35 + wave * 0.35).toFixed(2)})`
              : isLight
                ? `rgba(20,20,20,${al.toFixed(3)})`
                : `rgba(242,241,236,${al.toFixed(3)})`;
          ctx.fillRect(c * pitch, r * pitch, sq, sq);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  // Escape closes drawers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setInspected(null);
        setAuthOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function switchView(v: DashboardView) {
    setView(v);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // /health state comes from the session ledger (the last on-demand
  // /health Ping or B02 probe). This page runs no health poller: the
  // shell's health pill already polls /health every 30s, and a second
  // (plus a third in StatusDocs) poller per route was pure duplication.
  const lastHealthReceipt = receipts.find((r) => r.intent === "HEALTH") ?? null;
  // /health is NON-receipted by contract (J1 R3 B-1): getHealth passes
  // no expectReceipt and HealthResponse has no receipt field, so a
  // healthy miner answers 200 {status:"ok",...} with no receipt — that
  // is "ok" via isHealthOk, never a refusal. Requiring a receipt here
  // (round 3) called every healthy miner "refused". A 200 whose body
  // is NOT {status:"ok"} — e.g. the lib refused it as INVALID_RESPONSE,
  // status 200, error body — keeps the refused text below. (J2 R5:
  // the parenthetical is "(body not ok)" — /health never has a
  // receipt, so "(no receipt)" misattributed the cause.)
  const healthLabel = lastHealthReceipt
    ? isHealthOk(lastHealthReceipt)
      ? `/health: ok · uptime ${(() => {
          const b = lastHealthReceipt.body as { uptime_s?: unknown } | null;
          return typeof b?.uptime_s === "number" ? `${b.uptime_s}s` : "—";
        })()}`
      : `/health: HTTP ${lastHealthReceipt.status} — ${lastHealthReceipt.status === 200 ? "refused (body not ok)" : "not ok"}`
    : "No manual /health probe in this tab · live status is in the header";

  const authPillLabel = authMode === "sponsored" ? "Sponsored" : "MCP / CLI";

  // The two drawers are mutually exclusive: opening one closes the other.
  function openReceipt(receipt: LiveReceipt | null) {
    setInspected(receipt);
    if (receipt !== null) setAuthOpen(false);
  }
  function openAuth() {
    setAuthOpen(true);
    setInspected(null);
  }

  return (
    <div className="vr-dashboard">
      {/* Page-level heading for assistive tech + the route smoke test: the
          visible H1s are the per-view headings from the design. */}
      <h1 className="sr-only">Dashboard &amp; Proof Hub</h1>
      <div id="scroll-bar" ref={scrollBarRef} aria-hidden="true" />
      <div id="c-dot" ref={dotRef} aria-hidden="true" />
      <div id="c-ring" ref={ringRef} aria-hidden="true" />

      <header className="navbar">
        <div className="wrap nav-inner">
          <div className="brand">
            <button type="button" className="wordmark" onClick={() => switchView("desk")}>
              <span className="wm-dim">/*</span>
              <span className="wm-v">v</span>
              <span className="wm-dim">*/</span>
              <span className="wm-txt">erireceipt</span>
            </button>
            <span className="brand-tag">// dashboard</span>
          </div>

          <nav className="view-tabs" aria-label="Dashboard Views">
            {VIEW_TABS.map((t) => (
              <button key={t.id} type="button" className={`v-tab${view === t.id ? " active" : ""}`} onClick={() => switchView(t.id)}>
                <span className="dot" />
                <span className="num">{t.num}</span>
                <span>{t.label}</span>
              </button>
            ))}
          </nav>

          <div className="nav-actions">
            <button type="button" className="auth-pill" onClick={openAuth} title="Configure Auth & Payment Mode">
              <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--accent)" }} />
              <span>{authPillLabel}</span>
            </button>
          </div>
        </div>
      </header>

      <div className="mobile-tabs">
        <div className="mobile-tabs-inner">
          {VIEW_TABS.map((t) => (
            <button key={t.id} type="button" className={`m-tab${view === t.id ? " active" : ""}`} onClick={() => switchView(t.id)}>
              {t.num} {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="telemetry-bar">
        <canvas id="ribbon-dither" ref={ditherRef} aria-hidden="true" />
        <div className="wrap telemetry-inner">
          <div className="tele-group">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--text)", fontWeight: 500 }}>
              <span className="pulse-ok" />
              Render (render.yaml: virginia) · {healthLabel}
            </span>
            <span className="sep">|</span>
            <span>
              Sepolia Diamond <strong style={{ color: "var(--text)", fontWeight: 500 }}>{DIAMOND_SHORT}</strong>
            </span>
            <span className="sep">|</span>
            <span>
              Rail: <strong style={{ color: "var(--text)", fontWeight: 500 }}>Direct probe · /api (no signing)</strong>
            </span>
          </div>
          <div className="tele-group">
            <span style={{ color: "var(--text)" }}>{utcNow} UTC</span>
            <span className="sep">|</span>
            <span>
              Receipts (this tab): <strong style={{ color: "var(--accent)" }}>{receipts.filter((r) => r.receipt !== null).length}</strong>
              {receipts.some((r) => r.receipt === null) && (
                <> · refusals/pings: {receipts.filter((r) => r.receipt === null).length}</>
              )}
            </span>
            {receipts.length >= LEDGER_CAP && (
              <>
                <span className="sep">|</span>
                <span>capped at latest {LEDGER_CAP}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {view === "desk" && (
        <section className="view active" aria-label="Mission Desk">
          <MissionDesk onRecord={onRecord} onInspect={openReceipt} showToast={showToast} />
        </section>
      )}
      {view === "receipts" && (
        <section className="view active" aria-label="Receipts">
          <ReceiptsLedger receipts={receipts} onInspect={openReceipt} showToast={showToast} />
          <div className="wrap">
            <EscrowPurchases />
          </div>
        </section>
      )}
      {view === "benchmarks" && (
        <section className="view active" aria-label="Benchmarks">
          <Benchmarks onRecord={onRecord} showToast={showToast} />
        </section>
      )}
      {view === "status" && (
        <section className="view active" aria-label="Status and Docs">
          <StatusDocs
            active={view === "status"}
            receipts={receipts}
            samples={samples}
            onRecord={onRecord}
            showToast={showToast}
          />
        </section>
      )}

      <div
        className={`backdrop${inspected !== null || authOpen ? " open" : ""}`}
        onClick={() => {
          setInspected(null);
          setAuthOpen(false);
        }}
      />
      <ReceiptDrawer receipt={inspected} onClose={() => setInspected(null)} showToast={showToast} />
      <AuthDrawer open={authOpen} authMode={authMode} onSelectMode={setAuthMode} onClose={() => setAuthOpen(false)} showToast={showToast} />


      <div id="toast" role="status" aria-live="polite" className={toast ? "show" : ""}>
        {toast ?? ""}
      </div>
    </div>
  );
}
