import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
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
import { useTheme } from "../hooks/useTheme";
import ThemeToggle from "./ThemeToggle";

const NAV_LINKS = [
  { to: "/", label: "Home", end: true },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/receipts", label: "Receipts" },
  { to: "/benchmarks", label: "Benchmarks" },
  { to: "/status", label: "Status" },
  { to: "/docs", label: "Docs" },
];

type HealthState = "checking" | "ok" | "down";

/** Live health pill: GET /api/health (proxied to the Render miner).
 *  Hardened: each check races a 10s AbortSignal.timeout, polls never stack
 *  (a check already in flight makes the interval tick a no-op), and a
 *  sequence number drops stale responses — only the latest check updates
 *  state. */
function HealthPill() {
  const [health, setHealth] = useState<HealthState>("checking");
  const inFlightRef = useRef(false);
  const seqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const seq = ++seqRef.current;
      try {
        const res = await fetch(`${API_BASE}/health`, {
          signal: AbortSignal.timeout(10000),
        });
        if (cancelled || seq !== seqRef.current) return;
        if (!res.ok) {
          setHealth("down");
          return;
        }
        const data = (await res.json()) as { status?: string };
        if (cancelled || seq !== seqRef.current) return;
        setHealth(data.status === "ok" ? "ok" : "down");
      } catch {
        if (!cancelled && seq === seqRef.current) setHealth("down");
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

export default function Layout() {
  const { theme, toggleTheme } = useTheme();

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
            <HealthPill />
            <Link to="/#probe" className="btn-outline-accent" aria-label="Start a probe">
              <span className="cta-label-full">Start a probe</span>
              <span className="cta-label-short" aria-hidden="true">
                Probe
              </span>
            </Link>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>
        </div>
      </header>

      <Outlet />

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
              <div className="kicker">// endpoints</div>
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
                Miner {MINER_ID} · {MINER_SLUG}
              </div>
            </div>
            <div>
              <div className="kicker">// deployment</div>
              <div style={{ color: "var(--text)", marginBottom: 6 }}>Always-Warm Render US-East</div>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 4 }}>
                Node.js 20 · Fastify · SQLite WAL
              </div>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>
                auth: none · {BOND_DISPLAY}
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
