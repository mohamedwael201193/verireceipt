import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATE_LIMITS, PROBE_LIMITS, runGate, runProbe, type GateRun, type ProbeRun, type SpendLedger } from "../src/gate";
import { policyObjectHash, type GatePolicy, type GateTask } from "../src/gatePolicy";
import { canonicalPayloadJson } from "../src/verify";
import { makePayer, node, payerAddress } from "./gateNodeFixture";

const task: GateTask = {
  id: "gate-tvl-floor-aave-v3",
  mission: "M13",
  title: "Treasury venue screen",
  intent: "TVL_LOOKUP_GENERAL",
  value_field: "tvl_usd",
  fixed_params: { protocol: "aave-v3" },
  accepts_params: ["protocol"],
  rule: { op: ">=", value: 1_000_000_000, units: "USD", label: "Verified protocol TVL at or above 1,000,000,000 USD" },
};
const policy = {
  version: "gate-policy-v1", committed_at: "2026-11-22T16:40:00Z", network: "eip155:11155111",
  rail: "escrow", routing: "auto", max_call_uusdc: "10000", note: "", tasks: [task],
} as GatePolicy;
const POLICY_HASH = policyObjectHash(policy);

const dirs: string[] = [];
function workspace(over: Partial<SpendLedger> = {}) {
  const d = mkdtempSync(join(tmpdir(), "gate-"));
  dirs.push(d);
  const spend: SpendLedger = {
    reservationsFile: join(d, "reservations.jsonl"),
    lockFile: join(d, "spend.lock"),
    readSettlementSnapshot: () => ({ settledTodayUusdc: 0n, settledNonces: new Set<string>() }),
    settledTodayUusdc: () => 0n,
    settledNonces: () => new Set<string>(),
    ...over,
  };
  return { dir: d, ledgerFile: join(d, "gate-runs.jsonl"), spend };
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const baseOpts = (w: ReturnType<typeof workspace>) => ({ policy, policyHash: POLICY_HASH, ledgerFile: w.ledgerFile, spend: w.spend });

describe("runGate", () => {
  it("PASSes when the fresh auto-routed purchase verifies and the value meets the precommitted rule", async () => {
    const w = workspace();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node().f });
    expect(rec.outcome).toBe("PASS");
    expect(rec.record_appended).toBe(true);
    expect(rec.purchase.routed).toBe("auto");
    expect(rec.purchase.serving_miner).toBe("6160");
    expect(rec.purchase.paid_uusdc).toBe("10000");
    expect(rec.delivery_status).toBe("included");
    expect(rec.miner_chain).toBe("passed");
    expect(rec.value).toBe(2_000_000_000);
    expect(rec.node_checks.every((c) => c.ok)).toBe(true);
    // The record binds the exact task content (incl. rule) it evaluated.
    expect(rec.task_hash).toBe(createHash("sha256").update(canonicalPayloadJson(task)).digest("hex"));
    expect(rec.policy_hash).toBe(POLICY_HASH);
    const lines = readFileSync(w.ledgerFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const stored = JSON.parse(lines[0]) as GateRun;
    expect(stored.gate_id).toBe(task.id);
    // The persisted flag must match the returned object.
    expect(stored.record_appended).toBe(true);
    expect(stored.record_appended).toBe(rec.record_appended);
  });
  it("refuses to run when the supplied policy hash does not match the policy object", async () => {
    const w = workspace();
    const f = node().f;
    await expect(runGate(task.id, makePayer(), { ...baseOpts(w), policyHash: "0".repeat(64), f })).rejects.toThrow(/policy hash mismatch/);
    expect(f).not.toHaveBeenCalled();
  });
  it("HOLDs when the verified value violates the precommitted rule", async () => {
    const w = workspace();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node({ value: 500_000_000 }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/does not satisfy the precommitted rule/);
  });
  it("PASSes via an external auto-routed provider with the miner chain recorded not_applicable", async () => {
    const w = workspace();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node({ miner: "424242", minerSlug: "other-miner" }).f });
    expect(rec.outcome).toBe("PASS");
    expect(rec.miner_chain).toBe("not_applicable");
    expect(rec.purchase.serving_miner).toBe("424242");
    expect(rec.purchase.serving_miner_slug).toBe("other-miner");
  });
  it("HOLDs when the payload claims VeriReceipt under an unknown registration (identity must not downgrade verification)", async () => {
    const w = workspace();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node({ miner: "424242", minerSlug: "verireceipt" }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.miner_chain).toBe("not_applicable");
    expect(rec.reasons.join(" ")).toMatch(/identity consistent with the receipt registration/);
  });
  it("HOLDs when a VeriReceipt registration serves under a foreign slug", async () => {
    const w = workspace();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node({ miner: "6160", minerSlug: "other-miner" }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/identity consistent with the receipt registration/);
  });
  it("HOLDs when the payload names no serving miner", async () => {
    const w = workspace();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node({ minerSlug: null }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/serving miner identity present/);
  });
  it("HOLDs when the signal payload names different params than asked", async () => {
    const w = workspace();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node({ requestParams: { protocol: "uniswap-v3" } }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/params match the asked input/);
  });
  it("HOLDs when the engine value disagrees with the recorded provider answer", async () => {
    const w = workspace();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node({ value: 2_000_000_000, payloadValue: 3_000_000_000 }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/engine value equals provider answer/);
  });
  it("HOLDs when the paid reply's signal_hash does not re-derive from the payload", async () => {
    const w = workspace();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node({ signalHash: "0x" + "00".repeat(32) }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/signal hash re-derived/);
  });
  it("HOLDs when the payload wallet is not the payer", async () => {
    const w = workspace();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node({ wallet: "0x" + "11".repeat(20) }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/wallet is the payer/);
  });
  it("HOLDs on a stale signal timestamp", async () => {
    const w = workspace();
    const stale = new Date(Date.now() - 3600_000).toISOString();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node({ payloadTimestamp: stale }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/signal timestamp within the signed purchase window/);
  });
  it("HOLds on a signal timestamp outside the authorization window", async () => {
    const w = workspace();
    const outside = new Date(Date.now() - (120 + 60) * 1000).toISOString();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node({ payloadTimestamp: outside }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/signal timestamp within the signed purchase window/);
  });
  it("HOLDs on a future signal timestamp", async () => {
    const w = workspace();
    const future = new Date(Date.now() + 3600_000).toISOString();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node({ payloadTimestamp: future }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/signal timestamp/);
  });
  it("HOLDs on a missing signal timestamp", async () => {
    const w = workspace();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node({ payloadTimestamp: null }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/signal timestamp present/);
  });
  it("records delivery pending for a fresh epoch and still decides on verified evidence", async () => {
    const w = workspace();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node({ delivery: "pending" }).f });
    expect(rec.delivery_status).toBe("pending");
    expect(rec.outcome).toBe("PASS");
  });
  it("HOLDs when the predecessor's block-window lookup errors even though the epoch probe says recorded", async () => {
    const w = workspace();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node({ delivery: "pending", prevProbeError: true }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/legitimately pending/);
  });
  it.each([
    { fromOffsetSec: 3600, toOffsetSec: 7200 },
    { fromOffsetSec: -60, toOffsetSec: -180 },
    { fromOffsetSec: -60, toOffsetSec: -60 },
    { fromOffsetSec: -180, toOffsetSec: -61, epochId: 38 },
    { fromOffsetSec: -180, toOffsetSec: -61, epochId: null },
  ])("HOLDs pending with invalid predecessor window or identity: %j", async (prevWindow) => {
    const w = workspace();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node({ delivery: "pending", prevWindow }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/legitimately pending/);
  });
  it("records a HOLD without signing when the settled daily cap is already spent", async () => {
    const w = workspace({ readSettlementSnapshot: () => ({ settledTodayUusdc: 2_000_000n, settledNonces: new Set<string>() }) });
    const payer = makePayer();
    const rec = await runGate(task.id, payer, { ...baseOpts(w), f: node().f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/daily cap/);
    expect(rec.purchase.receipt_hash).toBeNull();
    expect(rec.purchase.worst_case_uusdc).toBeNull();
    expect(payer.signMessage).not.toHaveBeenCalled();
    expect(readFileSync(w.ledgerFile, "utf8").trim().split("\n")).toHaveLength(1);
  });
  it("records a HOLD without signing when outstanding reservations would cross the daily cap", async () => {
    const w = workspace();
    writeFileSync(w.spend.reservationsFile, JSON.stringify({ kind: "gate", nonce: "old", amount_uusdc: "1995000", reserved_at: new Date().toISOString() }) + "\n");
    const payer = makePayer();
    const rec = await runGate(task.id, payer, { ...baseOpts(w), f: node().f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/daily cap/);
    expect(payer.signMessage).not.toHaveBeenCalled();
    // No new reservation was journaled.
    expect(readFileSync(w.spend.reservationsFile, "utf8").trim().split("\n")).toHaveLength(1);
  });
  it("refuses to sign when the reservation cannot be journaled", async () => {
    const w = workspace();
    const payer = makePayer();
    const spend: SpendLedger = { ...w.spend, reservationsFile: join(w.dir, "missing-dir", "reservations.jsonl") };
    const rec = await runGate(task.id, payer, { ...baseOpts(w), spend, f: node().f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/purchase refused or failed/);
    expect(rec.purchase.worst_case_uusdc).toBeNull(); // nothing was signed
    expect(payer.signMessage).not.toHaveBeenCalled();
  });
  it("journals the reservation BEFORE signing and records worst-case spend when the paid fetch rejects after submission", async () => {
    const w = workspace();
    const payer = makePayer();
    payer.signMessage = vi.fn((message: string) => {
      // At signature time the reservation must already be on disk.
      const lines = readFileSync(w.spend.reservationsFile, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).amount_uusdc).toBe("10000");
      return makePayer().signMessage(message);
    });
    const rec = await runGate(task.id, payer, { ...baseOpts(w), f: node({ paidRejects: true }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/purchase refused or failed/);
    expect(rec.purchase.paid_uusdc).toBeNull();
    expect(rec.purchase.worst_case_uusdc).toBe("10000");
    expect(payer.signMessage).toHaveBeenCalledOnce();
    // The settled record's nonce reconciles the reservation (no double count).
    const res = JSON.parse(readFileSync(w.spend.reservationsFile, "utf8").trim().split("\n")[0]);
    expect(rec.purchase.nonce).toBe(res.nonce);
  });
  it("records worst-case spend when a signed attempt fails receipt decoding", async () => {
    const w = workspace();
    const payer = makePayer();
    const rec = await runGate(task.id, payer, { ...baseOpts(w), f: node({ badReceiptHeader: true }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/miner=x/);
    expect(rec.purchase.paid_uusdc).toBeNull();
    expect(rec.purchase.worst_case_uusdc).toBe("10000");
    expect(payer.signMessage).toHaveBeenCalledOnce();
  });
  it("HOLDs when the decision field's status is unavailable, even with a satisfying numeric value", async () => {
    // The reviewer's mutant: an unavailable external-provider grid value 0 must not PASS a <= 150 rule.
    const floorTask: GateTask = { ...task, id: "gate-grid-floor", rule: { op: "<=", value: 150, units: "USD/MWh", label: "price at or below 150" } };
    const floorPolicy = { ...policy, tasks: [floorTask] } as GatePolicy;
    const w = workspace();
    const opts = { policy: floorPolicy, policyHash: policyObjectHash(floorPolicy), ledgerFile: w.ledgerFile, spend: w.spend };
    const rec = await runGate(floorTask.id, makePayer(), { ...opts, f: node({ value: 0, fieldStatus: { tvl_usd: "unavailable" } }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/value field status is ok/);
    // control: the same 0 with status ok passes
    const w2 = workspace();
    const ok = await runGate(floorTask.id, makePayer(), { ...opts, ledgerFile: w2.ledgerFile, spend: w2.spend, f: node({ value: 0 }).f });
    expect(ok.outcome).toBe("PASS");
  });
  it("HOLDs when the paid reply carries no field_status", async () => {
    const w = workspace();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), f: node({ fieldStatus: null }).f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/value field status is ok/);
  });
  it("evaluates the frozen rule even when the policy is mutated mid-flight (onRawResponse)", async () => {
    const w = workspace();
    const mutating = node({ value: 500_000_000 });
    const f = mutating.f;
    const rec = await runGate(task.id, makePayer(), {
      ...baseOpts(w),
      f,
      onRawResponse: () => {
        // Mutate the live policy object during the purchase await.
        (policy.tasks[0].rule as { value: number }).value = 1;
      },
    });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/does not satisfy the precommitted rule/);
    expect(rec.rule.value).toBe(1_000_000_000);
    (policy.tasks[0].rule as { value: number }).value = 1_000_000_000; // restore for other tests
  });
  it("operator overrides reach the purchased params", async () => {
    const w = workspace();
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), overrides: { protocol: "uniswap-v3" }, f: node({ requestParams: { protocol: "uniswap-v3" } }).f });
    expect(rec.params.protocol).toBe("uniswap-v3");
    expect(rec.outcome).toBe("PASS");
  });
  it("records a HOLD with no network and no signature when an override key is rejected", async () => {
    const w = workspace();
    const payer = makePayer();
    const f = node().f;
    const rec = await runGate(task.id, payer, { ...baseOpts(w), overrides: { bogus: "x" }, f });
    expect(rec.outcome).toBe("HOLD");
    expect(rec.reasons.join(" ")).toMatch(/accepts_params/);
    expect(payer.signMessage).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
    expect(rec.record_appended).toBe(true);
  });
  it("returns the record with record_appended false (never throws) when the audit append fails", async () => {
    const w = workspace();
    const ledgerDir = join(w.dir, "ledger-as-dir");
    mkdirSync(ledgerDir);
    const rec = await runGate(task.id, makePayer(), { ...baseOpts(w), ledgerFile: ledgerDir, f: node().f });
    expect(rec.outcome).toBe("PASS");
    expect(rec.record_appended).toBe(false);
    expect(rec.reasons.join(" ")).toMatch(/audit append failed/);
  });
  it("limits state the true scope: testnet purchase effects, committed-policy precommitment, Merkle shape-only", () => {
    const all = GATE_LIMITS.join(" ");
    expect(all).not.toMatch(/changed nothing off-chain/);
    expect(all).toMatch(/testnet escrow purchase itself/);
    expect(all).toMatch(/accepts_params keys/);
    expect(all).toMatch(/shape-checked only/);
    expect(all).toMatch(/not_applicable, never silently skipped/);
  });
});

describe("runProbe (benchmark's own verification API)", () => {
  const probeCase = { id: "case-tvl", intent: "TVL_LOOKUP_GENERAL", params: { protocol: "aave-v3" }, valueField: "tvl_usd", question: "What is the current TVL of Aave v3 in USD?" };
  const frozenCaseSet = { version: "frontier-benchmark-v1", cases: [{ id: probeCase.id, intent: probeCase.intent, params: probeCase.params, value_field: probeCase.valueField, question: probeCase.question }] };
  const probeHash = createHash("sha256").update(canonicalPayloadJson(frozenCaseSet)).digest("hex");
  const probeOpts = (w: ReturnType<typeof workspace>) => ({ frozenCaseSet, casesVersion: frozenCaseSet.version, casesHash: probeHash, ledgerFile: w.ledgerFile, spend: w.spend });
  it("ANSWERED when the fresh purchase verifies, bound to the case-set hash with no policy", async () => {
    const w = workspace();
    const rec = await runProbe(probeCase, makePayer(), { ...probeOpts(w), f: node().f });
    expect(rec.outcome).toBe("ANSWERED");
    expect(rec.kind).toBe("benchmark-probe");
    expect(rec.cases_hash).toBe(probeHash);
    expect(rec.value).toBe(2_000_000_000);
    expect(rec.miner_chain).toBe("passed");
    expect(rec.limits).toBe(PROBE_LIMITS);
    expect("policy_hash" in rec).toBe(false);
    expect("rule" in rec).toBe(false);
    const line = JSON.parse(readFileSync(w.ledgerFile, "utf8").trim().split("\n")[0]) as ProbeRun;
    expect(line.case_id).toBe("case-tvl");
  });
  it.each([
    { intent: "ONCHAIN_TX_LOOKUP_GENERAL" }, { params: { protocol: "other" } },
    { valueField: "block_number" }, { question: "Another question" },
  ])("refuses mismatched frozen probe input before any request or signature: %j", async (mutation) => {
    const w = workspace();
    const payer = makePayer();
    const f = vi.fn();
    await expect(runProbe({ ...probeCase, ...mutation }, payer, { ...probeOpts(w), f })).rejects.toThrow(/does not match the frozen case/);
    expect(f).not.toHaveBeenCalled();
    expect(payer.signMessage).not.toHaveBeenCalled();
  });
  it("refuses missing or forged frozen-set binding before requests", async () => {
    const w = workspace();
    const payer = makePayer();
    const f = vi.fn();
    await expect(runProbe(probeCase, payer, { ...probeOpts(w), frozenCaseSet: undefined as never, f })).rejects.toThrow(/hash\/version mismatch/);
    await expect(runProbe(probeCase, payer, { ...probeOpts(w), casesHash: "0".repeat(64), f })).rejects.toThrow(/hash\/version mismatch/);
    expect(f).not.toHaveBeenCalled();
    expect(payer.signMessage).not.toHaveBeenCalled();
  });
  it("ABSTAINs (never PASSes) when verification fails, with worst-case spend recorded", async () => {
    const w = workspace();
    const payer = makePayer();
    const rec = await runProbe(probeCase, payer, { ...probeOpts(w), f: node({ badReceiptHeader: true }).f });
    expect(rec.outcome).toBe("ABSTAIN");
    expect(rec.value).toBeNull();
    expect(rec.purchase.worst_case_uusdc).toBe("10000");
    expect(payer.signMessage).toHaveBeenCalledOnce();
  });
  it("ABSTAINs when the verified value is not a finite number", async () => {
    const w = workspace();
    const rec = await runProbe(probeCase, makePayer(), { ...probeOpts(w), f: node({ value: NaN }).f });
    expect(rec.outcome).toBe("ABSTAIN");
    expect(rec.reasons.join(" ")).toMatch(/engine value equals provider answer|finite|value field/);
  });
});
