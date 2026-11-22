// Giant footer — page content (the Layout owns the chrome around it).
//
// Endpoint list corrected to the live GET contract (the design's POST
// /v1/*-lookup paths do not exist). Miner identity is the verified
// 774921 / verireceipt; the repo link points at the real repo and the
// build commit (VERCEL_GIT_COMMIT_SHA when present; otherwise an honest origin/main pin). The clock is
// real client time; the deployment column shows the live /health status
// next to the brand copy.
import { useEffect, useState } from "react";
import { frontendCommit, REPO_URL } from "../../lib/buildCommit";
import { useHealth } from "../../lib/hooks";
import { BOND_DISPLAY, CHAIN_ID, CHAIN_NAME, DIAMOND_SHORT, MINER_ID, MINER_SLUG } from "../../config";

const BUILD = frontendCommit();

function useUtcClock(): string {
  const [now, setNow] = useState(() => new Date().toISOString().slice(11, 19) + " UTC+0");
  useEffect(() => {
    const t = setInterval(() => setNow(new Date().toISOString().slice(11, 19) + " UTC+0"), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function SiteFooter() {
  const clock = useUtcClock();
  const health = useHealth();

  return (
    <footer className="giant-footer">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 20, paddingBottom: 36 }}>
        <div className="giant-wm">
          <span className="wm-dim">/*</span>
          <span className="wm-crisp">v</span>
          <span className="wm-dim">*/</span>
          <span className="wm-name">erireceipt</span>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 14, color: "var(--muted)", marginBottom: 4 }}>
            Zero-LLM Cryptographic Receipt Oracle &amp; Mission 13/12 Desk.
          </div>
          <div className="mono" style={{ fontSize: 13, color: "var(--text)" }}>
            verireceipt.onrender.com
          </div>
        </div>
      </div>

      <div className="foot-cols">
        <div>
          <div className="kicker">// sitemap</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, color: "var(--soft)" }}>
            <a href="#intents">Intents</a>
            <a href="#guarantees">Guarantees</a>
            <a href="#desk-logs">Desk logs ↗</a>
            <a href="#roadmap">Roadmap</a>
            <a href="#manifesto">Manifesto</a>
          </div>
        </div>
        <div>
          <div className="kicker">// selected endpoints · 14 declared intents</div>
          <div className="mono" style={{ display: "flex", flexDirection: "column", gap: 7, fontSize: 11.5, color: "var(--soft)" }}>
            <span>GET /v1/tx</span>
            <span>GET /v1/filings</span>
            <span>GET /v1/tvl</span>
            <span>GET /v1/route</span>
            <span>GET /v1/grid-price</span>
            <span>GET /v1/validator</span>
            <span>GET /health</span>
          </div>
        </div>
        <div>
          <div className="kicker">// network</div>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--accent)" }} />
            <span>
              {CHAIN_NAME} ({CHAIN_ID})
            </span>
          </div>
          <div className="mono" style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 6 }}>
            {clock}
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>
            Diamond {DIAMOND_SHORT}
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
            Miner {MINER_ID} · {MINER_SLUG} ·{" "}
            <a href={REPO_URL} target="_blank" rel="noreferrer" style={{ color: "var(--text)" }}>
              repo @{BUILD.short}
            </a>
          </div>
        </div>
        <div>
          <div className="kicker">// deployment</div>
          <div style={{ color: "var(--text)", marginBottom: 6 }}>
            Render web service{" "}
            <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
              {health.loading && "(checking…)"}
              {health.data && `(live · ${health.data.status})`}
              {health.error && "(unreachable)"}
            </span>
          </div>
          <div className="mono" style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 4 }}>
            Node.js 20 · Fastify · persistent storage (see /health)
          </div>
          <div className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>
            auth: none · {BOND_DISPLAY}
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 6, overflowWrap: "anywhere" }}>
            <a href={`${REPO_URL}/commit/${BUILD.sha}`} target="_blank" rel="noreferrer" style={{ color: "var(--muted)" }}>
              {BUILD.sha}
            </a>
            <div style={{ marginTop: 4 }}>{BUILD.label}</div>
          </div>
        </div>
      </div>

      <div className="mono" style={{ paddingTop: 24, display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 12, fontSize: 11.5, color: "var(--muted)" }}>
        <span>© 2026 VeriReceipt · Telegraph Season II</span>
        <span>// zero llm. receipt-first.</span>
        <a href="#top" style={{ color: "var(--text)" }}>
          Back to top ↑
        </a>
      </div>
    </footer>
  );
}
