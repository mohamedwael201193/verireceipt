// /benchmarks — live latency benchmarks.
//
// REAL MEASUREMENTS ONLY. "Run benchmark" measures the actual round-trip
// latency of all five endpoints + /health against the live API (3 runs each,
// sequential), then shows min / median / max per endpoint with timestamps.
// Nothing is pre-filled: before the first run the table is an honest empty
// state. No Math.random() latencies, no fixed cadence, no simulated suite.
//
// Notes shown with the numbers, because they are part of the measurement:
// a first run after the service idles can include a Render cold start —
// that is real latency and is shown as measured, not hidden.

import { useCallback, useRef, useState } from 'react';
import { getFilings, getGridPrice, getHealth, getRoute, getTvl, getTx, ApiError } from '../lib/api';
import { useLiveQuery } from '../lib/hooks';

const API_BASE_URL = 'https://verireceipt.onrender.com';
const RUNS_PER_ENDPOINT = 3;

// Sample inputs verified live against the API on 2026-11-20.
const SAMPLE_TX_HASH = '0xafdbc83c485355d90f79fd660bcd12713402aa78922d966657d1005f59e92902';

function defaultGridInterval(): string {
  const d = new Date(Date.now() - 2 * 60 * 60 * 1000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function errText(err: unknown): string {
  if (err instanceof ApiError) return `${err.status} ${err.code} — ${err.message}`;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return iso;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

interface Probe {
  key: string;
  label: string;
  methodPath: string;
  run: () => Promise<unknown>;
}

interface EndpointStats {
  runs: (number | null)[];
  error: string | null;
  startedAt: string;
  finishedAt: string;
}

export default function Benchmarks() {
  // Live service line (uptime comes from the API itself, not a canned value).
  const healthQuery = useLiveQuery('benchmark-health', () => getHealth());
  const health = healthQuery.data as unknown as
    | { status: string; service: string; uptime_s: number }
    | null;

  const [results, setResults] = useState<Record<string, EndpointStats> | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [doneAt, setDoneAt] = useState<string | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<string | null>(null);
  const cancelled = useRef(false);

  const probes: Probe[] = [
    { key: 'health', label: 'GET /health', methodPath: '/health', run: () => getHealth() },
    {
      key: 'tx',
      label: 'GET /v1/tx',
      methodPath: '/v1/tx?tx_hash=…&chain=ethereum',
      run: () => getTx({ tx_hash: SAMPLE_TX_HASH, chain: 'ethereum' }),
    },
    {
      key: 'filings',
      label: 'GET /v1/filings',
      methodPath: '/v1/filings?entity=Apple&period=last 12 months',
      run: () => getFilings({ entity: 'Apple', period: 'last 12 months' }),
    },
    {
      key: 'tvl',
      label: 'GET /v1/tvl',
      methodPath: '/v1/tvl?protocol=aave-v3',
      run: () => getTvl({ protocol: 'aave-v3' }),
    },
    {
      key: 'route',
      label: 'GET /v1/route',
      methodPath: '/v1/route?pair=ETH/USDC',
      run: () => getRoute({ pair: 'ETH/USDC' }),
    },
    {
      key: 'grid-price',
      label: 'GET /v1/grid-price',
      methodPath: '/v1/grid-price?node_or_zone=TH_NP15_GEN-APND&interval_start=…',
      run: () =>
        getGridPrice({ node_or_zone: 'TH_NP15_GEN-APND', interval_start: defaultGridInterval() }),
    },
  ];

  const runBenchmark = useCallback(async () => {
    cancelled.current = false;
    setRunning(true);
    setDoneAt(null);
    const next: Record<string, EndpointStats> = {};
    setRunStartedAt(new Date().toISOString());
    for (const probe of probes) {
      const startedAt = new Date().toISOString();
      const runs: (number | null)[] = [];
      let error: string | null = null;
      for (let i = 0; i < RUNS_PER_ENDPOINT; i++) {
        if (cancelled.current) break;
        setProgress(`${probe.label} — run ${i + 1} of ${RUNS_PER_ENDPOINT}`);
        const t0 = performance.now();
        try {
          await probe.run();
          runs.push(Math.round(performance.now() - t0));
        } catch (err) {
          runs.push(null);
          error = errText(err);
        }
        // Live partial update so the table fills in as measurements land.
        next[probe.key] = { runs: [...runs], error, startedAt, finishedAt: new Date().toISOString() };
        setResults({ ...next });
      }
      if (cancelled.current) break;
      next[probe.key] = { runs, error, startedAt, finishedAt: new Date().toISOString() };
      setResults({ ...next });
    }
    setProgress('');
    if (!cancelled.current) setDoneAt(new Date().toISOString());
    setRunning(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = useCallback(() => {
    cancelled.current = true;
    setProgress('Cancelling after the current call…');
  }, []);

  const allRuns = results ? Object.values(results).flatMap((s) => s.runs) : [];
  const okRuns = allRuns.filter((r): r is number => typeof r === 'number');
  const overallMedian = okRuns.length ? median(okRuns) : null;
  const overallMax = okRuns.length ? Math.max(...okRuns) : null;

  return (
    <div className="vr-page vr-benchmarks">
      <style>{PAGE_CSS}</style>
      <header className="vr-head">
        <div>
          <div className="vr-kicker">// live latency · measured round-trips, never simulated</div>
          <h1 className="vr-h1">
            Latency <span className="serif-i">Benchmarks.</span>
          </h1>
          <p className="vr-lede">
            Each run calls the live API ({API_BASE_URL}) and times the real round trip —{' '}
            {RUNS_PER_ENDPOINT} runs per endpoint, sequential. The numbers below are the
            measurements from the run you started; before that, there is nothing to show.
          </p>
        </div>
        <div className="vr-head-side">
          {health ? (
            <span className="vr-badge vr-b-ok">
              {health.service} · {health.status} · uptime {Math.floor(health.uptime_s / 60)}m
            </span>
          ) : healthQuery.loading ? (
            <span className="vr-badge vr-b-dim">checking service…</span>
          ) : (
            <span className="vr-badge vr-b-err">service check failed</span>
          )}
        </div>
      </header>

      <section className="vr-card" aria-label="Benchmark controls">
        <div className="vr-bench-actions">
          <button type="button" className="vr-btn-accent" onClick={runBenchmark} disabled={running}>
            {running ? 'Benchmark running…' : 'Run benchmark ▶'}
          </button>
          {running && (
            <button type="button" className="vr-btn-ghost" onClick={cancel}>
              Cancel
            </button>
          )}
          {doneAt && !running && (
            <span className="vr-badge vr-b-ok">completed {fmtTime(doneAt)}</span>
          )}
        </div>
        {running && (
          <div className="vr-progress" role="status">
            <div className="vr-progress-bar" />
            <span className="vr-mono vr-small">{progress}</span>
          </div>
        )}
        <p className="vr-muted vr-small" style={{ margin: '12px 0 0' }}>
          Sample calls are the verified-live ones (Ethereum tx, Apple filings, aave-v3, ETH/USDC,
          CAISO TH_NP15_GEN-APND at a recent past hour). A first run after the service idles can
          include a Render cold start — that is real latency and is shown as measured.
        </p>
      </section>

      {!results && !running && (
        <section className="vr-card" aria-label="No benchmark results yet">
          <div className="vr-empty">
            <p className="vr-empty-title">No benchmark has been run yet.</p>
            <p className="vr-muted">
              Press “Run benchmark” to measure all six endpoints live. No timings are shown until
              they are measured — this page never ships pre-filled numbers.
            </p>
          </div>
        </section>
      )}

      {results && (
        <section className="vr-card" aria-label="Benchmark results">
          <div className="vr-kicker">// {RUNS_PER_ENDPOINT} runs per endpoint · min / median / max of successful runs</div>
          <div className="vr-tbl-wrap">
            <table className="vr-tbl">
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>Run 1</th>
                  <th>Run 2</th>
                  <th>Run 3</th>
                  <th>Min</th>
                  <th>Median</th>
                  <th>Max</th>
                  <th>Measured at</th>
                </tr>
              </thead>
              <tbody>
                {probes.map((probe) => {
                  const s = results[probe.key];
                  if (!s) return null;
                  const ok = s.runs.filter((r): r is number => typeof r === 'number');
                  const barMax = overallMax ?? 1;
                  return (
                    <tr key={probe.key}>
                      <td>
                        <span className="vr-mono">{probe.label}</span>
                        <br />
                        <span className="vr-muted vr-small vr-mono">{probe.methodPath}</span>
                        {s.error && (
                          <>
                            <br />
                            <span className="vr-err vr-small">{s.error}</span>
                          </>
                        )}
                      </td>
                      {s.runs.map((r, i) => (
                        <td key={i} className="vr-mono">
                          {r === null ? <span className="vr-badge vr-b-err">failed</span> : `${r} ms`}
                        </td>
                      ))}
                      <td className="vr-mono">{ok.length ? `${Math.min(...ok)} ms` : '—'}</td>
                      <td className="vr-mono">{ok.length ? `${median(ok)} ms` : '—'}</td>
                      <td className="vr-mono">{ok.length ? `${Math.max(...ok)} ms` : '—'}</td>
                      <td className="vr-mono vr-small vr-muted">{fmtTime(s.finishedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {okRuns.length > 0 && (
            <div className="vr-bars" aria-label="Median latency chart">
              {probes.map((probe) => {
                const s = results[probe.key];
                if (!s) return null;
                const ok = s.runs.filter((r): r is number => typeof r === 'number');
                if (!ok.length) return null;
                const med = median(ok);
                return (
                  <div key={probe.key} className="vr-bar-row">
                    <span className="vr-mono vr-small vr-bar-label">{probe.label}</span>
                    <span className="vr-bar-track">
                      <span
                        className="vr-bar-fill"
                        style={{ width: `${Math.max(2, Math.round((med / (overallMax ?? 1)) * 100))}%` }}
                      />
                    </span>
                    <span className="vr-mono vr-small">{med} ms median</span>
                  </div>
                );
              })}
              <p className="vr-muted vr-small">
                Overall median across {okRuns.length} successful run
                {okRuns.length === 1 ? '' : 's'}: {overallMedian} ms · slowest successful run:{' '}
                {overallMax} ms{runStartedAt ? ` · run started ${fmtTime(runStartedAt)}` : ''}.
              </p>
            </div>
          )}
        </section>
      )}
      <p className="vr-muted vr-small">
        Miner <span className="vr-mono">774921 · verireceipt</span> · latencies are browser-measured
        round trips to the live API via the same-origin <span className="vr-mono">/api</span>{' '}
        proxy, so they include proxy + network time from this browser.
      </p>
    </div>
  );
}

const PAGE_CSS = `
.vr-page{max-width:1340px;margin:0 auto;padding:28px 24px 64px;color:var(--text,#F3F2EE);font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;line-height:1.55}
.vr-kicker{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11.5px;color:var(--muted,#8F8E8A);margin-bottom:6px}
.vr-h1{font-size:clamp(1.9rem,3.2vw,2.6rem);font-weight:300;letter-spacing:-.03em;line-height:1.08;margin:0 0 10px}
.vr-h1 .serif-i,.serif-i{font-family:'Newsreader',Georgia,serif;font-style:italic;font-weight:400}
.vr-lede{font-size:14.5px;color:var(--muted,#8F8E8A);max-width:640px;line-height:1.6;margin:0}
.vr-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:22px}
.vr-head-side{display:flex;gap:8px;flex-wrap:wrap}
.vr-card{background:var(--surface,#121214);border:1px solid var(--border,rgba(255,255,255,.10));border-radius:12px;padding:20px;margin-bottom:18px}
.vr-mono{font-family:'JetBrains Mono',ui-monospace,monospace}
.vr-small{font-size:12px}
.vr-muted{color:var(--muted,#8F8E8A)}
.vr-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:10.5px;font-weight:500;white-space:nowrap}
.vr-b-ok{background:var(--ok-soft,rgba(34,197,94,.14));color:var(--ok,#22C55E);border:1px solid rgba(34,197,94,.35)}
.vr-b-err{background:var(--bad-soft,var(--err-soft,rgba(239,68,68,.15)));color:var(--bad,var(--err,#EF4444));border:1px solid rgba(239,68,68,.35)}
.vr-b-dim{background:var(--panel,#151518);color:var(--muted,#8F8E8A);border:1px solid var(--border-strong,var(--border-hi,rgba(255,255,255,.22)))}
.vr-btn-accent{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 20px;border-radius:999px;background:var(--accent,#FF5722);color:#fff;font-size:13.5px;font-weight:500;border:0;cursor:pointer}
.vr-btn-accent:hover:not(:disabled){background:var(--accent-hover,#FF6E40)}
.vr-btn-accent:disabled{opacity:.55;cursor:default}
.vr-btn-ghost{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border-radius:999px;border:1px solid var(--border-strong,var(--border-hi,rgba(255,255,255,.22)));background:transparent;font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--text,#F3F2EE);cursor:pointer}
.vr-err{color:var(--bad,var(--err,#EF4444));font-size:13px}
.vr-empty{padding:18px 4px 8px}
.vr-empty-title{font-size:16px;margin:0 0 6px}
.vr-bench-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.vr-progress{display:flex;align-items:center;gap:12px;margin-top:14px}
.vr-progress-bar{width:120px;height:4px;border-radius:999px;background:var(--accent,#FF5722);animation:vr-pulse 1.2s ease-in-out infinite}
@keyframes vr-pulse{0%,100%{opacity:.35}50%{opacity:1}}
.vr-tbl-wrap{overflow-x:auto}
.vr-tbl{width:100%;border-collapse:collapse;font-size:12.5px;text-align:left}
.vr-tbl th{font-family:'JetBrains Mono',monospace;font-size:10.5px;font-weight:500;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#8F8E8A);padding:10px 14px;border-bottom:1px solid var(--border,rgba(255,255,255,.10))}
.vr-tbl td{padding:11px 14px;border-bottom:1px solid var(--border,rgba(255,255,255,.10));vertical-align:top}
.vr-tbl tr:last-child td{border-bottom:0}
.vr-bars{margin-top:18px;display:flex;flex-direction:column;gap:8px}
.vr-bar-row{display:grid;grid-template-columns:170px 1fr 110px;gap:12px;align-items:center}
.vr-bar-track{height:8px;border-radius:999px;background:var(--panel,#151518);border:1px solid var(--border,rgba(255,255,255,.10));overflow:hidden}
.vr-bar-fill{display:block;height:100%;background:var(--accent,#FF5722)}
@media (max-width:640px){.vr-page{padding:20px 14px 48px}.vr-card{padding:16px}.vr-bar-row{grid-template-columns:110px 1fr 90px}}
`;
