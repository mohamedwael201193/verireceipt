// /docs — API documentation rendered from the miner.yaml contracts.
//
// STATIC TEXT FROM miner.yaml ONLY. Every endpoint, parameter, type, and
// error code below comes from miner.yaml + the handler source
// (src/core/errors.ts, src/handlers/*). Every example is a REAL callable
// request against the live base URL, and each one links to its live try-it
// form on /receipts. No invented endpoints: only the routes the server
// actually serves (GET /health + six GET /v1/* + the /receipts/:id routes)
// are listed — the miner has no MCP route in this build, so none is
// documented (r8: live 404 on GET and POST, 2026-11-21).
//
// Registration snippet uses the real repo and the real commit SHA:
// github.com/mohamedwael201193/verireceipt @
// 4f471e48296d7225a482ef70025352e954b9cf5d (A8 accepted_fields map-form commit on origin/main; this tree's miner.yaml,
// registered on Sepolia as registrationId 6152).

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { REGISTRATION_CAST_SNIPPET } from './dashboard/docs';
import { MINER_BOND_SOURCE, MINER_BOND_USD_TEXT } from '../lib/minerBond';

const API_BASE_URL = 'https://verireceipt.onrender.com';
const REPO_URL = 'https://github.com/mohamedwael201193/verireceipt';
const MINER_YAML_COMMIT = '4f471e48296d7225a482ef70025352e954b9cf5d';
const MINER_YAML_URL = `https://raw.githubusercontent.com/mohamedwael201193/verireceipt/${MINER_YAML_COMMIT}/miner.yaml`;

interface EndpointDoc {
  key: string;
  method: string;
  path: string;
  intent: string;
  description: string;
  params: { name: string; type: string; description: string }[];
  outputs: { name: string; unit?: string }[];
  exampleLabel: string;
  exampleUrl: string;
  exampleCurl: string;
}

const ENDPOINTS: EndpointDoc[] = [
  {
    key: 'tx',
    method: 'GET',
    path: '/v1/tx',
    intent: 'ONCHAIN_TX_LOOKUP_GENERAL',
    description:
      'Looks up one EVM transaction by hash on a named chain with a 2-of-N archive-RPC quorum and returns tx_hash, status (confirmed, reverted, pending, not_found), from, to, block_number, value_eth and a SHA-256 receipt.',
    params: [
      {
        name: 'tx_hash',
        type: 'string',
        description: 'Complete 0x-prefixed 64-hex-character transaction hash.',
      },
      {
        name: 'chain',
        type: 'string',
        description: 'EVM chain name, lower case: ethereum, base, arbitrum, optimism, polygon, sepolia or base-sepolia. Ethereum mainnet may also be written eth or mainnet.',
      },
    ],
    outputs: [
      { name: 'tx_hash' },
      { name: 'status' },
      { name: 'from' },
      { name: 'to' },
      { name: 'block_number', unit: 'block height' },
      { name: 'value_eth', unit: 'whole native units' },
    ],
    exampleLabel: 'Confirmed Ethereum transaction, block 26454869 (live 2026-11-20)',
    exampleUrl: `${API_BASE_URL}/v1/tx?tx_hash=0xafdbc83c485355d90f79fd660bcd12713402aa78922d966657d1005f59e92902&chain=ethereum`,
    exampleCurl: `curl "${API_BASE_URL}/v1/tx?tx_hash=0xafdbc83c485355d90f79fd660bcd12713402aa78922d966657d1005f59e92902&chain=ethereum"`,
  },
  {
    key: 'filings',
    method: 'GET',
    path: '/v1/filings',
    intent: 'REGULATORY_FILING_MONITOR_GENERAL',
    description:
      'Counts a company\'s filings on SEC EDGAR (data.sec.gov submissions, by filing date) in a period, optionally of one exact EDGAR form type, and returns entity, form_type, filing_count, the filing titles newest first, their URLs and a SHA-256 receipt. SEC EDGAR only: an unknown or ambiguous company or form is refused (422), never answered from another source or with an unfiltered count.',
    params: [
      {
        name: 'entity',
        type: 'string',
        description: 'The subject of the question verbatim, including any SEC form type and CIK, e.g. "Form 10-Q filings by Tesla, Inc. (CIK 1318605)", "Tesla, Inc.", "TSLA", "1318605".',
      },
      {
        name: 'period',
        type: 'string',
        description: 'Search period such as last 12 months, 2026, calendar 2023, or YYYY-MM-DD..YYYY-MM-DD. Calendar years only; fiscal-year periods are rejected.',
      },
      {
        name: 'form_type (optional)',
        type: 'string',
        description: 'One SEC EDGAR form type exactly as asked, e.g. 10-K, 10-Q, 8-K, 144/A, 4/A. Exact match (10-K counts originals only; 10-K/A counts amendments only). Omit to count all forms.',
      },
    ],
    outputs: [
      { name: 'entity' },
      { name: 'filing_count', unit: 'filings' },
      { name: 'filings' },
      { name: 'urls' },
    ],
    exampleLabel: 'AAPL filings, last 12 months (live 2026-11-20)',
    exampleUrl: `${API_BASE_URL}/v1/filings?entity=AAPL&period=last%2012%20months`,
    exampleCurl: `curl "${API_BASE_URL}/v1/filings?entity=AAPL&period=last%2012%20months"`,
  },
  {
    key: 'tvl',
    method: 'GET',
    path: '/v1/tvl',
    intent: 'TVL_LOOKUP_GENERAL',
    description:
      'Returns the current total value locked of a DeFi protocol or chain from DeFiLlama\'s keyless API: protocol_or_chain, tvl_usd, chain_tvl_usd, as_of and a SHA-256 receipt.',
    params: [
      {
        name: 'protocol',
        type: 'string',
        description: 'DeFi protocol name or DeFiLlama slug, keeping the version when one is named (Aave V3 or aave-v3, Uniswap V3 or uniswap-v3, Lido), or a chain name (ethereum). At most 512 characters.',
      },
    ],
    outputs: [
      { name: 'protocol_or_chain' },
      { name: 'tvl_usd', unit: 'USD' },
      { name: 'chain_tvl_usd', unit: 'USD' },
      { name: 'as_of' },
    ],
    exampleLabel: 'Aave V3 TVL (live 2026-11-20)',
    exampleUrl: `${API_BASE_URL}/v1/tvl?protocol=aave-v3`,
    exampleCurl: `curl "${API_BASE_URL}/v1/tvl?protocol=aave-v3"`,
  },
  {
    key: 'route',
    method: 'GET',
    path: '/v1/route',
    intent: 'OPTIMAL_EXECUTION_ROUTE_GENERAL',
    description:
      'Returns a block-pinned Ethereum mainnet execution quote for selling exactly 1 ETH for USDC, the best quote across Uniswap V2/V3, SushiSwap V2, as amount_out in USDC base units (6 decimals) with a SHA-256 receipt.',
    params: [
      {
        name: 'pair',
        type: 'string',
        description: 'The swap to route. Only ETH/USDC (sell exactly 1 ETH for USDC on Ethereum mainnet).',
      },
    ],
    outputs: [{ name: 'amount_out', unit: 'USDC base units (6 decimals)' }],
    exampleLabel: 'Sell exactly 1 ETH for USDC, block-pinned (live 2026-11-20)',
    exampleUrl: `${API_BASE_URL}/v1/route?pair=ETH%2FUSDC`,
    exampleCurl: `curl "${API_BASE_URL}/v1/route?pair=ETH%2FUSDC"`,
  },
  {
    key: 'grid-price',
    method: 'GET',
    path: '/v1/grid-price',
    intent: 'GRID_POWER_PRICE_GENERAL',
    description:
      'Returns the wholesale electricity price lmp_usd_per_mwh for one pricing node or zone and one finished settlement interval, from official public feeds: CAISO OASIS day-ahead hourly LMP, NYISO real-time 5-minute zonal LBMP, and the Elering dashboard API 15-minute prices (EUR/MWh converted to USD with the open.er-api.com EUR rate). Returns node_or_zone, market, interval_start, currency and a SHA-256 receipt. Any other node or zone is refused (422).',
    params: [
      {
        name: 'node_or_zone',
        type: 'string',
        description: 'Exactly one of: CAISO hubs TH_NP15_GEN-APND, TH_SP15_GEN-APND, TH_ZP26_GEN-APND, or CAISO when no CAISO node is named (median of the three hubs); NYISO zones ZONE_A to ZONE_K (NYISO names such as N.Y.C. also accepted); Elering zones EE, FI, LV, LT.',
      },
      {
        name: 'interval_start',
        type: 'string',
        description: 'Start of the settlement interval, ISO-8601 UTC, e.g. 2026-09-13T14:00:00Z.',
      },
    ],
    outputs: [
      { name: 'lmp_usd_per_mwh', unit: 'USD per MWh' },
      { name: 'node_or_zone' },
      { name: 'market' },
      { name: 'interval_start' },
      { name: 'currency' },
    ],
    exampleLabel: 'CAISO TH_NP15_GEN-APND, 2026-11-20T06:00:00Z (live 2026-11-20)',
    exampleUrl: `${API_BASE_URL}/v1/grid-price?node_or_zone=TH_NP15_GEN-APND&interval_start=2026-11-20T06%3A00%3A00Z`,
    exampleCurl: `curl "${API_BASE_URL}/v1/grid-price?node_or_zone=TH_NP15_GEN-APND&interval_start=2026-11-20T06%3A00%3A00Z"`,
  },
  {
    key: 'validator',
    method: 'GET',
    path: '/v1/validator',
    intent: 'VALIDATOR_PERFORMANCE_VERIFY_GENERAL',
    description:
      'Returns the effective balance in gwei of one Ethereum beacon-chain validator at the finalized state, read from four independently operated public beacon APIs (2-of-4 quorum): answered only when at least two sources agree on effective_balance and status; fewer than two agreeing sources, or any source that disagrees, fails closed (502, no answer). Returns validator_index, effective_balance, status and a SHA-256 receipt. Use for questions such as "What is the effective balance of Ethereum validator index 1, in gwei?".',
    params: [
      {
        name: 'validator_index',
        type: 'string',
        description: 'Ethereum beacon-chain validator index as a canonical decimal digit string (0, or a non-negative integer with no sign and no leading zeros), e.g. 1, at most 1000000000 (the official intent max).',
      },
    ],
    outputs: [{ name: 'effective_balance', unit: 'gwei' }],
    exampleLabel: 'Validator index 1 (served by builds that include /v1/validator)',
    exampleUrl: `${API_BASE_URL}/v1/validator?validator_index=1`,
    exampleCurl: `curl "${API_BASE_URL}/v1/validator?validator_index=1"`,
  },
];

const ERROR_ROWS: { status: number; code: string; meaning: string }[] = [
  { status: 400, code: 'MISSING_PARAM', meaning: 'tx_hash and chain are required query parameters.' },
  { status: 400, code: 'INVALID_TX_HASH', meaning: 'tx_hash is not a well-formed 0x-prefixed 64-hex hash.' },
  { status: 400, code: 'UNSUPPORTED_CHAIN', meaning: 'chain is not one of ethereum, base, arbitrum, optimism, polygon, sepolia, base-sepolia.' },
  { status: 400, code: 'MISSING_ENTITY', meaning: 'Query parameter "entity" is required.' },
  { status: 400, code: 'MISSING_PERIOD', meaning: 'Query parameter "period" is required.' },
  { status: 400, code: 'MAX_PARAM_SIZE', meaning: 'Query parameter "entity" or "protocol" must not exceed 512 characters (miner.yaml MAX_PARAM_SIZE, machine-enforced).' },
  { status: 400, code: 'INVALID_PERIOD', meaning: 'Unparseable period value.' },
  { status: 400, code: 'MISSING_PROTOCOL', meaning: 'Query parameter "protocol" is required.' },
  { status: 400, code: 'UNKNOWN_PARAM', meaning: 'A query parameter is not declared for that endpoint (for example index= on /v1/validator).' },
  { status: 400, code: 'INVALID_NODE', meaning: 'node_or_zone is required.' },
  { status: 400, code: 'INVALID_INTERVAL', meaning: 'interval_start is required or is not a valid datetime.' },
  { status: 400, code: 'INVALID_VALIDATOR_INDEX', meaning: 'validator_index is required and must be a canonical non-negative decimal digit string (no sign, no leading zeros except 0 itself).' },
  { status: 400, code: 'MAX_PARAM_VALUE', meaning: 'validator_index is greater than 1000000000, the official intent maximum (miner.yaml MAX_PARAM_VALUE, machine-enforced).' },
  { status: 422, code: 'INVALID_PAIR', meaning: 'pair must be ETH/USDC.' },
  { status: 422, code: 'VALIDATOR_NOT_FOUND', meaning: 'At least two beacon sources return 404 and none returns the validator.' },
  { status: 422, code: 'ENTITY_NOT_FOUND', meaning: 'No SEC EDGAR filer matches the query (there is no Federal Register fallback).' },
  { status: 422, code: 'UNKNOWN_FORM', meaning: 'The form type is not one SEC EDGAR has ever recorded (closed vocabulary from the EDGAR full index).' },
  { status: 422, code: 'AMBIGUOUS_ENTITY', meaning: 'The entity matches more than one candidate; refine it.' },
  { status: 422, code: 'PROTOCOL_NOT_FOUND', meaning: 'Protocol slug not found in DeFiLlama; never fabricates $0.' },
  { status: 422, code: 'UNSUPPORTED_ZONE', meaning: 'node_or_zone is not a supported pricing node/zone.' },
  { status: 422, code: 'FUTURE_INTERVAL', meaning: 'Settlement interval has not finished yet. Includes retry_after_sec.' },
  { status: 422, code: 'OFF_BOUNDARY_INTERVAL', meaning: 'interval_start is not on a settlement boundary.' },
  { status: 502, code: 'GRID_CACHE_MISS', meaning: 'No cached price for that node at that interval.' },
  { status: 502, code: 'GRID_CACHE_STALE', meaning: 'Cached price is older than the staleness bound; never served as verified.' },
  { status: 502, code: 'SEC_UNAVAILABLE', meaning: 'SEC EDGAR upstream unreachable.' },
  { status: 502, code: 'SEC_USER_AGENT_MISSING', meaning: 'SEC_USER_AGENT is not set on the server, so SEC EDGAR cannot be called.' },
  { status: 504, code: 'SEC_TIMEOUT', meaning: 'SEC EDGAR did not answer in time; fails closed.' },
  { status: 502, code: 'SEC_DOCUMENT_TOO_LARGE', meaning: 'An SEC EDGAR submissions document or history page exceeds the 8,000,000-character cap; fails closed.' },
  { status: 500, code: 'RECEIPT_STORE_FAILED', meaning: 'The receipt could not be stored, so no verified answer (with a dead audit link) is served.' },
  { status: 502, code: 'DEFILLAMA_UNAVAILABLE', meaning: 'DeFiLlama upstream unreachable.' },
  { status: 502, code: 'DEFILLAMA_BAD_RESPONSE', meaning: 'DeFiLlama response has no usable TVL data.' },
  { status: 502, code: 'RPC_CONFIG', meaning: 'Archive-RPC configuration unavailable.' },
  { status: 502, code: 'ALL_QUOTERS_FAILED', meaning: 'All DEX quoters failed for the pinned block.' },
  { status: 502, code: 'QUORUM_UNREACHABLE', meaning: 'Fewer than 2 sources answered in agreement (tx: archive RPCs; validator: beacon APIs); fails closed, no answer.' },
  { status: 502, code: 'QUORUM_CONFLICT', meaning: 'Validator: a third beacon source answered differently from the agreeing pair; a 2-vs-1 split is not certified.' },
  { status: 502, code: 'INTERNAL', meaning: 'Fallback for any other failure; never leaks a stack trace.' },
];

const MINER_YAML_SNIPPET = `id: 774921
slug: verireceipt
name: VeriReceipt Deterministic Oracle
base_url: ${API_BASE_URL}
auth:
  type: none
cache_ttl_sec: 10
rate_limit_per_sec: 20
circuit_threshold: 5
circuit_cooldown_seconds: 30`;

const CAST_SNIPPET = REGISTRATION_CAST_SNIPPET;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the text stays visible in the code box.
      setCopied(false);
    }
  };
  return (
    <button type="button" className="vr-btn-ghost" onClick={copy} aria-label={label}>
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  );
}

export default function Docs() {
  const [tab, setTab] = useState<'curl' | 'yaml' | 'cast'>('curl');

  return (
    <div className="vr-page vr-docs">
      <style>{PAGE_CSS}</style>
      <header className="vr-head">
        <div>
          <div className="vr-kicker">// infrastructure telemetry &amp; developer quickstart</div>
          <h1 className="vr-h1">
            Status &amp; <span className="serif-i">30-Second Docs.</span>
          </h1>
          <p className="vr-lede">
            The VeriReceipt API, as registered in miner.yaml. Every example below is a real
            callable request against the live base URL — each links to its live try-it form on
            /receipts.
          </p>
        </div>
        <div className="vr-head-side">
          <span className="vr-badge vr-b-dim">auth: none · Bond {MINER_BOND_USD_TEXT} Test USDC</span>
          <span className="vr-badge vr-b-dim">miner 774921 · verireceipt</span>
        </div>
      </header>

      {/* ---- Quick facts ---- */}
      <section className="vr-card" aria-label="Quick facts">
        <div className="vr-kicker">// quick facts · from miner.yaml</div>
        <dl className="vr-kv">
          <dt>base URL</dt>
          <dd className="vr-mono">{API_BASE_URL}</dd>
          <dt>miner id / slug</dt>
          <dd className="vr-mono">774921 · verireceipt</dd>
          <dt>repository</dt>
          <dd className="vr-mono">
            <a className="vr-link" href={REPO_URL} target="_blank" rel="noreferrer">
              {REPO_URL}
            </a>
          </dd>
          <dt>auth</dt>
          <dd>none — all endpoints are keyless GETs</dd>
          <dt>rate limit (node-side)</dt>
          <dd className="vr-mono">20 req/s · cache TTL 10 s</dd>
          <dt>circuit breaker (node-side)</dt>
          <dd>
            <span className="vr-mono">threshold 5 · cooldown 30 s</span> — declared in miner.yaml and
            applied by the Telegraph node to calls into this miner; the miner process runs no breaker
          </dd>
          <dt>bond (on-chain)</dt>
          <dd>{MINER_BOND_USD_TEXT} Test USDC — {MINER_BOND_SOURCE}. Re-read live on the Status page.</dd>
          <dt>Sepolia registration</dt>
          <dd>
            registrationId 6152 (updateMiner of 6150) · tx{" "}
            <a href="https://sepolia.etherscan.io/tx/0x775fcc05adca9be05188554e0487b46e09f207bc5ea1de89a2fd86e2b79f07cb" target="_blank" rel="noopener noreferrer">
              0x775fcc05adca9be05188554e0487b46e09f207bc5ea1de89a2fd86e2b79f07cb
            </a>
            {" "}· yamlHash 0x1653f3c00f8ee983bc2d2b36579c665c94ce2215ab1bb0d526564a9aec183e9f
            (pin 4f471e48). Node activation is read live on the Status page and is not claimed here.
          </dd>
        </dl>
      </section>

      {/* ---- Receipt envelope ---- */}
      <section className="vr-card" aria-label="Receipt envelope">
        <div className="vr-kicker">// every success response carries this receipt block</div>
        <h2 className="vr-h2">The receipt envelope</h2>
        <p className="vr-muted">
          Every answer also carries <span className="vr-mono">answer</span> (one plain sentence),{' '}
          <span className="vr-mono">verdict</span>, <span className="vr-mono">confidence</span>,{' '}
          <span className="vr-mono">source</span>, and <span className="vr-mono">checked_at</span>.
          The receipt binds the answer to the raw upstream bytes:
        </p>
        <div className="vr-tbl-wrap">
          <table className="vr-tbl">
            <thead>
              <tr>
                <th>Field</th>
                <th>Type</th>
                <th>Meaning</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="vr-mono">receipt_id</td><td className="vr-mono">string</td><td>Unique receipt id, e.g. <span className="vr-mono">rcpt_…</span> (26 chars).</td></tr>
              <tr><td className="vr-mono">intent</td><td className="vr-mono">string</td><td>The Telegraph intent this answer serves.</td></tr>
              <tr><td className="vr-mono">upstream_url</td><td className="vr-mono">string</td><td>The exact upstream URL the answer was derived from.</td></tr>
              <tr><td className="vr-mono">raw_response_sha256</td><td className="vr-mono">string</td><td>SHA-256 (<span className="vr-mono">0x</span> + 64 hex) of the raw upstream response bytes.</td></tr>
              <tr><td className="vr-mono">quorum_votes</td><td className="vr-mono">string</td><td>e.g. <span className="vr-mono">3/3 sources agreed</span> (tx), <span className="vr-mono">1/1 primary source</span> (TVL).</td></tr>
              <tr><td className="vr-mono">fetched_at</td><td className="vr-mono">string</td><td>ISO-8601 UTC time the upstream was fetched.</td></tr>
              <tr><td className="vr-mono">audit_url</td><td className="vr-mono">string</td><td>Audit URL. <span className="vr-mono">GET /receipts/:id</span> returns the stored receipt and <span className="vr-mono">/receipts/:id/raw</span> the exact evidence bytes hashed into raw_response_sha256 (live check 2026-11-21: HTTP 200).</td></tr>
            </tbody>
          </table>
        </div>
        <p className="vr-muted vr-small" style={{ overflowWrap: 'anywhere' }}>
          To verify, recompute the hash the miner actually hashed. The browser verifier
          (one verifier for the whole site, /receipts page + dashboard inspector + landing
          badge) fetches the stored raw bytes first —{' '}
          <span className="vr-mono">GET /api/receipts/:id/raw</span> (served; live check
          2026-11-21: HTTP 200 for all six intents) — and hashes them against the recorded
          digest. Only if that fetch fails does it fall back to a live re-check whose method
          differs per endpoint: tx replays the exact JSON-RPC{' '}
          <span className="vr-mono">eth_getTransactionReceipt</span> call against the
          receipt’s upstream RPC URL; filings and TVL re-fetch the upstream URL and hash the
          exact bytes (filings reproduces the hash byte-for-byte; TVL can legitimately
          mismatch because the upstream serves different bytes per edge); grid re-hashes the
          canonical evidence JSON{' '}
          <span className="vr-mono">{'{"node_or_zone","interval_start","lmp_usd_per_mwh","market"}'}</span>{' '}
          built from the answer fields; route has no live re-check because its evidence
          includes quoter request/response data the answer does not carry, so route is
          verified through /raw only. Only a match counts as verified, and the UI names the
          method it used.
        </p>
      </section>

      {/* ---- Endpoints ---- */}
      <div className="vr-kicker" style={{ marginTop: 8 }}>
        // endpoints · six intents + liveness
      </div>
      <section className="vr-card" aria-label="Health endpoint">
        <div className="vr-kicker">// liveness · no receipt block</div>
        <h2 className="vr-h2">
          <span className="vr-mono">GET /health</span>
        </h2>
        <p className="vr-muted" style={{ overflowWrap: 'anywhere' }}>
          Returns <span className="vr-mono">{'{"status":"ok","service":"verireceipt","uptime_s":N,"upstreams":{}}'}</span>.
          Uptime counts seconds since the last service restart.
        </p>
        <div className="vr-code">
          <pre>{`curl "${API_BASE_URL}/health"`}</pre>
        </div>
      </section>

      {ENDPOINTS.map((ep) => (
        <section key={ep.key} className="vr-card" aria-label={`${ep.method} ${ep.path}`}>
          <div className="vr-kicker">// {ep.intent}</div>
          <h2 className="vr-h2">
            <span className="vr-mono">
              {ep.method} {ep.path}
            </span>
          </h2>
          <p className="vr-muted">{ep.description}</p>
          <div className="vr-kicker" style={{ marginTop: 14 }}>
            // required query parameters
          </div>
          <div className="vr-tbl-wrap">
            <table className="vr-tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {ep.params.map((p) => (
                  <tr key={p.name}>
                    <td className="vr-mono">{p.name}</td>
                    <td className="vr-mono">{p.type}</td>
                    <td>{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="vr-kicker" style={{ marginTop: 14 }}>
            // response fields (plus answer, verdict, confidence, source, checked_at, receipt)
          </div>
          <p>
            {ep.outputs.map((o) => (
              <span key={o.name} className="vr-badge vr-b-dim" style={{ margin: '0 6px 6px 0' }}>
                {o.name}
                {o.unit ? ` · ${o.unit}` : ''}
              </span>
            ))}
          </p>
          <div className="vr-kicker" style={{ marginTop: 14 }}>
            // live example — {ep.exampleLabel}
          </div>
          <div className="vr-code">
            <pre>{ep.exampleCurl}</pre>
          </div>
          <div className="vr-doc-actions">
            <a className="vr-btn-ghost vr-link-btn" href={ep.exampleUrl} target="_blank" rel="noreferrer">
              Open live response ↗
            </a>
            <Link className="vr-btn-accent vr-link-btn" to="/receipts">
              Try it live on /receipts →
            </Link>
            <CopyButton text={ep.exampleCurl} label={`Copy ${ep.path} example curl`} />
          </div>
        </section>
      ))}

      {/* ---- Errors ---- */}
      <section className="vr-card" aria-label="Error codes">
        <div className="vr-kicker">// fail-closed · never a guessed value</div>
        <h2 className="vr-h2">Error codes</h2>
        <p className="vr-muted">
          Errors are JSON: <span className="vr-mono">{'{"error": "snake_case", "code": "CODE", "message": "…"}'}</span>
          , plus <span className="vr-mono">retry_after_sec</span> where it applies (FUTURE_INTERVAL).
          The miner fails closed — a bad input or a dead upstream is an error, never an invented
          answer.
        </p>
        <div className="vr-tbl-wrap">
          <table className="vr-tbl">
            <thead>
              <tr>
                <th>HTTP</th>
                <th>Code</th>
                <th>Meaning</th>
              </tr>
            </thead>
            <tbody>
              {ERROR_ROWS.map((row) => (
                <tr key={row.code}>
                  <td className="vr-mono">{row.status}</td>
                  <td className="vr-mono">{row.code}</td>
                  <td>{row.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- Snippets ---- */}
      <section className="vr-card" aria-label="Integration snippets">
        <div className="vr-kicker">// integration · copy-paste, values verified</div>
        <h2 className="vr-h2">Snippets</h2>
        <div className="vr-tabs" role="tablist" aria-label="Snippet tabs">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'curl'}
            className={`vr-tab ${tab === 'curl' ? 'active' : ''}`}
            onClick={() => setTab('curl')}
          >
            curl
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'yaml'}
            className={`vr-tab ${tab === 'yaml' ? 'active' : ''}`}
            onClick={() => setTab('yaml')}
          >
            miner.yaml
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'cast'}
            className={`vr-tab ${tab === 'cast' ? 'active' : ''}`}
            onClick={() => setTab('cast')}
          >
            Registration (cast)
          </button>
        </div>
        {tab === 'curl' && (
          <div>
            <div className="vr-code">
              <pre>{`BASE=${API_BASE_URL}

# 1. Transaction lookup
curl "$BASE/v1/tx?tx_hash=0xafdbc83c485355d90f79fd660bcd12713402aa78922d966657d1005f59e92902&chain=ethereum"

# 2. Filings for an entity over a period
curl "$BASE/v1/filings?entity=AAPL&period=last%2012%20months"

# 3. TVL for a protocol
curl "$BASE/v1/tvl?protocol=aave-v3"

# 4. Execution quote: sell exactly 1 ETH for USDC
curl "$BASE/v1/route?pair=ETH%2FUSDC"

# 5. Grid price for a node and interval (CAISO example; use a recent past interval)
curl "$BASE/v1/grid-price?node_or_zone=TH_NP15_GEN-APND&interval_start=2026-11-20T06%3A00%3A00Z"`}</pre>
            </div>
            <div className="vr-doc-actions">
              <Link className="vr-btn-accent vr-link-btn" to="/receipts">
                Try them live on /receipts →
              </Link>
            </div>
          </div>
        )}
        {tab === 'yaml' && (
          <div>
            <div className="vr-code">
              <pre>{MINER_YAML_SNIPPET}</pre>
            </div>
            <p className="vr-muted vr-small" style={{ marginTop: 10 }}>
              Full file: <span className="vr-mono">{MINER_YAML_URL}</span> (pinned to commit{' '}
              <span className="vr-mono">{MINER_YAML_COMMIT.slice(0, 7)}</span>). Miner id{' '}
              <span className="vr-mono">774921</span>, slug{' '}
              <span className="vr-mono">verireceipt</span> — the values in the design drafts (
              <span className="vr-mono">89412 / verireceipt-oracle</span>) were wrong and are not
              used anywhere here.
            </p>
          </div>
        )}
        {tab === 'cast' && (
          <div>
            <div className="vr-code">
              <pre>{CAST_SNIPPET}</pre>
            </div>
            <p className="vr-muted vr-small" style={{ marginTop: 10 }}>
              Template: only <span className="vr-mono">$PRIVATE_KEY</span> is yours to fill
              (testnet key). Signatures follow the official Telegraph miner-registration
              guide; the bond is read live with{' '}
              <span className="vr-mono">quoteMinerBond</span> and approved in Sepolia Test USDC.{' '}The repo and commit SHA above are real.
            </p>
          </div>
        )}
      </section>

      <p className="vr-muted vr-small">
        Only the routes on this page are served by this build. The design drafts also named an
        MCP route and POST /v1/* paths — none of those exist in the server, so they are not
        documented here.
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
.vr-lede{font-size:14.5px;color:var(--muted,#8F8E8A);max-width:640px;line-height:1.6;margin:0}
.vr-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:22px}
.vr-head-side{display:flex;gap:8px;flex-wrap:wrap}
.vr-card{background:var(--surface,#121214);border:1px solid var(--border,rgba(255,255,255,.10));border-radius:12px;padding:20px;margin-bottom:18px}
.vr-mono{font-family:'JetBrains Mono',ui-monospace,monospace}
.vr-small{font-size:12px}
.vr-muted{color:var(--muted,#8F8E8A)}
.vr-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:10.5px;font-weight:500;white-space:nowrap}
.vr-b-dim{background:var(--panel,#151518);color:var(--muted,#8F8E8A);border:1px solid var(--border-strong,var(--border-hi,rgba(255,255,255,.22)))}
.vr-btn-accent{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 20px;border-radius:999px;background:var(--accent,#FF5722);color:#fff;font-size:13.5px;font-weight:500;border:0;cursor:pointer;text-decoration:none}
.vr-btn-accent:hover:not(:disabled){background:var(--accent-hover,#FF6E40)}
.vr-btn-ghost{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border-radius:999px;border:1px solid var(--border-strong,var(--border-hi,rgba(255,255,255,.22)));background:transparent;font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--text,#F3F2EE);cursor:pointer;text-decoration:none}
.vr-link-btn{text-decoration:none}
.vr-link{color:var(--accent,#FF5722)}
.vr-code{border-radius:10px;border:1px solid var(--border,rgba(255,255,255,.10));background:var(--code-bg,#0D0D0F);color:#F2F1EC;overflow:hidden}
.vr-code pre{padding:16px 18px;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.66;overflow-x:auto;margin:0;color:#F2F1EC;white-space:pre-wrap;word-break:break-word}
.vr-tbl-wrap{overflow-x:auto}
.vr-tbl{width:100%;border-collapse:collapse;font-size:12.5px;text-align:left}
.vr-tbl th{font-family:'JetBrains Mono',monospace;font-size:10.5px;font-weight:500;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#8F8E8A);padding:10px 14px;border-bottom:1px solid var(--border,rgba(255,255,255,.10))}
.vr-tbl td{padding:11px 14px;border-bottom:1px solid var(--border,rgba(255,255,255,.10));vertical-align:top}
.vr-tbl tr:last-child td{border-bottom:0}
.vr-kv{display:grid;grid-template-columns:150px 1fr;gap:6px 12px;margin:12px 0;font-size:13px}
.vr-kv dt{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted,#8F8E8A)}
.vr-kv dd{margin:0;word-break:break-word}
.vr-doc-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
.vr-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
.vr-tab{padding:6px 12px;border-radius:999px;border:1px solid var(--border,rgba(255,255,255,.10));background:transparent;font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--muted,#8F8E8A);cursor:pointer}
.vr-tab.active{color:var(--text,#F3F2EE);border-color:var(--accent,#FF5722);background:var(--accent-soft,rgba(255,87,34,.14))}
@media (max-width:640px){.vr-page{padding:20px 14px 48px}.vr-card{padding:16px}}
`;
