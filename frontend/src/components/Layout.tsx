import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./ErrorBoundary";
import {
  API_BASE,
  BOND_DISPLAY,
  CHAIN_ID,
  CHAIN_NAME,
  DIAMOND_SHORT,
  INTENT_ENDPOINTS,
  MINER_BASE_URL,
  MINER_ID,
  MINER_SLUG,
} from "../config";
import { frontendCommit, REPO_URL } from "../lib/buildCommit";
import { BOND_REGISTRATION_ID } from "../lib/minerBond";
import { DECLARED_INTENT_COUNT } from "../lib/minerManifest";
import { useTheme } from "../hooks/useTheme";
import ThemeToggle from "./ThemeToggle";

const BUILD = frontendCommit();

const NAV_LINKS = [
  { to: "/", label: "Home", end: true },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/receipts", label: "Receipts" },
  { to: "/benchmarks", label: "Benchmarks" },
  { to: "/status", label: "Status" },
  { to: "/docs", label: "Docs" },
  { to: "/research", label: "Research" },
];

type HealthState = "checking" | "ok" | "down";

/** Live health pill: GET /api/health (proxied to the Render miner).
 *  Hardened: each check races an AbortSignal.timeout and polls never
 *  stack (a check already in flight makes the interval tick a no-op).
 *  The FIRST check gets a 60s timeout: a cold Render start can take
 *  25–55s to answer /health, and the old flat 10s timeout showed a live
 *  miner as "unreachable" for ~60s on first visit (J2 re-review minor
 *  3). Subsequent polls keep 10s — a dead API must read as down within
 *  one poll interval (30s) plus the timeout, not a minute.
 *  There is deliberately NO sequence guard here: the in-flight guard
 *  plus a timeout shorter than the poll interval make overlap
 *  unreachable, so a seq number could never drop a stale response —
 *  it was dead code implying a guarantee it cannot provide
 *  (J2 re-review minor 4). */
/** Backend release as reported by the live API (/health git_sha) — QA-10.
 *  Only a plain hex SHA is accepted; anything else reads as unknown. */
export function parseBackendSha(v: unknown): string | null {
  return typeof v === "string" && /^[0-9a-f]{7,40}$/.test(v) ? v : null;
}

function HealthPill({ onBackendSha }: { onBackendSha?: (sha: string | null) => void }) {
  const [health, setHealth] = useState<HealthState>("checking");
  const inFlightRef = useRef(false);
  const firstCheckRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      // First check (cold start) gets 60s; every later poll gets 10s.
      const timeoutMs = firstCheckRef.current ? 60000 : 10000;
      firstCheckRef.current = false;
      try {
        const res = await fetch(`${API_BASE}/health`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (cancelled) return;
        if (!res.ok) {
          setHealth("down");
          return;
        }
        const data = (await res.json()) as { status?: string; git_sha?: unknown };
        if (cancelled) return;
        setHealth(data.status === "ok" ? "ok" : "down");
        onBackendSha?.(parseBackendSha(data.git_sha));
      } catch {
        if (!cancelled) setHealth("down");
      } finally {
        inFlightRef.current = false;
      }
    };
    void check();
    const id = window.setInterval(() => void check(), 30000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // onBackendSha is a stable state setter; the poll must not restart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <span className={`health-pill ${health === "ok" ? "ok" : health === "down" ? "down" : ""}`} role="status">
      <span className="hp-dot" aria-hidden="true" />
      {health === "ok" ? "live · verireceipt" : health === "down" ? "unreachable" : "checking…"}
    </span>
  );
}

/** Real client UTC clock (the design files' clock is real client time — kept). */
function UtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <span>
      {pad(now.getUTCHours())}:{pad(now.getUTCMinutes())}:{pad(now.getUTCSeconds())} UTC
    </span>
  );
}

function Wordmark() {
  return (
    <span className="wordmark">
      <span className="wm-dim">/*</span>
      <span className="wm-crisp">v</span>
      <span className="wm-dim">*/</span>
      <span className="wm-name">erireceipt</span>
    </span>
  );
}

/**
 * QA-05: below 860px the inline links are hidden (they do not fit next to
 * the wordmark, CTA and theme toggle), so a Menu button opens the same
 * six destinations in a panel. Closes on navigation, Escape, and an
 * outside click; focus moves into the panel on open and back on Escape.
 */
function MobileMenu({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Any route change closes the menu.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && !panelRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="nav-menu-btn"
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{open ? "✕" : "☰"}</span>
        <span className="nav-menu-label">Menu</span>
      </button>
      {open && (
        <div id="mobile-nav-panel" ref={panelRef} className="mobile-nav-panel">
          <nav aria-label="Primary (mobile)">
            {NAV_LINKS.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                className={({ isActive }) => (isActive ? "active" : undefined)}
                onClick={() => setOpen(false)}
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
        </div>
      )}
    </>
  );
}

export default function Layout() {
  const { theme, toggleTheme } = useTheme();
  const { pathname, search, hash } = useLocation();
  const [backendSha, setBackendSha] = useState<string | null>(null);

  // (J2 C3 F2b / P-C3 B) Same-URL re-click nonce. A click on a CTA whose
  // URL equals the current location (e.g. "Start a probe" → /#probe while
  // already on /#probe) does NOT navigate — React Router no-ops — so
  // pathname/search/hash never change and the boundary's resetKeys never
  // fire, leaving a shown fallback stuck. The capture-phase document
  // listener bumps this nonce on same-URL anchor clicks, which IS a
  // resetKey change, so the fallback clears and the page re-renders.
  // Capture phase (before React Router handles the click) so the
  // comparison sees the pre-click location; same-origin anchors only.
  // The comparison is against the ROUTER's location (the same values
  // resetKeys uses), not window.location: under MemoryRouter the two
  // differ, and the router is the source of truth for navigation.
  const [navNonce, setNavNonce] = useState(0);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      let url: URL;
      try {
        url = new URL(anchor.getAttribute("href") ?? "", window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === pathname && url.search === search && url.hash === hash) {
        setNavNonce((n) => n + 1);
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [pathname, search, hash]);

  return (
    <div className="app-shell">
      <header className="navbar">
        <div className="container nav-inner">
          <Link to="/" aria-label="VeriReceipt home">
            <Wordmark />
          </Link>
          <div className="nav-right">
            <nav className="nav-links" aria-label="Primary">
              {NAV_LINKS.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  end={l.end}
                  className={({ isActive }) => (isActive ? "active" : undefined)}
                >
                  {l.label}
                </NavLink>
              ))}
            </nav>
            <HealthPill onBackendSha={setBackendSha} />
            <Link to="/#probe" className="btn-outline-accent" aria-label="Start a probe">
              <span className="cta-label-full">Start a probe</span>
              <span className="cta-label-short" aria-hidden="true">
                Probe
              </span>
            </Link>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <MobileMenu pathname={pathname} />
          </div>
        </div>
      </header>

      {/* The boundary wraps ONLY the routed page (J2 R2 B1/B2): Layout —
          nav, health pill, UTC clock, footer — lives outside it and keeps
          its state across navigations, so a click never resets the health
          pill to "checking…". resetKeys={[pathname, search, hash]} clears
          a render error when the user navigates away WITHOUT remounting
          (PLAN.md C3) — the old key={pathname} remount dropped the page's
          state on every nav, including /receipts → /receipts/:id. The
          hash (and search) are keys too: a hash-only click such as the
          navbar "Start a probe" CTA (/#probe) changes neither the
          pathname nor the page, so pathname-only keys left the fallback
          stuck on a failed Landing page (J2 C3 F2). The navNonce key
          covers the last hole: a SAME-URL re-click of that CTA (already
          on /#probe) does not navigate at all, so no location key
          changes — the nonce bump clears the fallback (J2 C3 F2b /
          P-C3 B). The nav stays usable to navigate away from a failed
          page. */}
      <ErrorBoundary resetKeys={[pathname, search, hash, navNonce]}>
        <Outlet />
      </ErrorBoundary>

      <footer className="giant-footer">
        <div className="container">
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "flex-end",
              justifyContent: "space-between",
              gap: 20,
              paddingBottom: 36,
            }}
          >
            <div className="giant-wm">
              <Wordmark />
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 14, color: "var(--muted)", marginBottom: 4 }}>
                Zero-LLM Cryptographic Receipt Oracle &amp; Mission 13/12 Desk.
              </div>
              <div className="mono" style={{ fontSize: 13, color: "var(--text)" }}>
                {MINER_BASE_URL.replace("https://", "")}
              </div>
            </div>
          </div>

          <div className="foot-cols">
            <div>
              <div className="kicker">// sitemap</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, color: "var(--soft)" }}>
                <Link to="/docs">Intents</Link>
                <Link to="/docs">Guarantees</Link>
                <Link to="/dashboard">Desk logs ↗</Link>
                <Link to="/#roadmap">Roadmap</Link>
                <Link to="/#manifesto">Manifesto</Link>
              </div>
            </div>
            <div>
              <div className="kicker">// selected endpoints · {DECLARED_INTENT_COUNT} declared intents</div>
              <div
                className="mono"
                style={{ display: "flex", flexDirection: "column", gap: 7, fontSize: 11.5, color: "var(--soft)" }}
              >
                {INTENT_ENDPOINTS.map((e) => (
                  <span key={e.path}>
                    {e.method} {e.path}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <div className="kicker">// network</div>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                <span
                  style={{ width: 6, height: 6, borderRadius: 999, background: "var(--accent)" }}
                />
                <span>
                  {CHAIN_NAME} ({CHAIN_ID})
                </span>
              </div>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 6 }}>
                <UtcClock />
              </div>
              <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>
                Diamond {DIAMOND_SHORT}
              </div>
              <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
                miner.yaml id {MINER_ID} · {MINER_SLUG}
              </div>
              <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                node registration {BOND_REGISTRATION_ID} (on-chain bond)
              </div>
            </div>
            <div>
              <div className="kicker">// deployment</div>
              <div style={{ color: "var(--text)", marginBottom: 6 }}>Render web service</div>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 4 }}>
                Node.js 20 · Fastify · persistent storage (see /health)
              </div>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>
                auth: none · {BOND_DISPLAY}
              </div>
              <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 6, overflowWrap: "anywhere" }}>
                frontend{" "}
                <a href={`${REPO_URL}/commit/${BUILD.sha}`} target="_blank" rel="noreferrer" style={{ color: "var(--muted)" }}>
                  {BUILD.sha}
                </a>
                <div style={{ marginTop: 4 }}>{BUILD.label}</div>
                <div style={{ marginTop: 6 }}>
                  backend{" "}
                  {backendSha ? (
                    <a href={`${REPO_URL}/commit/${backendSha}`} target="_blank" rel="noreferrer" style={{ color: "var(--muted)" }}>
                      {backendSha}
                    </a>
                  ) : (
                    "unknown (no git_sha from /health yet)"
                  )}
                </div>
                <div style={{ marginTop: 4 }}>
                  frontend and backend deploy separately; a commit is deployed only where its SHA appears here
                </div>
              </div>
            </div>
          </div>

          <div
            className="mono"
            style={{
              paddingTop: 24,
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "space-between",
              gap: 12,
              fontSize: 11.5,
              color: "var(--muted)",
            }}
          >
            <span>© 2026 VeriReceipt · Telegraph Season II</span>
            <span>// zero llm. receipt-first.</span>
            <Link to="/" style={{ color: "var(--text)" }}>
              Back to top ↑
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
