// /status — live service status.
//
// ONLY WHAT THE API ITSELF REPORTS. The health card is the live /health
// response (polled every 30 s by an in-page interval calling the hook's
// refetch — useHealth itself never polls); each endpoint row is a real
// probe — a valid sample call against the live API, timed in this browser.
// Up/down, latency, and last-checked time are all measured here; any outage
// shows the real error (status + code + message).
//
// Render service facts shown are only the documented base URL plus the
// miner.yaml registration facts (miner id 774921, slug verireceipt) and the
// bond, which is re-read live on-chain (minerBond(6152), quoteMinerBond(6)). Live Sepolia registration status is
// read from the Telegraph node and is never shown as "active" unless
// that live read says so. The Render plan, disk, and region are NOT
// shown: the API does not report them. No "Always-Warm" claim, no sponsored
// balance (no such figure exists), no canned p50 latencies.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getFilings, getGridPrice, getHealth, getRoute, getTvl, getTx, ApiError } from '../lib/api';
import { useHealth } from '../lib/hooks';
import { describeNodeListing, useMinerRegistration } from '../lib/minerRegistration';
import { useLiveQuery } from '../lib/hooks';
import { bondBadge, fetchLiveMinerBond, MINER_BOND_SOURCE, MINER_BOND_USD_TEXT } from '../lib/minerBond';

const API_BASE_URL = 'https://verireceipt.onrender.com';
const PROBE_INTERVAL_MS = 60_000;

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

function fmtUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

interface ProbeDef {
  key: string;
  label: string;
  methodPath: string;
  intent: string;
  run: () => Promise<unknown>;
}

interface ProbeResult {
  status: 'up' | 'down' | 'checking';
  latencyMs: number | null;
  checkedAt: string | null;
  error: string | null;
  detail: string | null;
}

const PROBES: ProbeDef[] = [
  {
    key: 'health',
    label: 'GET /health',
    methodPath: '/health',
    intent: 'liveness',
    run: () => getHealth(),
  },
  {
    key: 'tx',
    label: 'GET /v1/tx',
    methodPath: '/v1/tx?tx_hash=…&chain=ethereum',
    intent: 'ONCHAIN_TX_LOOKUP_GENERAL',
    run: () => getTx({ tx_hash: SAMPLE_TX_HASH, chain: 'ethereum' }),
  },
  {
    key: 'filings',
    label: 'GET /v1/filings',
    methodPath: '/v1/filings?entity=AAPL&period=last 12 months',
    intent: 'REGULATORY_FILING_MONITOR_GENERAL',
    run: () => getFilings({ entity: 'AAPL', period: 'last 12 months' }),
  },
  {
    key: 'tvl',
    label: 'GET /v1/tvl',
    methodPath: '/v1/tvl?protocol=aave-v3',
    intent: 'TVL_LOOKUP_GENERAL',
    run: () => getTvl({ protocol: 'aave-v3' }),
  },
  {
    key: 'route',
    label: 'GET /v1/route',
    methodPath: '/v1/route?pair=ETH/USDC',
    intent: 'OPTIMAL_EXECUTION_ROUTE_GENERAL',
    run: () => getRoute({ pair: 'ETH/USDC' }),
  },
  {
    key: 'grid-price',
    label: 'GET /v1/grid-price',
    methodPath: '/v1/grid-price?node_or_zone=TH_NP15_GEN-APND&interval_start=…',
    intent: 'GRID_POWER_PRICE_GENERAL',
    run: () =>
      getGridPrice({ node_or_zone: 'TH_NP15_GEN-APND', interval_start: defaultGridInterval() }),
  },
];

function probeDetail(key: string, data: unknown, methodPath?: string): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (key === 'health') return `status ${String(d.status ?? '—')}`;
  if (key === 'tx') return `block ${String(d.block_number ?? '—')} · ${String(d.status ?? '—')}`;
  if (key === 'filings') {
    // The count carries its window (filings J1 R3 M1): the filings
    // probe asks AAPL · last 12 months — read the entity + period from
    // the probe's own query string, never hardcode them, and omit the
    // window only if the probe genuinely asked without one.
    const q = new URLSearchParams(methodPath?.split('?')[1] ?? '');
    const entity = q.get('entity');
    const period = q.get('period');
    const count = String(d.filing_count ?? '—');
    return `${count} filings${entity ? ` · ${entity}` : ''}${period ? ` · ${period}` : ''}`;
  }
  if (key === 'tvl') return `TVL $${Number(d.tvl_usd ?? 0).toLocaleString('en-US')}`;
  if (key === 'route') return `amount_out ${String(d.amount_out ?? '—')}`;
  if (key === 'grid-price') return `LMP $${String(d.lmp_usd_per_mwh ?? '—')}/MWh`;
  return null;
}

export default function Status() {
  const health = useHealth();
  const registration = useMinerRegistration();
  const bond = useLiveQuery('miner-bond-live', (signal) => fetchLiveMinerBond(signal));
  const healthData = health.data as unknown as
    | { status: string; service: string; uptime_s: number; upstreams: Record<string, unknown> }
    | null;

  // "Last checked" is page state, not a hook field: the real useHealth
  // returns no lastChecked. Record a timestamp whenever a health fetch
  // settles (success or error), and poll every 30 s in-page via refetch
  // (the hook itself never polls), with cleanup on unmount.
  const [healthCheckedAt, setHealthCheckedAt] = useState<string | null>(null);
  useEffect(() => {
    if (!health.loading) setHealthCheckedAt(new Date().toISOString());
  }, [health.loading, health.data, health.error]);
  useEffect(() => {
    const id = window.setInterval(() => health.refetch(), 30000);
    return () => window.clearInterval(id);
  }, [health.refetch]);

  const [probes, setProbes] = useState<Record<string, ProbeResult>>(() =>
    Object.fromEntries(
      PROBES.map((p) => [p.key, { status: 'checking', latencyMs: null, checkedAt: null, error: null, detail: null } as ProbeResult]),
    ),
  );
  const [probing, setProbing] = useState(false);
  const mounted = useRef(true);
  // Generation guard + in-flight check (M2): a probe round can outlast the
  // 60 s interval (slow grid probe, 45 s timeout + 1 retry = 90 s), so a
  // new round must never start while one is in flight, and results from a
  // stale round must never overwrite newer state.
  const probeRound = useRef(0);
  const probeInFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const runProbes = useCallback(async () => {
    // Skip starting a new round while one is in flight (interval overlap
    // or a second manual re-probe during a slow round).
    if (probeInFlight.current) return;
    probeInFlight.current = true;
    const round = ++probeRound.current;
    setProbing(true);
    setProbes((prev) => {
      const next = { ...prev };
      for (const p of PROBES) next[p.key] = { ...next[p.key], status: 'checking' };
      return next;
    });
    await Promise.all(
      PROBES.map(async (probe) => {
        const t0 = performance.now();
        try {
          const data = await probe.run();
          if (!mounted.current || round !== probeRound.current) return;
          setProbes((prev) => ({
            ...prev,
            [probe.key]: {
              status: 'up',
              latencyMs: Math.round(performance.now() - t0),
              checkedAt: new Date().toISOString(),
              error: null,
              detail: probeDetail(probe.key, data, probe.methodPath),
            },
          }));
        } catch (err) {
          if (!mounted.current || round !== probeRound.current) return;
          setProbes((prev) => ({
            ...prev,
            [probe.key]: {
              status: 'down',
              latencyMs: Math.round(performance.now() - t0),
              checkedAt: new Date().toISOString(),
              error: errText(err),
              detail: null,
            },
          }));
        }
      }),
    );
    probeInFlight.current = false;
    if (mounted.current && round === probeRound.current) setProbing(false);
  }, []);

  useEffect(() => {
    void runProbes();
    const id = window.setInterval(() => void runProbes(), PROBE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [runProbes]);

  const upCount = PROBES.filter((p) => probes[p.key]?.status === 'up').length;
  const downCount = PROBES.filter((p) => probes[p.key]?.status === 'down').length;
  const allUp = downCount === 0 && upCount === PROBES.length;

  return (
    <div className="vr-page vr-status">
      <style>{PAGE_CSS}</style>
      <header className="vr-head">
        <div>
          <div className="vr-kicker">// infrastructure telemetry · live probes only</div>
          <h1 className="vr-h1">
            Service <span className="serif-i">Status.</span>
          </h1>
          <p className="vr-lede">
            Health and every endpoint below are probed live from this browser — /health every
            30 s, each endpoint with a valid sample call every 60 s. If anything is down, the
            real error is shown here.
          </p>
        </div>
        <div className="vr-head-side">
          <span className={`vr-badge ${allUp ? 'vr-b-ok' : downCount > 0 ? 'vr-b-err' : 'vr-b-dim'}`}>
            {allUp ? 'ALL SYSTEMS UP' : downCount > 0 ? `${downCount} ENDPOINT${downCount === 1 ? '' : 'S'} DOWN` : 'CHECKING…'}
          </span>
          <span className="vr-badge vr-b-dim">auth: none · Bond {MINER_BOND_USD_TEXT} Test USDC</span>
        </div>
      </header>

      {/* ---- Health card (live /health response) ---- */}
      <section className="vr-card" aria-label="Service health">
        <div className="vr-kicker">// GET /health · polled live every 30 s</div>
        <div className="vr-health-grid">
          <div>
            <span className="vr-label">status</span>
            {health.loading && !healthData ? (
              <span className="vr-badge vr-b-dim">checking…</span>
            ) : health.error ? (
              <span className="vr-badge vr-b-err">UNREACHABLE</span>
            ) : (
              <span className="vr-badge vr-b-ok">{healthData?.status ?? 'unknown'}</span>
            )}
          </div>
          <div>
            <span className="vr-label">service</span>
            <span className="vr-mono">{healthData?.service ?? '—'}</span>
          </div>
          <div>
            <span className="vr-label">uptime (since last restart)</span>
            <span className="vr-mono">
              {healthData ? fmtUptime(healthData.uptime_s) : '—'}
            </span>
          </div>
          <div>
            <span className="vr-label">last checked</span>
            <span className="vr-mono vr-small">
              {healthCheckedAt ? fmtTime(healthCheckedAt) : '—'}
            </span>
          </div>
        </div>
        {health.error && (
          <p className="vr-err" role="alert">
            Live /health poll failed: {errText(health.error)}
          </p>
        )}
        {healthData && (
          <div className="vr-code" style={{ marginTop: 14 }}>
            <pre>{JSON.stringify(healthData, null, 2)}</pre>
          </div>
        )}
      </section>

      {/* ---- Endpoint probes ---- */}
      <section className="vr-card" aria-label="Endpoint probes">
        <div className="vr-probes-head">
          <div>
            <div className="vr-kicker">// live endpoint probes · valid sample call per endpoint</div>
            <h2 className="vr-h2">
              {upCount} of {PROBES.length} endpoints up
            </h2>
          </div>
          <button type="button" className="vr-btn-ghost" onClick={() => void runProbes()} disabled={probing}>
            {probing ? 'Probing…' : 'Re-probe now'}
          </button>
        </div>
        <div className="vr-tbl-wrap">
          <table className="vr-tbl">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Intent</th>
                <th>State</th>
                <th>Latency</th>
                <th>Last checked</th>
                <th>Probe result</th>
              </tr>
            </thead>
            <tbody>
              {PROBES.map((probe) => {
                const r = probes[probe.key];
                return (
                  <tr key={probe.key}>
                    <td>
                      <span className="vr-mono">{probe.label}</span>
                      <br />
                      <span className="vr-muted vr-small vr-mono">{probe.methodPath}</span>
                    </td>
                    <td className="vr-mono vr-small">{probe.intent}</td>
                    <td>
                      {r.status === 'up' && <span className="vr-badge vr-b-ok">UP</span>}
                      {r.status === 'down' && <span className="vr-badge vr-b-err">DOWN</span>}
                      {r.status === 'checking' && <span className="vr-badge vr-b-dim">CHECKING…</span>}
                    </td>
                    <td className="vr-mono">{r.latencyMs === null ? '—' : `${r.latencyMs} ms`}</td>
                    <td className="vr-mono vr-small vr-muted">
                      {r.checkedAt ? fmtTime(r.checkedAt) : '—'}
                    </td>
                    <td>
                      {r.status === 'up' && <span className="vr-small">{r.detail ?? 'ok'}</span>}
                      {r.status === 'down' && (
                        <span className="vr-err vr-small" role="alert">
                          {r.error}
                        </span>
                      )}
                      {r.status === 'checking' && <span className="vr-muted vr-small">probing…</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="vr-muted vr-small" style={{ marginTop: 12 }}>
          Probes re-run automatically every 60 s. Latency is the round trip measured in this
          browser; a slow first probe after idle can include a Render cold start.
        </p>
      </section>

      {/* ---- Registration facts (miner.yaml — documented config only) ---- */}
      <section className="vr-card" aria-label="Registration facts">
        <div className="vr-kicker">// miner.yaml · documented registration facts</div>
        <h2 className="vr-h2">Miner identity</h2>
        <dl className="vr-kv">
          <dt>base URL</dt>
          <dd className="vr-mono">{API_BASE_URL}</dd>
          <dt>miner id / slug</dt>
          <dd className="vr-mono">774921 · verireceipt</dd>
          <dt>auth</dt>
          <dd>none</dd>
          <dt>bond (on-chain)</dt>
          <dd>
            {MINER_BOND_USD_TEXT} Test USDC — {MINER_BOND_SOURCE}.{' '}
            {(() => {
              // J2 Minor 3 (r7): a later failed or in-flight re-read never
              // keeps an earlier green "matches" badge (see bondBadge).
              const badge = bondBadge(bond);
              return <span className={`vr-badge vr-b-${badge.tone}`}>{badge.text}</span>;
            })()}
          </dd>
          <dt>rate limit (node-side)</dt>
          <dd className="vr-mono">20 req/s · cache TTL 10 s</dd>
          <dt>circuit breaker (node-side)</dt>
          <dd>
            <span className="vr-mono">threshold 5 · cooldown 30 s</span> — declared in miner.yaml and
            applied by the Telegraph node to calls into this miner; the miner process runs no breaker
          </dd>
        </dl>
        <p className="vr-muted vr-small">
          Not shown on purpose: Render plan, disk, and region. The API does not report them, so
          this page does not claim them. Uptime above comes from the live /health response, not
          from a hosting dashboard.
        </p>
      </section>

      <section className="vr-card" aria-label="Sepolia registration">
        <div className="vr-kicker">// sepolia · live node check</div>
        <h2 className="vr-h2">Sepolia registration</h2>
        <p className="vr-muted vr-small">
          The miner is registered on Ethereum Sepolia. The identifiers below are the
          confirmed updateMiner transaction facts (it replaced the earlier registration
          6150). Activation on the Telegraph node is read live and is shown as active only
          when that read says so.
        </p>
        {registration.data ? (
          <dl className="vr-kv">
            <dt>registration id</dt>
            <dd className="vr-mono">{registration.data.registrationId}</dd>
            <dt>updateMiner tx</dt>
            <dd className="vr-mono">
              <a href={registration.data.explorerTx} target="_blank" rel="noopener noreferrer">
                {registration.data.registerTx}
              </a>
              {' '}· block {registration.data.registerBlock}
            </dd>
            <dt>replaces</dt>
            <dd className="vr-mono">registrationId {registration.data.previousRegistrationId}</dd>
            <dt>yaml hash</dt>
            <dd className="vr-mono">{registration.data.yamlHash}</dd>
            <dt>yaml pin</dt>
            <dd className="vr-mono">{registration.data.yamlPin}</dd>
            <dt>node /api/miners/{registration.data.registrationId}</dt>
            <dd>
              {describeNodeListing(registration.data.nodeByRegistrationId)}
              {registration.data.nodeReportsActive ? (
                <span className="vr-badge vr-b-ok" style={{ marginLeft: 8 }}>active (live node)</span>
              ) : (
                <span className="vr-badge vr-b-dim" style={{ marginLeft: 8 }}>not reported active</span>
              )}
            </dd>
          </dl>
        ) : (
          <p className="vr-muted vr-small">
            {registration.loading
              ? "Checking the live Telegraph node…"
              : registration.error
                ? `Node check failed (${registration.error.message}) — UNVERIFIED`
                : "UNVERIFIED"}
          </p>
        )}
      </section>
    </div>
  );
}

const PAGE_CSS = `
.vr-page{max-width:1340px;margin:0 auto;padding:28px 24px 64px;color:var(--text,#F3F2EE);font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;line-height:1.55;overflow-wrap:anywhere}
.vr-kicker{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11.5px;color:var(--muted,#8F8E8A);margin-bottom:6px}
.vr-h1{font-size:clamp(1.9rem,3.2vw,2.6rem);font-weight:300;letter-spacing:-.03em;line-height:1.08;margin:0 0 10px}
.vr-h1 .serif-i,.serif-i{font-family:'Newsreader',Georgia,serif;font-style:italic;font-weight:400}
.vr-h2{font-size:19px;font-weight:400;letter-spacing:-.02em;margin:0 0 6px}
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
.vr-btn-ghost{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border-radius:999px;border:1px solid var(--border-strong,var(--border-hi,rgba(255,255,255,.22)));background:transparent;font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--text,#F3F2EE);cursor:pointer}
.vr-btn-ghost:disabled{opacity:.55;cursor:default}
.vr-code{border-radius:10px;border:1px solid var(--border,rgba(255,255,255,.10));background:var(--code-bg,#0D0D0F);color:#F2F1EC;overflow:hidden}
.vr-code pre{padding:16px 18px;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.66;overflow-x:auto;margin:0;color:#F2F1EC;white-space:pre-wrap;word-break:break-word}
.vr-err{color:var(--bad,var(--err,#EF4444));font-size:13px}
.vr-label{display:block;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted,#8F8E8A);margin:0 0 5px}
.vr-health-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.vr-probes-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px}
.vr-tbl-wrap{overflow-x:auto}
.vr-tbl{width:100%;border-collapse:collapse;font-size:12.5px;text-align:left}
.vr-tbl th{font-family:'JetBrains Mono',monospace;font-size:10.5px;font-weight:500;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#8F8E8A);padding:10px 14px;border-bottom:1px solid var(--border,rgba(255,255,255,.10))}
.vr-tbl td{padding:11px 14px;border-bottom:1px solid var(--border,rgba(255,255,255,.10));vertical-align:top}
.vr-tbl tr:last-child td{border-bottom:0}
.vr-kv{display:grid;grid-template-columns:150px 1fr;gap:6px 12px;margin:12px 0;font-size:13px}
.vr-kv dt{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted,#8F8E8A)}
.vr-kv dd{margin:0;word-break:break-word}
@media (max-width:900px){.vr-health-grid{grid-template-columns:repeat(2,1fr)}}
@media (max-width:640px){.vr-page{padding:20px 14px 48px}.vr-card{padding:16px}.vr-health-grid{grid-template-columns:1fr}}
`;
