// /receipts — the receipt ledger.
//
// LIVE DATA ONLY. Every receipt on this page comes from a real call made
// in the current browser session — through this page's try-it forms or
// through the dashboard's live checks (both append to the same shared
// session ledger, src/lib/sessionReceipts.ts).
// Receipts persist in localStorage so they survive navigation, and are
// labelled as "this browser session". There is no seeded ledger: with no
// calls yet the page shows a real empty state.
//
// Receipt verification is real, not a badge — and there is exactly ONE
// verifier (src/lib/verifyReceipt.ts, PLAN.md C2). It tries the stored
// raw bytes first (GET /api/receipts/:id/raw, SHA-256 vs the recorded
// digest) and falls back to the per-endpoint live re-check only when
// /raw is unavailable (live check 2026-11-21: /raw HTTP 200; it was a
// 404 on 2026-11-20 before miner C1 landed). The live re-check methods,
// proven live 2026-11-20:
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
// - /v1/route: NOT reproducible in-browser by live re-check. The evidence
//   includes the winning quoter's raw request/response, which the API
//   response does not carry — so the panel says so, never "verified".
//   (Once the miner serves /raw, route becomes verifiable — the stored
//   bytes ARE the quoter bytes the miner hashed.)
// A mismatch does not by itself prove tampering (upstream bytes can move or
// differ by edge after the receipt was issued); only a match counts as
// verified, and the method used is always named — including whether the
// bytes came from /raw or from a live re-check, because a raw_bytes
// mismatch (stored bytes do not hash to the recorded digest) means
// something different from a live_recheck mismatch (upstream moved).
// For grid, per-intent stored-bytes semantics must be confirmed with the
// miner team (C1): the miner hashed canonical evidence JSON, not the
// CAISO zip, so a raw_bytes grid check against zip bytes would mismatch
// a receipt the live re-check matches.
// The API serves the receipt's audit_url (/receipts/:id, live check
// 2026-11-21: HTTP 200; 404 on 2026-11-20). The receipts/:id route deep-links into the session ledger instead: an
// id matching a receipt collected in this browser session opens that
// entry; any other id shows an honest not-found notice (see below).
//
// Design: VeriReceipt dark obsidian, accent #FF5722, Inter / JetBrains Mono /
// Newsreader italic — same tokens as the showcase landing + proof hub.
// The router/shell wraps this page in Layout (nav/footer chrome); this file
// renders page content only.

import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getFilings, getGridPrice, getHealth, getRoute, getTvl, getTx, getValidator, ApiError } from '../lib/api';
import { useHealth } from '../lib/hooks';
import {
  SESSION_RECEIPTS_CAP as LEDGER_CAP,
  SESSION_RECEIPTS_CORRUPT_BACKUP_KEY as BACKUP_KEY,
  SESSION_RECEIPTS_KEY,
  appendSessionReceipt,
  backupCorruptSessionReceipts,
  bumpLedgerGeneration,
  clearSessionReceipts,
  readLedgerGeneration,
  readSessionReceipts,
  uniqueSessionReceiptKey,
  type SessionReceipt as StoredReceipt,
  type SessionReceiptEndpoint,
} from '../lib/sessionReceipts';
import type { Receipt } from '../lib/types';
import {
  verifyMethodNote,
  verifyReceipt,
  type VerifyData,
  type VerifyResult,
} from '../lib/verifyReceipt';
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

type EndpointKey = SessionReceiptEndpoint;

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
// Session ledger storage lives in src/lib/sessionReceipts.ts (shared with
// the dashboard since 2026-11-20: dashboard receipts persist to the same
// key so they appear here after navigation).

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

// Stored entries are UNTRUSTED input: localStorage can hold anything, so
// every stored entry is fully validated on load — see
// src/lib/sessionReceipts.ts (isValidSessionReceipt). A receipt restored
// from storage never shows a bare VERIFIED badge — it is labelled as a
// stored entry.

// Defense in depth for rendering: a non-string renders as "—", never as a
// React child (an object child throws React error #31 and unmounts the page).
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '—';
}

function asEnvelope(value: unknown): Envelope {
  const data = value as Envelope;
  if (!data || typeof data !== 'object' || !data.receipt) {
    throw new Error('Unexpected API response: no receipt block');
  }
  return data;
}

// ---------------------------------------------------------------------------
// Receipt verification — THE ONE verifier lives in
// src/lib/verifyReceipt.ts (PLAN.md C2). The panel below only renders
// its result: verified / mismatch / unverifiable / not-reproducible /
// no-crypto. A cancelled check (no signal is passed here, so it cannot
// happen from this panel) goes back to idle.
// ---------------------------------------------------------------------------

// Panel state: idle / checking plus the verifier's result kinds.
type VerifyState = { kind: "idle" } | { kind: "checking" } | VerifyResult;

function VerifyPanel({
  receipt,
  endpoint,
  data,
  stored,
}: {
  receipt: Receipt;
  endpoint: EndpointKey;
  data?: VerifyData;
  // True for entries restored from localStorage: a hash match there proves
  // only that the stored fields are self-consistent (anyone can write
  // matching bytes to localStorage), so a stored entry never shows the
  // bare live VERIFIED badge — it is labelled as stored instead.
  stored?: boolean;
}) {
  const [state, setState] = useState<VerifyState>({ kind: 'idle' });
  const run = useCallback(async () => {
    setState({ kind: 'checking' });
    const result = await verifyReceipt(receipt, endpoint, data);
    // A cancelled check goes back to idle (no signal is passed here, so
    // this cannot happen from this panel — it is the verifier's contract).
    if (result.kind === 'cancelled') {
      setState({ kind: 'idle' });
      return;
    }
    setState(result);
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
      {stored && (
        <p className="vr-muted vr-small">
          Stored entry — restored from this browser’s storage, not from a live call just now.
          Re-run the live call for a fresh receipt; a hash match here is not live verification.
        </p>
      )}
      {state.kind === 'idle' && (
        <p className="vr-muted vr-small">{verifyMethodNote(endpoint)}</p>
      )}
      {state.kind === 'checking' && <p className="vr-muted vr-small">Verifying…</p>}
      {state.kind === 'verified' && (
        <div>
          {stored ? (
            state.mode === 'raw_bytes' ? (
              <>
                <span className="vr-badge vr-b-warn">STORED ENTRY — STORED BYTES HASH TO THE STORED DIGEST</span>
                <p className="vr-muted vr-small" style={{ marginTop: 8 }}>
                  Method: {state.method}
                  {state.evidenceKind ? ` · evidence: ${state.evidenceKind}` : ''}. The bytes
                  stored for this receipt hash to the digest stored beside them — but both
                  came from this browser's storage, so this proves only self-consistency,
                  not provenance: anyone can write matching bytes to localStorage. This entry
                  is <strong>not live-verified</strong>. Re-run the live call to verify.
                </p>
              </>
            ) : endpoint === 'grid' ? (
              <>
                <span className="vr-badge vr-b-warn">STORED ENTRY — HASH MATCHES STORED FIELDS</span>
                <p className="vr-muted vr-small" style={{ marginTop: 8 }}>
                  The hash matches the fields stored in this browser — but the grid check
                  re-hashes those stored fields, so this proves nothing about provenance:
                  anyone can write matching bytes to localStorage. This entry is{' '}
                  <strong>not live-verified</strong>. Re-run the live call to verify.
                </p>
              </>
            ) : (
              <>
                <span className="vr-badge vr-b-warn">STORED ENTRY — RE-CHECKED AGAINST LIVE UPSTREAM</span>
                <p className="vr-muted vr-small" style={{ marginTop: 8 }}>
                  Method: {state.method}. The recorded https upstream was re-fetched just now
                  and the hash matched — but the entry itself was restored from storage, so
                  re-run the live call for a fresh receipt.
                </p>
              </>
            )
          ) : (
            <>
              <span className="vr-badge vr-b-ok">SHA-256 MATCH VERIFIED ✓</span>
              <p className="vr-muted vr-small" style={{ marginTop: 8 }}>
                Method: {state.method}
                {state.evidenceKind ? ` · evidence: ${state.evidenceKind}` : ''}.
              </p>
            </>
          )}
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
            Method: {state.method}
            {state.evidenceKind ? ` · evidence: ${state.evidenceKind}` : ''}.{' '}
            {state.mode === 'raw_bytes' ? (
              <>
                The stored bytes do not hash to the recorded digest — the miner recorded a
                digest that does not match the bytes it stored for this receipt (or the
                stored bytes changed after issue). The receipt is{' '}
                <strong>not verified</strong>.
              </>
            ) : (
              <>
                The bytes checked now differ from the bytes the miner hashed at{' '}
                {fmtTime(receipt.fetched_at)}. Upstream data can move after the receipt is
                issued, or the upstream can serve different bytes than the miner saw
                (CDN/edge drift — proven for DeFiLlama TVL) — so this does not by itself
                prove tampering, but the receipt is <strong>not verified</strong>.
              </>
            )}
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
      {state.kind === 'no-crypto' && (
        <div>
          <span className="vr-badge vr-b-dim">WEB CRYPTO UNAVAILABLE</span>
          <p className="vr-muted vr-small" style={{ marginTop: 8 }}>
            This browser cannot compute SHA-256, so the receipt was not verified — never
            a fake hash.
          </p>
        </div>
      )}
      <p className="vr-muted vr-small">
        Recorded audit URL:{' '}
        <span className="vr-mono">
          {typeof receipt.audit_url === 'string' ? receipt.audit_url : '—'}
        </span>{' '}
        — the miner serves <span className="vr-mono">/receipts/:id</span> (live check
        2026-11-21: HTTP 200); it is shown here as recorded text. Verification above tries{' '}
        <span className="vr-mono">/api/receipts/:id/raw</span> first and falls back to a live
        re-check only if that fetch fails.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ledger error boundary (J2 B1): one bad stored row must never blank the
// page. The boundary wraps only the ledger list, so a render throw inside
// a row shows this fallback — with Clear reachable — while the rest of the
// page (header, health, try-it forms) keeps working.
// ---------------------------------------------------------------------------

interface LedgerBoundaryProps {
  onClear: () => void;
  children: ReactNode;
}

interface LedgerBoundaryState {
  hasError: boolean;
}

class LedgerErrorBoundary extends Component<LedgerBoundaryProps, LedgerBoundaryState> {
  state: LedgerBoundaryState = { hasError: false };

  static getDerivedStateFromError(): LedgerBoundaryState {
    return { hasError: true };
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="vr-notice" role="alert">
          <p>
            The stored ledger could not be rendered — one of the saved entries is corrupt.
            The rest of the page keeps working.
          </p>
          <button type="button" className="vr-btn-ghost" onClick={this.props.onClear}>
            Clear session ledger
          </button>
        </div>
      );
    }
    return this.props.children;
  }
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
  /** The last successful run's receipt was dropped from the ledger
   *  because the ledger was cleared while the call was in flight
   *  (J2 R6 minor D) — the card shows the live result either way, so
   *  the ledger outcome is named here. */
  ledgerDropped?: boolean;
}

function TryItCard(props: TryItProps) {
  const { endpoint, title, intent, methodPath, fields, values, onChange, onRun, running, result, ledgerDropped } =
    props;
  const data = result?.data ?? null;
  return (
    <section className="vr-card vr-tryit" aria-label={`${title} try-it`}>
      <div className="vr-kicker">// {intent}</div>
      <h3 className="vr-h3">{title}</h3>
      <p className="vr-mono vr-small vr-muted" style={{ margin: '0 0 14px', overflowWrap: 'anywhere' }}>
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
      {result && !result.error && ledgerDropped && (
        <p className="vr-muted vr-small">
          Not added to the session ledger — the ledger was cleared while this call was in flight.
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
  validator: {
    title: 'Validator effective balance',
    intent: 'VALIDATOR_PERFORMANCE_VERIFY_GENERAL',
    path: '/v1/validator',
  },
};

/** Merge persisted entries with memory-only ones for display, newest
 *  first by fetchedAt (ISO strings sort lexicographically), deduped by
 *  key, capped. Memory-only entries are first-class rows (J2 R3 B1/B2):
 *  they are never dropped by a re-read, a later successful append, or
 *  Discard — only by an explicit Clear of the whole session ledger.
 *  Cap rule (J2 R3 M1): memory-only rows have no other copy, so they
 *  are never the ones the cap drops — keep every memory-only row and
 *  fill the remaining slots with the newest persisted rows, total
 *  still ≤ LEDGER_CAP. (The old slice() dropped whichever rows sorted
 *  last, which could hide a memory-only receipt that exists nowhere
 *  else.) The cap is applied to the memory-first partition, then the
 *  DISPLAY is sorted globally newest-first (J2 R4 minor): without
 *  that final sort the whole memory-only block would render above
 *  newer persisted rows, contradicting "newest first". */
function mergeLedgerDisplay(
  persisted: StoredReceipt[],
  memoryOnly: StoredReceipt[],
): StoredReceipt[] {
  const memKeys = new Set(memoryOnly.map((e) => e.key));
  const merged = [...memoryOnly, ...persisted.filter((e) => !memKeys.has(e.key))];
  merged.sort((a, b) => (a.fetchedAt < b.fetchedAt ? 1 : a.fetchedAt > b.fetchedAt ? -1 : 0));
  const mem = merged.filter((e) => memKeys.has(e.key));
  const rest = merged.filter((e) => !memKeys.has(e.key));
  const display = [...mem, ...rest].slice(0, LEDGER_CAP);
  display.sort((a, b) => (a.fetchedAt < b.fetchedAt ? 1 : a.fetchedAt > b.fetchedAt ? -1 : 0));
  return display;
}

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
  const [storedInit] = useState(readSessionReceipts);
  const [stored, setStored] = useState<StoredReceipt[]>(storedInit.entries);
  // Receipts that could not be persisted (corrupt/unavailable storage,
  // or an entry the ledger refused as invalid): they are displayed with
  // a "memory only" badge and are NEVER silently discarded — not by the
  // next successful append, not by Discard (J2 R3 B1/B2). On every
  // successful append the backlog is retried, so a transient cause
  // (e.g. corrupt storage since discarded) heals itself; permanently
  // invalid entries stay memory-only, visibly.
  const [memoryOnly, setMemoryOnly] = useState<StoredReceipt[]>([]);
  // Ref mirror of the memory-only backlog. It is updated SYNCHRONOUSLY
  // at every mutation site (addReceipt, clearStored) — never during
  // render — so concurrent addReceipt calls see each other's entries
  // instead of sharing one stale closure snapshot (J2 R3 B1 race), and
  // the once-mounted storage listener sees the current backlog. A
  // render-time assignment here would clobber the ref with stale state
  // whenever a render landed between two concurrent appends.
  const memoryOnlyRef = useRef<StoredReceipt[]>([]);
  // Clear generation (J2 R5 B1): "Clear session ledger" promises the
  // WHOLE ledger is gone. A try-it in flight across a Clear used to
  // complete through addReceipt and resurrect its receipt into the
  // freshly cleared ledger. runEndpoint captures the generation at
  // call start; addReceipt drops entries whose call predates the
  // latest Clear. Discard does NOT bump it: its promise is narrow
  // (only the corrupt stored value goes) and an in-flight receipt
  // must survive it (J2 R4 B1). The dashboard path IS gated — on the
  // persist side: persistLiveReceiptToSessionLedger returns "skipped"
  // for a row whose call predates a Clear. Navigating away from
  // /dashboard also aborts its in-flight fetches, so no dashboard
  // call can complete after a Clear here.
  // Cross-tab (J2 R6): the in-memory ref is per tab — a try-it in
  // flight in ANOTHER tab would still resurrect its receipt after a
  // Clear here. Clear also bumps the STORED generation
  // (lib/sessionReceipts.ts SESSION_RECEIPTS_GEN_KEY), and addReceipt
  // checks both: the ref covers this tab (and storage-unavailable),
  // the stored counter covers every other tab sharing this ledger.
  const clearGenRef = useRef(0);
  const memoryOnlyKeys = useMemo(
    () => new Set(memoryOnly.map((e) => e.key)),
    [memoryOnly],
  );
  // Deep link (Gemini line-by-line verdict 2026-11-20): the
  // receipts/:id route renders this page with the id in the URL. An id
  // matching a receipt in this browser session opens that entry and
  // scrolls it into view; any other id shows an honest not-found
  // notice below. No backend fetch is attempted by this deep link
  // (the API does serve /receipts/:id since 2026-11-21, HTTP 200;
  // loading another session's receipt here is out of scope).
  const { id: deepLinkId } = useParams();
  const deepLinkEntry = useMemo(
    () =>
      deepLinkId !== undefined
        ? stored.find((e) => e.receipt.receipt_id === deepLinkId)
        : undefined,
    [deepLinkId, stored],
  );
  const deepLinkRef = useRef<HTMLLIElement | null>(null);
  // Scroll once per deep-link id (gemini J2 R5 B1): deepLinkEntry gets
  // a new identity on every storage re-read (fresh JSON.parse), so an
  // effect on [deepLinkEntry] re-fired — and yanked the viewport —
  // whenever the ledger grew. The id is the stable identity: same id,
  // no re-scroll; a new id, or an entry arriving late, scrolls once.
  const scrolledForRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!deepLinkEntry || !deepLinkRef.current) return;
    if (scrolledForRef.current === deepLinkId) return;
    scrolledForRef.current = deepLinkId;
    // jsdom has no scrollIntoView — guard so tests don't throw.
    deepLinkRef.current.scrollIntoView?.({ block: 'nearest' });
  }, [deepLinkEntry, deepLinkId]);
  // Rows the user closed by hand (gemini J2 R5 B1): a <details open>
  // prop is only re-applied on remount — and the ledger list remounts
  // whenever its length changes (key={stored.length} on the boundary)
  // — so a user-closed deep-linked row was forced back open by the
  // next ledger growth. Closed entry keys are remembered and the prop
  // stops forcing those rows open; re-opening a row clears its key.
  // Reset on id change: a fresh deep link opens its rows again.
  const [closedDeepLinkKeys, setClosedDeepLinkKeys] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setClosedDeepLinkKeys(new Set());
  }, [deepLinkId]);
  // Reset when the entry LEAVES (gemini J2 R6): the closed set and the
  // scroll-once ref were reset only on deepLinkId change, so after a
  // Clear the next entry with the same id never scrolled (stale
  // scrolledForRef) and a restored entry with a previously-closed key
  // stayed closed (stale closed set). The entry leaving is the reset
  // signal; the entry staying present (ledger growth) is not — the B1
  // test above still pins that a close survives growth.
  useEffect(() => {
    if (deepLinkEntry === undefined) {
      setClosedDeepLinkKeys(new Set());
      scrolledForRef.current = undefined;
    }
  }, [deepLinkEntry]);
  // How many ledger rows match the deep-link id (usually 1; duplicates
  // share one receipt_id — dedupe is by per-call key, never by id).
  const deepLinkMatchCount = useMemo(
    () =>
      deepLinkId === undefined
        ? 0
        : stored.filter((e) => e.receipt.receipt_id === deepLinkId).length,
    [deepLinkId, stored],
  );
  // How many of the matching rows are ACTUALLY open (gemini J2 R6 F2):
  // after round 6 made rows closable, the notice unconditionally
  // claimed all matches "are open" — false the moment the user closes
  // one. Same predicate the row itself uses (keyless rows force-open).
  const deepLinkOpenCount = useMemo(
    () =>
      deepLinkId === undefined
        ? 0
        : stored.filter((e) => {
            if (e.receipt.receipt_id !== deepLinkId) return false;
            const rowKey = typeof e.key === "string" ? e.key : null;
            return rowKey === null || !closedDeepLinkKeys.has(rowKey);
          }).length,
    [deepLinkId, stored, closedDeepLinkKeys],
  );
  function deepLinkOpenNotice(): string {
    if (deepLinkOpenCount === deepLinkMatchCount) {
      return deepLinkMatchCount === 1
        ? "the matching entry below is open."
        : `${deepLinkMatchCount} matching entries below are open.`;
    }
    if (deepLinkOpenCount === 0) {
      return deepLinkMatchCount === 1
        ? "the matching entry below is closed — click it to reopen it."
        : `all ${deepLinkMatchCount} matching entries below are closed — click one to reopen it.`;
    }
    return `${deepLinkOpenCount} of ${deepLinkMatchCount} matching entries below are open.`;
  }
  // True when the saved value was unparseable, not an array, or a
  // non-empty array with zero valid entries: the corrupt value is left
  // untouched (M6) and a backup copy is kept under BACKUP_KEY.
  const [storedCorrupt, setStoredCorrupt] = useState<boolean>(storedInit.corrupt);
  // True when browser storage itself threw on read (e.g. private mode):
  // nothing is known to be corrupt — receipts stay in memory only, and
  // the page must say "unavailable", never "corrupt" (J2 R2 M1).
  const [storedUnavailable, setStoredUnavailable] = useState<boolean>(storedInit.unavailable);
  const [values, setValues] = useState<Record<string, string>>(() => ({
    tx_hash: SAMPLE_TX_HASH,
    chain: 'ethereum',
    entity: 'AAPL',
    period: 'last 12 months',
    protocol: 'aave-v3',
    pair: 'ETH/USDC',
    node_or_zone: 'TH_NP15_GEN-APND',
    interval_start: defaultGridInterval(),
    validator_index: '1',
  }));
  // Running state is tracked PER ENDPOINT (B2): a single shared slot let a
  // finishing call re-enable another endpoint's button mid-flight. Each
  // form's button is disabled only by its own in-flight call.
  const [running, setRunning] = useState<ReadonlySet<EndpointKey | 'health'>>(new Set());
  const markRunning = useCallback((key: EndpointKey | 'health', on: boolean) => {
    setRunning((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const [results, setResults] = useState<Partial<Record<EndpointKey | 'health', TryItResult>>>({});
  // Endpoints whose last successful try-it call was dropped from the
  // ledger because the ledger was cleared while the call was in flight
  // (J2 R6 minor D): the try-it card still shows "200 OK" and the
  // receipt, so without this the user cannot tell it was not saved.
  // Cleared by the endpoint's next successful persisted run.
  const [ledgerDropped, setLedgerDropped] = useState<ReadonlySet<EndpointKey>>(new Set());
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthMs, setHealthMs] = useState<number | null>(null);

  // M6: preserve a corrupt stored value under a backup key on mount.
  useEffect(() => {
    if (!storedCorrupt) return;
    backupCorruptSessionReceipts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Two-tab sync (J2 R2 M3): when another tab writes the shared ledger,
  // re-read it here. localStorage.setItem in THIS tab does not fire the
  // event, so our own writes are unaffected. e.key === null means
  // another tab CLEARED storage (J2 R3 M2): re-read too — our stored
  // rows are gone, memory-only rows stay. The read-modify-write race
  // between two tabs appending at once remains — a rare lost write, not
  // a corrupted ledger (the store only ever holds validated entries).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== SESSION_RECEIPTS_KEY) return;
      const { entries, corrupt, unavailable } = readSessionReceipts();
      setStored(mergeLedgerDisplay(entries, memoryOnlyRef.current));
      setStoredCorrupt(corrupt);
      setStoredUnavailable(unavailable);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Single write path: appendSessionReceipt is the only writer of the
  // shared ledger (the dashboard writes through it too). Dedupe is by
  // the per-call entry key, never by receipt_id — two legitimate calls
  // can share one receipt_id and must not collapse to one row (J2 R2 B1).
  //
  // Memory-only entries are first-class rows (J2 R3 B1/B2): a refused
  // entry is displayed with a "memory only" badge, and every successful
  // append retries persisting the backlog — so a transient cause heals
  // itself — while the display is ALWAYS rebuilt as
  // merge(storage, memoryOnly), never as a bare re-read that would
  // silently drop the backlog.
  //
  // No flag gate (J2 R4 B1): the append is ALWAYS attempted, even when
  // the storedCorrupt / storedUnavailable flags say storage is broken.
  // appendSessionReceipt re-reads and re-validates storage on every
  // call, so its return value is authoritative AT CALL TIME — while the
  // flags are a render-time snapshot. A try-it in flight across a
  // Discard used to complete through the stale pre-recovery
  // addReceipt and land memory-only without ever attempting the
  // append, even though storage had healed. The Discard direction
  // needs no gate: healthy→corrupt mid-flight lands memory-only
  // because the append attempt itself fails. The Clear direction DOES
  // have a gate (J2 R5 B1 + J2 R6 cross-tab): the generation check
  // below drops entries whose call predates the latest Clear —
  // otherwise an in-flight call would resurrect its receipt into a
  // ledger the user just explicitly cleared. The flags still drive the
  // UI notices; they just never gate a write.
  // Returns false when the entry was dropped as stale (the caller
  // shows the "not added to the ledger" note, J2 R6 minor D), true
  // when the entry was attempted (persisted or memory-only).
  // Deps are []: it reads only refs and module functions,
  // so the identity is stable — an in-flight runEndpoint always calls
  // the current logic, never a stale snapshot.
  const addReceipt = useCallback(
    (entry: StoredReceipt, clearGenAtStart: number, ledgerGenAtStart: number): boolean => {
      // A Clear that landed while this call was in flight discards its
      // entry (J2 R5 B1 / J2 R6 cross-tab): the entry's call predates
      // the latest Clear, so persisting it would resurrect a receipt
      // into a ledger the user just explicitly cleared. Either
      // generation going stale drops it — the in-memory ref for a Clear
      // in this tab, the stored counter for a Clear in another tab.
      // The call's result still shows in its try-it card (setResults
      // runs before addReceipt); only the ledger write is skipped.
      // The backlog is still retried (J2 R6 minor B): it may hold
      // post-Clear memory-only entries whose own calls started after
      // the Clear and must not be stranded by this stale completion —
      if (
        clearGenAtStart !== clearGenRef.current ||
        ledgerGenAtStart !== readLedgerGeneration()
      ) {
        // Stale completion: do NOT retry the memory-only backlog into
        // storage here (P-LEDGER-XTAB loop defect). A post-Clear
        // completion of a later call still retries the backlog on its
        // success path, generation-gated by appendSessionReceipt.
        setStored(mergeLedgerDisplay(readSessionReceipts().entries, memoryOnlyRef.current));
        return false;
      }
      // Read the backlog from the ref, never from the closure snapshot
      // (J2 R3 B1 race): two try-its in flight at once share one stale
      // `memoryOnly` value, and the later setMemoryOnly overwrote the
      // earlier receipt. The ref is updated synchronously below, so a
      // concurrent call sees the entry this call just added — before
      // any re-render.
      const current = memoryOnlyRef.current;
      let nextMemory: StoredReceipt[];
      if (appendSessionReceipt(entry, ledgerGenAtStart)) {
        // Entry persisted: retry the backlog (a transient cause may
        // have healed). Permanently invalid entries stay memory-only.
        // Backlog writes are gated on the CURRENT generation so a
        // pre-Clear memory-only row cannot resurrect (P-LEDGER-XTAB).
        const genNow = readLedgerGeneration();
        nextMemory = current.filter((m) => !appendSessionReceipt(m, genNow));
      } else {
        nextMemory = [entry, ...current.filter((r) => r.key !== entry.key)].slice(
          0,
          LEDGER_CAP,
        );
      }
      memoryOnlyRef.current = nextMemory;
      setMemoryOnly(nextMemory);
      setStored(mergeLedgerDisplay(readSessionReceipts().entries, nextMemory));
      return true;
    },
    [],
  );

  const setValue = useCallback((name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const runEndpoint = useCallback(
    async (endpoint: EndpointKey) => {
      // The generation at call start (J2 R5 B1): if the user clears
      // the ledger while this call is in flight, addReceipt drops
      // the entry instead of resurrecting it into the cleared ledger.
      // Both generations are captured: the in-memory ref for a Clear
      // in this tab, the stored counter for a Clear in another tab
      // (J2 R6 cross-tab).
      const clearGenAtStart = clearGenRef.current;
      const ledgerGenAtStart = readLedgerGeneration();
      // The button is disabled while its own call is in flight; this guard
      // covers any other path that calls runEndpoint twice for one endpoint.
      if (running.has(endpoint)) return;
      markRunning(endpoint, true);
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
          // The count carries its window (filings J1 R3 M1): the
          // fallback is only reached when the live answer (which
          // carries the window) is absent, so the entity + period the
          // call actually asked for are folded in here too.
          summary = d.answer ?? `${String(d.filing_count ?? '—')} filings · ${values.entity.trim()} · ${values.period.trim()}`;
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
        } else if (endpoint === 'validator') {
          raw = await getValidator({ validator_index: values.validator_index.trim() });
          label = `validator ${values.validator_index.trim()}`;
          params = `validator_index=${values.validator_index.trim()}`;
          const d = asEnvelope(raw);
          summary = d.answer ?? `effective_balance ${String(d.effective_balance ?? '—')} gwei`;
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
        // typeof-guarded, never bare casts: api.ts does not validate the
        // types of these fields, and an unguarded non-string would poison
        // the shared ledger until the user discards it (J2 R2 B2).
        const verifyData =
          endpoint === 'tx'
            ? { tx_hash: typeof data.tx_hash === 'string' ? data.tx_hash : undefined }
            : endpoint === 'grid'
              ? {
                  node_or_zone:
                    typeof data.node_or_zone === 'string' ? data.node_or_zone : undefined,
                  interval_start:
                    typeof data.interval_start === 'string' ? data.interval_start : undefined,
                  lmp_usd_per_mwh:
                    typeof data.lmp_usd_per_mwh === 'number' ? data.lmp_usd_per_mwh : undefined,
                  market: typeof data.market === 'string' ? data.market : undefined,
                }
              : undefined;
        const added = addReceipt({
          // Per-call unique key (session counter): dedupe is by key, never
          // by receipt_id — two identical calls must both appear (J2 R2 B1).
          key: uniqueSessionReceiptKey(endpoint, data.receipt.receipt_id),
          endpoint,
          label,
          params,
          fetchedAt: data.receipt.fetched_at,
          receipt: data.receipt,
          summary,
          verifyData,
        }, clearGenAtStart, ledgerGenAtStart);
        // Dropped entries (J2 R6 minor D): the try-it card shows the
        // live result either way, so the ledger outcome is named here
        // instead of silently vanishing.
        setLedgerDropped((prev) => {
          const next = new Set(prev);
          if (added) next.delete(endpoint);
          else next.add(endpoint);
          return next;
        });
      } catch (err) {
        const latencyMs = Math.round(performance.now() - started);
        setResults((prev) => ({
          ...prev,
          [endpoint]: { endpoint, data: null, health: null, latencyMs, error: errText(err) },
        }));
      } finally {
        // Only this endpoint's own slot is cleared — a finishing call can
        // never re-enable another endpoint's button mid-flight (B2).
        markRunning(endpoint, false);
      }
    },
    [values, addReceipt, running, markRunning],
  );

  const runHealth = useCallback(async () => {
    if (running.has('health')) return;
    markRunning('health', true);
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
      markRunning('health', false);
    }
  }, [running, markRunning]);

  // "Clear session ledger": the explicit whole-ledger action — clears
  // storage (ledger + backup), the memory-only backlog, and the flags.
  // The ref is cleared synchronously with the state (J2 R3 B1 race):
  // a later concurrent append must not resurrect cleared rows from a
  // stale ref. In-flight calls are dropped by the generation check in
  // addReceipt (J2 R5 B1) — clearing the ref alone did not stop a
  // NEW entry minted after the clear from landing.
  const clearStored = useCallback(() => {
    // Bump the generations FIRST: any try-it in flight when this runs
    // has its entry dropped by addReceipt (J2 R5 B1) — the in-memory
    // ref for this tab, the stored counter for every other tab sharing
    // this ledger (J2 R6 cross-tab).
    clearGenRef.current += 1;
    bumpLedgerGeneration();
    setStored([]);
    memoryOnlyRef.current = [];
    setMemoryOnly([]);
    setStoredCorrupt(false);
    setStoredUnavailable(false);
    clearSessionReceipts();
  }, []);

  // "Discard corrupt stored data": removes ONLY the corrupt stored value
  // (and its backup). Memory-only receipts collected since the
  // corruption are legitimate, were never persisted, and have no backup
  // — deleting them would destroy the only copy (J2 R3 B1). They stay
  // displayed; the next append retries persisting them now that storage
  // is empty again. Reads the backlog from the ref (same race reason
  // as addReceipt) so a concurrent append is not lost.
  const discardCorruptStored = useCallback(() => {
    clearSessionReceipts();
    setStoredCorrupt(false);
    setStored(mergeLedgerDisplay(readSessionReceipts().entries, memoryOnlyRef.current));
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
      { name: 'entity', label: 'entity — company name, ticker, CIK, or agency', placeholder: 'AAPL' },
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
    validator: [
      { name: 'validator_index', label: 'validator_index — canonical non-negative integer as a decimal string', placeholder: '1' },
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
            Every receipt below was obtained from a live call made in this browser session —
            on this page or on the dashboard — nothing is seeded, and no totals are claimed
            beyond what this session actually fetched. Each receipt carries its upstream URL
            and SHA-256 digest, re-hashable in your browser.
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
          {/* Always rendered (disabled when empty) so the clear control is
              reachable in every state, including after a poisoned entry. */}
          <button type="button" className="vr-btn-ghost" onClick={clearStored} disabled={stored.length === 0 && !storedCorrupt}>
            Clear session ledger
          </button>
        </div>
        {storedCorrupt && (
          <div className="vr-notice" role="alert">
            <p>
              Stored receipts could not be read — the saved data is corrupt and was ignored.
              Nothing was deleted; a copy was kept under{' '}
              <span className="vr-mono">{BACKUP_KEY}</span>. The page keeps working.
            </p>
            <button type="button" className="vr-btn-ghost" onClick={discardCorruptStored}>
              Discard corrupt stored data
            </button>
          </div>
        )}
        {storedUnavailable && (
          <div className="vr-notice" role="alert">
            <p>
              Browser storage is unavailable in this context — receipts are kept in memory
              for this session only and will not survive navigation. Nothing was deleted;
              the saved data was never read, so it is not corrupt.
            </p>
          </div>
        )}
        {deepLinkId !== undefined && (
          <div className="vr-notice" role="status">
            {deepLinkEntry ? (
              <p>
                Showing receipt <span className="vr-mono">{deepLinkId}</span> from this
                browser session's ledger — {deepLinkOpenNotice()}
              </p>
            ) : (
              <p>
                No receipt <span className="vr-mono">{deepLinkId}</span> in this browser
                session's ledger. Receipts are kept per browser session — run a live call
                on the dashboard or below to collect one. The miner does serve{' '}
                <span className="vr-mono">/receipts/:id</span> (live check 2026-11-21: HTTP 200),
                but this page does not load receipts from it, so a receipt from another
                session is not shown here.
              </p>
            )}
            <Link to="/receipts" className="vr-btn-ghost">
              Show the full ledger
            </Link>
          </div>
        )}
        {stored.length === 0 ? (
          <div className="vr-empty">
            <p className="vr-empty-title">No receipts yet in this browser session.</p>
            <p className="vr-muted">
              Run any probe below, or run a live check on the dashboard — each successful
              live call adds its real receipt here with its upstream URL and SHA-256 digest.
              Nothing is shown until a call actually happens.
            </p>
          </div>
        ) : (
          // One bad row must never blank the page: the boundary contains any
          // render throw to this list and keeps Clear reachable (B1).
          // key remounts the boundary when the ledger changes, so clearing
          // after an error shows the list again instead of a stuck fallback.
          <LedgerErrorBoundary key={stored.length} onClear={clearStored}>
            <ol className="vr-ledger-list">
              {stored.slice(0, LEDGER_CAP).map((entry, i) => {
                const isDeepLink =
                  deepLinkId !== undefined && entry.receipt.receipt_id === deepLinkId;
                // The scroll target is the FIRST matching row only
                // (gemini J2 R5 A-scroll): deepLinkEntry is .find() —
                // the first match — but the ref used to attach to EVERY
                // matching row, so it ended on the last one and the
                // scroll landed on the wrong match.
                const isScrollTarget = entry === deepLinkEntry;
                // A keyless row cannot be tracked in the closed set, so
                // it keeps the old force-open behaviour; every validated
                // stored entry carries a string key.
                const rowKey = typeof entry.key === "string" ? entry.key : null;
                const deepLinkOpen =
                  isDeepLink && (rowKey === null || !closedDeepLinkKeys.has(rowKey));
                return (
                <li
                  key={typeof entry.key === 'string' ? entry.key : `row-${i}`}
                  className="vr-ledger-row"
                  ref={isScrollTarget ? deepLinkRef : undefined}
                >
                  <details
                    open={deepLinkOpen || undefined}
                    onToggle={
                      isDeepLink && rowKey !== null
                        ? (e) => {
                            const open = e.currentTarget.open;
                            setClosedDeepLinkKeys((prev) => {
                              const next = new Set(prev);
                              if (open) next.delete(rowKey);
                              else next.add(rowKey);
                              return next;
                            });
                          }
                        : undefined
                    }
                  >
                    <summary>
                      <span className="vr-badge vr-b-acc">{asText(entry.endpoint)}</span>
                      <span className="vr-ledger-label">{asText(entry.label)}</span>
                      {/* Memory-only rows say so (J2 R3 B2): a refused
                          receipt must never look persisted. It lives in
                          memory only and will not survive navigation. */}
                      {memoryOnlyKeys.has(entry.key) && (
                        <span
                          className="vr-badge vr-b-err"
                          title="This receipt could not be saved to browser storage — it lives in memory only and will not survive navigation."
                        >
                          memory only
                        </span>
                      )}
                      {isDeepLink && (
                        <span
                          className="vr-badge vr-b-acc"
                          title="Opened from the /receipts/:id deep link."
                        >
                          linked receipt
                        </span>
                      )}
                      <span className="vr-mono vr-small vr-muted">
                        {typeof entry.fetchedAt === 'string' ? fmtTime(entry.fetchedAt) : '—'}
                      </span>
                    </summary>
                    <p className="vr-answer vr-small">{asText(entry.summary)}</p>
                    <p className="vr-mono vr-small vr-muted vr-params">{asText(entry.params)}</p>
                    <ReceiptCard receipt={entry.receipt} />
                    <VerifyPanel
                      receipt={entry.receipt}
                      endpoint={entry.endpoint as EndpointKey}
                      data={entry.verifyData}
                      stored
                    />
                  </details>
                </li>
                );
              })}
            </ol>
          </LedgerErrorBoundary>
        )}
      </section>

      {/* ---- Health try-it ---- */}
      <section className="vr-card vr-health" aria-label="Health check">
        <div className="vr-kicker">// GET /health · no receipt — liveness only</div>
        <h2 className="vr-h2">Service health</h2>
        <div className="vr-tryit-actions">
          <button type="button" className="vr-btn-accent" onClick={runHealth} disabled={running.has('health')}>
            {running.has('health') ? 'Checking…' : 'Check /health →'}
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
        // try-it · six live endpoints · each call returns its real receipt
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
            running={running.has(key)}
            result={results[key] ?? null}
            ledgerDropped={ledgerDropped.has(key)}
          />
        ))}
      </div>
      <p className="vr-muted vr-small" style={{ marginTop: 18 }}>
        Miner <span className="vr-mono">774921 · verireceipt</span> · auth: none · all six
        endpoints are GET — the forms above call the live API through the same-origin{' '}
        <span className="vr-mono">/api</span> proxy. Failed calls (e.g. a future grid interval, an
        unknown protocol) return the real error — nothing is fabricated.
      </p>
    </div>
  );
}

const PAGE_CSS = `
.vr-page{max-width:1340px;margin:0 auto;padding:28px 24px 64px;color:var(--text,#F3F2EE);font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;line-height:1.55;overflow-wrap:anywhere}
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
.vr-notice{border:1px solid rgba(245,158,11,.36);background:var(--warn-soft,rgba(245,158,11,.15));color:var(--warn,#F59E0B);border-radius:10px;padding:12px 14px;margin-bottom:12px;font-size:13px}
.vr-notice p{margin:0 0 10px}
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
