// /receipts — the receipt ledger.
//
// LIVE DATA ONLY. Every receipt on this page comes from a real call made
// through this page in the current browser session (try-it forms below).
// Receipts persist in localStorage so they survive navigation, and are
// labelled as "this browser session". There is no seeded ledger: with no
// calls yet the page shows a real empty state.
//
// Receipt verification is real, not a badge. The method depends on what the
// miner actually hashed (read from src/handlers/* + proven live 2026-11-20):
// - /v1/tx: replay the exact JSON-RPC call the miner made —
//   POST {"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt",
//   "params":[txHash]} to receipt.upstream_url — and hash the exact
//   response text. MATCH proven live (0xe105b631…f3954).
// - /v1/filings: GET re-fetch of receipt.upstream_url, hash the exact bytes.
//   MATCH proven live (SEC submissions JSON, 0xf0010225…31e57b).
// - /v1/tvl: GET re-fetch, hash the exact bytes. In practice this MISMATCHES:
//   the miner's hash and a re-fetch minutes later are both stable yet
//   different (CDN edge/version drift on api.llama.fi) — proven live, so a
//   mismatch here is shown honestly with that explanation, never "verified".
// - /v1/grid-price: the hash is over canonical evidence JSON built from the
//   cached ISO row, NOT over the CAISO zip bytes — so the zip can never
//   match. The panel re-hashes JSON.stringify({node_or_zone, interval_start,
//   lmp_usd_per_mwh, market}) from the answer fields. MATCH proven live
//   (0x6f3f1c29…655d6).
// - /v1/route: NOT reproducible in-browser. The evidence includes the
//   winning quoter's raw request/response, which the API response does not
//   carry — so the panel says so, never "verified".
// A mismatch does not by itself prove tampering (upstream bytes can move or
// differ by edge after the receipt was issued); only a match counts as
// verified, and the method used is always named.
// The receipt's audit_url is recorded text only: the API does not serve
// /receipts/:id in this build (live check 2026-11-20 returned HTTP 404).
//
// Design: VeriReceipt dark obsidian, accent #FF5722, Inter / JetBrains Mono /
// Newsreader italic — same tokens as the showcase landing + proof hub.
// The router/shell wraps this page in Layout (nav/footer chrome); this file
// renders page content only.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getFilings, getGridPrice, getHealth, getRoute, getTvl, getTx, ApiError } from '../lib/api';
import { useHealth } from '../lib/hooks';
import type { Receipt } from '../lib/types';
import { ReceiptCard } from '../components/ReceiptCard';

// ---------------------------------------------------------------------------
// Types (structural; the lib returns the miner's flat JSON envelope)
// ---------------------------------------------------------------------------

type Envelope = Record<string, unknown> & {
  answer?: string;
  verdict?: string;
  confidence?: number;
  source?: string;
  checked_at?: string;
  receipt: Receipt;
};

interface StoredReceipt {
  key: string;
  endpoint: string;
  label: string;
  params: string;
  fetchedAt: string;
  receipt: Receipt;
  summary: string;
  // Minimal fields the verifier needs for endpoints whose hash is not a
  // plain upstream re-fetch (tx hash for the JSON-RPC replay; the four grid
  // evidence fields for the canonical re-hash).
  verifyData?: {
    tx_hash?: string;
    node_or_zone?: string;
    interval_start?: string;
    lmp_usd_per_mwh?: number;
    market?: string;
  };
}

type EndpointKey = 'tx' | 'filings' | 'tvl' | 'route' | 'grid';

interface TryItResult {
  endpoint: EndpointKey | 'health';
  data: Envelope | null;
  health: { status: string; service: string; uptime_s: number } | null;
  latencyMs: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Constants — sample inputs verified live against the API on 2026-11-20
// ---------------------------------------------------------------------------

const API_BASE_URL = 'https://verireceipt.onrender.com';
const STORAGE_KEY = 'verireceipt.session-receipts.v1';

// Real confirmed Ethereum tx (block 26454869, checked live 2026-11-20).
const SAMPLE_TX_HASH = '0xafdbc83c485355d90f79fd660bcd12713402aa78922d966657d1005f59e92902';

// Grid cache covers recent past intervals only: default to 2h ago, on the hour.
function defaultGridInterval(): string {
  const d = new Date(Date.now() - 2 * 60 * 60 * 1000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errText(err: unknown): string {
  if (err instanceof ApiError) {
    return `${err.status} ${err.code} — ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

function shortHash(hash: string): string {
  if (!hash) return '—';
  return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return iso;
  }
}

function loadStored(): StoredReceipt[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is StoredReceipt =>
        !!r && typeof r === 'object' && !!(r as StoredReceipt).receipt?.receipt_id,
    );
  } catch {
    return [];
  }
}

function asEnvelope(value: unknown): Envelope {
  const data = value as Envelope;
  if (!data || typeof data !== 'object' || !data.receipt) {
    throw new Error('Unexpected API response: no receipt block');
  }
  return data;
}

// ---------------------------------------------------------------------------
// Real receipt verification (see file header)
// ---------------------------------------------------------------------------

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'verified'; computed: string; method: string }
  | { kind: 'mismatch'; computed: string; method: string }
  | { kind: 'unverifiable'; reason: string }
  | { kind: 'not-reproducible'; reason: string };

async function sha256Hex(input: ArrayBuffer | string): Promise<string> {
  if (!window.crypto?.subtle) {
    throw new Error('WebCrypto (crypto.subtle) is unavailable in this browser context');
  }
  const bytes =
    typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  const digest = await window.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `0x${hex}`;
}

function normaliseHash(hash: string): string {
  return hash.trim().toLowerCase();
}

// Fields the verifier reads from a full response envelope (try-it results)
// or from a stored receipt's verifyData (ledger rows).
interface VerifyData extends Record<string, unknown> {
  tx_hash?: unknown;
  node_or_zone?: unknown;
  interval_start?: unknown;
  lmp_usd_per_mwh?: unknown;
  market?: unknown;
}

function verifyMethodNote(endpoint: EndpointKey): string {
  if (endpoint === 'tx') {
    return 'Replays the miner’s exact JSON-RPC call — POST {"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":[txHash]} to the receipt’s upstream RPC URL — and hashes the exact response text.';
  }
  if (endpoint === 'grid') {
    return 'Re-hashes the canonical evidence JSON the miner hashed: JSON.stringify({node_or_zone, interval_start, lmp_usd_per_mwh, market}) built from the answer fields. (The CAISO zip bytes are NOT what was hashed, so re-fetching the zip can never match.)';
  }
  if (endpoint === 'route') {
    return 'The receipt hash covers the winning quoter’s raw request/response, which the API response does not carry — so this receipt cannot be re-hashed in the browser.';
  }
  return 'Re-fetches the receipt’s upstream URL and hashes the exact bytes with WebCrypto, then compares with the receipt hash. Verified only on a match.';
}

async function verifyReceipt(
  receipt: Receipt,
  endpoint: EndpointKey,
  data?: VerifyData,
): Promise<VerifyState> {
  // --- /v1/route: evidence not carried by the API response. ---
  if (endpoint === 'route') {
    return {
      kind: 'not-reproducible',
      reason:
        'The receipt hash covers the winning quoter’s raw request/response at the pinned block (src/handlers/optimalRoute.ts), which the API response does not carry — so this receipt cannot be independently re-hashed in the browser.',
    };
  }

  // --- /v1/grid-price: canonical evidence re-hash (proven MATCH live). ---
  if (endpoint === 'grid') {
    const node = data?.node_or_zone;
    const interval = data?.interval_start;
    const lmp = data?.lmp_usd_per_mwh;
    const market = data?.market;
    if (
      typeof node !== 'string' ||
      typeof interval !== 'string' ||
      typeof lmp !== 'number' ||
      typeof market !== 'string'
    ) {
      return {
        kind: 'unverifiable',
        reason:
          'The grid evidence fields (node_or_zone, interval_start, lmp_usd_per_mwh, market) are missing from this record, so the canonical evidence JSON cannot be rebuilt.',
      };
    }
    try {
      const canonical = JSON.stringify({
        node_or_zone: node,
        interval_start: interval,
        lmp_usd_per_mwh: lmp,
        market,
      });
      const computed = await sha256Hex(canonical);
      if (normaliseHash(computed) === normaliseHash(receipt.raw_response_sha256)) {
        return { kind: 'verified', computed, method: 'Canonical evidence re-hash' };
      }
      return { kind: 'mismatch', computed, method: 'Canonical evidence re-hash' };
    } catch (err) {
      return {
        kind: 'unverifiable',
        reason: `Canonical re-hash failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      };
    }
  }

  // --- /v1/tx: exact JSON-RPC replay (proven MATCH live). ---
  if (endpoint === 'tx') {
    const txHash = data?.tx_hash;
    if (typeof txHash !== 'string' || !txHash) {
      return {
        kind: 'unverifiable',
        reason: 'The transaction hash is missing from this record, so the JSON-RPC call cannot be replayed.',
      };
    }
    if (!receipt.upstream_url) {
      return { kind: 'unverifiable', reason: 'Receipt carries no upstream_url to replay against.' };
    }
    try {
      const res = await fetch(receipt.upstream_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionReceipt',
          params: [txHash],
        }),
      });
      if (!res.ok) {
        return {
          kind: 'unverifiable',
          reason: `RPC replay returned HTTP ${res.status} — the hash was not checked, not confirmed.`,
        };
      }
      const computed = await sha256Hex(await res.arrayBuffer());
      if (normaliseHash(computed) === normaliseHash(receipt.raw_response_sha256)) {
        return { kind: 'verified', computed, method: 'JSON-RPC replay' };
      }
      return { kind: 'mismatch', computed, method: 'JSON-RPC replay' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'fetch failed';
      return {
        kind: 'unverifiable',
        reason:
          /Failed to fetch|NetworkError|CORS|blocked/i.test(msg) || err instanceof TypeError
            ? 'RPC replay was blocked by the browser (CORS / network) — the hash was not checked, not confirmed.'
            : `RPC replay failed: ${msg} — the hash was not checked, not confirmed.`,
      };
    }
  }

  // --- /v1/filings + /v1/tvl: upstream GET re-fetch. ---
  if (!receipt.upstream_url) {
    return { kind: 'unverifiable', reason: 'Receipt carries no upstream_url to re-fetch.' };
  }
  try {
    const res = await fetch(receipt.upstream_url);
    if (!res.ok) {
      return {
        kind: 'unverifiable',
        reason: `Upstream re-fetch returned HTTP ${res.status} — the hash was not checked, not confirmed.`,
      };
    }
    const bytes = await res.arrayBuffer();
    const computed = await sha256Hex(bytes);
    if (normaliseHash(computed) === normaliseHash(receipt.raw_response_sha256)) {
      return { kind: 'verified', computed, method: 'Upstream re-fetch' };
    }
    return { kind: 'mismatch', computed, method: 'Upstream re-fetch' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'fetch failed';
    const reason =
      /Failed to fetch|NetworkError|CORS|blocked/i.test(msg) || err instanceof TypeError
        ? 'Upstream fetch was blocked by the browser (CORS / network) — the hash was not checked, not confirmed.'
        : `Upstream re-fetch failed: ${msg} — the hash was not checked, not confirmed.`;
    return { kind: 'unverifiable', reason };
  }
}

function VerifyPanel({
  receipt,
  endpoint,
  data,
}: {
  receipt: Receipt;
  endpoint: EndpointKey;
  data?: VerifyData;
}) {
  const [state, setState] = useState<VerifyState>({ kind: 'idle' });
  const run = useCallback(async () => {
    setState({ kind: 'checking' });
    setState(await verifyReceipt(receipt, endpoint, data));
  }, [receipt, endpoint, data]);

  return (
    <div className="vr-verify">
      <div className="vr-verify-head">
        <span className="vr-kicker" style={{ marginBottom: 0 }}>
          // receipt verification · real re-hash, not a badge
        </span>
        <button
          type="button"
          className="vr-btn-ghost"
          onClick={run}
          disabled={state.kind === 'checking'}
        >
          {state.kind === 'checking' ? 'Verifying…' : 'Recompute SHA-256 in browser'}
        </button>
      </div>
      {state.kind === 'idle' && (
        <p className="vr-muted vr-small">{verifyMethodNote(endpoint)}</p>
      )}
      {state.kind === 'checking' && <p className="vr-muted vr-small">Verifying…</p>}
      {state.kind === 'verified' && (
        <div>
          <span className="vr-badge vr-b-ok">SHA-256 MATCH VERIFIED ✓</span>
          <p className="vr-muted vr-small" style={{ marginTop: 8 }}>
            Method: {state.method}.
          </p>
          <p className="vr-muted vr-small vr-mono">
            computed {state.computed}
            <br />
            recorded {receipt.raw_response_sha256}
          </p>
        </div>
      )}
      {state.kind === 'mismatch' && (
        <div>
          <span className="vr-badge vr-b-warn">DIGEST MISMATCH</span>
          <p className="vr-muted vr-small" style={{ marginTop: 8 }}>
            Method: {state.method}. The bytes checked now differ from the bytes the miner hashed
            at {fmtTime(receipt.fetched_at)}. Upstream data can move after the receipt is issued,
            or the upstream can serve different bytes than the miner saw (CDN/edge drift — proven
            for DeFiLlama TVL) — so this does not by itself prove tampering, but the receipt is{' '}
            <strong>not verified</strong>.
          </p>
          <p className="vr-muted vr-small vr-mono">
            computed {state.computed}
            <br />
            recorded {receipt.raw_response_sha256}
          </p>
        </div>
      )}
      {state.kind === 'unverifiable' && (
        <div>
          <span className="vr-badge vr-b-dim">COULD NOT VERIFY IN BROWSER</span>
          <p className="vr-muted vr-small" style={{ marginTop: 8 }}>
            {state.reason}
          </p>
        </div>
      )}
      {state.kind === 'not-reproducible' && (
        <div>
          <span className="vr-badge vr-b-dim">NOT REPRODUCIBLE IN BROWSER</span>
          <p className="vr-muted vr-small" style={{ marginTop: 8 }}>
            {state.reason}
          </p>
        </div>
      )}
      <p className="vr-muted vr-small">
        Recorded audit URL:{' '}
        <span className="vr-mono">
          {typeof receipt.audit_url === 'string' ? receipt.audit_url : '—'}
        </span>{' '}
        — the API does
        not serve <span className="vr-mono">/receipts/:id</span> in this build (live check
        2026-11-20: HTTP 404), so it is shown as recorded text, not a working link.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Try-it form
// ---------------------------------------------------------------------------

interface FieldDef {
  name: string;
  label: string;
  placeholder: string;
}

interface TryItProps {
  endpoint: EndpointKey;
  title: string;
  intent: string;
  methodPath: string;
  fields: FieldDef[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  onRun: () => void;
  running: boolean;
  result: TryItResult | null;
}

function TryItCard(props: TryItProps) {
  const { endpoint, title, intent, methodPath, fields, values, onChange, onRun, running, result } =
    props;
  const data = result?.data ?? null;
  return (
    <section className="vr-card vr-tryit" aria-label={`${title} try-it`}>
      <div className="vr-kicker">// {intent}</div>
      <h3 className="vr-h3">{title}</h3>
      <p className="vr-mono vr-small vr-muted" style={{ margin: '0 0 14px' }}>
        GET {methodPath}
      </p>
      {fields.map((f) => (
        <label key={f.name} className="vr-field-wrap">
          <span className="vr-label">{f.label}</span>
          <input
            className="vr-field"
            value={values[f.name] ?? ''}
            placeholder={f.placeholder}
            onChange={(e) => onChange(f.name, e.target.value)}
            spellCheck={false}
          />
        </label>
      ))}
      <div className="vr-tryit-actions">
        <button type="button" className="vr-btn-accent" onClick={onRun} disabled={running}>
          {running ? 'Calling live API…' : 'Run live call →'}
        </button>
        {result && !result.error && (
          <span className="vr-badge vr-b-ok">200 OK · {result.latencyMs} ms</span>
        )}
      </div>
      {result?.error && (
        <p className="vr-err" role="alert">
          Live call failed: {result.error}
        </p>
      )}
      {data && (
        <div className="vr-result">
          {data.answer && <p className="vr-answer">{data.answer}</p>}
          <dl className="vr-kv">
            {data.verdict && (
              <>
                <dt>verdict</dt>
                <dd>{data.verdict}</dd>
              </>
            )}
            {typeof data.confidence === 'number' && (
              <>
                <dt>confidence</dt>
                <dd>{data.confidence}</dd>
              </>
            )}
            {data.source && (
              <>
                <dt>source</dt>
                <dd className="vr-mono vr-small">{data.source}</dd>
              </>
            )}
            {data.checked_at && (
              <>
                <dt>checked_at</dt>
                <dd className="vr-mono vr-small">{fmtTime(data.checked_at)}</dd>
              </>
            )}
          </dl>
          <ReceiptCard receipt={data.receipt} />
          <VerifyPanel receipt={data.receipt} endpoint={endpoint} data={data} />
          <details className="vr-json">
            <summary className="vr-mono vr-small">Full JSON response</summary>
            <div className="vr-code">
              <pre>{JSON.stringify(data, null, 2)}</pre>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const ENDPOINT_META: Record<EndpointKey, { title: string; intent: string; path: string }> = {
  tx: { title: 'Transaction lookup', intent: 'ONCHAIN_TX_LOOKUP_GENERAL', path: '/v1/tx' },
  filings: {
    title: 'Filings monitor',
    intent: 'REGULATORY_FILING_MONITOR_GENERAL',
    path: '/v1/filings',
  },
  tvl: { title: 'TVL lookup', intent: 'TVL_LOOKUP_GENERAL', path: '/v1/tvl' },
  route: {
    title: 'Execution route',
    intent: 'OPTIMAL_EXECUTION_ROUTE_GENERAL',
    path: '/v1/route',
  },
  grid: { title: 'Grid power price', intent: 'GRID_POWER_PRICE_GENERAL', path: '/v1/grid-price' },
};

export default function Receipts() {
  const health = useHealth();
  // "Last checked" is page state, not a hook field: the real useHealth
  // returns no lastChecked. Record a timestamp whenever a health fetch
  // settles, and poll every 30 s in-page via refetch (the hook itself
  // never polls), with cleanup on unmount.
  const [healthCheckedAt, setHealthCheckedAt] = useState<string | null>(null);
  useEffect(() => {
    if (!health.loading) setHealthCheckedAt(new Date().toISOString());
  }, [health.loading, health.data, health.error]);
  useEffect(() => {
    const id = window.setInterval(() => health.refetch(), 30000);
    return () => window.clearInterval(id);
  }, [health.refetch]);
  const [stored, setStored] = useState<StoredReceipt[]>(() => loadStored());
  const [values, setValues] = useState<Record<string, string>>(() => ({
    tx_hash: SAMPLE_TX_HASH,
    chain: 'ethereum',
    entity: 'Apple',
    period: 'last 12 months',
    protocol: 'aave-v3',
    pair: 'ETH/USDC',
    node_or_zone: 'TH_NP15_GEN-APND',
    interval_start: defaultGridInterval(),
  }));
  const [running, setRunning] = useState<EndpointKey | 'health' | null>(null);
  const [results, setResults] = useState<Partial<Record<EndpointKey | 'health', TryItResult>>>({});
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthMs, setHealthMs] = useState<number | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // storage full/unavailable — receipts stay in memory for the session
    }
  }, [stored]);

  const addReceipt = useCallback((entry: StoredReceipt) => {
    setStored((prev) => [entry, ...prev.filter((r) => r.receipt.receipt_id !== entry.receipt.receipt_id)]);
  }, []);

  const setValue = useCallback((name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const runEndpoint = useCallback(
    async (endpoint: EndpointKey) => {
      setRunning(endpoint);
      const started = performance.now();
      try {
        let raw: unknown;
        let label: string;
        let params: string;
        let summary: string;
        if (endpoint === 'tx') {
          raw = await getTx({ tx_hash: values.tx_hash.trim(), chain: values.chain.trim() });
          label = `tx ${shortHash(values.tx_hash.trim())} · ${values.chain.trim()}`;
          params = `tx_hash=${values.tx_hash.trim()}&chain=${values.chain.trim()}`;
          const d = asEnvelope(raw);
          summary = d.answer ?? `status ${String(d.status ?? '—')}, block ${String(d.block_number ?? '—')}`;
        } else if (endpoint === 'filings') {
          raw = await getFilings({ entity: values.entity.trim(), period: values.period.trim() });
          label = `filings ${values.entity.trim()} · ${values.period.trim()}`;
          params = `entity=${values.entity.trim()}&period=${values.period.trim()}`;
          const d = asEnvelope(raw);
          summary = d.answer ?? `${String(d.filing_count ?? '—')} filings`;
        } else if (endpoint === 'tvl') {
          raw = await getTvl({ protocol: values.protocol.trim() });
          label = `tvl ${values.protocol.trim()}`;
          params = `protocol=${values.protocol.trim()}`;
          const d = asEnvelope(raw);
          summary = d.answer ?? `TVL $${Number(d.tvl_usd ?? 0).toLocaleString('en-US')}`;
        } else if (endpoint === 'route') {
          raw = await getRoute({ pair: values.pair.trim() });
          label = `route ${values.pair.trim()}`;
          params = `pair=${values.pair.trim()}`;
          const d = asEnvelope(raw);
          summary = d.answer ?? `amount_out ${String(d.amount_out ?? '—')}`;
        } else {
          raw = await getGridPrice({
            node_or_zone: values.node_or_zone.trim(),
            interval_start: values.interval_start.trim(),
          });
          label = `grid ${values.node_or_zone.trim()} · ${values.interval_start.trim()}`;
          params = `node_or_zone=${values.node_or_zone.trim()}&interval_start=${values.interval_start.trim()}`;
          const d = asEnvelope(raw);
          summary = d.answer ?? `LMP $${String(d.lmp_usd_per_mwh ?? '—')}/MWh`;
        }
        const data = asEnvelope(raw);
        const latencyMs = Math.round(performance.now() - started);
        setResults((prev) => ({
          ...prev,
          [endpoint]: { endpoint, data, health: null, latencyMs, error: null },
        }));
        // Keep the minimal fields the verifier needs for tx (hash for the
        // JSON-RPC replay) and grid (the four canonical evidence fields).
        const verifyData =
          endpoint === 'tx'
            ? { tx_hash: data.tx_hash as string | undefined }
            : endpoint === 'grid'
              ? {
                  node_or_zone: data.node_or_zone as string | undefined,
                  interval_start: data.interval_start as string | undefined,
                  lmp_usd_per_mwh: data.lmp_usd_per_mwh as number | undefined,
                  market: data.market as string | undefined,
                }
              : undefined;
        addReceipt({
          key: `${endpoint}-${data.receipt.receipt_id}`,
          endpoint,
          label,
          params,
          fetchedAt: data.receipt.fetched_at,
          receipt: data.receipt,
          summary,
          verifyData,
        });
      } catch (err) {
        const latencyMs = Math.round(performance.now() - started);
        setResults((prev) => ({
          ...prev,
          [endpoint]: { endpoint, data: null, health: null, latencyMs, error: errText(err) },
        }));
      } finally {
        setRunning(null);
      }
    },
    [values, addReceipt],
  );

  const runHealth = useCallback(async () => {
    setRunning('health');
    setHealthError(null);
    const started = performance.now();
    try {
      const h = (await getHealth()) as unknown as {
        status: string;
        service: string;
        uptime_s: number;
      };
      setHealthMs(Math.round(performance.now() - started));
      setResults((prev) => ({
        ...prev,
        health: {
          endpoint: 'health',
          data: null,
          health: h,
          latencyMs: Math.round(performance.now() - started),
          error: null,
        },
      }));
    } catch (err) {
      setHealthMs(Math.round(performance.now() - started));
      setHealthError(errText(err));
    } finally {
      setRunning(null);
    }
  }, []);

  const clearStored = useCallback(() => {
    setStored([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  const healthStatus = useMemo(() => {
    if (health.loading && !health.data) return { label: 'checking…', cls: 'vr-b-dim' };
    if (health.error) return { label: 'health unreachable', cls: 'vr-b-err' };
    if (health.data) return { label: `live · ${health.data.status}`, cls: 'vr-b-ok' };
    return { label: 'unknown', cls: 'vr-b-dim' };
  }, [health]);

  const fieldDefs: Record<EndpointKey, FieldDef[]> = {
    tx: [
      { name: 'tx_hash', label: 'tx_hash — 0x-prefixed 64-hex transaction hash', placeholder: '0x…' },
      { name: 'chain', label: 'chain — ethereum, base, arbitrum, optimism, polygon, sepolia', placeholder: 'ethereum' },
    ],
    filings: [
      { name: 'entity', label: 'entity — company name, ticker, CIK, or agency', placeholder: 'Apple' },
      { name: 'period', label: 'period — e.g. last 12 months, 2026', placeholder: 'last 12 months' },
    ],
    tvl: [
      { name: 'protocol', label: 'protocol — DeFi protocol slug or chain name', placeholder: 'aave-v3' },
    ],
    route: [
      { name: 'pair', label: 'pair — must be ETH/USDC', placeholder: 'ETH/USDC' },
    ],
    grid: [
      { name: 'node_or_zone', label: 'node_or_zone — pricing node or bidding zone', placeholder: 'TH_NP15_GEN-APND' },
      { name: 'interval_start', label: 'interval_start — ISO-8601 UTC, past interval on a settlement boundary', placeholder: '2026-11-20T06:00:00Z' },
    ],
  };

  return (
    <div className="vr-page vr-receipts">
      <style>{PAGE_CSS}</style>
      <header className="vr-head">
        <div>
          <div className="vr-kicker">// public auditable ledger · this browser session</div>
          <h1 className="vr-h1">
            Receipts <span className="serif-i">Ledger.</span>
          </h1>
          <p className="vr-lede">
            Every receipt below was obtained from a live call made on this page — nothing is
            seeded, and no totals are claimed beyond what this session actually fetched. Each
            receipt carries its upstream URL and SHA-256 digest, re-hashable in your browser.
          </p>
        </div>
        <div className="vr-head-side">
          <span className={`vr-badge ${healthStatus.cls}`}>API {healthStatus.label}</span>
          <span className="vr-badge vr-b-dim">
            {stored.length} receipt{stored.length === 1 ? '' : 's'} this session
          </span>
        </div>
      </header>

      {/* ---- Session ledger ---- */}
      <section className="vr-card" aria-label="Session receipt ledger">
        <div className="vr-ledger-head">
          <div>
            <div className="vr-kicker" style={{ marginBottom: 4 }}>
              // session ledger · localStorage · survives navigation
            </div>
            <h2 className="vr-h2">Receipts collected in this browser session</h2>
          </div>
          {stored.length > 0 && (
            <button type="button" className="vr-btn-ghost" onClick={clearStored}>
              Clear session ledger
            </button>
          )}
        </div>
        {stored.length === 0 ? (
          <div className="vr-empty">
            <p className="vr-empty-title">No receipts yet in this browser session.</p>
            <p className="vr-muted">
              Run any probe below — each successful live call adds its real receipt here with its
              upstream URL and SHA-256 digest. Nothing is shown until a call actually happens.
            </p>
          </div>
        ) : (
          <ol className="vr-ledger-list">
            {stored.map((entry) => (
              <li key={entry.key} className="vr-ledger-row">
                <details>
                  <summary>
                    <span className="vr-badge vr-b-acc">{entry.endpoint}</span>
                    <span className="vr-ledger-label">{entry.label}</span>
                    <span className="vr-mono vr-small vr-muted">{fmtTime(entry.fetchedAt)}</span>
                  </summary>
                  <p className="vr-answer vr-small">{entry.summary}</p>
                  <p className="vr-mono vr-small vr-muted vr-params">{entry.params}</p>
                  <ReceiptCard receipt={entry.receipt} />
                  <VerifyPanel
                    receipt={entry.receipt}
                    endpoint={entry.endpoint as EndpointKey}
                    data={entry.verifyData}
                  />
                </details>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* ---- Health try-it ---- */}
      <section className="vr-card vr-health" aria-label="Health check">
        <div className="vr-kicker">// GET /health · no receipt — liveness only</div>
        <h2 className="vr-h2">Service health</h2>
        <div className="vr-tryit-actions">
          <button type="button" className="vr-btn-accent" onClick={runHealth} disabled={running === 'health'}>
            {running === 'health' ? 'Checking…' : 'Check /health →'}
          </button>
          {health.data && (
            <span className="vr-badge vr-b-ok">
              {health.data.status} · uptime {Math.floor(health.data.uptime_s / 60)}m{' '}
              {health.data.uptime_s % 60}s
            </span>
          )}
          {healthMs !== null && <span className="vr-badge vr-b-dim">last probe {healthMs} ms</span>}
        </div>
        {healthError && (
          <p className="vr-err" role="alert">
            Live call failed: {healthError}
          </p>
        )}
        {health.error && (
          <p className="vr-err" role="alert">
            Live poll failed: {errText(health.error)}
          </p>
        )}
        {health.data && (
          <div className="vr-code" style={{ marginTop: 12 }}>
            <pre>{JSON.stringify(health.data, null, 2)}</pre>
          </div>
        )}
        <p className="vr-muted vr-small" style={{ marginTop: 10 }}>
          Base URL <span className="vr-mono">{API_BASE_URL}</span> · polled live every 30 s ·
          last checked{' '}
          {healthCheckedAt ? fmtTime(healthCheckedAt) : '—'}
        </p>
      </section>

      {/* ---- Try-it forms ---- */}
      <div className="vr-kicker" style={{ marginTop: 28 }}>
        // try-it · five live endpoints · each call returns its real receipt
      </div>
      <div className="vr-tryit-grid">
        {(Object.keys(ENDPOINT_META) as EndpointKey[]).map((key) => (
          <TryItCard
            key={key}
            endpoint={key}
            title={ENDPOINT_META[key].title}
            intent={ENDPOINT_META[key].intent}
            methodPath={`${ENDPOINT_META[key].path} — ${API_BASE_URL}${ENDPOINT_META[key].path}`}
            fields={fieldDefs[key]}
            values={values}
            onChange={setValue}
            onRun={() => runEndpoint(key)}
            running={running === key}
            result={results[key] ?? null}
          />
        ))}
      </div>
      <p className="vr-muted vr-small" style={{ marginTop: 18 }}>
        Miner <span className="vr-mono">774921 · verireceipt</span> · auth: none · all five
        endpoints are GET — the forms above call the live API through the same-origin{' '}
        <span className="vr-mono">/api</span> proxy. Failed calls (e.g. a future grid interval, an
        unknown protocol) return the real error — nothing is fabricated.
      </p>
    </div>
  );
}

const PAGE_CSS = `
.vr-page{max-width:1340px;margin:0 auto;padding:28px 24px 64px;color:var(--text,#F3F2EE);font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;line-height:1.55}
.vr-kicker{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11.5px;color:var(--muted,#8F8E8A);margin-bottom:6px}
.vr-h1{font-size:clamp(1.9rem,3.2vw,2.6rem);font-weight:300;letter-spacing:-.03em;line-height:1.08;margin:0 0 10px}
.vr-h1 .serif-i,.serif-i{font-family:'Newsreader',Georgia,serif;font-style:italic;font-weight:400}
.vr-h2{font-size:19px;font-weight:400;letter-spacing:-.02em;margin:0 0 6px}
.vr-h3{font-size:16px;font-weight:500;letter-spacing:-.02em;margin:0 0 4px}
.vr-lede{font-size:14.5px;color:var(--muted,#8F8E8A);max-width:640px;line-height:1.6;margin:0}
.vr-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:22px}
.vr-head-side{display:flex;gap:8px;flex-wrap:wrap}
.vr-card{background:var(--surface,#121214);border:1px solid var(--border,rgba(255,255,255,.10));border-radius:12px;padding:20px;margin-bottom:18px}
.vr-mono{font-family:'JetBrains Mono',ui-monospace,monospace}
.vr-small{font-size:12px}
.vr-muted{color:var(--muted,#8F8E8A)}
.vr-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:10.5px;font-weight:500;white-space:nowrap}
.vr-b-ok{background:var(--ok-soft,rgba(34,197,94,.14));color:var(--ok,#22C55E);border:1px solid rgba(34,197,94,.35)}
.vr-b-warn{background:var(--warn-soft,rgba(245,158,11,.15));color:var(--warn,#F59E0B);border:1px solid rgba(245,158,11,.36)}
.vr-b-err{background:var(--bad-soft,var(--err-soft,rgba(239,68,68,.15)));color:var(--bad,var(--err,#EF4444));border:1px solid rgba(239,68,68,.35)}
.vr-b-dim{background:var(--panel,#151518);color:var(--muted,#8F8E8A);border:1px solid var(--border-strong,var(--border-hi,rgba(255,255,255,.22)))}
.vr-b-acc{background:var(--accent-soft,rgba(255,87,34,.14));color:var(--accent,#FF5722);border:1px solid rgba(255,87,34,.40)}
.vr-btn-accent{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 20px;border-radius:999px;background:var(--accent,#FF5722);color:#fff;font-size:13.5px;font-weight:500;border:0;cursor:pointer;transition:background-color .16s}
.vr-btn-accent:hover:not(:disabled){background:var(--accent-hover,#FF6E40)}
.vr-btn-accent:disabled{opacity:.55;cursor:default}
.vr-btn-ghost{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border-radius:999px;border:1px solid var(--border-strong,var(--border-hi,rgba(255,255,255,.22)));background:transparent;font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--text,#F3F2EE);cursor:pointer}
.vr-btn-ghost:disabled{opacity:.55;cursor:default}
.vr-field{width:100%;padding:8px 11px;border-radius:7px;border:1px solid var(--border-strong,var(--border-hi,rgba(255,255,255,.22)));background:var(--bg,#0B0B0C);color:var(--text,#F3F2EE);font-family:'JetBrains Mono',monospace;font-size:12px;outline:none;box-sizing:border-box}
.vr-field:focus{border-color:var(--accent,#FF5722)}
.vr-field-wrap{display:block;margin-bottom:12px}
.vr-label{display:block;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted,#8F8E8A);margin:0 0 5px}
.vr-code{border-radius:10px;border:1px solid var(--border,rgba(255,255,255,.10));background:var(--code-bg,#0D0D0F);color:#F2F1EC;overflow:hidden}
.vr-code pre{padding:16px 18px;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.66;overflow-x:auto;margin:0;color:#F2F1EC;white-space:pre-wrap;word-break:break-word}
.vr-err{color:var(--bad,var(--err,#EF4444));font-size:13px}
.vr-empty{padding:18px 4px 8px}
.vr-empty-title{font-size:16px;margin:0 0 6px}
.vr-ledger-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px}
.vr-ledger-list{list-style:none;margin:0;padding:0}
.vr-ledger-row{border-top:1px solid var(--border,rgba(255,255,255,.10));padding:12px 0}
.vr-ledger-row summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap;cursor:pointer;list-style:none}
.vr-ledger-row summary::-webkit-details-marker{display:none}
.vr-ledger-label{font-size:13.5px}
.vr-params{word-break:break-all}
.vr-answer{font-size:14px;line-height:1.55;margin:10px 0}
.vr-kv{display:grid;grid-template-columns:110px 1fr;gap:4px 12px;margin:12px 0;font-size:13px}
.vr-kv dt{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted,#8F8E8A)}
.vr-kv dd{margin:0;word-break:break-word}
.vr-tryit-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.vr-tryit{margin-bottom:0}
.vr-tryit-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:4px 0 12px}
.vr-result{border-top:1px solid var(--border,rgba(255,255,255,.10));padding-top:14px}
.vr-json{margin-top:14px}
.vr-json summary{cursor:pointer;color:var(--muted,#8F8E8A);margin-bottom:8px}
.vr-verify{border:1px solid var(--border,rgba(255,255,255,.10));border-radius:10px;padding:14px 16px;margin-top:14px;background:var(--panel,#151518)}
.vr-verify-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.vr-verify p{margin:8px 0}
.vr-health{margin-top:0}
@media (max-width:900px){.vr-tryit-grid{grid-template-columns:1fr}}
@media (max-width:640px){.vr-page{padding:20px 14px 48px}.vr-card{padding:16px}}
`;
