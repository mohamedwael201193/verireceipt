// Benchmarks (View 03) — a REAL runner.
//
// Replaces the simulated runBenchmarkSuite (DESIGN-SPEC §6 D-07/D-08/D-09):
// rows go QUEUED → RUNNING → PASS/FAIL/SKIP only when the live call settles,
// the progress bar is completed/24, and every tile + the histogram are
// computed from measured values. Nothing passes on a timer. Two cases are
// SKIP (F04, B03) because the public API has no fault-injection parameter —
// see benchmarks.ts. The suite runs sequentially to stay gentle on the miner.

import { useMemo, useRef, useState } from "react";
import { BENCH_CASES, BENCH_RUNNABLE_COUNT, BENCH_TOTAL_COUNT, catLabel, type BenchResult } from "./benchmarks";
import type { LiveReceipt } from "./types";
import { formatMs } from "./utils";

interface BenchmarksProps {
  onRecord: (receipt: LiveReceipt) => void;
  showToast: (msg: string) => void;
}

const FILTERS = [
  { key: "all", label: "All 24" },
  { key: "tx", label: "12 Frozen TX Traps" },
  { key: "reg", label: "4 Cross-Bug Regressions" },
  { key: "refusal", label: "4 Refusal 422 Matrix" },
  { key: "burst", label: "4 Burst Concurrency" },
];

/** Bucket measured latencies into 7 histogram bins. */
function histogramBins(latencies: number[]): number[] {
  const edges = [50, 100, 150, 200, 300, 500, Infinity];
  const bins = [0, 0, 0, 0, 0, 0, 0];
  for (const ms of latencies) {
    const idx = edges.findIndex((e) => ms < e);
    bins[idx === -1 ? 6 : idx] += 1;
  }
  return bins;
}

export default function Benchmarks({ onRecord, showToast }: BenchmarksProps) {
  const [results, setResults] = useState<Record<string, BenchResult>>({});
  const [running, setRunning] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [done, setDone] = useState(0);
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const runToken = useRef(0);

  const runnableResults = useMemo(
    () => BENCH_CASES.filter((c) => c.runnable).map((c) => results[c.id]).filter(Boolean),
    [results],
  );
  const passed = runnableResults.filter((r) => r.verdict === "PASS").length;
  const failed = runnableResults.filter((r) => r.verdict === "FAIL").length;
  const http503 = useMemo(() => {
    let n = 0;
    for (const c of BENCH_CASES) {
      const r = results[c.id];
      if (r?.http === 503) n += 1;
    }
    return n;
  }, [results]);
  const refusalCases = BENCH_CASES.filter((c) => c.cat === "refusal" && c.runnable);
  const refusalRun = refusalCases.filter((c) => results[c.id]).length;
  const refusalPassed = refusalCases.filter((c) => results[c.id]?.verdict === "PASS").length;
  const burstP95 = results["B01"]?.latencyMs ?? null;
  const latencies = useMemo(
    () => Object.values(results).map((r) => r.latencyMs).filter((x): x is number => typeof x === "number"),
    [results],
  );
  const bins = useMemo(() => histogramBins(latencies), [latencies]);
  const maxBin = Math.max(1, ...bins);

  const list = BENCH_CASES.filter((c) => filter === "all" || c.cat === filter);
  const hasRun = Object.keys(results).length > 0;

  async function runSuite() {
    if (running) return;
    const token = ++runToken.current;
    setRunning(true);
    setResults({});
    setDone(0);
    setExpanded(null);
    let completed = 0;
    let passedCount = 0;
    let failedCount = 0;
    let http503Count = 0;
    for (const c of BENCH_CASES) {
      if (runToken.current !== token) return;
      if (!c.runnable) {
        setResults((prev) => ({
          ...prev,
          [c.id]: { verdict: "SKIP", http: null, latencyMs: null, actual: c.skipReason ?? "not runnable via the public API", note: c.skipReason },
        }));
        completed += 1;
        setDone(completed);
        continue;
      }
      setRunningId(c.id);
      const result = await c.run({ record: onRecord });
      if (runToken.current !== token) return;
      setRunningId(null);
      if (result.verdict === "PASS") passedCount += 1;
      if (result.verdict === "FAIL") failedCount += 1;
      if (result.http === 503) http503Count += 1;
      setResults((prev) => ({ ...prev, [c.id]: result }));
      completed += 1;
      setDone(completed);
    }
    setRunning(false);
    showToast(`Benchmark suite finished — ${passedCount} passed, ${failedCount} failed, ${http503Count} HTTP 503s`);
  }

  function verdictBadge(r: BenchResult | undefined, id: string): { cls: string; label: string } {
    if (runningId === id) return { cls: "b-acc", label: "RUNNING…" };
    if (!r) return { cls: "b-dim", label: "QUEUED" };
    if (r.verdict === "PASS") return { cls: "b-ok", label: "PASS ✓" };
    if (r.verdict === "FAIL") return { cls: "b-err", label: "FAIL" };
    return { cls: "b-dim", label: "SKIP" };
  }

  return (
    <div className="wrap">
      <div className="view-head">
        <div>
          <div className="kicker">// adversarial verification · deterministic trap &amp; burst suite</div>
          <h1 className="h1-ed">
            24-Case <span className="serif-i">Benchmarks.</span>
          </h1>
        </div>
        <button type="button" className="btn-accent" onClick={runSuite} disabled={running}>
          {running ? "Running… (live calls)" : "Run 24-Case Adversarial Suite ▶"}
        </button>
      </div>

      <div className="bench-prog-wrap">
        <div className="bench-prog-fill" style={{ width: `${(done / BENCH_TOTAL_COUNT) * 100}%` }} />
      </div>

      <div className="kpi-grid-4">
        <div className="card" style={{ padding: "16px 18px" }}>
          <div className="kpi-lbl">Pass Rate</div>
          <div className="kpi-val mono" style={{ color: failed > 0 ? "var(--err)" : "var(--ok)" }}>
            {hasRun ? `${passed} / ${BENCH_RUNNABLE_COUNT}` : "— / 22"}
          </div>
          <div className="kpi-sub">
            {hasRun
              ? `${failed} failed · 2 skipped (not executable via public API)`
              : "22 runnable · 2 skipped (F04, B03)"}
          </div>
        </div>
        <div className="card" style={{ padding: "16px 18px" }}>
          <div className="kpi-lbl">HTTP 503 Count</div>
          <div className="kpi-val mono" style={{ color: http503 === 0 ? "var(--ok)" : "var(--err)" }}>{hasRun ? http503 : "—"}</div>
          <div className="kpi-sub">measured across suite runs</div>
        </div>
        <div className="card" style={{ padding: "16px 18px" }}>
          <div className="kpi-lbl">Refusal Precision</div>
          <div className="kpi-val mono">{refusalRun === 0 ? "—" : `${Math.round((refusalPassed / refusalRun) * 100)}%`}</div>
          <div className="kpi-sub">refusal cases answered 4xx, never 200</div>
        </div>
        <div className="card" style={{ padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div className="kpi-lbl">Burst p95</div>
            <div className="kpi-val mono" style={{ color: "var(--accent)" }}>{burstP95 === null ? "—" : formatMs(burstP95)}</div>
            <div className="kpi-sub">50 req burst (B01)</div>
          </div>
          <svg viewBox="0 0 116 54" width="116" height="54" aria-label="Measured latency distribution histogram" role="img">
            <line x1="2" y1="48" x2="114" y2="48" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1" />
            {bins.map((count, i) => {
              const h = Math.max(count === 0 ? 2 : 4, Math.round((count / maxBin) * 42));
              const fill = i === 2 ? "var(--accent)" : i === 1 || i === 3 ? "var(--text)" : "var(--muted)";
              const opacity = i === 2 ? 1 : i === 1 || i === 3 ? 0.72 : 0.45;
              return <rect key={i} x={6 + i * 14} y={48 - h} width="10" height={h} rx="2" fill={fill} fillOpacity={opacity} />;
            })}
            <text x="6" y="54" fontSize="6.5" fill="var(--muted)" fontFamily="JetBrains Mono,monospace">0ms</text>
            <text x="80" y="54" fontSize="6.5" fill="var(--muted)" fontFamily="JetBrains Mono,monospace">500ms+</text>
          </svg>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 14 }}>
        {FILTERS.map((f) => (
          <button key={f.key} type="button" className={`pill${filter === f.key ? " active" : ""}`} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        <div className="tbl-wrap">
          <table className="hl-tbl">
            <thead>
              <tr>
                <th>ID</th>
                <th>Category</th>
                <th>Case Name</th>
                <th>Expected Assertion</th>
                <th>HTTP</th>
                <th>Latency</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const r = results[c.id];
                const badge = verdictBadge(r, c.id);
                const httpCls = r?.http === 200 ? "b-ok" : r?.http === 422 || r?.http === 400 ? "b-warn" : r?.http ? "b-err" : "b-dim";
                return (
                  <tr key={c.id} className="clickable" onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
                    <td className="mono" style={{ fontSize: 11.5, color: "var(--accent)", fontWeight: 500 }}>{c.id}</td>
                    <td><span className="badge b-dim">{catLabel(c.cat)}</span></td>
                    <td style={{ fontWeight: 500 }}>{c.name}</td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{c.expect}</td>
                    <td>{r?.http ? <span className={`badge ${httpCls}`}>{r.http}</span> : <span className="badge b-dim">—</span>}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{r?.latencyMs === null || r?.latencyMs === undefined ? "—" : formatMs(r.latencyMs)}</td>
                    <td><span className={`badge ${badge.cls}`}>{badge.label}</span></td>
                  </tr>
                );
              })}
              {list.length === 0 && (
                <tr>
                  <td colSpan={7} className="mono" style={{ textAlign: "center", padding: 28, color: "var(--muted)" }}>No cases in this filter.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {expanded && (() => {
        const c = BENCH_CASES.find((x) => x.id === expanded);
        const r = c ? results[c.id] : undefined;
        if (!c) return null;
        return (
          <div className="card" style={{ marginTop: 14, padding: "16px 18px" }}>
            <div className="kicker" style={{ marginBottom: 10 }}>// {c.id} · {c.name}</div>
            <div className="expand-grid mono" style={{ fontSize: 11 }}>
              <div>
                <div style={{ color: "var(--muted)", fontSize: 10, marginBottom: 4 }}>PROBE PAYLOAD</div>
                <div style={{ color: "var(--text)", wordBreak: "break-all" }}>{c.probe}</div>
              </div>
              <div>
                <div style={{ color: "var(--muted)", fontSize: 10, marginBottom: 4 }}>ASSERTION RULE</div>
                <div style={{ color: "var(--accent)" }}>{c.expect}</div>
              </div>
              <div>
                <div style={{ color: "var(--muted)", fontSize: 10, marginBottom: 4 }}>CAPTURED ENVELOPE</div>
                <div style={{ color: "var(--ok)", wordBreak: "break-all" }}>
                  {runningId === c.id ? "RUNNING…" : r ? r.actual : "Not run yet — press “Run 24-Case Adversarial Suite”."}
                </div>
              </div>
            </div>
            {c.skipReason && <div className="note-line" style={{ marginTop: 10 }}>Skipped: {c.skipReason}</div>}
          </div>
        );
      })()}
    </div>
  );
}
