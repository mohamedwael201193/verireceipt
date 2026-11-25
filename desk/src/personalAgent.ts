// The personal-agent heartbeat (mission issue #197, Route 1): a self-hosted
// agent loop with wallet budget, logging and limits. Each watch declares an
// intent, params, a freshness window and a decision rule; every tick reuses
// a still-fresh verified answer or buys a new one from escrow, verifies it
// end to end, optionally cross-checks a second provider, evaluates the rule
// and appends a dated memo with receipts and the running day cost.
// Local CLI only: hosted spend and retention stay OFF, the payer key comes
// from a local secrets file and every purchase is testnet. The loop never
// acts on the world; the memo is the deliverable and any external effect is
// the user's own explicit decision.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DESK_DAILY_CAP_UUSDC, VERIRECEIPT_MINER_ID } from "./constants.js";
import { escrowAskMiner, type Fetch, type Payer } from "./client.js";
import { committedExposureUusdc, reserveSpend, type SpendLedger } from "./gate.js";
import { verifyPurchase } from "./verify.js";
import type { FieldStatus } from "../../src/core/shapedFields.js";

export interface WatchRule {
  op: "gte" | "lte" | "eq";
  value: string;
}

export interface CrossCheck {
  /** A DIFFERENT provider (engine miner id) bought for the same intent+params. */
  miner_id: string;
  /** Maximum allowed difference between the two verified values, in basis points of the larger magnitude. */
  tolerance_bps: number;
}

export interface Watch {
  id: string;
  intent: string;
  params: Record<string, string>;
  /** The intent answer field the agent decides on (e.g. lmp_usd_per_mwh). */
  field: string;
  rule: WatchRule;
  /** A verified answer younger than this is reused; no new purchase is made. */
  max_age_seconds: number;
  /** Primary provider; defaults to the VeriReceipt miner. */
  miner_id?: string;
  cross_check?: CrossCheck;
  /** Why this watch exists; carried into every memo. */
  rationale: string;
}

export interface MemoReceipt {
  miner_id: string;
  nonce: string;
  receipt_hash: string | null;
  charge_uusdc: string;
}

export interface Memo {
  version: 1;
  watch_id: string;
  at: string;
  status: "PASS" | "HOLD" | "SKIP" | "REUSED";
  /** The verified answer value as a decimal string, null when there is none. */
  result: string | null;
  source: string;
  uncertainty: string;
  rule: WatchRule;
  rule_outcome: "inside" | "outside" | null;
  reason: string | null;
  receipts: MemoReceipt[];
  /** This agent's settled+reserved purchases on this UTC day after this memo. */
  day_cost_uusdc: string;
}

function readMemos(file: string): Memo[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Memo);
}

function appendMemo(file: string, memo: Memo): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(memo) + "\n");
}

/** Exact decimal comparison of two non-scientific decimal strings. */
export function compareDecimals(a: string, b: string): number | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(a);
  const n = /^(-?)(\d+)(?:\.(\d+))?$/.exec(b);
  if (!m || !n) return null;
  const scale = Math.max((m[3] ?? "").length, (n[3] ?? "").length);
  const toInt = (g: RegExpExecArray): bigint => {
    const v = BigInt(g[2] + (g[3] ?? "").padEnd(scale, "0"));
    return g[1] === "-" ? -v : v;
  };
  const x = toInt(m);
  const y = toInt(n);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** |a-b| as basis points of the larger magnitude; null when either is not a decimal or both are zero-unequal. */
export function diffBps(a: string, b: string): number | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(a);
  const n = /^(-?)(\d+)(?:\.(\d+))?$/.exec(b);
  if (!m || !n) return null;
  const scale = Math.max((m[3] ?? "").length, (n[3] ?? "").length);
  const toInt = (g: RegExpExecArray): bigint => {
    const v = BigInt(g[2] + (g[3] ?? "").padEnd(scale, "0"));
    return g[1] === "-" ? -v : v;
  };
  const x = toInt(m);
  const y = toInt(n);
  const denom = x < 0n ? -x : x;
  const d = y < 0n ? -y : y;
  const mag = denom > d ? denom : d;
  if (mag === 0n) return x === y ? 0 : null;
  const diff = x > y ? x - y : y - x;
  return Number((diff * 10000n) / mag);
}

function ruleOutcome(rule: WatchRule, value: string): "inside" | "outside" | null {
  const c = compareDecimals(value, rule.value);
  if (c === null) return null;
  if (rule.op === "eq") return c === 0 ? "inside" : "outside";
  if (rule.op === "gte") return c >= 0 ? "inside" : "outside";
  return c <= 0 ? "inside" : "outside";
}

function dayCostUusdc(memos: Memo[], extra: MemoReceipt[], now: Date): string {
  const day = now.toISOString().slice(0, 10);
  let sum = 0n;
  for (const m of memos) {
    if (!m.at.startsWith(day)) continue;
    for (const r of m.receipts) sum += BigInt(r.charge_uusdc);
  }
  for (const r of extra) sum += BigInt(r.charge_uusdc);
  return sum.toString();
}

interface AskBody {
  miner_id?: string;
  result?: Record<string, unknown>;
  field_status?: Record<string, FieldStatus>;
  signal_hash?: string;
}

interface BuyOutcome {
  ok: boolean;
  value: string | null;
  source: string;
  uncertainty: string;
  reason: string | null;
  receipts: MemoReceipt[];
}

export interface HeartbeatOptions {
  /** Shared reservation journal (spendLedgerFromFiles); every purchase joins the cross-agent daily cap. */
  spend: SpendLedger;
  memosFile: string;
  dailyCapUusdc?: bigint;
  /** Every id the node may use for the primary miner (catalogue id + registration id). */
  minerIds?: readonly string[];
  now?: () => Date;
  f?: Fetch;
  /** Injected verifier for unit tests; production uses the real end-to-end verifier. */
  verify?: typeof verifyPurchase;
  log?: (line: string) => void;
}

export async function runHeartbeat(payer: Payer, watches: Watch[], opts: HeartbeatOptions): Promise<Memo[]> {
  const now = (opts.now ?? (() => new Date()))();
  const log = opts.log ?? (() => {});
  const cap = opts.dailyCapUusdc ?? DESK_DAILY_CAP_UUSDC;
  const out: Memo[] = [];
  for (const w of watches) {
    const prior = readMemos(opts.memosFile);
    const fresh = prior
      .filter((m) => m.watch_id === w.id && m.status === "PASS" && m.result !== null)
      .filter((m) => now.getTime() - new Date(m.at).getTime() <= w.max_age_seconds * 1000)
      .sort((a, b) => b.at.localeCompare(a.at))[0];
    if (fresh) {
      log(`${w.id}: fresh verified answer from ${fresh.at}, no new purchase`);
      const memo: Memo = {
        version: 1,
        watch_id: w.id,
        at: now.toISOString(),
        status: "REUSED",
        result: fresh.result,
        source: `heartbeat cache · verified purchase at ${fresh.at}`,
        uncertainty: `answer is ${Math.round((now.getTime() - new Date(fresh.at).getTime()) / 1000)} s old; declared freshness window ${w.max_age_seconds} s`,
        rule: w.rule,
        rule_outcome: fresh.result ? ruleOutcome(w.rule, fresh.result) : null,
        reason: null,
        receipts: [],
        day_cost_uusdc: dayCostUusdc(prior, [], now),
      };
      appendMemo(opts.memosFile, memo);
      out.push(memo);
      continue;
    }
    const buy = await buyVerified(payer, w, w.miner_id ?? VERIRECEIPT_MINER_ID, opts.minerIds, cap, now, opts, `paid purchase · ${w.intent}`);
    const receipts: MemoReceipt[] = [...buy.receipts];
    if (!buy.ok) {
      const memo = holdMemo(w, now, prior, receipts, buy.reason ?? "purchase failed");
      appendMemo(opts.memosFile, memo);
      out.push(memo);
      continue;
    }
    let value = buy.value!;
    let source = buy.source;
    let uncertainty = buy.uncertainty;
    if (w.cross_check) {
      const other = await buyVerified(payer, w, w.cross_check.miner_id, [w.cross_check.miner_id], cap, now, opts, `cross-check purchase · ${w.intent}`);
      receipts.push(...other.receipts);
      if (!other.ok) {
        const memo = holdMemo(w, now, prior, receipts, `cross-check unavailable: ${other.reason}`);
        appendMemo(opts.memosFile, memo);
        out.push(memo);
        continue;
      }
      const bps = diffBps(value, other.value!);
      if (bps === null || bps > w.cross_check.tolerance_bps) {
        const memo = holdMemo(
          w,
          now,
          prior,
          receipts,
          `conflicting provider answers: ${value} vs ${other.value} (${bps === null ? "not comparable" : `${bps} bps`} > ${w.cross_check.tolerance_bps} bps tolerance); no answer is served until a human reviews`,
        );
        memo.result = null;
        appendMemo(opts.memosFile, memo);
        out.push(memo);
        continue;
      }
      source += ` · cross-checked against miner ${w.cross_check.miner_id} (${bps} bps apart, within ${w.cross_check.tolerance_bps} bps)`;
    }
    const outcome = ruleOutcome(w.rule, value);
    const memo: Memo = {
      version: 1,
      watch_id: w.id,
      at: now.toISOString(),
      status: "PASS",
      result: value,
      source,
      uncertainty,
      rule: w.rule,
      rule_outcome: outcome,
      reason: null,
      receipts,
      day_cost_uusdc: dayCostUusdc(prior, receipts, now),
    };
    appendMemo(opts.memosFile, memo);
    out.push(memo);
    log(`${w.id}: ${value} rule ${w.rule.op} ${w.rule.value} → ${outcome} (${receipts.length} receipt(s), day cost ${memo.day_cost_uusdc} μUSDC)`);
  }
  return out;
}

function holdMemo(w: Watch, now: Date, prior: Memo[], receipts: MemoReceipt[], reason: string): Memo {
  const status = /daily cap/.test(reason) ? "SKIP" : "HOLD";
  return {
    version: 1,
    watch_id: w.id,
    at: now.toISOString(),
    status,
    result: null,
    source: "none",
    uncertainty: "no fresh verified answer this tick",
    rule: w.rule,
    rule_outcome: null,
    reason,
    receipts,
    day_cost_uusdc: dayCostUusdc(prior, receipts, now),
  };
}

async function buyVerified(
  payer: Payer,
  w: Watch,
  minerId: string,
  acceptedIds: readonly string[] | undefined,
  cap: bigint,
  now: Date,
  opts: HeartbeatOptions,
  sourceLabel: string,
): Promise<BuyOutcome> {
  const none: MemoReceipt[] = [];
  let paid;
  try {
    paid = await escrowAskMiner(minerId, { intent: w.intent, params: w.params }, payer, {
      spentTodayUusdc: committedExposureUusdc(opts.spend, now),
      dailyCapUusdc: cap,
      minerIds: acceptedIds ?? [minerId],
      f: opts.f,
      onBeforeSign: ({ amountUusdc, authorization }) =>
        reserveSpend(opts.spend, "heartbeat", amountUusdc, authorization.nonce, cap, now),
    });
  } catch (e) {
    return { ok: false, value: null, source: "none", uncertainty: "no answer purchased", reason: `failed payment: ${(e as Error).message}`, receipts: none };
  }
  const receipt: MemoReceipt = {
    miner_id: minerId,
    nonce: paid.authorization.nonce,
    receipt_hash: paid.receipt.receipt_hash,
    charge_uusdc: String(paid.receipt.amount_uusdc),
  };
  const body = paid.body as AskBody;
  const signalHash = String(body.signal_hash ?? "");
  if (!/^0x[0-9a-f]{64}$/.test(signalHash)) {
    return { ok: false, value: null, source: "none", uncertainty: "no answer purchased", reason: "paid reply carried no signal_hash", receipts: [receipt] };
  }
  const verify = opts.verify ?? verifyPurchase;
  const v = await verify(
    {
      payer: paid.authorization.from,
      minerSlug: minerId,
      signalHash,
      valueField: w.field,
      engineResult: body.result ?? {},
      intent: w.intent,
      fieldStatus: body.field_status,
    },
    opts.f,
  );
  if (!v.verified) {
    const failed = v.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; ");
    return { ok: false, value: null, source: "none", uncertainty: "purchase failed verification", reason: `paid answer failed end-to-end verification (${failed}); the charge stands and no answer is served`, receipts: [receipt] };
  }
  const field = v.fields?.[w.field];
  const value = field === undefined ? null : String(typeof field === "object" && field !== null && "value" in field ? (field as { value: unknown }).value : field);
  if (value === null || value === "undefined") {
    return { ok: false, value: null, source: "none", uncertainty: "verified answer lacked the decision field", reason: `verified answer carried no ${w.field} field`, receipts: [receipt] };
  }
  return {
    ok: true,
    value,
    source: `${sourceLabel} · miner ${minerId} · verified end to end · bought ${new Date(paid.receipt.timestamp * 1000).toISOString()}`,
    uncertainty: `signal ${v.signalTimestamp ?? "unknown age"}; answer reflects its sources' own windows`,
    reason: null,
    receipts: [receipt],
  };
}
