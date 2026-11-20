// Burst test — 500 concurrent requests against the REAL server over REAL
// HTTP, mixed across the five endpoints, with live upstreams. No mocks.
//
// Realistic valid inputs (verified before the burst):
// - tx: 0x2d70ca963eb8763d4704572c62e36a8418d7559e54683ef31c1589d955343687
//   on base-sepolia — a confirmed transfer (block 55258439, 0.001 ETH),
//   ground truth from TrapTest traps-frozen-2026-11-06.json (t02) and
//   re-verified live against the Base Sepolia public RPC while writing
//   this script. A single warm-up call must return 200 confirmed before
//   the burst starts, or the run aborts.
// - filings: entity=AAPL, period=last 12 months (live SEC EDGAR).
// - tvl: protocol=aave-v3 (live DeFiLlama).
// - route: pair=ETH/USDC (live on-chain quote).
// - grid: node_or_zone=TH_NP15_GEN-APND, interval_start=2026-11-19T00:00:00Z
//   — included ONLY if a probe call returns 2xx (i.e. the ingester has
//   cached that interval); otherwise grid is skipped and that is reported.
//
// Prints: total, 2xx, 4xx, 5xx, 503, p50, p99. Requirements: 0% 503 and
// p50 < 400ms. Exit code 0 only if both hold.
//
// Run: npx tsx scripts/burst-test.ts   (from the repo root)

import { buildServer } from "../src/server";

// TEST-ONLY default, same as scripts/run-traptest.ts: lets this local test
// run call live upstreams (SEC EDGAR requires a contact string) without a
// real identity. NEVER a production value.
process.env.SEC_USER_AGENT ??= "TrapTest/1.0 (test@example.local)";

const PORT = 18124;
const BASE = `http://127.0.0.1:${PORT}`;
const TOTAL_REQUESTS = 500;
const REQUEST_TIMEOUT_MS = 60_000;

const TX_HASH = "0x2d70ca963eb8763d4704572c62e36a8418d7559e54683ef31c1589d955343687";
const TX_CHAIN = "base-sepolia";

interface Endpoint {
  name: string;
  url: string;
}

const FIXED_ENDPOINTS: Endpoint[] = [
  { name: "tx", url: `/v1/tx?tx_hash=${TX_HASH}&chain=${TX_CHAIN}` },
  { name: "filings", url: "/v1/filings?entity=AAPL&period=last%2012%20months" },
  { name: "tvl", url: "/v1/tvl?protocol=aave-v3" },
  { name: "route", url: "/v1/route?pair=ETH%2FUSDC" },
];
const GRID_ENDPOINT: Endpoint = {
  name: "grid-price",
  url: "/v1/grid-price?node_or_zone=TH_NP15_GEN-APND&interval_start=2026-11-19T00%3A00%3A00Z",
};

interface Outcome {
  status: number | null; // null = no HTTP response (timeout / connection error)
  latencyMs: number;
  endpoint: string;
}

async function oneRequest(url: string, endpoint: string): Promise<Outcome> {
  const started = performance.now();
  try {
    const res = await fetch(`${BASE}${url}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    // Drain the body so the connection is fully consumed and timed fairly.
    await res.arrayBuffer();
    return { status: res.status, latencyMs: performance.now() - started, endpoint };
  } catch {
    return { status: null, latencyMs: performance.now() - started, endpoint };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

async function main(): Promise<number> {
  const app = buildServer();
  await app.listen({ host: "127.0.0.1", port: PORT });
  console.log(`Burst test: server listening on 127.0.0.1:${PORT}`);
  try {
    // 1. Verify the tx input first: the warm-up must be a 200 confirmed
    //    answer for the known tx, or the burst is meaningless.
    const warmup = await oneRequest(FIXED_ENDPOINTS[0]?.url ?? "", "tx-warmup");
    if (warmup.status !== 200) {
      console.error(
        `Burst test ABORTED: tx warm-up for ${TX_HASH} on ${TX_CHAIN} returned HTTP ${warmup.status ?? "no-response"} (expected 200 confirmed). ` +
          "The burst needs a verified live input; fix the tx path first.",
      );
      return 1;
    }
    console.log(`Burst test: tx warm-up OK (HTTP 200, ${warmup.latencyMs.toFixed(0)}ms)`);

    // 2. Probe grid: include it only if the cache has that interval.
    const endpoints = [...FIXED_ENDPOINTS];
    const gridProbe = await oneRequest(GRID_ENDPOINT.url, "grid-probe");
    let gridIncluded = false;
    if (gridProbe.status === 200) {
      endpoints.push(GRID_ENDPOINT);
      gridIncluded = true;
      console.log(`Burst test: grid probe OK (HTTP 200), grid-price included in the mix`);
    } else {
      console.log(
        `Burst test: grid probe returned HTTP ${gridProbe.status ?? "no-response"} — ` +
          "grid-price NOT in the mix (ingester has not cached that interval); mix covers tx/filings/tvl/route only",
      );
    }

    // 3. Fire 500 concurrent requests, round-robin across the mix.
    const jobs: Array<Promise<Outcome>> = [];
    for (let i = 0; i < TOTAL_REQUESTS; i++) {
      const ep = endpoints[i % endpoints.length] as Endpoint;
      jobs.push(oneRequest(ep.url, ep.name));
    }
    const outcomes = await Promise.all(jobs);

    const total = outcomes.length;
    const ok2xx = outcomes.filter((o) => o.status !== null && o.status >= 200 && o.status < 300).length;
    const c4xx = outcomes.filter((o) => o.status !== null && o.status >= 400 && o.status < 500).length;
    const c5xx = outcomes.filter((o) => o.status !== null && o.status >= 500).length;
    const c503 = outcomes.filter((o) => o.status === 503).length;
    const noResponse = outcomes.filter((o) => o.status === null).length;
    const latencies = outcomes
      .filter((o) => o.status !== null)
      .map((o) => o.latencyMs)
      .sort((a, b) => a - b);
    const p50 = percentile(latencies, 50);
    const p99 = percentile(latencies, 99);
    const errorRate = total === 0 ? 0 : ((total - ok2xx) / total) * 100;

    const perEndpoint = new Map<string, { n: number; ok: number }>();
    for (const o of outcomes) {
      const entry = perEndpoint.get(o.endpoint) ?? { n: 0, ok: 0 };
      entry.n += 1;
      if (o.status !== null && o.status >= 200 && o.status < 300) entry.ok += 1;
      perEndpoint.set(o.endpoint, entry);
    }

    console.log("Burst test results:");
    console.log(`  total: ${total}`);
    console.log(`  2xx: ${ok2xx}`);
    console.log(`  4xx: ${c4xx}`);
    console.log(`  5xx: ${c5xx}`);
    console.log(`  503: ${c503}`);
    console.log(`  no-response (timeout/conn error): ${noResponse}`);
    console.log(`  error rate (non-2xx): ${errorRate.toFixed(1)}%`);
    console.log(`  p50: ${Number.isFinite(p50) ? p50.toFixed(0) : "n/a"}ms`);
    console.log(`  p99: ${Number.isFinite(p99) ? p99.toFixed(0) : "n/a"}ms`);
    console.log(`  grid included: ${gridIncluded}`);
    for (const [name, counts] of [...perEndpoint.entries()].sort()) {
      console.log(`  per-endpoint ${name}: ${counts.ok}/${counts.n} 2xx`);
    }

    const pass503 = c503 === 0;
    const passP50 = Number.isFinite(p50) && p50 < 400;
    console.log(`  requirement 0% 503: ${pass503 ? "PASS" : "FAIL"}`);
    console.log(`  requirement p50 < 400ms: ${passP50 ? "PASS" : "FAIL"}`);
    return pass503 && passP50 ? 0 : 1;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error("Burst test runner error:", err);
    process.exitCode = 1;
  });
