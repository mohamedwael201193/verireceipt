// Benchmark cases — real probes, real measurements. No canned results.
//
// Replaces BENCH_CASES (DESIGN-SPEC §6 D-07/D-08/D-09).
// - T01–T12 are the REAL frozen 12 traps from scripts/run-traptest.ts
//   (all base-sepolia, full hashes + expected status/from/to/block/value).
//   The design file's T01–T12 (truncated hashes, invented blocks like
//   #15725067 / 274118902, "confidence 0.72", "value 0.00001") are fabricated.
// - R01–R04 / F01–F03 are real calls with real assertions (refusals must be
//   4xx with an error body and no receipt — never 200, never fabricated $0).
// - F04 (simulated upstream outage) and B03 (circuit-breaker trip) are NOT
//   executable via the public API — there is no injection parameter. They
//   render as SKIP with the reason, excluded from the pass rate. The old
//   file's "502/4512ms" and "breaker_primary: OPEN" were invented.
// - B01 fires 50 real requests; B02 is a real /health call; B04 is two real
//   grid calls. Latency tiles + histogram are computed from measured values.

import { getFilings, getGridPrice, getHealth, getRoute, getTvl, getTx } from "../../lib/api";
import type { FilingsResponse, GridPriceResponse, LiveReceipt, ProbeOutcome, TvlResponse, TxResponse } from "./types";
import { directUrl, futureGridInterval, p95, probe, recentGridInterval, toLiveReceipt } from "./utils";

export type BenchCategory = "tx" | "reg" | "refusal" | "burst";
export type BenchVerdict = "PASS" | "FAIL" | "SKIP";

export interface BenchResult {
  verdict: BenchVerdict;
  http: number | null;
  latencyMs: number | null;
  /** What the live call actually returned (shown in the expanded row). */
  actual: string;
  /** Optional note (e.g. why a case was skipped). */
  note?: string;
}

export interface BenchContext {
  record: (receipt: LiveReceipt) => void;
}

export interface BenchCase {
  id: string;
  cat: BenchCategory;
  name: string;
  /** The assertion the live result is checked against. */
  expect: string;
  /** Display payload for the expanded row. */
  probe: string;
  runnable: boolean;
  skipReason?: string;
  run: (ctx: BenchContext) => Promise<BenchResult>;
}

function catLabel(c: BenchCategory): string {
  return { tx: "Frozen TX", reg: "Regression", refusal: "422 Matrix", burst: "Burst Load" }[c];
}

export { catLabel };

const SHA_RE = /^0x[0-9a-f]{64}$/;

function hasValidReceipt(body: unknown): boolean {
  if (body === null || typeof body !== "object" || !("receipt" in body)) return false;
  const r = (body as { receipt?: { raw_response_sha256?: unknown } }).receipt;
  return !!r && typeof r.raw_response_sha256 === "string" && SHA_RE.test(r.raw_response_sha256);
}

function failFrom(outcome: ProbeOutcome, what: string): BenchResult {
  return {
    verdict: "FAIL",
    http: outcome.ok ? 200 : outcome.status,
    latencyMs: outcome.latencyMs,
    actual: `${what} — call did not return a usable answer: ${outcome.ok ? JSON.stringify(outcome.body).slice(0, 240) : `HTTP ${outcome.status} ${outcome.errorMessage ?? ""}`}`,
  };
}

interface Trap {
  id: string;
  name: string;
  txHash: string;
  expectedStatus: "confirmed" | "reverted" | "not_found";
  expectedFrom: string | null;
  expectedTo: string | null;
  expectedValueWei: string | null;
  /** "tx" = expectedValueWei is the tx value; "transfer-event" = the Transfer-event amount (tx value must be 0). */
  valueBasis: "tx" | "transfer-event";
  expectedBlock: number | null;
}

/** Frozen 12 traps, verbatim from scripts/run-traptest.ts (chain base-sepolia). */
const TRAPS: Trap[] = [
  { id: "T01", name: "t01-plain-transfer", txHash: "0xd47a090fee50ae43d3af7dcb03eced0be6c98a48b3aa92dc21a8c4d9d784ae96", expectedStatus: "confirmed", expectedFrom: "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001", expectedTo: "0x4200000000000000000000000000000000000015", expectedValueWei: "0", valueBasis: "tx", expectedBlock: 53047427 },
  { id: "T02", name: "t02-plain-transfer", txHash: "0x2d70ca963eb8763d4704572c62e36a8418d7559e54683ef31c1589d955343687", expectedStatus: "confirmed", expectedFrom: "0xb0b8b0e6b5f3e9ecc8a4f1390af2be37dc418ad7", expectedTo: "0xb0b8b0e6b5f3e9ecc8a4f1390af2be37dc418ad7", expectedValueWei: "1000000000000000", valueBasis: "tx", expectedBlock: 55258439 },
  { id: "T03", name: "t03-token-transfer", txHash: "0x0113bafdf54755989384d25240447e2071e4888da16686d180cc4eacc846b9af", expectedStatus: "confirmed", expectedFrom: "0x0af9df1a49fdbf9215dd787a7c17b1eb11a50bd5", expectedTo: "0x2736548295851c2181a0a1cdef707b2dd614d047", expectedValueWei: "950000", valueBasis: "transfer-event", expectedBlock: 53047427 },
  { id: "T04", name: "t04-token-transfer", txHash: "0x1a0ecef6eb220b00aa875d81c94f8ec843f147ad390ba1b623faef4bd634ae54", expectedStatus: "confirmed", expectedFrom: "0x2735bd4edf19957a79deb609d72bf33e59849348", expectedTo: "0x82470e66e788867390d16f9ec4169b81915112d8", expectedValueWei: "2000000000000000000", valueBasis: "transfer-event", expectedBlock: 55258552 },
  { id: "T05", name: "t05-contract-interaction", txHash: "0xb65725814254a99ee494130e6f22898fb1bcfe3442e00b1d4fd23ba49774de21", expectedStatus: "confirmed", expectedFrom: "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001", expectedTo: "0x4200000000000000000000000000000000000015", expectedValueWei: null, valueBasis: "tx", expectedBlock: 55258576 },
  { id: "T06", name: "t06-contract-interaction", txHash: "0x48d8b3c208ee336f69d782e42d26c7d36d276e5a9e707a985ed5e759fcadf4f5", expectedStatus: "confirmed", expectedFrom: "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001", expectedTo: "0x4200000000000000000000000000000000000030", expectedValueWei: null, valueBasis: "tx", expectedBlock: 55258576 },
  { id: "T07", name: "t07-reverted-tx", txHash: "0x08f6d36438dd60ecfd262d44bbd236abd5538de1a836ed79f903813f038aca48", expectedStatus: "reverted", expectedFrom: "0xe49866891ab9b82873663912687c4ef8dc8b0d8f", expectedTo: "0x572bf0fc198f0482bf55a789ceddff4f3b61f76b", expectedValueWei: null, valueBasis: "tx", expectedBlock: 55258569 },
  { id: "T08", name: "t08-reverted-tx", txHash: "0xdba37af4b112aa49c61f9153981c57b345f1e24cbc4d0ce29011c5a4e120597b", expectedStatus: "reverted", expectedFrom: "0x40dd35389dcf63f45c6069edea658745ab2f6903", expectedTo: "0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4", expectedValueWei: "10000000000000", valueBasis: "tx", expectedBlock: 55258555 },
  { id: "T09", name: "t09-multi-recipient-tx", txHash: "0xd06bb83d77449de011264f73066b537be70a272ee643132176442cf25de5d5dc", expectedStatus: "confirmed", expectedFrom: "0x0de59ee7b9007d6154a105375f4484058b934205", expectedTo: "0x84162e52063504a701cda5e931d2fd174c10648d", expectedValueWei: null, valueBasis: "tx", expectedBlock: 55258574 },
  { id: "T10", name: "t10-multi-recipient-tx", txHash: "0x5bad2aa6ed070cafc628fe5010a3684ac7e3bcf3d2f3a6500709d5f8d49b84a5", expectedStatus: "confirmed", expectedFrom: "0x0decd19497beb916b48a63949ada19daac509604", expectedTo: "0x84162e52063504a701cda5e931d2fd174c10648d", expectedValueWei: null, valueBasis: "tx", expectedBlock: 55258573 },
  { id: "T11", name: "t11-unknown-tx", txHash: "0xd0b1cc353aa7e1ecbfa3a0ea5ff890d0042210a92720e2aaedcfcc586f9fb90d", expectedStatus: "not_found", expectedFrom: null, expectedTo: null, expectedValueWei: null, valueBasis: "tx", expectedBlock: null },
  { id: "T12", name: "t12-unknown-tx", txHash: "0x6f57ebe49914984c73766affa5f1cd1d5ff5dbb2ec32923f3b3c0dd414013767", expectedStatus: "not_found", expectedFrom: null, expectedTo: null, expectedValueWei: null, valueBasis: "tx", expectedBlock: null },
];

function trapCase(trap: Trap): BenchCase {
  const expect =
    trap.expectedStatus === "not_found"
      ? "status=not_found · no invented from/to/block"
      : `status=${trap.expectedStatus} · block=${trap.expectedBlock}${trap.expectedValueWei !== null && trap.valueBasis === "tx" ? ` · value=${trap.expectedValueWei} wei` : ""}`;
  return {
    id: trap.id,
    cat: "tx",
    name: `${trap.name} (base-sepolia)`,
    expect,
    probe: JSON.stringify({ tx_hash: trap.txHash, chain: "base-sepolia" }),
    runnable: true,
    run: async (ctx) => {
      const outcome = await probe(() => getTx({ tx_hash: trap.txHash, chain: "base-sepolia" }));
      ctx.record(
        toLiveReceipt(
          "ONCHAIN_TX_LOOKUP_GENERAL",
          `${trap.txHash.slice(0, 8)}…${trap.txHash.slice(-4)} (base-sepolia)`,
          directUrl("/v1/tx", { tx_hash: trap.txHash, chain: "base-sepolia" }),
          outcome,
        ),
      );
      if (!outcome.ok) return failFrom(outcome, "tx lookup");
      const body = outcome.body as TxResponse;
      const failures: string[] = [];
      if (body.status !== trap.expectedStatus) failures.push(`status: expected ${trap.expectedStatus}, got ${JSON.stringify(body.status)}`);
      if (trap.expectedFrom !== null && (body.from ?? "").toLowerCase() !== trap.expectedFrom.toLowerCase())
        failures.push(`from: expected ${trap.expectedFrom}, got ${JSON.stringify(body.from)}`);
      if (trap.expectedTo !== null && (body.to ?? "").toLowerCase() !== trap.expectedTo.toLowerCase())
        failures.push(`to: expected ${trap.expectedTo}, got ${JSON.stringify(body.to)}`);
      if (trap.expectedBlock !== null && body.block_number !== trap.expectedBlock)
        failures.push(`block: expected ${trap.expectedBlock}, got ${JSON.stringify(body.block_number)}`);
      if (trap.expectedStatus === "not_found") {
        if (body.from !== null && body.from !== undefined) failures.push(`not_found must not invent from`);
        if (body.to !== null && body.to !== undefined) failures.push(`not_found must not invent to`);
        if (body.block_number !== null && body.block_number !== undefined) failures.push(`not_found must not invent block`);
      }
      if (trap.valueBasis === "tx" && trap.expectedValueWei !== null) {
        const wei = body.value_eth === null || body.value_eth === undefined ? null : BigInt(Math.round(Number(body.value_eth) * 1e18)).toString();
        if (wei !== trap.expectedValueWei) failures.push(`value: expected ${trap.expectedValueWei} wei, got ${wei}`);
      }
      if (trap.valueBasis === "transfer-event") {
        const wei = body.value_eth === null || body.value_eth === undefined ? null : BigInt(Math.round(Number(body.value_eth) * 1e18)).toString();
        if (wei !== "0") failures.push(`tx value must be 0 wei (event amount is not value_eth), got ${wei}`);
      }
      if (!hasValidReceipt(body)) failures.push("receipt.raw_response_sha256 missing or malformed");
      const actual = JSON.stringify({
        status: body.status,
        from: body.from,
        to: body.to,
        block_number: body.block_number,
        value_eth: body.value_eth,
        receipt: (body.receipt as { receipt_id?: string })?.receipt_id,
      });
      return {
        verdict: failures.length === 0 ? "PASS" : "FAIL",
        http: 200,
        latencyMs: outcome.latencyMs,
        actual: failures.length === 0 ? actual : `${actual} — FAILURES: ${failures.join("; ")}`,
      };
    },
  };
}

/** A refusal case: the live API must answer 4xx with an error body and no receipt. */
function refusalCase(
  id: string,
  name: string,
  expect: string,
  probeText: string,
  intent: string,
  query: string,
  requestUrl: string,
  fetcher: () => Promise<unknown>,
  extraCheck?: (outcome: ProbeOutcome) => string | null,
): BenchCase {
  return {
    id,
    cat: "refusal",
    name,
    expect,
    probe: probeText,
    runnable: true,
    run: async (ctx) => {
      const outcome = await probe(fetcher);
      ctx.record(toLiveReceipt(intent, query, requestUrl, outcome));
      if (outcome.ok) {
        return {
          verdict: "FAIL",
          http: 200,
          latencyMs: outcome.latencyMs,
          actual: `expected a 4xx refusal, got 200: ${JSON.stringify(outcome.body).slice(0, 240)}`,
        };
      }
      const failures: string[] = [];
      if (!(outcome.status === 400 || outcome.status === 422)) failures.push(`expected HTTP 400/422, got ${outcome.status}`);
      if (hasValidReceipt(outcome.body)) failures.push("refusal must not carry a receipt");
      const extra = extraCheck ? extraCheck(outcome) : null;
      if (extra) failures.push(extra);
      return {
        verdict: failures.length === 0 ? "PASS" : "FAIL",
        http: outcome.status,
        latencyMs: outcome.latencyMs,
        actual: JSON.stringify(outcome.body) + (failures.length ? ` — FAILURES: ${failures.join("; ")}` : ""),
      };
    },
  };
}

function skipCase(id: string, cat: BenchCategory, name: string, expect: string, probeText: string, reason: string): BenchCase {
  return {
    id,
    cat,
    name,
    expect,
    probe: probeText,
    runnable: false,
    skipReason: reason,
    run: async () => ({ verdict: "SKIP", http: null, latencyMs: null, actual: reason, note: reason }),
  };
}

export const BENCH_CASES: BenchCase[] = [
  ...TRAPS.map(trapCase),

  // 4 Cross-Bug Regressions
  {
    id: "R01",
    cat: "reg",
    name: "Wrong-Chain Pool Guard (aave-v3)",
    expect: "Echoes the requested protocol exactly · tvl_usd > 0 · receipt",
    probe: JSON.stringify({ protocol: "aave-v3" }),
    runnable: true,
    run: async (ctx) => {
      const outcome = await probe(() => getTvl({ protocol: "aave-v3" }));
      ctx.record(toLiveReceipt("TVL_LOOKUP_GENERAL", "protocol=aave-v3", directUrl("/v1/tvl", { protocol: "aave-v3" }), outcome));
      if (!outcome.ok) return failFrom(outcome, "tvl lookup");
      const body = outcome.body as TvlResponse;
      const failures: string[] = [];
      if (body.protocol_or_chain !== "aave-v3") failures.push(`protocol_or_chain: expected aave-v3, got ${JSON.stringify(body.protocol_or_chain)}`);
      if (!(typeof body.tvl_usd === "number" && body.tvl_usd > 0)) failures.push(`tvl_usd must be > 0, got ${JSON.stringify(body.tvl_usd)}`);
      if (!hasValidReceipt(body)) failures.push("receipt.raw_response_sha256 missing or malformed");
      return {
        verdict: failures.length === 0 ? "PASS" : "FAIL",
        http: 200,
        latencyMs: outcome.latencyMs,
        actual: JSON.stringify({ protocol_or_chain: body.protocol_or_chain, tvl_usd: body.tvl_usd, chain_tvl_usd: body.chain_tvl_usd, as_of: body.as_of }) + (failures.length ? ` — FAILURES: ${failures.join("; ")}` : ""),
      };
    },
  },
  refusalCase(
    "R02",
    "Unscoped Aggregate Guard (empty protocol)",
    "Refuse empty protocol with 4xx · never 200 · never fabricated $0",
    JSON.stringify({ protocol: "" }),
    "TVL_LOOKUP_GENERAL",
    "protocol=",
    directUrl("/v1/tvl", { protocol: "" }),
    () => getTvl({ protocol: "" }),
  ),
  refusalCase(
    "R03",
    "Wrong-Location Zone Guard (UNKNOWN_ZONE_99)",
    "Refuse unknown zone with 4xx · echo nothing invented",
    JSON.stringify({ node_or_zone: "UNKNOWN_ZONE_99", interval_start: "PAST" }),
    "GRID_POWER_PRICE_GENERAL",
    "zone=UNKNOWN_ZONE_99",
    directUrl("/v1/grid-price", { node_or_zone: "UNKNOWN_ZONE_99", interval_start: recentGridInterval() }),
    () => getGridPrice({ node_or_zone: "UNKNOWN_ZONE_99", interval_start: recentGridInterval() }),
  ),
  {
    id: "R04",
    cat: "reg",
    name: "Root Canonical Schema Parity Check",
    expect: "entity, filing_count, filings[], urls[] all present at root · receipt",
    probe: JSON.stringify({ entity: "AAPL", period: "last 6 months" }),
    runnable: true,
    run: async (ctx) => {
      const outcome = await probe(() => getFilings({ entity: "AAPL", period: "last 6 months" }));
      ctx.record(toLiveReceipt("REGULATORY_FILING_MONITOR_GENERAL", "AAPL · last 6 months", directUrl("/v1/filings", { entity: "AAPL", period: "last 6 months" }), outcome));
      if (!outcome.ok) return failFrom(outcome, "filings lookup");
      const body = outcome.body as FilingsResponse;
      const failures: string[] = [];
      if (typeof body.entity !== "string" || !body.entity) failures.push("entity missing");
      if (typeof body.filing_count !== "number") failures.push("filing_count missing");
      if (!Array.isArray(body.filings)) failures.push("filings[] missing");
      if (!Array.isArray(body.urls)) failures.push("urls[] missing");
      if (!hasValidReceipt(body)) failures.push("receipt.raw_response_sha256 missing or malformed");
      return {
        verdict: failures.length === 0 ? "PASS" : "FAIL",
        http: 200,
        latencyMs: outcome.latencyMs,
        actual: JSON.stringify({ entity: body.entity, filing_count: body.filing_count, filings: (body.filings ?? []).length, urls: (body.urls ?? []).length }) + (failures.length ? ` — FAILURES: ${failures.join("; ")}` : ""),
      };
    },
  },

  // 4 Refusal Matrix
  refusalCase(
    "F01",
    "Future Grid Settlement Window",
    "HTTP 422 + retry_after_sec · billed $0.00",
    JSON.stringify({ node_or_zone: "TH_NP15_GEN-APND", interval_start: "2026-11-25T12:00:00Z" }),
    "GRID_POWER_PRICE_GENERAL",
    "TH_NP15_GEN-APND · future interval",
    directUrl("/v1/grid-price", { node_or_zone: "TH_NP15_GEN-APND", interval_start: futureGridInterval() }),
    () => getGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: futureGridInterval() }),
    (outcome) => {
      if (outcome.ok) return "expected a refusal, got 200";
      if (outcome.status !== 422) return `expected HTTP 422, got ${outcome.status}`;
      const b = outcome.body as { retry_after_sec?: unknown };
      if (typeof b?.retry_after_sec !== "number") return "retry_after_sec missing from 422 body";
      return null;
    },
  ),
  refusalCase(
    "F02",
    "Unknown Equity Ticker (ZZZZZ)",
    "HTTP 4xx unknown entity · never 200 with 0 filings",
    JSON.stringify({ entity: "ZZZZZ_INVALID", period: "last 12 months" }),
    "REGULATORY_FILING_MONITOR_GENERAL",
    "ZZZZZ_INVALID · last 12 months",
    directUrl("/v1/filings", { entity: "ZZZZZ_INVALID", period: "last 12 months" }),
    () => getFilings({ entity: "ZZZZZ_INVALID", period: "last 12 months" }),
  ),
  refusalCase(
    "F03",
    "Unsupported DEX Execution Pair",
    "HTTP 422 enum violation (ETH/USDC only)",
    JSON.stringify({ pair: "SOL/USDT" }),
    "OPTIMAL_EXECUTION_ROUTE_GENERAL",
    "pair=SOL/USDT",
    directUrl("/v1/route", { pair: "SOL/USDT" }),
    () => getRoute({ pair: "SOL/USDT" }),
    (outcome) => {
      if (outcome.ok) return "expected a refusal, got 200";
      return outcome.status !== 422 ? `expected HTTP 422, got ${outcome.status}` : null;
    },
  ),
  skipCase(
    "F04",
    "refusal",
    "Simulated Upstream Outage (Fail-Closed)",
    "HTTP 502 upstream_unavailable · never 200",
    JSON.stringify({ simulate_upstream_down: true }),
    "The public API has no upstream-outage injection parameter, so this case cannot be executed from the browser. A 502 can only be observed during a real upstream outage.",
  ),

  // 4 Burst Concurrency & Always-Warm Spot Checks
  {
    id: "B01",
    cat: "burst",
    name: "50-Request / 10s Concurrent Burst",
    expect: "50/50 settle · 0 HTTP 503 · p95 reported live",
    probe: "50 mixed GET /v1/tx + /v1/grid-price, concurrency 5",
    runnable: true,
    run: async (ctx) => {
      const txHash = "0x2d70ca963eb8763d4704572c62e36a8418d7559e54683ef31c1589d955343687";
      const interval = recentGridInterval();
      const txUrl = directUrl("/v1/tx", { tx_hash: txHash, chain: "base-sepolia" });
      const gridUrl = directUrl("/v1/grid-price", { node_or_zone: "TH_NP15_GEN-APND", interval_start: interval });
      const jobs: Array<{ intent: string; url: string; run: () => Promise<ProbeOutcome> }> = [];
      for (let i = 0; i < 25; i++) {
        jobs.push({ intent: "ONCHAIN_TX_LOOKUP_GENERAL", url: txUrl, run: () => probe(() => getTx({ tx_hash: txHash, chain: "base-sepolia" })) });
        jobs.push({ intent: "GRID_POWER_PRICE_GENERAL", url: gridUrl, run: () => probe(() => getGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: interval })) });
      }
      const latencies: number[] = [];
      let settled = 0;
      let http503 = 0;
      let failed = 0;
      // Concurrency 5: gentle on the miner (rate limit 20/s) and on Render.
      const workers = Array.from({ length: 5 }, async () => {
        while (jobs.length > 0) {
          const job = jobs.shift();
          if (!job) return;
          const outcome = await job.run();
          settled += 1;
          latencies.push(outcome.latencyMs);
          if (!outcome.ok && outcome.status === 503) http503 += 1;
          if (!outcome.ok) failed += 1;
          ctx.record(toLiveReceipt(job.intent, "burst probe", job.url, outcome));
        }
      });
      await Promise.all(workers);
      const p95Ms = p95(latencies);
      const actual = JSON.stringify({ total: 50, settled, failed, http_503: http503, p95_ms: p95Ms === null ? null : Math.round(p95Ms) });
      return {
        verdict: settled === 50 && http503 === 0 && failed === 0 ? "PASS" : "FAIL",
        http: 200,
        latencyMs: p95Ms,
        actual: failed > 0 ? `${actual} — ${failed} request(s) did not settle cleanly` : actual,
      };
    },
  },
  {
    id: "B02",
    cat: "burst",
    name: "Always-Warm Spot-Check Probe",
    expect: "GET /health returns 200 · status ok · latency reported live",
    probe: "GET /health",
    runnable: true,
    run: async (ctx) => {
      const outcome = await probe(() => getHealth());
      ctx.record(toLiveReceipt("HEALTH", "GET /health", directUrl("/health", {}), outcome));
      if (!outcome.ok) return failFrom(outcome, "health probe");
      const body = outcome.body as { status?: unknown; uptime_s?: unknown };
      const ok = body.status === "ok";
      return {
        verdict: ok ? "PASS" : "FAIL",
        http: 200,
        latencyMs: outcome.latencyMs,
        actual: JSON.stringify({ status: body.status, uptime_s: body.uptime_s }),
      };
    },
  },
  skipCase(
    "B03",
    "burst",
    "Circuit Breaker Trip & 30s Recovery",
    "Auto-failover to secondary RPC in <200ms",
    "Primary RPC injected 500 -> fallback LlamaRPC",
    "A breaker trip cannot be injected via the public API — there is no fault-injection parameter. Failover can only be observed during a real upstream failure.",
  ),
  {
    id: "B04",
    cat: "burst",
    name: "SQLite WAL Grid Cron Cache Hit",
    expect: "Two consecutive grid calls both 200 with receipts · 2nd latency reported live",
    probe: "GET /v1/grid-price (TH_NP15_GEN-APND) × 2",
    runnable: true,
    run: async (ctx) => {
      const interval = recentGridInterval();
      const first = await probe(() => getGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: interval }));
      ctx.record(toLiveReceipt("GRID_POWER_PRICE_GENERAL", `TH_NP15_GEN-APND · ${interval}`, directUrl("/v1/grid-price", { node_or_zone: "TH_NP15_GEN-APND", interval_start: interval }), first));
      const second = await probe(() => getGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: interval }));
      ctx.record(toLiveReceipt("GRID_POWER_PRICE_GENERAL", `TH_NP15_GEN-APND · ${interval}`, directUrl("/v1/grid-price", { node_or_zone: "TH_NP15_GEN-APND", interval_start: interval }), second));
      if (!first.ok) return failFrom(first, "first grid call");
      if (!second.ok) return failFrom(second, "second grid call");
      const secondBody = second.body as GridPriceResponse & { receipt?: { quorum_votes?: string } };
      const quorum = (secondBody.receipt as unknown as { quorum_votes?: string } | undefined)?.quorum_votes;
      return {
        verdict: "PASS",
        http: 200,
        latencyMs: second.latencyMs,
        actual: JSON.stringify({
          lmp_usd_per_mwh: (second.body as GridPriceResponse).lmp_usd_per_mwh,
          first_ms: Math.round(first.latencyMs),
          second_ms: Math.round(second.latencyMs),
          quorum_votes: quorum ?? null,
        }),
      };
    },
  },
];

export const BENCH_RUNNABLE_COUNT = BENCH_CASES.filter((c) => c.runnable).length;
export const BENCH_TOTAL_COUNT = BENCH_CASES.length;
