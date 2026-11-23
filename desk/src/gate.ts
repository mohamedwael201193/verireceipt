// The live pre-execution evidence gate: one new input -> one fresh paid,
// auto-routed purchase -> layered verification -> PASS/HOLD against a rule
// that was committed to disk before any run. Fail-closed everywhere: any
// refusal, verification gap or invalid value is a HOLD, never a guess.
// A PASS is advisory evidence only; the gate never executes an action.
//
// Spend accounting: the quote is journaled to a shared reservations file
// BEFORE anything is signed (a journal failure refuses the signature), the
// check+reserve runs under an exclusive lock file so concurrent runs across
// the desk/gate/benchmark ledgers share one daily cap, and any attempt that
// reached a signature records worst-case spend when the outcome is unknown.
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import {exactNumericEqual} from './exactNumeric.js';
import { createHash } from "node:crypto";
import { DESK_DAILY_CAP_UUSDC, ENGINE_URL, MAX_WINDOW_SECONDS, VERIRECEIPT_ONCHAIN_MINER_IDS } from "./constants.js";
import { escrowAskAuto, type Fetch, type Payer, type RawResponse, type SignNotice } from "./client.js";
import { EscrowRefusal } from "./escrow.js";
import { gateTask, policyObjectHash, ruleHolds, type GatePolicy, type GateTask } from "./gatePolicy.js";
import { caisoHour, nyisoInterval } from "./missions.js";
import {
  BOUGHT_AT_SLACK_MS,
  canonicalPayloadJson,
  checkDelivery,
  checkEpochConsistency,
  fetchEpochBlock,
  merkleProofShapeOk,
  parseEngineRequest,
  parseTimeMs,
  paramsEqual,
  signalHashOf,
  verifyPurchase,
  type Check,
  type DeliveryProof,
  type SignalPayload,
} from "./verify.js";
import type { FieldStatus } from "../../src/core/shapedFields.js";
import { verifyFilingSource } from "./filingSource.js";
import { gridContract, verifyGridSource } from "./gridSource.js";
import { txContract, verifyTxSource } from "./txSource.js";
import { reconcilePrimaryAnswer, type SourceVerification } from "./sourceTypes.js";

export const GATE_LIMITS = [
  "Advisory evidence only: a PASS never executes a dispatch, trade or allocation. The run's only effects are the Sepolia testnet escrow purchase itself (payment and the node's public records), a journaled spend reservation and this audit record.",
  "Related-party Sepolia testnet purchase through network-ranked auto-routing; not independent adoption, customer revenue or a mainnet claim.",
  "Node-level checks bind the payment, signal hash, wallet, intent, serving identity, signal freshness, delivery identity and epoch; a fresh purchase's delivery may legitimately still be pending its epoch block (recorded as delivery_status).",
  "The miner raw-byte chain is checked only when the receipt names a known VeriReceipt registration AND the payload identity is consistent with it; for another provider that layer is recorded as not_applicable, never silently skipped. A payload claiming VeriReceipt under an unknown registration fails the identity check instead of downgrading verification.",
  "The rule for this task was committed to the repository before any gate run (policy and task hashes in this record). Precommitment covers the committed policy file; operator params are limited to the task's accepts_params keys and are recorded verbatim in the record.",
  "The delivery Merkle proof is shape-checked only (array of 32-byte hashes plus root; the leaf/node hash algorithm is not documented), not walked.",
] as const;

export const PROBE_LIMITS = [
  "Benchmark probe: buys and verifies a fresh answer for one frozen benchmark case. No decision rule is evaluated; the frozen case set's graders score the value. The outcome is ANSWERED or ABSTAIN, never PASS/HOLD.",
  "The case set (hash in this record) was committed before any arm answered; the probe binds the case id and case-set hash, not a gate policy.",
  "Related-party Sepolia testnet purchase through network-ranked auto-routing; not independent adoption, customer revenue or a mainnet claim.",
  "A fresh purchase's delivery may legitimately still be pending its epoch block (recorded as delivery_status); the delivery Merkle proof is shape-checked only, not walked.",
] as const;

export interface PurchaseEvidence {
  routed: "auto";
  quoted_uusdc: string;
  paid_uusdc: string | null;
  /**
   * The signed amount when a payment was signed/submitted but the settled
   * outcome is unknown (e.g. the paid fetch failed or the receipt did not
   * decode): the exposure the daily cap must assume. Null when nothing was
   * signed or the settled amount is known.
   */
  worst_case_uusdc: string | null;
  receipt_hash: string | null;
  epoch_id: number | null;
  serving_miner: string | null;
  serving_miner_slug: string | null;
  duration_ms: number | null;
  nonce: string | null;
}

export interface GateRun {
  version: 1;
  gate_id: string;
  policy_version: string;
  policy_hash: string;
  /** sha256 (canonical JSON) of the exact task (incl. rule) this run evaluated. */
  task_hash: string;
  evaluated_at: string;
  mission: string;
  title: string;
  intent: string;
  params: Record<string, string>;
  rule: { op: string; value: number; units: string; label: string };
  payer: string;
  purchase: PurchaseEvidence;
  signal_hash: string | null;
  value: unknown;
  delivery_status: "included" | "pending" | "error" | null;
  node_checks: Check[];
  miner_chain: "passed" | "failed" | "not_applicable";
  miner_checks: Check[];
  source_verification?: SourceVerification;
  outcome: "PASS" | "HOLD";
  reasons: string[];
  limits: readonly string[];
  /** False when the audit append itself failed; the returned record is the only copy. */
  record_appended: boolean;
}

export interface ProbeRun {
  version: 1;
  kind: "benchmark-probe";
  case_id: string;
  cases_version: string;
  /** sha256 (canonical JSON) of the frozen case set — named honestly, not a policy hash. */
  cases_hash: string;
  evaluated_at: string;
  question: string;
  intent: string;
  params: Record<string, string>;
  value_field: string;
  case_input_hash: string;
  payer: string;
  purchase: PurchaseEvidence;
  signal_hash: string | null;
  value: unknown;
  delivery_status: "included" | "pending" | "error" | null;
  node_checks: Check[];
  miner_chain: "passed" | "failed" | "not_applicable";
  miner_checks: Check[];
  source_verification?: SourceVerification;
  outcome: "ANSWERED" | "ABSTAIN";
  reasons: string[];
  limits: readonly string[];
  record_appended: boolean;
}

// ---------------------------------------------------------------------------
// Shared spend reservations (fix: journal before signing, atomic check+reserve)

export interface SpendReservation {
  kind: string;
  nonce: string;
  amount_uusdc: string;
  reserved_at: string;
}

/** A settlement row retires a reservation only in the same snapshot that counts it. */
export interface SettlementSnapshot {
  settledTodayUusdc: bigint;
  settledNonces: Set<string>;
}

export interface SpendLedger {
  /** Optional crash-durable journal writer, required by the local Research Desk. */
  writeReservation?: (reservation: SpendReservation) => void;
  reservationsFile: string;
  lockFile: string;
  readSettlementSnapshot: () => SettlementSnapshot;
  /** Diagnostic conveniences only. Never combine separate calls for cap checks. */
  settledTodayUusdc: () => bigint;
  settledNonces: () => Set<string>;
}

function readJsonl(file: string): unknown[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Outstanding (not yet settled) reserved exposure for the current UTC day. */
export function outstandingReservationsUusdc(reservationsFile: string, settledNonces: Set<string>, now: Date): bigint {
  const day = now.toISOString().slice(0, 10);
  let sum = 0n;
  for (const raw of readJsonl(reservationsFile)) {
    const r = raw as Partial<SpendReservation>;
    if (typeof r.nonce !== "string" || typeof r.amount_uusdc !== "string" || typeof r.reserved_at !== "string") continue;
    if (r.reserved_at.slice(0, 10) !== day) continue; // a signed authorization expires in ~2 minutes
    if (settledNonces.has(r.nonce)) continue;
    sum += BigInt(r.amount_uusdc);
  }
  return sum;
}

/** Exclusive cross-process lock via create-exclusive; busy retry up to ~5s, then fail closed. */
function withFileLock<T>(lockFile: string, fn: () => T): T {
  const deadline = Date.now() + 5000;
  const sab = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = openSync(lockFile, "wx");
      try {
        return fn();
      } finally {
        closeSync(fd);
        rmSync(lockFile, { force: true });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST" && Date.now() < deadline) {
        Atomics.wait(sab, 0, 0, 25);
        continue;
      }
      throw e;
    }
  }
}

/**
 * Atomic check+reserve: under the lock, recompute settled + outstanding spend
 * and refuse if the new reservation would cross the daily cap; otherwise
 * journal the reservation. Runs BEFORE any signature; a journal failure
 * refuses the signature (fail closed).
 */
export function reserveSpend(
  spend: SpendLedger,
  kind: string,
  amountUusdc: bigint,
  nonce: string,
  dailyCapUusdc: bigint,
  now: Date,
): void {
  withFileLock(spend.lockFile, () => {
    const committed = committedExposureUusdc(spend, now);
    if (committed + amountUusdc > dailyCapUusdc) {
      throw new EscrowRefusal(
        `reservation would cross the Desk daily cap ${dailyCapUusdc} μUSDC (settled+reserved ${committed}, new ${amountUusdc})`,
      );
    }
    const r: SpendReservation = { kind, nonce, amount_uusdc: amountUusdc.toString(), reserved_at: now.toISOString() };
    if(spend.writeReservation)spend.writeReservation(r);
    else appendFileSync(spend.reservationsFile, JSON.stringify(r) + "\n");
  });
}

/**
 * Read every append-only settlement ledger once per snapshot. Both the sum
 * and nonce set derive from those exact rows, never from separate file reads.
 * A concurrent append is either counted with its nonce or is still covered
 * by its reservation. A partial JSONL append throws, refusing the signature.
 */
export function spendLedgerFromFiles(
  files: { reservationsFile: string; lockFile: string; purchasesFile?: string; runLedgerFiles: string[] },
  now: () => Date = () => new Date(),
): SpendLedger {
  const readSettlementSnapshot = (): SettlementSnapshot => {
    const day = now().toISOString().slice(0, 10);
    let sum = 0n;
    const nonces = new Set<string>();
    if (files.purchasesFile) {
      for (const raw of readJsonl(files.purchasesFile)) {
        const p = raw as { bought_at?: string; nonce?: string; telegraph_receipt?: { amount_uusdc?: string } };
        if (typeof p.bought_at === "string" && p.bought_at.slice(0, 10) === day && typeof p.telegraph_receipt?.amount_uusdc === "string") {
          sum += BigInt(p.telegraph_receipt.amount_uusdc);
          if (typeof p.nonce === "string") nonces.add(p.nonce);
        }
      }
    }
    for (const file of files.runLedgerFiles) {
      for (const raw of readJsonl(file)) {
        const g = raw as { evaluated_at?: string; purchase?: { nonce?: string | null; paid_uusdc?: string | null; worst_case_uusdc?: string | null } };
        const amount = g.purchase?.paid_uusdc ?? g.purchase?.worst_case_uusdc;
        if (typeof g.evaluated_at === "string" && g.evaluated_at.slice(0, 10) === day && typeof amount === "string") {
          sum += BigInt(amount);
          if (typeof g.purchase?.nonce === "string") nonces.add(g.purchase.nonce);
        }
      }
    }
    return { settledTodayUusdc: sum, settledNonces: nonces };
  };
  return {
    reservationsFile: files.reservationsFile,
    lockFile: files.lockFile,
    readSettlementSnapshot,
    settledTodayUusdc: () => readSettlementSnapshot().settledTodayUusdc,
    settledNonces: () => readSettlementSnapshot().settledNonces,
  };
}

/** One matched settlement snapshot for every production exposure check. */
export function committedExposureUusdc(spend: SpendLedger, now: Date): bigint {
  const snapshot = spend.readSettlementSnapshot();
  return snapshot.settledTodayUusdc + outstandingReservationsUusdc(spend.reservationsFile, snapshot.settledNonces, now);
}

// ---------------------------------------------------------------------------

export interface GateOptions {
  policy: GatePolicy;
  /** Must equal policyObjectHash(policy); a mismatch refuses to run (no copied rules under an unchanged hash). */
  policyHash: string;
  ledgerFile: string;
  /** Param overrides for this run (the new input). Keys must be in the task's accepts_params. */
  overrides?: Record<string, string>;
  spend: SpendLedger;
  now?: () => Date;
  f?: Fetch;
  onRawResponse?: (raw: RawResponse) => void | Promise<void>;
  secUserAgent?: string;
  /** Additional durable authority, awaited before any signature. Never replaces the local cap. */
  durableBeforeSign?: (notice: SignNotice) => Promise<void>;
}

/** Resolve a task's params: fixed, then dynamic (computed from `now`), then operator overrides. */
export function resolveGateParams(task: GateTask, overrides: Record<string, string> | undefined, now: Date): Record<string, string> {
  const params: Record<string, string> = { ...task.fixed_params };
  for (const [k, kind] of Object.entries(task.dynamic_params ?? {})) {
    params[k] = kind === "caiso_hour" ? caisoHour(now) : nyisoInterval(now);
  }
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (!task.accepts_params.includes(k)) throw new Error(`param ${k} is not in ${task.id}'s accepts_params (${task.accepts_params.join(", ")})`);
    if (typeof v !== "string" || !v) throw new Error(`param ${k} must be a non-empty string`);
    params[k] = v;
  }
  return params;
}

interface NodeLevel {
  ok: boolean;
  checks: Check[];
  value: unknown;
  minerSlug: string | null;
  delivery: "included" | "pending" | "error";
  providerResponse?: Record<string, unknown>;
}

/**
 * Miner-agnostic delivery identity (the existing deliveryIsOk pins the
 * VeriReceipt registration ids; an auto-routed purchase may be served by any
 * provider). An included row must match the receipt exactly: hash, payer,
 * amount, intent and the serving miner the receipt named.
 */
function gateDeliveryOk(d: DeliveryProof, receipt: { receipt_hash: string; amount_uusdc: string; miner: string }, payer: string, intent: string): boolean {
  if (d.status !== "included" || !d.delivery) return false;
  if (typeof d.delivery.receipt_hash !== "string" || d.delivery.receipt_hash !== receipt.receipt_hash) return false;
  if (String(d.delivery.payer ?? "").toLowerCase() !== payer.toLowerCase()) return false;
  if (Number(d.delivery.usdc) !== Number(receipt.amount_uusdc)) return false;
  if (String(d.delivery.intent ?? "") !== intent) return false;
  if (String(d.delivery.miner_id ?? "") !== receipt.miner) return false;
  return true;
}

/**
 * Miner-agnostic verification over the node's public records: signal hash
 * re-derived from the canonical payload, payload wallet is the payer, serving
 * identity present and consistent with the receipt registration, the signal
 * is fresh (its timestamp belongs to this purchase and this run), the intent
 * and params match what was asked, the engine's value equals the provider's
 * recorded answer, the delivery is included with exact identity and proof
 * shape — or legitimately pending — and the receipt time belongs to its epoch.
 */
export async function verifyNodeLevel(
  input: {
    payer: string;
    signalHash: string;
    intent: string;
    askedParams: Record<string, string>;
    valueField: string;
    engineResult: Record<string, unknown>;
    /** Node field_status from the paid reply; the decision field must be shaped "ok". */
    fieldStatus?: Record<string, string>;
    exactNumericTransport?: boolean;
    receipt: { receipt_hash: string; amount_uusdc: string; epoch_id: number; timestamp: number; miner: string };
    runStartedMs: number;
    verifiedAtMs: number;
  },
  f: Fetch,
): Promise<NodeLevel> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  let value: unknown = undefined;
  let minerSlug: string | null = null;

  const sigRes = await f(`${ENGINE_URL}/v1/signal/${input.signalHash}`);
  if (!sigRes.ok) {
    add("signal record", false, `GET /engine/v1/signal/{hash} HTTP ${sigRes.status}`);
    return { ok: false, checks, value, minerSlug, delivery: "error" };
  }
  const sig = (await sigRes.json()) as { signal_hash?: string; payload?: SignalPayload };
  const derived = signalHashOf(sig.payload);
  add("signal hash re-derived", derived === input.signalHash && sig.signal_hash === input.signalHash, `keccak256(payload)=${derived}`);
  add("signal wallet is the payer", String(sig.payload?.wallet_address).toLowerCase() === input.payer.toLowerCase(), String(sig.payload?.wallet_address));
  minerSlug = typeof sig.payload?.miner_slug === "string" && sig.payload.miner_slug ? sig.payload.miner_slug : null;

  // Serving identity must be present and consistent with the receipt's
  // on-chain registration in both directions. A payload claiming VeriReceipt
  // under an unknown registration fails here instead of silently skipping
  // the raw-byte layer; a VeriReceipt registration with a foreign slug fails too.
  const receiptMiner = input.receipt.miner;
  const knownVeriReceipt = VERIRECEIPT_ONCHAIN_MINER_IDS.includes(receiptMiner);
  const slugIsVeriReceipt = minerSlug === "verireceipt";
  add("serving miner identity present", receiptMiner !== "" && minerSlug !== null,
    `registration=${receiptMiner || "missing"} slug=${minerSlug ?? "missing"}`);
  add("serving identity consistent with the receipt registration", minerSlug !== null && knownVeriReceipt === slugIsVeriReceipt,
    `registration ${receiptMiner} ${knownVeriReceipt ? "is" : "is not"} a known VeriReceipt id; slug ${JSON.stringify(minerSlug)}`);

  // Freshness: the signal must belong to THIS purchase, not a replayed one.
  const sigMs = parseTimeMs(sig.payload?.timestamp);
  add("signal timestamp present", sigMs !== null, String(sig.payload?.timestamp ?? "missing"));
  if (sigMs !== null) {
    const receiptMs = input.receipt.timestamp * 1000;
    add("signal timestamp within the signed purchase window",
      sigMs >= receiptMs - MAX_WINDOW_SECONDS * 1000 - BOUGHT_AT_SLACK_MS && sigMs <= receiptMs + BOUGHT_AT_SLACK_MS,
      `signal ${new Date(sigMs).toISOString()} vs receipt ${new Date(receiptMs).toISOString()}`);
    add("signal timestamp belongs to this run",
      sigMs >= input.runStartedMs - BOUGHT_AT_SLACK_MS && sigMs <= input.verifiedAtMs + BOUGHT_AT_SLACK_MS,
      `signal ${new Date(sigMs).toISOString()} vs run ${new Date(input.runStartedMs).toISOString()} .. ${new Date(input.verifiedAtMs).toISOString()}`);
  }

  const parsed = parseEngineRequest(sig.payload?.request);
  const signalParams = parsed?.params ?? null;
  add("signal intent", sig.payload?.intent_id === input.intent && parsed !== null && parsed.intentId === input.intent, String(sig.payload?.intent_id));
  add("signal params match the asked input", paramsEqual(input.askedParams, signalParams), JSON.stringify(signalParams));
  const response = sig.payload?.response ?? {};
  value = response[input.valueField];
  const engineValue = input.engineResult[input.valueField];
  add("engine value equals provider answer", engineValue !== undefined && engineValue !== null && (input.exactNumericTransport ? exactNumericEqual(engineValue,value) : engineValue === value),
    `${input.valueField}: engine=${JSON.stringify(engineValue)} provider=${JSON.stringify(value)}`);
  // A numeric answer whose field the node marked unavailable/missing/rejected
  // is not evidence (a placeholder 0 must never satisfy a <= rule).
  const fieldState = input.fieldStatus ? input.fieldStatus[input.valueField] : undefined;
  add("value field status is ok", fieldState === "ok",
    input.fieldStatus ? `field_status[${input.valueField}]=${String(fieldState)}` : "no field_status in the paid reply");

  const d = await checkDelivery(input.receipt.epoch_id, input.receipt.receipt_hash, f);
  const epoch = await checkEpochConsistency({ claimedEpoch: input.receipt.epoch_id, receiptTimeMs: input.receipt.timestamp * 1000 }, f);
  // A fresh purchase's epoch block is usually not recorded yet. "Pending" is
  // acceptable only with POSITIVE predecessor evidence: the previous epoch's
  // block is recorded AND its window endpoints parse (a recorded probe whose
  // window lookup fails never legitimizes pending), and the claimed epoch is
  // consistent. A vacuous "no latest epoch found" never legitimizes pending.
  const prev = d.status === "pending" && input.receipt.epoch_id > 0
    ? await fetchEpochBlock(input.receipt.epoch_id - 1, f)
    : null;
  const prevWindowOk = prev !== null && prev.status === "recorded"
    && prev.epoch_id === input.receipt.epoch_id - 1
    && prev.windowFromMs != null && prev.windowToMs != null
    && prev.windowFromMs < prev.windowToMs
    && prev.windowToMs <= input.receipt.timestamp * 1000;
  add("delivery included with exact identity and proof shape, or legitimately pending",
    d.status === "included"
      ? d.epochId === input.receipt.epoch_id && gateDeliveryOk(d, input.receipt, input.payer, input.intent) && merkleProofShapeOk(d)
      : d.status === "pending" && epoch.ok && prevWindowOk,
    d.status === "included" ? "included" : `${d.status}: ${d.detail} (previous epoch ${prev ? `${prev.status}${prevWindowOk ? " with recorded window" : ", window missing or inconsistent"}` : "none"})`);
  add("receipt time belongs to recorded epoch", epoch.ok, epoch.failures.join("; ") || "epoch window agrees");

  return { ok: checks.every((c) => c.ok), checks, value:input.exactNumericTransport?engineValue:value, minerSlug, delivery: d.status, providerResponse: response };
}

interface VerifiedCore {
  purchase: PurchaseEvidence;
  signal_hash: string | null;
  value: unknown;
  delivery_status: "included" | "pending" | "error" | null;
  node_checks: Check[];
  miner_chain: "passed" | "failed" | "not_applicable";
  miner_checks: Check[];
  source_verification?: SourceVerification;
  provider_response?: Record<string, unknown>;
  /** Verification failures (purchase refusals included); empty when the evidence stands. */
  reasons: string[];
  evidenceOk: boolean;
}

/**
 * One fresh paid auto-routed purchase plus layered verification. Never
 * throws: a refused or unverifiable purchase is returned as failed evidence
 * with worst-case spend recorded for anything that reached a signature.
 */
export async function executeVerifiedPurchase(
  input: { intent: string; params: Record<string, string>; valueField: string; kind: string },
  payer: Payer,
  opts: { exactNumericTransport?: boolean; spend: SpendLedger; now?: () => Date; f?: Fetch; onRawResponse?: (raw: RawResponse) => void | Promise<void>; secUserAgent?: string; durableBeforeSign?: (notice: SignNotice) => Promise<void> },
): Promise<VerifiedCore> {
  const nowDate = (opts.now ?? (() => new Date()))();
  const f = opts.f ?? fetch;
  const purchase: PurchaseEvidence = {
    routed: "auto", quoted_uusdc: "0", paid_uusdc: null, worst_case_uusdc: null,
    receipt_hash: null, epoch_id: null, serving_miner: null, serving_miner_slug: null, duration_ms: null, nonce: null,
  };
  const failed = (reasons: string[], extra?: Partial<VerifiedCore>): VerifiedCore => ({
    purchase, signal_hash: null, value: null, delivery_status: null,
    node_checks: extra?.node_checks ?? [], miner_chain: extra?.miner_chain ?? "not_applicable",
    miner_checks: extra?.miner_checks ?? [], reasons, evidenceOk: false, ...extra,
  });

  // Under-specified grid questions must not consume a paid authorization.
  // The old frozen v1 cases/policy are left unchanged; their grid requests
  // have no market selector and therefore abstain under this new contract.
  if (input.intent === "GRID_POWER_PRICE_GENERAL") {
    try { gridContract(input.params); }
    catch (error) { return failed([`grid contract: ${error instanceof Error ? error.message : String(error)}`]); }
  }

  if (input.intent === "ONCHAIN_TX_LOOKUP_GENERAL") {
    try { txContract(input.params); }
    catch (error) { return failed([`TX contract: ${error instanceof Error ? error.message : String(error)}`]); }
  }

  // The quote+nonce are reserved BEFORE signing (inside onBeforeSign), under
  // the shared lock. If the reservation cannot be journaled, the signature
  // is refused and worst_case stays null (nothing was signed).
  let reservedUusdc: string | null = null;
  let reservedNonce: string | null = null;
  try {
    const started = Date.now();
    const spentPre = committedExposureUusdc(opts.spend, nowDate);
    const paid = await escrowAskAuto({ intent: input.intent, params: input.params }, payer, {
      spentTodayUusdc: spentPre,
      dailyCapUusdc: DESK_DAILY_CAP_UUSDC,
      f,
      onBeforeSign: async ({ amountUusdc, authorization }) => {
        reserveSpend(opts.spend, input.kind, amountUusdc, authorization.nonce, DESK_DAILY_CAP_UUSDC, nowDate);
        reservedUusdc = amountUusdc.toString();
        reservedNonce = authorization.nonce;
        await opts.durableBeforeSign?.({ amountUusdc, authorization });
      },
      onRawResponse: opts.onRawResponse,
    });
    purchase.quoted_uusdc = paid.quotedUusdc.toString();
    purchase.paid_uusdc = String(paid.receipt.amount_uusdc);
    purchase.receipt_hash = paid.receipt.receipt_hash;
    purchase.epoch_id = paid.receipt.epoch_id;
    purchase.serving_miner = String(paid.receipt.miner);
    purchase.duration_ms = Date.now() - started;
    purchase.nonce = paid.authorization.nonce;

    const body = paid.body as {
      result?: Record<string, unknown>;
      field_status?: Record<string, string>;
      signal_hash?: string;
    };
    const signalHash = String(body.signal_hash ?? "");
    const validHash = /^0x[0-9a-f]{64}$/.test(signalHash) ? signalHash : null;

    let node: NodeLevel;
    if (!validHash) {
      node = { ok: false, checks: [{ name: "signal_hash present", ok: false, detail: "no signal_hash in the paid reply" }], value: undefined, minerSlug: null, delivery: "error" };
    } else {
      node = await verifyNodeLevel(
        {
          payer: paid.authorization.from,
          signalHash: validHash,
          intent: input.intent,
          askedParams: input.params,
          exactNumericTransport: opts.exactNumericTransport,
          valueField: input.valueField,
          engineResult: body.result ?? {},
          fieldStatus: body.field_status as Record<string, string> | undefined,
          receipt: {
            receipt_hash: paid.receipt.receipt_hash,
            amount_uusdc: String(paid.receipt.amount_uusdc),
            epoch_id: paid.receipt.epoch_id,
            timestamp: paid.receipt.timestamp,
            miner: String(paid.receipt.miner),
          },
          runStartedMs: started,
          verifiedAtMs: Date.now(),
        },
        f,
      );
    }
    purchase.serving_miner_slug = node.minerSlug;

    // The miner raw-byte chain is verifiable only for a provider whose
    // receipt registration is a known VeriReceipt id (identity consistency
    // is a node-level check above, so a mismatch is already a HOLD).
    let minerChain: VerifiedCore["miner_chain"] = "not_applicable";
    let minerChecks: Check[] = [];
    if (node.ok && VERIRECEIPT_ONCHAIN_MINER_IDS.includes(String(paid.receipt.miner))) {
      const v = await verifyPurchase(
        {
          payer: paid.authorization.from,
          minerSlug: node.minerSlug ?? "verireceipt",
          signalHash: validHash!,
          valueField: input.valueField,
          engineResult: body.result ?? {},
          intent: input.intent,
          fieldStatus: body.field_status as Record<string, FieldStatus> | undefined,
        },
        f,
      );
      minerChecks = v.checks;
      minerChain = v.verified ? "passed" : "failed";
    }

    const reconciled = node.ok && node.providerResponse && ["REGULATORY_FILING_MONITOR_GENERAL", "GRID_POWER_PRICE_GENERAL", "ONCHAIN_TX_LOOKUP_GENERAL"].includes(input.intent)
      ? reconcilePrimaryAnswer(input.intent, body.result ?? {}, (body.field_status ?? {}) as Record<string,FieldStatus>, node.providerResponse, true)
      : undefined;
    const primaryAnswer = reconciled?.result ?? body.result ?? {};
    let sourceVerification: SourceVerification | undefined;
    if (node.ok && input.intent === "REGULATORY_FILING_MONITOR_GENERAL") {
      sourceVerification = await verifyFilingSource({ params: input.params, result: primaryAnswer }, { f, now: nowDate, secUserAgent: opts.secUserAgent });
      if (input.valueField !== "filing_count") {
        sourceVerification.status = "failed";
        sourceVerification.checks.push({name:"primary source supported filing field",ok:false,detail:"only independently recounted filing_count is supported"});
      }
    }
    if (node.ok && input.intent === "GRID_POWER_PRICE_GENERAL") {
      sourceVerification = await verifyGridSource({ params: input.params, result: primaryAnswer, providerResult: node.providerResponse }, { f, now: nowDate });
      if (input.valueField !== "lmp_usd_per_mwh") {
        sourceVerification.status = "failed";
        sourceVerification.checks.push({name:"primary source supported grid field",ok:false,detail:"only independently matched LMP is supported"});
      }
    }
    if (node.ok && input.intent === "ONCHAIN_TX_LOOKUP_GENERAL") {
      sourceVerification = await verifyTxSource({ params: input.params, result: primaryAnswer }, { f, now: nowDate });
      if (input.valueField !== "block_number") {
        sourceVerification.status = "failed";
        sourceVerification.checks.push({name:"primary source supported TX field",ok:false,detail:"only chain-bound mined block_number is supported"});
      }
    }
    if (sourceVerification && reconciled) sourceVerification.details.reconciled_fields = Object.fromEntries(
      Object.entries(reconciled.fields).map(([key,field]) => [key,{node_status:field.node_status,source:field.source}]),
    );
    const reasons = [
      ...(sourceVerification?.checks ?? []).filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`),
      ...node.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
      ...minerChecks.filter((c) => !c.ok).map((c) => `miner chain ${c.name}: ${c.detail}`),
    ];
    return {
      purchase,
      signal_hash: validHash,
      value: node.value ?? null,
      delivery_status: node.delivery,
      node_checks: node.checks,
      miner_chain: minerChain,
      miner_checks: minerChecks,
      reasons,
      source_verification: sourceVerification,
      provider_response: node.providerResponse,
      evidenceOk: node.ok && minerChain !== "failed" && (!sourceVerification || sourceVerification.status === "verified"),
    };
  } catch (e) {
    purchase.worst_case_uusdc = reservedUusdc;
    purchase.nonce = reservedNonce;
    return failed([`purchase refused or failed: ${e instanceof Error ? e.message : String(e)}`]);
  }
}

function appendRecordSafe(file: string, rec: GateRun | ProbeRun): void {
  // Set BEFORE stringify so the persisted row and the returned object agree.
  rec.record_appended = true;
  try {
    appendFileSync(file, JSON.stringify(rec) + "\n");
  } catch (e) {
    rec.record_appended = false;
    rec.reasons.push(`audit append failed: ${e instanceof Error ? e.message : String(e)}; any journaled reservation still counts against the daily cap`);
  }
}

/**
 * Run one gate task end to end and append the record. The task is selected
 * from the committed policy inside the gate (immutable content), the policy
 * hash is recomputed from the object and must match the supplied hash, and
 * the record carries both the policy hash and the exact task hash. Never
 * throws for a refusal: a refused or unverifiable run is a recorded HOLD.
 * Throws only for policy/hash misuse and unknown task ids (before any spend).
 */
export async function runGate(taskId: string, payer: Payer, opts: GateOptions): Promise<GateRun> {
  const computed = policyObjectHash(opts.policy);
  if (computed !== opts.policyHash) {
    throw new Error(`policy hash mismatch: the policy object hashes to ${computed} but ${opts.policyHash} was supplied; refusing to run`);
  }
  // Frozen deep copy: a caller mutating the policy (e.g. from onRawResponse
  // during an await) must never change the rule this run evaluates.
  const task = structuredClone(gateTask(opts.policy, taskId));
  const taskHash = createHash("sha256").update(canonicalPayloadJson(task)).digest("hex");
  const nowDate = (opts.now ?? (() => new Date()))();
  const base: Omit<GateRun, "outcome" | "reasons"> = {
    version: 1 as const,
    gate_id: task.id,
    policy_version: opts.policy.version,
    policy_hash: computed,
    task_hash: taskHash,
    evaluated_at: nowDate.toISOString(),
    mission: task.mission,
    title: task.title,
    intent: task.intent,
    params: {},
    rule: { op: task.rule.op, value: task.rule.value, units: task.rule.units, label: task.rule.label },
    payer: payer.address.toLowerCase(),
    purchase: {
      routed: "auto", quoted_uusdc: "0", paid_uusdc: null, worst_case_uusdc: null,
      receipt_hash: null, epoch_id: null, serving_miner: null, serving_miner_slug: null, duration_ms: null, nonce: null,
    },
    signal_hash: null,
    value: null,
    delivery_status: null,
    node_checks: [] as Check[],
    miner_chain: "not_applicable",
    miner_checks: [] as Check[],
    limits: GATE_LIMITS,
    record_appended: false,
  };

  let rec: GateRun;
  try {
    // Param resolution errors are recorded HOLDs, not uncaught throws.
    const params = resolveGateParams(task, opts.overrides, nowDate);
    base.params = params;
    const core = await executeVerifiedPurchase(
      { intent: task.intent, params, valueField: task.value_field, kind: "gate" },
      payer,
      opts,
    );
    base.purchase = core.purchase;
    base.signal_hash = core.signal_hash;
    base.value = core.value;
    base.delivery_status = core.delivery_status;
    base.node_checks = core.node_checks;
    base.miner_chain = core.miner_chain;
    base.miner_checks = core.miner_checks;
    base.source_verification = core.source_verification;

    const reasons = [...core.reasons];
    if (!ruleHolds(task.rule, core.value)) {
      reasons.push(
        core.evidenceOk
          ? `verified value ${JSON.stringify(core.value)} does not satisfy the precommitted rule (${task.rule.label})`
          : "no verified value to evaluate the rule against",
      );
    }
    rec = reasons.length === 0
      ? { ...base, outcome: "PASS", reasons: [`verified value satisfies the precommitted rule (${task.rule.label})`] }
      : { ...base, outcome: "HOLD", reasons };
  } catch (e) {
    rec = { ...base, outcome: "HOLD", reasons: [`gate setup failed: ${e instanceof Error ? e.message : String(e)}`] };
  }
  appendRecordSafe(opts.ledgerFile, rec);
  return rec;
}

export interface ProbeCase {
  id: string;
  intent: string;
  params: Record<string, string>;
  valueField: string;
  question: string;
}

export function probeInputHash(c: ProbeCase): string {
  return createHash("sha256").update(canonicalPayloadJson(c)).digest("hex");
}

export interface FrozenProbeSet {
  version: string;
  cases: Array<{ id: string; intent: string; params: Record<string, string>; value_field: string; question: string }>;
}

export interface ProbeOptions {
  frozenCaseSet: FrozenProbeSet;
  casesVersion: string;
  casesHash: string;
  ledgerFile: string;
  spend: SpendLedger;
  now?: () => Date;
  f?: Fetch;
  onRawResponse?: (raw: RawResponse) => void | Promise<void>;
  secUserAgent?: string;
  /** Additional durable authority, awaited before any signature. Never replaces the local cap. */
  durableBeforeSign?: (notice: SignNotice) => Promise<void>;
}

/**
 * The benchmark's own verification API: buy and verify a fresh answer for one
 * frozen case. No gate policy and no decision rule are involved; the record
 * binds the case id and the frozen case-set hash and reports ANSWERED (the
 * evidence stands and carries a finite value) or ABSTAIN.
 */
export async function runProbe(c0: ProbeCase, payer: Payer, opts: ProbeOptions): Promise<ProbeRun> {
  const nowDate = (opts.now ?? (() => new Date()))();
  const c = structuredClone(c0); // frozen against mutation during awaits
  // Validate execution parameters against the hash-bound frozen set before
  // reaching any network request or signature. Caller labels are not proof.
  const frozen = structuredClone(opts.frozenCaseSet);
  if (!frozen || createHash("sha256").update(canonicalPayloadJson(frozen)).digest("hex") !== opts.casesHash || frozen.version !== opts.casesVersion) {
    throw new Error("probe frozen case-set hash/version mismatch");
  }
  const matches = frozen.cases.filter((x) => x.id === c.id);
  const expected = matches[0];
  if (matches.length !== 1 || probeInputHash(c) !== probeInputHash({ id: expected.id, intent: expected.intent, params: expected.params, valueField: expected.value_field, question: expected.question })) {
    throw new Error("probe input does not match the frozen case");
  }
  const base: Omit<ProbeRun, "outcome" | "reasons"> = {
    version: 1 as const,
    kind: "benchmark-probe",
    case_id: c.id,
    cases_version: opts.casesVersion,
    cases_hash: opts.casesHash,
    evaluated_at: nowDate.toISOString(),
    question: c.question,
    intent: c.intent,
    params: c.params,
    value_field: c.valueField,
    case_input_hash: probeInputHash(c),
    payer: payer.address.toLowerCase(),
    purchase: {
      routed: "auto", quoted_uusdc: "0", paid_uusdc: null, worst_case_uusdc: null,
      receipt_hash: null, epoch_id: null, serving_miner: null, serving_miner_slug: null, duration_ms: null, nonce: null,
    },
    signal_hash: null,
    value: null,
    delivery_status: null,
    node_checks: [] as Check[],
    miner_chain: "not_applicable",
    miner_checks: [] as Check[],
    limits: PROBE_LIMITS,
    record_appended: false,
  };

  const core = await executeVerifiedPurchase(
    { intent: c.intent, params: c.params, valueField: c.valueField, kind: "benchmark" },
    payer,
    opts,
  );
  base.purchase = core.purchase;
  base.signal_hash = core.signal_hash;
  base.value = core.value;
  base.delivery_status = core.delivery_status;
  base.node_checks = core.node_checks;
  base.miner_chain = core.miner_chain;
  base.miner_checks = core.miner_checks;
  base.source_verification = core.source_verification;

  const finite = typeof core.value === "number" && Number.isFinite(core.value);
  const answered = core.evidenceOk && finite;
  const rec: ProbeRun = {
    ...base,
    outcome: answered ? "ANSWERED" : "ABSTAIN",
    reasons: answered
      ? ["verified value recorded; graded by the frozen case set"]
      : [...core.reasons, ...(finite || core.value === null ? [] : ["verified value is not a finite number"])],
  };
  appendRecordSafe(opts.ledgerFile, rec);
  return rec;
}
