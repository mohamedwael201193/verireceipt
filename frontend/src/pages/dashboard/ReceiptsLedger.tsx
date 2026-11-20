// Receipts Ledger (View 02) — the SESSION ledger only.
//
// Replaces the seeded RECEIPTS + global counters (DESIGN-SPEC §6 D-01/D-05/
// D-06, §8 A8). There is no ledger endpoint in miner.yaml, so the ledger
// lists exactly the calls this browser made in this session, newest first.
// It starts empty — that is the honest state, not a bug. KPIs are computed
// from those rows; "Escrow Spend" is $0.00 because direct probes are
// unbilled; the median is the median of measured latencies (or "—").

import { useEffect, useMemo, useState } from "react";
import type { LiveReceipt } from "./types";
import { downloadText, formatDate, formatMs, median, shortHash } from "./utils";

interface ReceiptsLedgerProps {
  receipts: LiveReceipt[];
  onInspect: (receipt: LiveReceipt) => void;
  showToast: (msg: string) => void;
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "ONCHAIN_TX_LOOKUP_GENERAL", label: "TX Lookup" },
  { key: "REGULATORY_FILING_MONITOR_GENERAL", label: "SEC Filing" },
  { key: "TVL_LOOKUP_GENERAL", label: "TVL" },
  { key: "OPTIMAL_EXECUTION_ROUTE_GENERAL", label: "ETH Route" },
  { key: "GRID_POWER_PRICE_GENERAL", label: "Grid LMP" },
  { key: "422", label: "422 Only" },
];

export default function ReceiptsLedger({ receipts, onInspect, showToast }: ReceiptsLedgerProps) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  // Paginate rendering: at most PAGE_SIZE rows mount at once, however long
  // the session ledger grows (the ledger itself is capped at 200 rows).
  const PAGE_SIZE = 50;

  const kpis = useMemo(() => {
    const total = receipts.length;
    const ok = receipts.filter((r) => r.status === 200).length;
    const refusals = receipts.filter((r) => r.status === 400 || r.status === 422).length;
    const errors503 = receipts.filter((r) => r.status === 503).length;
    const med = median(receipts.map((r) => r.latencyMs));
    return { total, ok, refusals, errors503, med };
  }, [receipts]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return receipts.filter((r) => {
      if (filter === "422" && !(r.status === 400 || r.status === 422)) return false;
      if (filter !== "all" && filter !== "422" && r.intent !== filter) return false;
      if (q) {
        const hay = `${r.id} ${r.intent} ${r.query} ${r.receipt?.raw_response_sha256 ?? ""} ${r.errorCode ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [receipts, filter, search]);

  // A new filter/search restarts at page 1; a shrinking ledger clamps the page.
  useEffect(() => {
    setPage(0);
  }, [filter, search]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  function exportJsonl() {
    const lines = receipts
      .map((r) =>
        JSON.stringify({
          receipt_id: r.receipt ? r.receipt.receipt_id : null,
          timestamp: r.ts,
          intent: r.intent,
          query: r.query,
          routed_miner: "verireceipt",
          rail: "direct",
          http_status: r.status,
          latency_ms: Math.round(r.latencyMs),
          cost_usdc: 0,
          upstream_url: r.receipt ? r.receipt.upstream_url : null,
          raw_response_sha256: r.receipt ? r.receipt.raw_response_sha256 : null,
          result: r.body,
        }),
      )
      .join("\n");
    downloadText("verireceipt-ledger.jsonl", lines.length > 0 ? lines + "\n" : "", "application/x-ndjson");
    showToast(`Exported ${receipts.length} rows to ledger.jsonl`);
  }

  return (
    <div className="wrap">
      <div className="view-head">
        <div>
          <div className="kicker">// session ledger · only calls this browser made</div>
          <h1 className="h1-ed">
            Receipts <span className="serif-i">Ledger.</span>
          </h1>
        </div>
        <button type="button" className="btn-ghost" onClick={exportJsonl} disabled={receipts.length === 0}>
          Export ledger.jsonl ↓
        </button>
      </div>

      <div className="kpi-grid-6">
        <div className="kpi-cell">
          <div className="kpi-lbl">Total Calls</div>
          <div className="kpi-val mono">{kpis.total}</div>
          <div className="kpi-sub">this session</div>
        </div>
        <div className="kpi-cell">
          <div className="kpi-lbl">200 OK Verified</div>
          <div className="kpi-val mono" style={{ color: "var(--ok)" }}>{kpis.ok}</div>
          <div className="kpi-sub">root schema + sha256</div>
        </div>
        <div className="kpi-cell">
          <div className="kpi-lbl">400 / 422 Refusals</div>
          <div className="kpi-val mono" style={{ color: "var(--warn)" }}>{kpis.refusals}</div>
          <div className="kpi-sub">unbilled ($0.00)</div>
        </div>
        <div className="kpi-cell">
          <div className="kpi-lbl">HTTP 503 Errors</div>
          <div className="kpi-val mono" style={{ color: "var(--ok)" }}>{kpis.errors503}</div>
          <div className="kpi-sub">measured this session</div>
        </div>
        <div className="kpi-cell">
          <div className="kpi-lbl">Escrow Spend</div>
          <div className="kpi-val mono">$0.00</div>
          <div className="kpi-sub">direct probes · unbilled</div>
        </div>
        <div className="kpi-cell">
          <div className="kpi-lbl">Median p50</div>
          <div className="kpi-val mono">{kpis.med === null ? "—" : formatMs(kpis.med)}</div>
          <div className="kpi-sub">measured latencies</div>
        </div>
      </div>

      <div className="card" style={{ padding: "14px 16px", marginBottom: 14, display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <input
          type="search"
          className="field-input"
          style={{ maxWidth: 340 }}
          placeholder="Search receipt_id, intent, hash, entity, miner..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {FILTERS.map((f) => (
            <button key={f.key} type="button" className={`pill${filter === f.key ? " active" : ""}`} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        <div className="tbl-wrap">
          <table className="hl-tbl">
            <thead>
              <tr>
                <th>Timestamp (UTC)</th>
                <th>Intent</th>
                <th>Query Input</th>
                <th>Routed Miner</th>
                <th>Rail</th>
                <th>HTTP</th>
                <th>Latency</th>
                <th>Cost</th>
                <th>raw_response_sha256</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {receipts.length === 0 ? (
                <tr>
                  <td colSpan={10} className="mono" style={{ textAlign: "center", padding: 28, color: "var(--muted)" }}>
                    No receipts yet in this session — run a Desk check, a Ping, or the benchmark suite.
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="mono" style={{ textAlign: "center", padding: 28, color: "var(--muted)" }}>
                    No receipts match the current filter.
                  </td>
                </tr>
              ) : (
                pageRows.map((r) => (
                  <tr key={r.key} className="clickable" onClick={() => onInspect(r)}>
                    <td className="mono" style={{ fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap" }}>{formatDate(r.ts)}</td>
                    <td className="mono" style={{ fontSize: 11, fontWeight: 500 }}>{r.intent.replace("_GENERAL", "")}</td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--soft)", maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.query}</td>
                    <td className="mono" style={{ fontSize: 11 }}>verireceipt</td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>direct</td>
                    <td>
                      <span className={`badge ${r.status === 200 ? "b-ok" : r.status === 0 ? "b-err" : "b-warn"}`}>
                        {r.status === 0 ? "TIMEOUT" : r.status}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>{formatMs(r.latencyMs)}</td>
                    <td className="mono" style={{ fontSize: 11 }}>unbilled</td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
                      {r.receipt ? shortHash(r.receipt.raw_response_sha256) : "—"}
                    </td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--accent)", whiteSpace: "nowrap" }}>Inspect →</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {rows.length > PAGE_SIZE && (
          <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
              Page {safePage + 1} of {pageCount} · {rows.length} matching rows · {PAGE_SIZE} per page
            </span>
            <span style={{ display: "flex", gap: 6 }}>
              <button type="button" className="btn-ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => setPage(safePage - 1)} disabled={safePage === 0}>
                ← Prev
              </button>
              <button type="button" className="btn-ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => setPage(safePage + 1)} disabled={safePage >= pageCount - 1}>
                Next →
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
