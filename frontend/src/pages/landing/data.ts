// Static copy + live presets for the VeriReceipt landing page.
//
// Everything in this file is either fixed marketing copy (DESIGN-SPEC §6
// L-25: hero sub, guarantees intro, manifesto, plate descriptions) or a
// *request preset* (the inputs sent to the live API). No response value
// lives here: every number the page shows comes from a live API call.
//
// Corrections applied vs the design file (DESIGN-SPEC §8, parent decisions):
// - Grid endpoint is GET /v1/grid-price (the design's /v1/grid-power and
//   /v1/grid-power-price are both wrong).
// - Grid copy drops ERCOT and MISO (de-advertised in miner e35fb0a;
//   ERCOT has no keyless feed). Supported grid markets: CAISO, NYISO,
//   Elering (EE, FI, LV, LT).
// - Miner identity: id 774921, slug verireceipt (see ../config).
// - Bond is $1.50 Test USDC (on-chain minerBond(6160) = quoteMinerBond(6),
//   lib/minerBond.ts). No sponsored-balance figure.
// - M12 curtailment numbers (ERCOT $118.40 vs $65) were fabricated and
//   are NOT reproduced: the desk grid items show live LMP with no
//   threshold verdict.
// - AAPL filing count is never hardcoded here — the live call decides.
// - No fabricated signal hashes, latencies, costs, or receipt ids.

import { MINER_BOND_USD_TEXT } from "../../lib/minerBond";

export type IntentKey = "tx" | "sec" | "tvl" | "route" | "grid" | "validator";

export interface IntentMeta {
  key: IntentKey;
  file: string;
  ext: string;
  name: string;
  sub: string;
  desc: string;
  kind: string;
  upstreams: string;
  schema: string;
  /** Display URL shown in the IDE app-window chrome (live contract path). */
  url: string;
}

export const INTENTS: IntentMeta[] = [
  {
    key: "tx",
    file: "tx-lookup",
    ext: ".ts",
    name: "ONCHAIN_TX_LOOKUP_GENERAL",
    sub: "# ONCHAIN_TX_LOOKUP_GENERAL · 2-of-N Archive Quorum",
    desc: "Queries archive RPCs (2-of-3 on Ethereum, Base, Arbitrum, Optimism and Sepolia; 2-of-2 on Polygon and Base Sepolia) with block-pinned confirmation depth and OP-Stack L1 data-fee accounting; a split vote fails closed.",
    kind: "deterministic",
    upstreams: "Archive RPC quorum · 2-of-3 (2-of-2 on Polygon, Base Sepolia)",
    schema: "tx_hash, status, block_number, value_eth",
    url: "GET /v1/tx · ethereum mainnet",
  },
  {
    key: "sec",
    file: "sec-filing",
    ext: ".ts",
    name: "REGULATORY_FILING_MONITOR_GENERAL",
    sub: "# REGULATORY_FILING_MONITOR_GENERAL · Official EDGAR",
    desc: "Resolves tickers to 10-digit CIKs in RAM, streams official submissions JSON with compliant User-Agent, and hashes the raw response.",
    kind: "deterministic",
    upstreams: "data.sec.gov",
    schema: "entity, filing_count, filings[] (titles), urls[]",
    url: "GET /v1/filings · data.sec.gov",
  },
  {
    key: "tvl",
    file: "tvl-oracle",
    ext: ".ts",
    name: "TVL_LOOKUP_GENERAL",
    sub: "# TVL_LOOKUP_GENERAL · DeFiLlama",
    desc: "Normalizes protocol slugs, extracts total and per-chain USD liquidity from DeFiLlama, and seals raw bytes.",
    kind: "deterministic",
    upstreams: "api.llama.fi",
    schema: "protocol_or_chain, tvl_usd, chain_tvl_usd, as_of",
    url: "GET /v1/tvl · api.llama.fi/protocol/aave-v3",
  },
  {
    key: "route",
    file: "eth-route",
    ext: ".ts",
    name: "OPTIMAL_EXECUTION_ROUTE_GENERAL",
    sub: "# OPTIMAL_EXECUTION_ROUTE_GENERAL · Block-Pinned DEX Math",
    desc: "Reads Uniswap V3, Uniswap V2, and SushiSwap V2 pools at one pinned Ethereum block, outputting exact 6-decimal USDC base units.",
    kind: "judgment (deterministic math)",
    upstreams: "Uniswap V3 QuoterV2 · Uniswap V2 · SushiSwap V2",
    schema: "amount_out (6-dec USDC) + provenance answer",
    url: "GET /v1/route · ethereum mainnet",
  },
  {
    key: "grid",
    file: "grid-lmp",
    ext: ".ts",
    name: "GRID_POWER_PRICE_GENERAL",
    sub: "# GRID_POWER_PRICE_GENERAL · Wholesale LMP Cache",
    desc: "An in-process background ingester (every 5 minutes) loads CAISO OASIS, NYISO, and Elering prices into the persistent store; answers are served from that stored settlement data.",
    kind: "deterministic",
    upstreams: "CAISO OASIS · NYISO · Elering",
    schema: "lmp_usd_per_mwh, node_or_zone, market, currency",
    url: "GET /v1/grid-price · oasis.caiso.com",
  },
  {
    key: "validator",
    file: "validator-balance",
    ext: ".ts",
    name: "VALIDATOR_PERFORMANCE_VERIFY_GENERAL",
    sub: "# VALIDATOR_PERFORMANCE_VERIFY_GENERAL · Beacon Effective Balance",
    desc: "Reads a validator's effective balance at the finalized state from a 2-of-4 Ethereum beacon-node quorum (Lodestar, PublicNode, Stakely, blockreq). The index is a canonical non-negative integer written as a decimal string.",
    kind: "deterministic",
    upstreams: "Lodestar ChainSafe · PublicNode Beacon · Stakely Beacon · blockreq Beacon",
    schema: "validator_index, effective_balance (gwei), status",
    url: "GET /v1/validator · beacon quorum",
  },
];

/** Live request presets: the exact inputs each try-it form sends. */
export const PRESETS: Record<
  IntentKey,
  Record<string, string>
> = {
  tx: {
    // Real confirmed Ethereum tx, block 26454869 (checked live
    // 2026-11-20 — receipt rcpt_4FT93E5NXZ8IXSFG3O0YD6TU4E). The old
    // preset (0x8c3f44…, block 15725067) was also real but months old;
    // the landing example now shows a current block.
    tx_hash:
      "0xafdbc83c485355d90f79fd660bcd12713402aa78922d966657d1005f59e92902",
    chain: "ethereum",
  },
  sec: { entity: "AAPL", period: "last 12 months" },
  tvl: { protocol: "aave-v3" },
  route: { pair: "ETH/USDC" },
  grid: {
    node_or_zone: "TH_NP15_GEN-APND",
    interval_start: "2026-11-20T05:00:00Z",
  },
  validator: { validator_index: "1" },
};

/** Inputs that genuinely 422 on the live API (verified against Render). */
export const TRAP_PRESETS: Record<IntentKey, Record<string, string>> = {
  // Well-formed 66-char hash that does not exist on mainnet.
  tx: {
    tx_hash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    chain: "ethereum",
  },
  // Missing period: the miner requires entity AND period.
  sec: { entity: "AAPL", period: "" },
  tvl: { protocol: "not-a-real-protocol-xyz" },
  route: { pair: "BTC/USDC" },
  // Settlement interval that has not closed yet (verified live: 422
  // FUTURE_INTERVAL). QA-06: computed at use time, 2–3 h ahead — the old
  // fixed 2026-11-25T12:00Z turned into a past (200) interval on 25 Nov,
  // and until then its retry_after_sec exceeded the client's 24 h bound
  // and was dropped from the rendered error.
  get grid() {
    const d = new Date(Date.now() + 3 * 60 * 60 * 1000);
    d.setUTCMinutes(0, 0, 0);
    return { node_or_zone: "TH_NP15_GEN-APND", interval_start: d.toISOString() };
  },
  // Canonical-form rejection: the handler only accepts a digit string
  // (0|[1-9][0-9]*). Live response is 400 INVALID_VALIDATOR_INDEX, not 422.
  validator: { validator_index: "-1" },
};

/** Upstream marquee: design list minus ERCOT (no keyless feed). */
export const UPSTREAMS: { n: string; ic: string }[] = [
  { n: "SEC EDGAR", ic: "M3 13h10M4 11V6M8 11V6M12 11V6M2 6l6-3.5L14 6Z" },
  { n: "DeFiLlama", ic: "M3 12l3.5-4 3 2.5L13 5" },
  { n: "PublicNode RPC", ic: "M8 2.5l5 2.8v5.4L8 13.5 3 10.7V5.3Z" },
  { n: "dRPC", ic: "M4 8a4 4 0 1 0 8 0 4 4 0 1 0-8 0M8 2v2M8 12v2" },
  { n: "Uniswap V3", ic: "M3 11c2.5 0 3.5-6 5-6s2.5 6 5 6" },
  { n: "CAISO OASIS", ic: "M9 2L4 9h4l-1 5 5-7H8l1-5Z" },
  { n: "Beacon quorum", ic: "M8 2.5l5 2.8v5.4L8 13.5 3 10.7V5.3Z" },
  { n: "Elering", ic: "M8 2.5v11M3.5 5.5l9 5M12.5 5.5l-9 5" },
  { n: "SushiSwap V2", ic: "M3 5.5h10M3 10.5h10M6 3v10M10 3v10" },
];

export interface Plate {
  id: string;
  fig: string;
  num: string;
  cat: "accuracy" | "reliability" | "verification" | "consumption";
  tag: string;
  title: string;
  desc: string;
}

/** Guarantee plates — fixed marketing copy (DESIGN-SPEC §7, verbatim). */
export const PLATES: Plate[] = [
  { id: "quorum", fig: "fig. 01 · quorum", num: "01", cat: "accuracy", tag: "// 2-of-n consensus", title: "2-of-N RPC Quorum →", desc: "Two independent archive RPCs must agree (2-of-3 on Ethereum, Base, Arbitrum, Optimism and Sepolia; 2-of-2 on Polygon and Base Sepolia); a split vote returns 502 QUORUM_DISAGREEMENT instead of a guess." },
  { id: "receipt", fig: "fig. 02 · receipt", num: "02", cat: "accuracy", tag: "// sha-256 envelope", title: "SHA-256 Receipts →", desc: "Every 200 answer carries receipt.raw_response_sha256 over the exact evidence bytes served at /receipts/{id}/raw." },
  { id: "vault", fig: "fig. 03 · vault", num: "03", cat: "accuracy", tag: "// fail-closed refusal", title: "Strict 400/422/502 →", desc: "Malformed input and future intervals are refused with 400/422 and no receipt; upstream failures return 502. No guessed values." },
  { id: "cabinet", fig: "fig. 04 · cabinet", num: "04", cat: "reliability", tag: "// live /health", title: "Live Status →", desc: "/health and every endpoint are probed live on /status. Uptime is only what /health reports; nothing more is claimed." },
  { id: "terrain", fig: "fig. 05 · terrain", num: "05", cat: "reliability", tag: "// persistent grid store", title: "Persistent Grid Store →", desc: "Grid prices use the persistent storage backend reported by /health. Latency is measured live on /benchmarks, not claimed here." },
  { id: "format", fig: "fig. 06 · format", num: "06", cat: "verification", tag: "// verbatim root keys", title: "Declared Schemas →", desc: "Responses use the field names declared in miner.yaml; a conformance suite checks them against the live service." },
  { id: "riffle", fig: "fig. 07 · riffle", num: "07", cat: "verification", tag: "// sha256sum check", title: "Recomputable Audits →", desc: "Fetch /receipts/{id}/raw, run sha256sum, and compare it with raw_response_sha256." },
  { id: "sieve", fig: "fig. 08 · sieve", num: "08", cat: "reliability", tag: "// per-intent abort timers", title: "Bounded Upstream Calls →", desc: "Every upstream call has its own abort timer, set per intent: route 4 s per RPC call (8 s total), TVL 4.5 s per fetch (9 s total), validator 4.5 s for the whole request, filings 10 s per SEC request (30 s total), tx 12 s per RPC call. Grid answers come from the stored ingest (20 s per ingester fetch); a missing CAISO hour, or a NYISO post-close re-check, is fetched live, capped at 120 s. The miner itself runs no circuit breaker; the breaker settings in miner.yaml are applied by the Telegraph node." },
  { id: "settle", fig: "fig. 09 · settle", num: "09", cat: "consumption", tag: "// desk · direct + escrow", title: "Mission 13 & 12 Desk →", desc: "Several specialist checks combine into one deterministic verdict. Browser Desk runs call the miner directly (unbilled); the Desk agent's escrow-paid Telegraph engine purchases are listed with their receipts in the Receipts ledger." },
];

export interface SprintStep {
  label: string;
  cols: number[];
  g1: string;
  g2: string;
}

/**
 * Sprint roadmap — a dated plan (Nov 20 → Dec 1), kept as static plan copy
 * (DESIGN-SPEC §8 A17: no live progress source exists for these gates).
 * Default step is the first milestone, not a live progress claim.
 */
export const SPRINT_STEPS: SprintStep[] = [
  { label: "01 Star & Setup", cols: [0], g1: "// day 01 · Nov 20 — star bounties + Render deploy", g2: "// gate: /health 200 OK · persistent storage active · intent handlers live (six served today)" },
  { label: "02 Registration Check", cols: [1], g1: "// internal target · Nov 21 — verify registration and activation", g2: `// gate: ${MINER_BOND_USD_TEXT} Test USDC bond · activation_status: active` },
  { label: "03 Harden & Traps", cols: [2], g1: "// days 03–04 · Nov 22–23 — 22-case suite · 12 runnable + 10 unsupported-chain skips", g2: "// gate: 12/12 runnable pass · 10 explicit skips · 0% 503 · public Update #1 posted" },
  { label: "04 Mission Desk", cols: [3], g1: "// days 05–06 · Nov 24–25 — purposeful paid mission runs", g2: "// gate: different inputs, useful outputs and matched receipts in the Desk ledger" },
  { label: "05 Growth & Evaluation", cols: [4, 5], g1: "// internal target · Nov 26–28 — inspect evaluator state + external dev reruns", g2: "// gate: ranked epoch standings + tutorial + Updates #2 & #3" },
  { label: "06 Submit Pack", cols: [6, 7], g1: "// internal target · Nov 29–Dec 1 — execution demo + track evidence", g2: "// official deadline: Dec 1, 2026 · 23:59 UTC · submit through the H2 website" },
];

export const SPRINT_COLUMN_LABELS = [
  "d1 · Nov 20 · star + Render deploy",
  "d2 · Nov 21 · registration check",
  "d3–4 · Nov 22–23 · 22-case audit",
  "d5–6 · Nov 24–25 · paid mission runs",
  "d7–8 · Nov 26–27 · tutorial + devs",
  "d9 · Nov 28 · evaluation review",
  "d10 · Nov 29–30 · 3-min demo video",
  "d11 · Dec 1 · final evidence pack",
];

/**
 * Desk playlist — scenario shells only. Every step row, latency, verdict,
 * and receipt is produced by a live API call when the item runs; nothing
 * here carries a canned result, cost, or hash.
 *
 * - Item 01 (M13 Treasury Diligence): 4 live checks; APPROVE only if all
 *   four return live data with receipts.
 * - Item 02 (M13 Counterparty Check): live tx lookup; REJECT only if the
 *   looked-up tx is actually reverted, CLEAR if confirmed.
 * - Items 03/04 (M12 power gates): live grid LMP for CAISO NP15 and NYISO
 *   Zone J; verdict is RECEIPTED when the call returns live data with a
 *   receipt (no SHA-256 recompute happens here, so "VERIFIED" would
 *   overstate). No threshold and no curtailment claim (the design's
 *   $65/$85 thresholds and ERCOT $118.40 figure were fabricated).
 * - Item 05 (M13 422 guardrail): live future-interval grid call; the real
 *   422 refusal is the result.
 */
export interface DeskItem {
  num: string;
  thumb: string;
  title: string;
  sub: string;
  pill: string;
  /** Which live calls this item runs, in order. */
  calls: IntentKey[];
}

export const DESK_PLAYLIST: DeskItem[] = [
  {
    num: "01",
    thumb: "M13",
    title: "Treasury diligence, live.",
    sub: "Mission 13 · Treasury Diligence (Aave V3 + AAPL)",
    pill: "MISSION 13 · DESK",
    calls: ["tx", "sec", "tvl", "route"],
  },
  {
    num: "02",
    thumb: "M13",
    title: "Counterparty hash, checked.",
    sub: "Mission 13 · Counterparty Check",
    pill: "MISSION 13 · FAIL-CLOSED",
    calls: ["tx", "tvl"],
  },
  {
    num: "03",
    thumb: "M12",
    title: "CAISO NP15, live LMP.",
    sub: "Mission 12 · CAISO NP15 Dispatch Gate",
    pill: "MISSION 12 · POWER",
    calls: ["grid"],
  },
  {
    num: "04",
    thumb: "M12",
    title: "NYISO Zone J, live LMP.",
    sub: "Mission 12 · NYISO Zone J Dispatch Gate",
    pill: "MISSION 12 · POWER",
    calls: ["grid"],
  },
  {
    num: "05",
    thumb: "HOLD",
    title: "Future window, held.",
    sub: "Mission 13 · Unbilled 422 Guardrail",
    pill: "MISSION 13 · ZERO-GUESS",
    calls: ["grid"],
  },
];

/** NYISO Zone J preset used by desk item 04 (verified live). */
export const GRID_NYISO_PRESET: Record<string, string> = {
  node_or_zone: "ZONE_J",
  interval_start: "2026-11-20T05:00:00Z",
};

/** Manifesto — fixed copy (DESIGN-SPEC §7, verbatim). */
export const MANIFESTO_PARTS: string[] = [
  "Autonomous", "agents", "deserve", "answers", "they", "can", "prove,", "not", "confident", "prose.",
  "Every", "[v*]", "VeriReceipt", "response", "queries", "keyless", "authoritative", "upstreams", "directly,",
  "sealing", "[U:one]", "[U:verifiable]", "[U:receipt]", "under", "SHA-256", "so", "any", "judge", "or", "desk",
  "can", "recompute", "the", "exact", "bytes", "in", "thirty", "seconds.",
  "[I:The]", "[I:upstreams]", "[I:return]", "[I:the]", "[I:facts.]", "[I:The]", "[I:receipt]", "[I:proves]", "[I:them.]",
];
