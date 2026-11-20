// Status & Docs (View 04) — live telemetry, live probes, real docs.
//
// Replaces the simulated status view (DESIGN-SPEC §6 D-10/D-11/D-12/D-13):
// - Ping buttons call the real endpoint with a valid sample input and show
//   the measured latency + receipt (no Math.random()).
// - The oscilloscope plots measured latencies only — no random walk.
// - Telemetry cards show /health (live) + values sourced from render.yaml /
//   src (region, Node version, SQLite path, abort cap, quorum). "5 / 5
//   CLOSED" and "Fresh 2m ago" were canned; the cards now show how many
//   endpoints actually answered and the age of the last live grid receipt.
// - ERCOT/MISO are NOT advertised (de-advertised at base commit e35fb0a).
// - Doc snippets use the real GET endpoints and the real miner.yaml
//   (id 774921, slug verireceipt); grid is /v1/grid-price (§8 A1/A2).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getFilings, getGridPrice, getHealth, getRoute, getTvl, getTx } from "../../lib/api";
import { useLiveQuery } from "../../lib/hooks";
import type { HealthResponse } from "../../lib/types";
import { DOC_SNIPPETS, DOC_TABS, type DocTabId } from "./docs";
import type { LiveReceipt, ScopeSamples, ScopeSeriesKey } from "./types";
import {
  copyText,
  directUrl,
  formatMs,
  median,
  probe,
  recentGridInterval,
  relativeAge,
  toLiveReceipt,
} from "./utils";

interface StatusDocsProps {
  /** Whether the status view is the visible tab (canvas redraws on activation). */
  active: boolean;
  health: HealthResponse | null;
  healthError: Error | null;
  lastHealthCheck: string | null;
  receipts: LiveReceipt[];
  samples: ScopeSamples;
  onRecord: (receipt: LiveReceipt) => void;
  showToast: (msg: string) => void;
}

const CONFIRMED_TX =
  "0x1b9e2b48eb3510ee1a8aae2fc402139784f32d43b76d5853387cacb484a9a9d3";

interface EndpointDef {
  key: string;
  path: string;
  role: string;
  src: string;
  intent: string;
  query: string;
  requestUrl: string;
  fetcher: () => Promise<unknown>;
}

/** Sample inputs are valid, live-verified inputs (see presets.ts). */
function endpointDefs(): EndpointDef[] {
  const gridInterval = recentGridInterval();
  return [
    {
      key: "tx",
      path: "/v1/tx",
      role: "ONCHAIN_TX_LOOKUP_GENERAL",
      src: "2-of-3 Archive RPC Quorum",
      intent: "ONCHAIN_TX_LOOKUP_GENERAL",
      query: `${CONFIRMED_TX.slice(0, 8)}…${CONFIRMED_TX.slice(-4)} (ethereum)`,
      requestUrl: directUrl("/v1/tx", { tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      fetcher: () => getTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
    },
    {
      key: "filings",
      path: "/v1/filings",
      role: "REGULATORY_FILING_MONITOR_GENERAL",
      src: "SEC EDGAR + Federal Register",
      intent: "REGULATORY_FILING_MONITOR_GENERAL",
      query: "AAPL · last 12 months",
      requestUrl: directUrl("/v1/filings", { entity: "AAPL", period: "last 12 months" }),
      fetcher: () => getFilings({ entity: "AAPL", period: "last 12 months" }),
    },
    {
      key: "tvl",
      path: "/v1/tvl",
      role: "TVL_LOOKUP_GENERAL",
      src: "DeFiLlama",
      intent: "TVL_LOOKUP_GENERAL",
      query: "protocol=aave-v3",
      requestUrl: directUrl("/v1/tvl", { protocol: "aave-v3" }),
      fetcher: () => getTvl({ protocol: "aave-v3" }),
    },
    {
      key: "route",
      path: "/v1/route",
      role: "OPTIMAL_EXECUTION_ROUTE_GENERAL",
      src: "Uniswap V2/V3 + SushiSwap + Curve (block-pinned)",
      intent: "OPTIMAL_EXECUTION_ROUTE_GENERAL",
      query: "pair=ETH/USDC",
      requestUrl: directUrl("/v1/route", { pair: "ETH/USDC" }),
      fetcher: () => getRoute({ pair: "ETH/USDC" }),
    },
    {
      key: "grid",
      path: "/v1/grid-price",
      role: "GRID_POWER_PRICE_GENERAL",
      src: "CAISO OASIS SQLite cache",
      intent: "GRID_POWER_PRICE_GENERAL",
      query: `TH_NP15_GEN-APND · ${gridInterval}`,
      requestUrl: directUrl("/v1/grid-price", { node_or_zone: "TH_NP15_GEN-APND", interval_start: gridInterval }),
      fetcher: () => getGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: gridInterval }),
    },
    {
      key: "health",
      path: "/health",
      role: "Render health probe",
      src: "Local Fastify",
      intent: "HEALTH",
      query: "GET /health",
      requestUrl: directUrl("/health", {}),
      fetcher: () => getHealth(),
    },
    {
      key: "mcp",
      path: "/api/mcp",
      role: "Streamable HTTP MCP Server",
      src: "VeriReceipt Desk Tools (POST-only)",
      intent: "MCP",
      query: "GET /api/mcp (POST-only endpoint)",
      requestUrl: "https://verireceipt.onrender.com/api/mcp",
      // The miner serves no GET /api/mcp route yet (server.ts has no MCP
      // route); this probe reports the live status honestly instead of
      // assuming the endpoint exists.
      fetcher: async () => {
        const res = await fetch("/api/api/mcp", { headers: { Accept: "application/json" } });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
        return JSON.parse(text) as unknown;
      },
    },
  ];
}

interface RowProbe {
  latencyMs: number;
  status: number;
}

function HealthRow({
  def,
  onRecord,
  showToast,
}: {
  def: EndpointDef;
  onRecord: (r: LiveReceipt) => void;
  showToast: (msg: string) => void;
}) {
  const [last, setLast] = useState<RowProbe | null>(null);
  const [latencies, setLatencies] = useState<number[]>([]);
  const defRef = useRef(def);
  defRef.current = def;

  const fetcher = useCallback(async () => {
    const d = defRef.current;
    const outcome = await probe(d.fetcher);
    const receipt = toLiveReceipt(d.intent, d.query, d.requestUrl, outcome);
    onRecord(receipt);
    setLast({ latencyMs: outcome.latencyMs, status: receipt.status });
    setLatencies((prev) => [...prev, outcome.latencyMs].slice(-20));
    if (!outcome.ok) {
      throw new Error(`HTTP ${receipt.status || "—"}: ${receipt.errorMessage ?? "request failed"}`);
    }
    return outcome.body;
  }, [onRecord]);

  const q = useLiveQuery<unknown>(`health-${def.key}`, fetcher);

  const p50 = median(latencies);
  const stateBadge = (() => {
    if (q.loading && !last) return { cls: "b-dim", label: "PROBING…" };
    if (q.error) return { cls: "b-err", label: last?.status ? `HTTP ${last.status}` : "DOWN" };
    if (last?.status === 200) return { cls: "b-ok", label: "UP" };
    if (last) return { cls: "b-warn", label: `HTTP ${last.status}` };
    return { cls: "b-dim", label: "NOT PROBED" };
  })();

  return (
    <tr>
      <td className="mono" style={{ fontWeight: 500, color: "var(--accent)" }}>{def.path}</td>
      <td className="mono" style={{ fontSize: 11 }}>{def.role}</td>
      <td style={{ fontSize: 12, color: "var(--muted)" }}>{def.src}</td>
      <td className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
        {def.key === "health" || def.key === "mcp" ? "—" : "10s · miner.yaml"}
      </td>
      <td className="mono" style={{ fontSize: 11.5 }}>
        {p50 !== null && latencies.length >= 3
          ? `p50 ${formatMs(p50)} (n=${latencies.length})`
          : last
            ? `${formatMs(last.latencyMs)} (n=${latencies.length})`
            : "—"}
      </td>
      <td><span className={`badge ${stateBadge.cls}`}>{stateBadge.label}</span></td>
      <td>
        <button
          type="button"
          className="btn-ghost"
          style={{ padding: "4px 10px", fontSize: 10.5 }}
          onClick={() => {
            q.refetch();
            showToast(`Probing ${def.path}…`);
          }}
          disabled={q.loading}
        >
          {q.loading ? "…" : "Ping"}
        </button>
      </td>
    </tr>
  );
}

const SCOPE_SERIES: Array<{ key: ScopeSeriesKey; col: string; label: string }> = [
  { key: "tx", col: "#FF5722", label: "TX Quorum" },
  { key: "grid", col: "#22C55E", label: "Grid SQLite" },
  { key: "tvl", col: "#38BDF8", label: "DeFiLlama TVL" },
  { key: "route", col: "#A78BFA", label: "ETH Route" },
];

export default function StatusDocs({
  active,
  health,
  healthError,
  lastHealthCheck,
  receipts,
  samples,
  onRecord,
  showToast,
}: StatusDocsProps) {
  const [activeDoc, setActiveDoc] = useState<DocTabId>("curl");
  const defs = useMemo(() => endpointDefs(), []);
  const scopeRef = useRef<HTMLCanvasElement | null>(null);
  const samplesRef = useRef(samples);
  samplesRef.current = samples;

  const answeredEndpoints = useMemo(() => {
    const intents = new Set(
      receipts.filter((r) => r.status === 200).map((r) => r.intent),
    );
    return ["ONCHAIN_TX_LOOKUP_GENERAL", "REGULATORY_FILING_MONITOR_GENERAL", "TVL_LOOKUP_GENERAL", "OPTIMAL_EXECUTION_ROUTE_GENERAL", "GRID_POWER_PRICE_GENERAL"].filter((i) => intents.has(i)).length;
  }, [receipts]);

  const lastGrid = useMemo(
    () => receipts.find((r) => r.intent === "GRID_POWER_PRICE_GENERAL" && r.status === 200) ?? null,
    [receipts],
  );

  // Oscilloscope: draw measured samples only (no random walk).
  useEffect(() => {
    const canvas = scopeRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 20) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = rect.width;
      const h = 150;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const isLight = document.documentElement.getAttribute("data-theme") === "light";
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = isLight ? "rgba(20,20,20,0.09)" : "rgba(255,255,255,0.07)";
      ctx.lineWidth = 1;
      [30, 75, 120].forEach((y) => {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      });
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillStyle = isLight ? "#5C5B57" : "#8E8D89";
      ctx.fillText("250ms", 4, 24);
      ctx.fillText("125ms", 4, 70);
      ctx.fillText("20ms", 4, 116);
      const maxVal = 270;
      const s = samplesRef.current;
      SCOPE_SERIES.forEach(({ key, col }) => {
        const pts = s[key];
        if (pts.length === 0) return;
        ctx.beginPath();
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.6;
        pts.forEach((v, idx) => {
          const x = pts.length === 1 ? w - 3 : (idx / (pts.length - 1)) * w;
          const y = h - 12 - (Math.min(maxVal, v) / maxVal) * (h - 24);
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        const lastV = pts[pts.length - 1];
        const ly = h - 12 - (Math.min(maxVal, lastV) / maxVal) * (h - 24);
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(w - 3, ly, 3, 0, Math.PI * 2);
        ctx.fill();
      });
      if (Object.values(s).every((pts) => pts.length === 0)) {
        ctx.font = '11px "JetBrains Mono", monospace';
        ctx.fillStyle = isLight ? "#5C5B57" : "#8E8D89";
        ctx.fillText("No samples yet — run a Desk check, a Ping, or the benchmark suite.", 8, h / 2);
      }
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [samples, active]);

  return (
    <div className="wrap">
      <div className="view-head">
        <div>
          <div className="kicker">// infrastructure telemetry &amp; developer quickstart</div>
          <h1 className="h1-ed">
            Status &amp; <span className="serif-i">30-Second Docs.</span>
          </h1>
        </div>
        <span className="badge b-ok">auth: none · Bond $1.40 Test USDC</span>
      </div>

      <div className="kpi-grid-4">
        <div className="card" style={{ padding: "15px 17px" }}>
          <div className="kpi-lbl">Compute Runtime</div>
          <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 3 }}>Render Virginia · Node 20</div>
          <div className="kpi-sub">
            {health ? `/health ${health.status} · uptime ${health.uptime_s}s` : healthError ? `/health error: ${healthError.message}` : "awaiting first /health poll…"}
            {lastHealthCheck ? ` · checked ${lastHealthCheck}` : ""}
          </div>
        </div>
        <div className="card" style={{ padding: "15px 17px" }}>
          <div className="kpi-lbl">Endpoints Answered (this session)</div>
          <div style={{ fontSize: 16, fontWeight: 500, color: answeredEndpoints === 5 ? "var(--ok)" : "var(--text)", marginBottom: 3 }}>
            {answeredEndpoints} / 5
          </div>
          <div className="kpi-sub">4.5s abort cap · 2-of-3 quorum</div>
        </div>
        <div className="card" style={{ padding: "15px 17px" }}>
          <div className="kpi-lbl">Persistent Disk SQLite</div>
          <div className="mono" style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 4 }}>/var/data/verireceipt.sqlite</div>
          <div className="kpi-sub">WAL mode · survives every deploy</div>
        </div>
        <div className="card" style={{ padding: "15px 17px" }}>
          <div className="kpi-lbl">Grid Cron Cache</div>
          <div style={{ fontSize: 16, fontWeight: 500, color: "var(--accent)", marginBottom: 3 }}>
            {lastGrid ? `Last grid receipt ${relativeAge(lastGrid.ts)}` : "No grid probe yet"}
          </div>
          <div className="kpi-sub">
            {lastGrid?.receipt
              ? `quorum: ${String((lastGrid.receipt as unknown as Record<string, unknown>).quorum_votes ?? "—")}`
              : "CAISO OASIS cron cache"}
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: "16px 18px", marginBottom: 18 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
          <div className="mono" style={{ fontSize: 11.5, color: "var(--text)", fontWeight: 500 }}>// live multi-endpoint latency oscilloscope (ms · live samples)</div>
          <div className="mono" style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 10.5, color: "var(--muted)" }}>
            {SCOPE_SERIES.map((s) => (
              <span key={s.key}>
                <i style={{ display: "inline-block", width: 8, height: 2, background: s.col, verticalAlign: "middle", marginRight: 4 }} />
                {s.label}
              </span>
            ))}
          </div>
        </div>
        <canvas ref={scopeRef} style={{ width: "100%", height: 150, display: "block" }} />
      </div>

      <div className="card" style={{ overflow: "hidden", marginBottom: 22 }}>
        <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="mono" style={{ fontSize: 11.5, fontWeight: 500 }}>// live endpoint health &amp; probe state</span>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>auto-probed on open · click Ping to re-probe</span>
        </div>
        <div className="tbl-wrap">
          <table className="hl-tbl">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Canonical Intent / Role</th>
                <th>Quorum / Source</th>
                <th>Cache TTL</th>
                <th>p50 Latency</th>
                <th>State</th>
                <th>Probe</th>
              </tr>
            </thead>
            <tbody>
              {defs.map((def) => (
                <HealthRow key={def.key} def={def} onRecord={onRecord} showToast={showToast} />
              ))}
            </tbody>
          </table>
        </div>
        <div className="note-line" style={{ padding: "10px 16px", borderTop: "1px solid var(--border)" }}>
          Cache TTL 10s is the miner-wide cache_ttl_sec from miner.yaml. The /api/mcp row probes GET; the MCP server is
          Streamable HTTP (POST) and the miner serves no GET route for it yet — the live status is shown as-is.
        </div>
      </div>

      <div className="code-box">
        <div className="code-bar">
          <div className="code-tabs">
            {DOC_TABS.map((t) => (
              <button key={t.id} type="button" className={`c-tab${activeDoc === t.id ? " active" : ""}`} onClick={() => setActiveDoc(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn-ghost"
            style={{ borderColor: "rgba(255,255,255,0.22)", color: "#F2F1EC" }}
            onClick={() => {
              if (copyText(DOC_SNIPPETS[activeDoc])) showToast("Copied to clipboard");
              else showToast("Clipboard copy unavailable");
            }}
          >
            Copy snippet
          </button>
        </div>
        <pre className="code-pre">{DOC_SNIPPETS[activeDoc]}</pre>
      </div>
      {activeDoc === "yaml" && (
        <div className="note-line" style={{ marginTop: 10 }}>
          Verbatim from miner.yaml at base commit e35fb0a — re-sync this tab if miner.yaml changes.
        </div>
      )}
      {activeDoc === "cast" && (
        <div className="note-line" style={{ marginTop: 10 }}>
          Template — fill $YOUR_ADDRESS / $KEY and verify amounts against the live Diamond before broadcasting.
        </div>
      )}
    </div>
  );
}
