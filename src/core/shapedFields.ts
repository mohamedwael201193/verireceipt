// Node-shaped results vs. the miner's raw answer (fields-fix).
//
// Official docs (telegraph-docs c652c68, miners/yaml-config.md "Answers" and
// using/engine-ask.md "The answer's shape"): with an intent_mapping each
// output field is located by its `path`; numbers are computed in code; every
// other field comes from ONE node-side parser model call, and a field whose
// call "did not answer in time or is down" is reported `unavailable`.
// The miner cannot route a non-numeric field around that model call, so a
// consumer that needs the value reads it from the raw answer the node stored
// and hashed (signal_hash). This module does that, and only that:
//   - `ok` fields keep the node's value (source "node");
//   - an `unavailable` NON-numeric field is read at its mapped path from the
//     raw answer, and only when the caller has checked the raw answer against
//     the signal_hash (source "raw");
//   - `missing` / `rejected` are real verdicts and are never overridden;
//   - numeric fields (mapped with a `unit`) are never filled from raw: the
//     node converts them in code, so a raw number is not the canonical value.

export type FieldStatus = "ok" | "missing" | "rejected" | "unavailable";

export interface OutputMapping {
  path: string;
  /** Present on numeric fields: the node converts them in code. */
  unit?: string;
}

/** Mirror of miner.yaml `intent_mapping.<INTENT>.output` (pinned by
 *  tests/shaped-fields.test.ts against the file itself). */
export const OUTPUT_MAPPING: Record<string, Record<string, OutputMapping>> = {
  ONCHAIN_TX_LOOKUP_GENERAL: {
    tx_hash: { path: "tx_hash" },
    status: { path: "status" },
    from: { path: "from" },
    to: { path: "to" },
    block_number: { path: "block_number", unit: "block height" },
    value_eth: { path: "value_eth", unit: "whole native units" },
  },
  REGULATORY_FILING_MONITOR_GENERAL: {
    entity: { path: "entity" },
    filing_count: { path: "filing_count", unit: "filings" },
    filings: { path: "filings" },
    urls: { path: "urls" },
  },
  TVL_LOOKUP_GENERAL: {
    protocol_or_chain: { path: "protocol_or_chain" },
    tvl_usd: { path: "tvl_usd", unit: "USD" },
    chain_tvl_usd: { path: "chain_tvl_usd", unit: "USD" },
    as_of: { path: "as_of" },
  },
  OPTIMAL_EXECUTION_ROUTE_GENERAL: {
    amount_out: { path: "amount_out", unit: "USDC base units (6 decimals)" },
  },
  GRID_POWER_PRICE_GENERAL: {
    lmp_usd_per_mwh: { path: "lmp_usd_per_mwh", unit: "USD per MWh" },
    node_or_zone: { path: "node_or_zone" },
    market: { path: "market" },
    interval_start: { path: "interval_start" },
    currency: { path: "currency" },
  },
  VALIDATOR_PERFORMANCE_VERIFY_GENERAL: {
    effective_balance: { path: "effective_balance", unit: "gwei" },
  },
};

/** Official intent response field types (GET /engine/v1/intents/{intent} → response.fields), pinned here so the fill does not depend on a live fetch. `number` fields are never filled from raw, even if a future mapping omits `unit`. */
export type FieldFormatType = "number" | "string" | "datetime" | "list" | "enum";

export interface FieldFormat {
  type: FieldFormatType;
  allowed?: readonly string[];
}

export const FIELD_FORMAT: Record<string, Record<string, FieldFormat>> = {
  ONCHAIN_TX_LOOKUP_GENERAL: {
    tx_hash: { type: "string" },
    status: { type: "enum", allowed: ["confirmed", "reverted", "pending", "not_found"] },
    from: { type: "string" },
    to: { type: "string" },
    block_number: { type: "number" },
    value_eth: { type: "number" },
  },
  REGULATORY_FILING_MONITOR_GENERAL: {
    entity: { type: "string" },
    filing_count: { type: "number" },
    filings: { type: "list" },
    urls: { type: "list" },
  },
  TVL_LOOKUP_GENERAL: {
    protocol_or_chain: { type: "string" },
    tvl_usd: { type: "number" },
    chain_tvl_usd: { type: "number" },
    as_of: { type: "string" },
  },
  OPTIMAL_EXECUTION_ROUTE_GENERAL: {
    amount_out: { type: "number" },
  },
  GRID_POWER_PRICE_GENERAL: {
    lmp_usd_per_mwh: { type: "number" },
    node_or_zone: { type: "string" },
    market: { type: "string" },
    interval_start: { type: "datetime" },
    currency: { type: "string" },
  },
  VALIDATOR_PERFORMANCE_VERIFY_GENERAL: {
    effective_balance: { type: "number" },
  },
};

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function mappingFor(intent: string): Record<string, OutputMapping> | undefined {
  if (DANGEROUS_KEYS.has(intent) || !Object.hasOwn(OUTPUT_MAPPING, intent)) return undefined;
  return OUTPUT_MAPPING[intent];
}

export function formatFor(intent: string, field: string): FieldFormat | undefined {
  if (DANGEROUS_KEYS.has(intent) || DANGEROUS_KEYS.has(field) || !Object.hasOwn(FIELD_FORMAT, intent)) return undefined;
  const m = FIELD_FORMAT[intent];
  if (!Object.hasOwn(m, field)) return undefined;
  return m[field];
}

/** Numeric iff the official format type is `number`. Falls back to a present `unit` only when the field has no format entry. */
export function isNumericField(intent: string, field: string): boolean {
  const fmt = formatFor(intent, field);
  if (fmt) return fmt.type === "number";
  const m = mappingFor(intent)?.[field];
  return m?.unit !== undefined;
}

export function valueMatchesFormat(value: unknown, fmt: FieldFormat | undefined, field?: string): boolean {
  if (!fmt) return false;
  switch (fmt.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string": {
      if (typeof value !== "string" || value === "" || value.includes("\u0000")) return false;
      if (field === "tx_hash" || field === "from" || field === "to") {
        return /^0x[0-9a-fA-F]+$/.test(value) && value.length > 2;
      }
      return true;
    }
    case "datetime":
      return typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value));
    case "list":
      if (!Array.isArray(value)) return false;
      if (field === "urls") {
        return value.every((u) => typeof u === "string" && /^https?:\/\//i.test(u));
      }
      return true;
    case "enum":
      return typeof value === "string" && !!fmt.allowed && fmt.allowed.includes(value);
    default:
      return false;
  }
}

/** Fields the node must hand to its parser model (no `unit`), per intent. */
export function parserFields(intent: string): string[] {
  const m = mappingFor(intent);
  if (!m) throw new Error(`unknown intent: ${intent}`);
  return Object.keys(m).filter((k) => !isNumericField(intent, k));
}

/** Read a plain dot path (a numeric segment indexes an array). Returns
 *  undefined when any segment is absent. Wildcards are not used by this
 *  miner's mapping and are rejected rather than guessed. */
export function readPath(raw: unknown, path: string): unknown {
  const segs = path.split(".");
  for (const seg of segs) {
    if (seg === "" || seg === "*" || seg.endsWith("[]") || seg.startsWith("{") || DANGEROUS_KEYS.has(seg)) {
      throw new Error(`unsupported path segment: ${seg}`);
    }
  }
  let cur: unknown = raw;
  for (const seg of segs) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

export interface ShapedReply {
  intent: string;
  result: Record<string, unknown>;
  field_status: Record<string, FieldStatus>;
}

export interface ReconciledField {
  value: unknown;
  node_status: FieldStatus;
  source: "node" | "raw" | "none";
}

export function reconcileShaped(
  reply: ShapedReply,
  raw: unknown,
  opts: { rawVerified: boolean },
): Record<string, ReconciledField> {
  const mapping = mappingFor(reply.intent);
  if (!mapping) throw new Error(`unknown intent: ${reply.intent}`);
  const out: Record<string, ReconciledField> = Object.create(null);
  const statuses = reply.field_status ?? {};
  for (const field of Object.keys(statuses)) {
    if (DANGEROUS_KEYS.has(field)) continue;
    const status = statuses[field];
    if (status === "ok") {
      out[field] = { value: reply.result[field], node_status: status, source: "node" };
      continue;
    }
    const m = Object.hasOwn(mapping, field) ? mapping[field] : undefined;
    const fmt = formatFor(reply.intent, field);
    if (status === "unavailable" && opts.rawVerified && m && !isNumericField(reply.intent, field)) {
      const v = readPath(raw, m.path);
      if (v !== undefined && v !== null && valueMatchesFormat(v, fmt, field)) {
        out[field] = { value: v, node_status: status, source: "raw" };
        continue;
      }
    }
    out[field] = { value: null, node_status: status, source: "none" };
  }
  return out;
}
