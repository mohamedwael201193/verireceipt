// Gate policy: the precommitted rules the Gate enforces. The policy file is
// committed to the repository BEFORE any gate run; every run record carries
// the policy hash so a reviewer can check the rule was not tuned after the
// fact. Pure functions only: no network, no key handling.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalPayloadJson } from "./verify.js";

export const GATE_POLICY_VERSION = "gate-policy-v1";
export const GATE_NETWORK = "eip155:11155111";
export const GATE_MAX_CALL_UUSDC = "10000";

export type RuleOp = "<" | "<=" | ">" | ">=" | "==";
export const RULE_OPS: readonly RuleOp[] = ["<", "<=", ">", ">=", "=="];

export interface GateRule {
  op: RuleOp;
  value: number;
  units: string;
  label: string;
}

export type DynamicParamKind = "caiso_hour" | "nyiso_interval";
export const DYNAMIC_PARAM_KINDS: readonly DynamicParamKind[] = ["caiso_hour", "nyiso_interval"];

export interface GateTask {
  id: string;
  mission: string;
  title: string;
  intent: string;
  value_field: string;
  fixed_params: Record<string, string>;
  dynamic_params?: Record<string, DynamicParamKind>;
  /** Param keys an operator may override at run time (the question changes; the rule never does). */
  accepts_params: readonly string[];
  rule: GateRule;
}

export interface GatePolicy {
  version: typeof GATE_POLICY_VERSION;
  committed_at: string;
  network: typeof GATE_NETWORK;
  rail: "escrow";
  routing: "auto";
  max_call_uusdc: typeof GATE_MAX_CALL_UUSDC;
  note: string;
  tasks: GateTask[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function stringMap(v: unknown): v is Record<string, string> {
  return isPlainObject(v) && Object.entries(v).every(([k, x]) => k !== "__proto__" && k !== "constructor" && k !== "prototype" && typeof x === "string");
}

/** Validate an unknown value as a GatePolicy; throws with a reason on any deviation. */
export function validateGatePolicy(raw: unknown): GatePolicy {
  if (!isPlainObject(raw)) throw new Error("policy is not an object");
  if (raw.version !== GATE_POLICY_VERSION) throw new Error(`policy version ${String(raw.version)} is not ${GATE_POLICY_VERSION}`);
  if (typeof raw.committed_at !== "string" || !Number.isFinite(Date.parse(raw.committed_at))) throw new Error("policy committed_at is not a timestamp");
  if (raw.network !== GATE_NETWORK) throw new Error(`policy network ${String(raw.network)} is not ${GATE_NETWORK} (testnet only)`);
  if (raw.rail !== "escrow") throw new Error("policy rail must be escrow");
  if (raw.routing !== "auto") throw new Error("policy routing must be auto (the app never picks a miner)");
  if (raw.max_call_uusdc !== GATE_MAX_CALL_UUSDC) throw new Error(`policy max_call_uusdc must be ${GATE_MAX_CALL_UUSDC}`);
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) throw new Error("policy has no tasks");
  const ids = new Set<string>();
  const tasks = raw.tasks.map((t: unknown, i: number) => {
    if (!isPlainObject(t)) throw new Error(`task ${i} is not an object`);
    for (const k of ["id", "mission", "title", "intent", "value_field"] as const) {
      if (typeof t[k] !== "string" || !(t[k] as string)) throw new Error(`task ${i}: ${k} must be a non-empty string`);
    }
    const id = t.id as string;
    if (ids.has(id)) throw new Error(`duplicate task id ${id}`);
    ids.add(id);
    if (!stringMap(t.fixed_params)) throw new Error(`task ${id}: fixed_params must be a string map`);
    if (t.dynamic_params !== undefined) {
      if (!isPlainObject(t.dynamic_params) || Object.values(t.dynamic_params).some((d) => !DYNAMIC_PARAM_KINDS.includes(d as DynamicParamKind))) {
        throw new Error(`task ${id}: dynamic_params values must be one of ${DYNAMIC_PARAM_KINDS.join(", ")}`);
      }
    }
    if (!Array.isArray(t.accepts_params) || t.accepts_params.some((p) => typeof p !== "string" || !p)) {
      throw new Error(`task ${id}: accepts_params must be a list of param keys`);
    }
    // A param that is neither fixed, dynamic nor accepted can never be set.
    const rule = t.rule;
    if (!isPlainObject(rule)) throw new Error(`task ${id}: rule must be an object`);
    if (!RULE_OPS.includes(rule.op as RuleOp)) throw new Error(`task ${id}: rule.op must be one of ${RULE_OPS.join(", ")}`);
    if (!isFiniteNumber(rule.value)) throw new Error(`task ${id}: rule.value must be a finite number`);
    if (typeof rule.units !== "string" || typeof rule.label !== "string" || !rule.label) {
      throw new Error(`task ${id}: rule.units and rule.label must be strings`);
    }
    return t as unknown as GateTask;
  });
  return { ...(raw as unknown as GatePolicy), tasks };
}

/** sha256 over the canonical JSON of the parsed policy file; recorded in every gate run. */
export function policyHash(rawFileText: string): string {
  return createHash("sha256").update(canonicalPayloadJson(JSON.parse(rawFileText))).digest("hex");
}

/** The same hash computed from an already-parsed policy object; binds a run to the exact in-memory policy. */
export function policyObjectHash(policy: unknown): string {
  return createHash("sha256").update(canonicalPayloadJson(policy)).digest("hex");
}

export function loadGatePolicy(file: string): { policy: GatePolicy; hash: string } {
  const text = readFileSync(file, "utf8");
  return { policy: validateGatePolicy(JSON.parse(text)), hash: policyHash(text) };
}

/**
 * The precommitment anchor: sha256 (canonical JSON) of desk/policy/gate-policy.v1.json
 * as committed before any gate run. The CLI refuses to run a policy whose
 * content hash differs, so DESK_GATE_POLICY cannot swap in altered rules.
 */
export const COMMITTED_GATE_POLICY_SHA256 = "b85016544b2c0b3ffc36ede9e75462f31c67b0e797d888ff061ce89e09105d15";

export function assertCommittedPolicy(hash: string): void {
  if (hash !== COMMITTED_GATE_POLICY_SHA256) {
    throw new Error(`policy hash ${hash} does not match the committed gate policy ${COMMITTED_GATE_POLICY_SHA256}; refusing to run uncommitted rules`);
  }
}

export function gateTask(policy: GatePolicy, taskId: string): GateTask {
  const t = policy.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error(`unknown gate task ${taskId}; known: ${policy.tasks.map((x) => x.id).join(", ")}`);
  return t;
}

/** Compare a verified numeric value against a precommitted rule. */
export function ruleHolds(rule: GateRule, value: unknown): boolean {
  if (!isFiniteNumber(value)) return false;
  switch (rule.op) {
    case "<": return value < rule.value;
    case "<=": return value <= rule.value;
    case ">": return value > rule.value;
    case ">=": return value >= rule.value;
    case "==": return value === rule.value;
  }
}
