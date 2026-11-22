import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGateParams } from "../src/gate";
import { gateTask, loadGatePolicy, policyHash, ruleHolds, validateGatePolicy } from "../src/gatePolicy";
import { readFileSync } from "node:fs";

const policyFile = join(__dirname, "..", "policy", "gate-policy.v1.json");
const { policy, hash } = loadGatePolicy(policyFile);

describe("committed gate policy", () => {
  it("loads, validates and pins seven tasks with unique ids", () => {
    expect(policy.version).toBe("gate-policy-v1");
    expect(policy.network).toBe("eip155:11155111");
    expect(policy.routing).toBe("auto");
    expect(policy.tasks).toHaveLength(7);
    expect(new Set(policy.tasks.map((t) => t.id)).size).toBe(7);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("has a stable hash for unchanged file bytes", () => {
    expect(policyHash(readFileSync(policyFile, "utf8"))).toBe(hash);
  });
  it("matches the committed precommitment anchor and rejects altered content", async () => {
    const { COMMITTED_GATE_POLICY_SHA256, assertCommittedPolicy } = await import("../src/gatePolicy");
    expect(hash).toBe(COMMITTED_GATE_POLICY_SHA256);
    expect(() => assertCommittedPolicy(hash)).not.toThrow();
    expect(() => assertCommittedPolicy("0".repeat(64))).toThrow(/does not match the committed gate policy/);
  });
  it("covers every task intent with a scored value field", () => {
    const intents = new Set(policy.tasks.map((t) => t.intent));
    for (const i of ["GRID_POWER_PRICE_GENERAL", "TVL_LOOKUP_GENERAL", "OPTIMAL_EXECUTION_ROUTE_GENERAL", "ONCHAIN_TX_LOOKUP_GENERAL", "REGULATORY_FILING_MONITOR_GENERAL", "VALIDATOR_PERFORMANCE_VERIFY_GENERAL"]) {
      expect(intents.has(i)).toBe(true);
    }
  });
  it("gateTask names unknown tasks with the known list", () => {
    expect(() => gateTask(policy, "nope")).toThrow(/unknown gate task nope; known: gate-grid-curtail-caiso-np15/);
  });
});

describe("validateGatePolicy", () => {
  const good = JSON.parse(readFileSync(policyFile, "utf8"));
  const edit = (fn: (p: any) => void) => { const p = JSON.parse(JSON.stringify(good)); fn(p); return p; };
  it("rejects a wrong version", () => {
    expect(() => validateGatePolicy(edit((p) => { p.version = "v2"; }))).toThrow(/version/);
  });
  it("rejects a mainnet network", () => {
    expect(() => validateGatePolicy(edit((p) => { p.network = "eip155:1"; }))).toThrow(/testnet only/);
  });
  it("rejects non-auto routing (the app never picks a miner)", () => {
    expect(() => validateGatePolicy(edit((p) => { p.routing = "direct"; }))).toThrow(/auto/);
  });
  it("rejects duplicate task ids", () => {
    expect(() => validateGatePolicy(edit((p) => { p.tasks[1].id = p.tasks[0].id; }))).toThrow(/duplicate/);
  });
  it("rejects a bad rule op", () => {
    expect(() => validateGatePolicy(edit((p) => { p.tasks[0].rule.op = "!="; }))).toThrow(/rule.op/);
  });
  it("rejects a non-finite rule value", () => {
    expect(() => validateGatePolicy(edit((p) => { p.tasks[0].rule.value = NaN; }))).toThrow(/finite/);
  });
  it("rejects a rule value given as a string", () => {
    expect(() => validateGatePolicy(edit((p) => { p.tasks[0].rule.value = "150"; }))).toThrow(/finite/);
  });
  it("rejects an unknown dynamic param kind", () => {
    expect(() => validateGatePolicy(edit((p) => { p.tasks[0].dynamic_params = { interval_start: "tomorrow" }; }))).toThrow(/dynamic_params/);
  });
});

describe("ruleHolds", () => {
  const rule = (op: any, value: number) => ({ op, value, units: "u", label: "l" });
  it("evaluates every op", () => {
    expect(ruleHolds(rule("<=", 150), 150)).toBe(true);
    expect(ruleHolds(rule("<=", 150), 151)).toBe(false);
    expect(ruleHolds(rule(">=", 1e9), 2e9)).toBe(true);
    expect(ruleHolds(rule("<", 5), 5)).toBe(false);
    expect(ruleHolds(rule(">", 5), 6)).toBe(true);
    expect(ruleHolds(rule("==", 3), 3)).toBe(true);
  });
  it("fails closed on non-numbers, NaN and Infinity", () => {
    expect(ruleHolds(rule(">=", 1), "2")).toBe(false);
    expect(ruleHolds(rule(">=", 1), NaN)).toBe(false);
    expect(ruleHolds(rule(">=", 1), Infinity)).toBe(false);
    expect(ruleHolds(rule(">=", 1), undefined)).toBe(false);
  });
});

describe("resolveGateParams", () => {
  const task = policy.tasks.find((t) => t.id === "gate-grid-curtail-caiso-np15")!;
  const now = new Date("2026-11-22T16:00:00Z");
  it("combines fixed and dynamic params", () => {
    const p = resolveGateParams(task, undefined, now);
    expect(p.node_or_zone).toBe("TH_NP15_GEN-APND");
    expect(p.interval_start).toBe("2026-11-22T14:00:00Z");
  });
  it("lets an operator override an accepted param (the new input)", () => {
    const p = resolveGateParams(task, { interval_start: "2026-11-20T00:00:00Z" }, now);
    expect(p.interval_start).toBe("2026-11-20T00:00:00Z");
  });
  it("refuses a param the task does not accept", () => {
    expect(() => resolveGateParams(task, { protocol: "aave-v3" }, now)).toThrow(/not in gate-grid-curtail-caiso-np15's accepts_params/);
  });
  it("refuses an empty override value", () => {
    expect(() => resolveGateParams(task, { node_or_zone: "" }, now)).toThrow(/non-empty/);
  });
});
