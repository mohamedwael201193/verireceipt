// VeriReceipt Desk — seed runner (scripts/seed-desk-runs.ts).
//
// Executes the 140-call plan (110 M13 across 20 scenarios + 30 M12
// across 15 scenarios) as REAL ranked escrow calls (POST /engine/v1/ask,
// X-PAYMENT escrow primary) and logs every call to SQLite + receipts/
// ledger.jsonl, with one decisions.jsonl row per completed scenario.
//
//   npx tsx scripts/seed-desk-runs.ts --max-calls 10   # first-10 proof
//   npx tsx scripts/seed-desk-runs.ts                  # full 140 (after judges pass)
//   npx tsx scripts/seed-desk-runs.ts --plan           # print the plan, buy nothing
//   npx tsx scripts/seed-desk-runs.ts --mission M12 --max-calls 30
//
// Requires DESK_PAYER_PRIVATE_KEY in the environment (server-side payer
// key; never printed, never logged, never committed). Testnet only:
// Ethereum Sepolia, Test USDC, Diamond 0x72a70e…a08b.
//
// COSTS (all calls bill $0.01, the protocol floor):
//   M13 run = 6 calls = $0.06 (5 own intents + independent CRYPTO_PRICE_USD)
//   M13 scenarios 11–20 = 5 calls = $0.05 (4 own intents + CRYPTO_PRICE_USD;
//     no sanctions screen — the blueprint-sanctioned softening: §7.1
//     allows 4–5 intents, and this seed plan's own arithmetic
//     (110 M13 / 140 total / $1.40) drops the screen there. Blueprint
//     §7.3 (ll. 556–558) itself plans 90 M13 calls / 120+ total / ~$1.20 and mandates
//     nothing about which scenarios drop sanctions; the policy records
//     sanctions as "skipped" and names it in the Why box)
//   M12 run = 2 calls = $0.02
//   Full plan = 110 M13 + 30 M12 = 140 calls = $1.40.
//
// CALL ORDER — merged 7:3 queue (this is the Day-4 proof plan, and the
// split below is what the queue REALLY buys; it was verified by the
// --plan dry-run trace and by tests/seed-plan.test.ts):
//   The flat M13 call list and the flat M12 call list (each in scenario
//   order) are merged 7 M13 : 3 M12, repeating WHILE BOTH LISTS STILL
//   HAVE CALLS. The 7:3 pattern therefore holds only for the first 100
//   calls; jobs 101–140 are all M13 once the 30 M12 calls are exhausted
//   (overall ratio 110:30 = 11:3, never 7:3). So:
//     --max-calls 10 buys  7 M13 +  3 M12
//     --max-calls 13 buys 10 M13 +  3 M12  (matches the observed ledger
//       of the 2026-11-20 run: 10 M13 + 3 M12 logged)
//   A scenario is decided as soon as its last intent is bought, even
//   if other scenarios are still partial.
//
// THE $0.02 GAP (fixed here, disclosed in README.md "Desk" section):
//   The 2026-11-20 run logged 13 calls / 130,000 µUSDC while the node
//   ledger shows charged 150,000 µUSDC (unbilled 0; deposited 2,000,000,
//   available 1,850,000 at last check, 2026-11-20, epoch 25; snapshot:
//   receipts/node-ledger-snapshot-2026-11-20.json, fetched 2026-11-20T20:50:08Z) — 2 paid
//   calls missing from every client-side record. The $0.02 gap still
//   reconciles exactly (charged 150,000 vs logged 130,000); the field
//   has moved from unbilled to charged since the first check. ROOT CAUSE
//   (fixed): buy() used to receive the ask as an EAGERLY-CREATED PROMISE,
//   so the ask fired (challenge → sign → paid POST) BEFORE the budget
//   guard ran; when the cap was hit mid-scenario the extra ask ran to
//   completion unawaited, unlogged, unverified, uncounted. buy() now
//   takes a THUNK and checks the budget BEFORE the thunk is invoked
//   (budget guard scripts/seed-desk-runs.ts:334, thunk invoked :335),
//   so no paid call can ever fire past the cap. One orphan is attributed
//   (M12-02 MINING_HASHPRICE_VERIFY_GENERAL, the 14th call of the
//   --max-calls 13 run UNDER THE PRE-FIX SEQUENTIAL CALL ORDER the
//   settled runs used — under the merged queue in this file, job 14 is
//   M13-02 SANCTIONS and M12-02 HASHPRICE is job 18); the second is
//   unattributed in any surviving record (the queue simulation shows a
//   --max-calls 10 run would orphan M13-02 OPTIMAL_EXECUTION_ROUTE_GENERAL
//   — consistent with, but not proof of, that attribution; the earlier
//   run's records were reset). The fixed code cannot produce more orphans.

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { randomUUID } from "crypto";
import { join, resolve } from "path";
import {
  decideM12,
  decideM13,
  executeM12Intent,
  executeM13Intent,
  fetchBtcTipHeight,
  M12_INTENTS,
  M13_INTENTS,
  toCallRecord,
} from "../src/desk/scenarios";
import { logDeskRun, markDeskRunVerified, updateDeskRunVerdict } from "../src/desk/ledger";
import type { M12Input } from "../src/desk/policyM12";
import type { M13Input } from "../src/desk/policyM13";
import { TelegraphClient, type AskResult, type Hex } from "../src/desk/telegraphClient";

// Verified live 2026-11-20 (archive-RPC quorum): confirmed on ethereum.
const CONFIRMED_TX = "0x1b9e2b48eb3510ee1a8aae2fc402139784f32d43b76d5853387cacb484a9a9d3";
// Verified live 2026-11-20: reverted on ethereum.
const REVERTED_TX = "0x1a1467893eaed124a13164b589f1ed7a70ec203257084a7be27eee8f93bd8ba9";
// Well-formed hash that exists on no chain (not_found drill).
const NOT_FOUND_TX = "0x0000000000000000000000000000000000000000000000000000000000000001";

export interface M13ScenarioDef {
  id: string;
  input: M13Input;
  /** Intents to buy for this scenario (6 full, 5 without sanctions — always incl. CRYPTO_PRICE_USD in this seed plan). */
  intents: string[];
}

export interface M12ScenarioDef {
  id: string;
  input: M12Input;
}

const M13_PROTOCOLS: Array<[string, string]> = [
  ["aave-v3", "Apple Inc"],
  ["uniswap", "Microsoft Corporation"],
  ["compound-v3", "Alphabet Inc"],
  ["makerdao", "Amazon.com Inc"],
  ["lido", "NVIDIA Corporation"],
  ["curve", "JPMorgan Chase & Co"],
  ["balancer", "Bank of America Corp"],
  ["sushiswap", "Goldman Sachs Group Inc"],
  ["yearn", "Tesla Inc"],
  ["eigenlayer", "Meta Platforms Inc"],
  ["pendle", "Berkshire Hathaway Inc"],
  ["morpho", "Visa Inc"],
  ["spark", "Mastercard Inc"],
  ["frax", "Johnson & Johnson"],
  ["rocket-pool", "Exxon Mobil Corp"],
  ["convex", "Chevron Corp"],
  ["aave-v2", "Pfizer Inc"],
  ["dydx", "Coca-Cola Co"],
  ["synthetix", "Walmart Inc"],
  ["gmx", "Oracle Corp"],
];

export function buildM13Scenarios(): M13ScenarioDef[] {
  return M13_PROTOCOLS.map(([protocol, entity], i) => {
    const n = i + 1;
    const id = `M13-${String(n).padStart(2, "0")}`;
    // Drills (fail-closed evidence, not happy paths):
    // - 03: reverted counterparty tx -> REJECT.
    // - 07: counterparty tx does not exist -> REJECT.
    // - 11: confirmed tx asked on the wrong chain (base) -> REJECT.
    let txHash = CONFIRMED_TX;
    let chain = "ethereum";
    if (n === 3) txHash = REVERTED_TX;
    if (n === 7) txHash = NOT_FOUND_TX;
    if (n === 11) chain = "base";
    const period = n % 3 === 0 ? "2026" : n % 3 === 1 ? "last 12 months" : "last 6 months";
    return {
      id,
      input: {
        protocol,
        tx_hash: txHash,
        chain,
        issuer_entity: entity,
        period,
        trade_pair: "ETH/USDC",
      },
      // Every scenario in this seed plan buys the independent CRYPTO_PRICE_USD spot price
      // (blueprint §7.3) in addition to its own intents. First 10
      // scenarios buy all 5 own intents + price (6 calls); last 10 buy
      // 4 own intents (no sanctions screen — the policy records it as
      // "skipped") + price (5 calls). 10*6 + 10*5 = 110 M13 calls.
      intents:
        n <= 10
          ? [...M13_INTENTS, "CRYPTO_PRICE_USD"]
          : [...M13_INTENTS.slice(0, 4), "CRYPTO_PRICE_USD"],
    };
  });
}

const M12_NODES = ["TH_NP15_GEN-APND", "HB_NORTH", "ZONE_J", "DE-LU"];
const M12_INTERVALS = [
  "2026-11-19T00:00:00Z",
  "2026-11-19T06:00:00Z",
  "2026-11-19T12:00:00Z",
  "2026-11-19T18:00:00Z",
  "2026-11-18T12:00:00Z",
];
const M12_BREAKEVENS = [25, 40, 60, 90];

export function buildM12Scenarios(): M12ScenarioDef[] {
  const out: M12ScenarioDef[] = [];
  for (let i = 0; i < 15; i++) {
    out.push({
      id: `M12-${String(i + 1).padStart(2, "0")}`,
      input: {
        node_or_zone: M12_NODES[i % M12_NODES.length],
        interval_start: M12_INTERVALS[i % M12_INTERVALS.length],
        breakeven_usd_per_mwh: M12_BREAKEVENS[i % M12_BREAKEVENS.length],
      },
    });
  }
  return out;
}

export interface SeedCallJob {
  mission: "M13" | "M12";
  scenarioId: string;
  intent: string;
}

/**
 * Merge the flat per-mission call lists 7 M13 : 3 M12, repeating while
 * both lists still have calls, so a capped run buys the documented
 * split (first 10 = 7 M13 + 3 M12, first 13 = 10 M13 + 3 M12). The 7:3
 * pattern holds only for the first 100 calls; jobs 101–140 are all M13
 * once the 30 M12 calls are exhausted (overall 110:30 = 11:3). Pure
 * function — unit-tested, and the --plan dry-run trace prints the split
 * for --max-calls 10 and 13.
 */
export function buildMergedCallQueue(
  m13: M13ScenarioDef[],
  m12: M12ScenarioDef[],
  mission: "M13" | "M12" | "ALL",
): SeedCallJob[] {
  const m13Jobs: SeedCallJob[] = [];
  if (mission === "ALL" || mission === "M13") {
    for (const sc of m13) {
      for (const intent of sc.intents) m13Jobs.push({ mission: "M13", scenarioId: sc.id, intent });
    }
  }
  const m12Jobs: SeedCallJob[] = [];
  if (mission === "ALL" || mission === "M12") {
    for (const sc of m12) {
      for (const intent of M12_INTENTS) m12Jobs.push({ mission: "M12", scenarioId: sc.id, intent });
    }
  }
  const out: SeedCallJob[] = [];
  let i13 = 0;
  let i12 = 0;
  while (i13 < m13Jobs.length || i12 < m12Jobs.length) {
    for (let k = 0; k < 7 && i13 < m13Jobs.length; k++) out.push(m13Jobs[i13++]);
    for (let k = 0; k < 3 && i12 < m12Jobs.length; k++) out.push(m12Jobs[i12++]);
  }
  return out;
}

/** Split of the first N jobs of a merged queue (dry-run proof). */
export function queueSplit(queue: SeedCallJob[], n: number): { m13: number; m12: number } {
  let m13 = 0;
  let m12 = 0;
  for (const job of queue.slice(0, n)) {
    if (job.mission === "M13") m13 += 1;
    else m12 += 1;
  }
  return { m13, m12 };
}

interface Args {
  maxCalls: number;
  mission: "M13" | "M12" | "ALL";
  plan: boolean;
  outDir: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { maxCalls: 140, mission: "ALL", plan: false, outDir: "receipts" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-calls") args.maxCalls = Number(argv[++i]);
    else if (a === "--mission") args.mission = argv[++i] as Args["mission"];
    else if (a === "--plan") args.plan = true;
    else if (a === "--out") args.outDir = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(args.maxCalls) || args.maxCalls <= 0) {
    throw new Error("--max-calls must be a positive integer");
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const m13 = buildM13Scenarios();
  const m12 = buildM12Scenarios();
  const queue = buildMergedCallQueue(m13, m12, args.mission);
  const totalPlanned = queue.length;
  const split10 = queueSplit(queue, 10);
  const split13 = queueSplit(queue, 13);

  console.log(
    `verireceipt-desk seed: plan=${totalPlanned} calls ` +
      `(M13 ${m13.reduce((s, sc) => s + sc.intents.length, 0)} across ${m13.length} scenarios, ` +
      `M12 ${m12.length * M12_INTENTS.length} across ${m12.length} scenarios), ` +
      `max-calls=${args.maxCalls}, mission=${args.mission}`,
  );
  console.log(
    `merged 7:3 queue: first 10 = ${split10.m13} M13 + ${split10.m12} M12; ` +
      `first 13 = ${split13.m13} M13 + ${split13.m12} M12`,
  );
  if (args.plan) {
    for (const sc of m13) {
      console.log(`${sc.id} M13 ${sc.input.protocol} / ${sc.input.issuer_entity} / ${sc.input.chain} [${sc.intents.join(", ")}]`);
    }
    for (const sc of m12) {
      console.log(`${sc.id} M12 ${sc.input.node_or_zone} @ ${sc.input.interval_start} breakeven $${sc.input.breakeven_usd_per_mwh} [${[...M12_INTENTS].join(", ")}]`);
    }
    console.log("merged queue (first 13 jobs):");
    for (const [i, job] of queue.slice(0, 13).entries()) {
      console.log(`  ${i + 1}. ${job.mission} ${job.scenarioId} ${job.intent}`);
    }
    return;
  }

  const key = (process.env.DESK_PAYER_PRIVATE_KEY ?? "").trim();
  if (!key) {
    throw new Error("DESK_PAYER_PRIVATE_KEY is not set — refusing to run live calls without a payer key");
  }
  const client = new TelegraphClient({ privateKey: key as Hex });
  console.log(`payer: ${client.address} (escrow Diamond 0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b, Sepolia testnet)`);

  const outDir = resolve(process.cwd(), args.outDir);
  mkdirSync(outDir, { recursive: true });
  const ledgerPath = join(outDir, "ledger.jsonl");
  const decisionsPath = join(outDir, "decisions.jsonl");
  if (!existsSync(ledgerPath)) appendFileSync(ledgerPath, "");
  if (!existsSync(decisionsPath)) appendFileSync(decisionsPath, "");

  let callsMade = 0;
  let verified = 0;
  let failed = 0;
  let totalCost = 0;
  let decisions = 0;

  /**
   * Buy ONE call. The ask is a THUNK: the budget guard runs BEFORE the
   * thunk is invoked, so no paid call can ever fire past the cap. (The
   * pre-fix version took an eagerly-created promise and the ask fired
   * before the guard — the $0.02-gap root cause. Never pass a promise
   * here; always pass () => execute…Intent(…).)
   * Each bought call is logged to SQLite + ledger.jsonl immediately,
   * before the next call is bought, so a throw mid-scenario cannot
   * lose bought spend.
   */
  const buy = async (
    mission: "M13" | "M12",
    scenarioId: string,
    runId: string,
    askFn: () => Promise<AskResult>,
  ): Promise<AskResult | null> => {
    if (callsMade >= args.maxCalls) return null;
    const result = await askFn();
    callsMade += 1;
    const record = toCallRecord(result);
    totalCost += record.cost_uusdc;
    let verificationStatus = "failed";
    let verification: Record<string, unknown> = {};
    if (result.signal_hash) {
      const v = await client.verifySignal(result.signal_hash);
      verification = v.body;
      verificationStatus = v.verified ? "verified" : "failed";
      if (v.verified) verified += 1;
      else failed += 1;
    } else {
      failed += 1;
    }
    logDeskRun({
      run_id: runId,
      mission,
      scenario_id: scenarioId,
      intent: record.intent,
      miner_id: record.miner_id,
      miner_name: record.miner_name,
      signal_hash: record.signal_hash,
      receipt_hash: record.receipt_hash,
      receipt_json: JSON.stringify({ payments: record.payments, receipt: record.receipt }),
      cost_uusdc: record.cost_uusdc,
      rail: record.rail,
      verdict: null, // filled in by updateDeskRunVerdict once the scenario decides
      related_party: 1,
      fetched_at: record.fetched_at,
      verification_status: verificationStatus,
      verification_json: JSON.stringify(verification).slice(0, 4000),
    });
    if (result.signal_hash) {
      markDeskRunVerified(
        result.signal_hash,
        verificationStatus as "verified" | "failed",
        JSON.stringify(verification).slice(0, 4000),
      );
    }
    appendFileSync(
      ledgerPath,
      JSON.stringify({
        ...record,
        run_id: runId,
        mission,
        scenario_id: scenarioId,
        signal_url: record.signal_hash
          ? `https://devnode.telegraphprotocol.com/engine/v1/signal/${record.signal_hash}`
          : null,
        verification_status: verificationStatus,
        related_party: true,
      }) + "\n",
    );
    console.log(
      `[${callsMade}/${args.maxCalls}] ${mission} ${scenarioId} ${record.intent} ` +
        `miner=${record.miner_id ?? "?"} (${record.miner_name ?? "?"}) ` +
        `signal=${record.signal_hash ?? "none"} verified=${verificationStatus} ` +
        `cost=${record.cost_uusdc} uusdc rail=${record.rail}`,
    );
    return result;
  };

  const decide = (
    mission: "M13" | "M12",
    scenarioId: string,
    runId: string,
    input: M13Input | M12Input,
    calls: AskResult[],
    blockHeight?: number,
  ): void => {
    const decision =
      mission === "M13"
        ? decideM13(input as M13Input, calls)
        : decideM12(input as M12Input, calls, { expectedBlockHeight: blockHeight });
    decisions += 1;
    updateDeskRunVerdict(runId, decision.verdict);
    const row = {
      run_id: runId,
      mission,
      scenario_id: scenarioId,
      input,
      verdict: decision.verdict,
      checks: decision.checks,
      why: decision.why,
      total_cost_uusdc: calls.map(toCallRecord).reduce((s, c) => s + c.cost_uusdc, 0),
      decided_at: new Date().toISOString(),
      related_party: true,
    };
    appendFileSync(decisionsPath, JSON.stringify(row) + "\n");
    console.log(`  -> ${mission} ${scenarioId} VERDICT ${decision.verdict}`);
  };

  // Per-scenario state: one run_id per scenario, calls accumulate in
  // merged-queue order, decide as soon as the scenario is complete.
  const runIds = new Map<string, string>();
  const scenarioCalls = new Map<string, AskResult[]>();
  const decided = new Set<string>();
  const runIdFor = (scenarioId: string): string => {
    let id = runIds.get(scenarioId);
    if (!id) {
      id = `desk_${randomUUID()}`;
      runIds.set(scenarioId, id);
      scenarioCalls.set(scenarioId, []);
    }
    return id;
  };
  const m13ById = new Map(m13.map((sc) => [sc.id, sc]));
  const m12ById = new Map(m12.map((sc) => [sc.id, sc]));

  let blockHeight: number | null = null;
  for (const job of queue) {
    if (callsMade >= args.maxCalls) break;
    const runId = runIdFor(job.scenarioId);
    if (job.mission === "M13") {
      const def = m13ById.get(job.scenarioId) as M13ScenarioDef;
      const r = await buy("M13", job.scenarioId, runId, () =>
        executeM13Intent(client, job.intent, def.input),
      );
      if (r === null) break; // budget reached mid-scenario
      const calls = scenarioCalls.get(job.scenarioId) as AskResult[];
      calls.push(r);
      if (calls.length === def.intents.length) {
        decide("M13", job.scenarioId, runId, def.input, calls);
        decided.add(job.scenarioId);
      }
    } else {
      if (blockHeight === null) {
        blockHeight = await fetchBtcTipHeight();
        console.log(`bitcoin tip height for hashprice asks: ${blockHeight}`);
      }
      const def = m12ById.get(job.scenarioId) as M12ScenarioDef;
      const height = blockHeight;
      const r = await buy("M12", job.scenarioId, runId, () =>
        executeM12Intent(client, job.intent, def.input, height),
      );
      if (r === null) break;
      const calls = scenarioCalls.get(job.scenarioId) as AskResult[];
      calls.push(r);
      if (calls.length === M12_INTENTS.length) {
        decide("M12", job.scenarioId, runId, def.input, calls, blockHeight);
        decided.add(job.scenarioId);
      }
    }
  }

  for (const [scenarioId, calls] of scenarioCalls) {
    if (!decided.has(scenarioId) && calls.length > 0) {
      const expected =
        scenarioId.startsWith("M13")
          ? (m13ById.get(scenarioId) as M13ScenarioDef).intents.length
          : M12_INTENTS.length;
      console.log(`  -> ${scenarioId} PARTIAL (${calls.length}/${expected} calls) — no verdict, budget reached`);
    }
  }

  console.log(
    `DONE: ${callsMade} calls, ${verified} verified, ${failed} failed/unverified, ` +
      `${decisions} decisions, total cost ${totalCost} uusdc ($${(totalCost / 1_000_000).toFixed(2)})`,
  );
  console.log(`ledger: ${ledgerPath}`);
  console.log(`decisions: ${decisionsPath}`);
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch((err: unknown) => {
    console.error(`seed FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
