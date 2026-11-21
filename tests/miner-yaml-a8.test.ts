// A8 (miner.yaml rewrite): the registration file must match the official
// Telegraph intent schemas field-for-field and claim nothing the code does
// not back. Expected field lists and units are copied from the live
// GET https://devnode.telegraphprotocol.com/engine/v1/intents/{INTENT}
// responses fetched 2026-11-21 (request/response unchanged vs the
// telegraph-docs c652c68 snapshot). Text-level checks only: the repo has
// no YAML parser dependency, and the frontend suite already pins
// DOC_SNIPPETS.yaml byte-identical to this file.
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { ApiError, errorBody } from "../src/core/errors";
import { makeReceipt } from "../src/core/receipt";

const yaml = readFileSync(resolve(process.cwd(), "miner.yaml"), "utf8");

/** Lines of the block that starts at `start` (exact line) and runs until
 *  the next line with indentation <= the start line's. */
function block(startLine: string): string[] {
  const lines = yaml.split("\n");
  const i = lines.indexOf(startLine);
  expect(i, `missing line: ${startLine}`).toBeGreaterThan(-1);
  const indent = startLine.length - startLine.trimStart().length;
  const out: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() !== "" && l.length - l.trimStart().length <= indent) break;
    out.push(l);
  }
  return out;
}

/** Direct child keys of `lines` at exactly `indent` spaces. */
function keysAt(lines: string[], indent: number): string[] {
  const re = new RegExp(`^ {${indent}}([A-Za-z0-9_]+):`);
  return lines.map((l) => re.exec(l)?.[1]).filter((k): k is string => k !== undefined);
}

const OFFICIAL: Record<string, { endpoint: string; outputs: Record<string, string | null>; inputs: string[] }> = {
  ONCHAIN_TX_LOOKUP_GENERAL: {
    endpoint: "/v1/tx",
    inputs: ["tx_hash", "chain"],
    outputs: {
      tx_hash: null, status: null, from: null, to: null,
      block_number: "block height", value_eth: "whole native units",
    },
  },
  REGULATORY_FILING_MONITOR_GENERAL: {
    endpoint: "/v1/filings",
    inputs: ["entity", "period"],
    outputs: { entity: null, filing_count: "filings", filings: null, urls: null },
  },
  TVL_LOOKUP_GENERAL: {
    endpoint: "/v1/tvl",
    inputs: ["protocol"],
    outputs: { protocol_or_chain: null, tvl_usd: "USD", chain_tvl_usd: "USD", as_of: null },
  },
  OPTIMAL_EXECUTION_ROUTE_GENERAL: {
    endpoint: "/v1/route",
    inputs: ["pair"],
    outputs: { amount_out: "USDC base units (6 decimals)" },
  },
  GRID_POWER_PRICE_GENERAL: {
    endpoint: "/v1/grid-price",
    inputs: ["node_or_zone", "interval_start"],
    outputs: {
      lmp_usd_per_mwh: "USD per MWh", node_or_zone: null, market: null,
      interval_start: null, currency: null,
    },
  },
  VALIDATOR_PERFORMANCE_VERIFY_GENERAL: {
    endpoint: "/v1/validator",
    inputs: ["validator_index"],
    outputs: { effective_balance: "gwei" },
  },
};

describe("A8 miner.yaml vs the official intent schemas", () => {
  it("declares exactly the six intents, each on its own endpoint", () => {
    const si = block("  supported_intents:").map((l) => l.trim().replace(/^- /, "")).filter(Boolean);
    expect(si).toEqual(Object.keys(OFFICIAL));
    for (const [intent, o] of Object.entries(OFFICIAL)) {
      const ep = block(`  - path: ${o.endpoint}`);
      expect(ep.join("\n")).toContain(`      - ${intent}`);
    }
  });

  for (const [intent, o] of Object.entries(OFFICIAL)) {
    it(`${intent}: outputs are exactly the schema's response fields, units exact`, () => {
      const m = block(`  ${intent}:`);
      expect(m[0]).toBe(`    endpoint: ${o.endpoint}`);
      const outStart = m.indexOf("    output:");
      const outLines = m.slice(outStart + 1);
      expect(keysAt(outLines, 6)).toEqual(Object.keys(o.outputs));
      for (const [field, unit] of Object.entries(o.outputs)) {
        const f = outLines.slice(outLines.indexOf(`      ${field}:`) + 1);
        const own = f.slice(0, f.findIndex((l) => /^ {6}\S/.test(l)) === -1 ? f.length : f.findIndex((l) => /^ {6}\S/.test(l)));
        expect(own).toContain(`        path: ${field}`);
        const unitLine = own.find((l) => l.startsWith("        unit:"));
        if (unit === null) expect(unitLine).toBeUndefined();
        else expect(unitLine).toBe(`        unit: "${unit}"`);
      }
      const inLines = m.slice(m.indexOf("    input:") + 1, outStart);
      for (const name of o.inputs) expect(inLines).toContain(`        from: ${name}`);
    });
  }

  it("TX maps no l1_fee_eth (not an official TX field); the API body may still carry it", () => {
    expect(yaml).not.toContain("l1_fee_eth");
  });

  it("ROUTE pair enum uses accepted_fields with exactly ETH/USDC", () => {
    const ep = block("  - path: /v1/route").join("\n");
    expect(ep).toContain("accepted_fields:\n              - value: ETH/USDC\n");
    expect(ep.match(/- value: /g)).toHaveLength(1);
  });

  it("VALIDATOR: validator_index is a canonical digit string (node cannot send integer) and the description states the 2-of-3 quorum", () => {
    const ep = block("  - path: /v1/validator").join("\n");
    expect(ep).toContain("- name: validator_index\n            type: string\n");
    expect(ep).toContain("canonical decimal");
    expect(ep).toContain("2-of-3 quorum");
    expect(ep).not.toMatch(/two public beacon APIs/);
    const m = block("  VALIDATOR_PERFORMANCE_VERIFY_GENERAL:").join("\n");
    expect(m).toContain("        from: validator_index");
    expect(m).not.toMatch(/validator_index:[\s\S]*how:/);
  });

  it("TX, ROUTE and VALIDATOR simple inputs have no how (code mapping)", () => {
    for (const intent of [
      "ONCHAIN_TX_LOOKUP_GENERAL",
      "OPTIMAL_EXECUTION_ROUTE_GENERAL",
      "VALIDATOR_PERFORMANCE_VERIFY_GENERAL",
    ]) {
      const m = block(`  ${intent}:`);
      const inLines = m.slice(m.indexOf("    input:") + 1, m.indexOf("    output:"));
      expect(inLines.join("\n"), intent).not.toMatch(/^\s+how:/m);
    }
  });

  it("FILINGS, TVL and GRID keep how where a rewrite is needed", () => {
    const filings = block("  REGULATORY_FILING_MONITOR_GENERAL:").join("\n");
    expect(filings).toContain('how: "Copy the subject of the question verbatim');
    expect(filings).toContain("      form_type:\n        from: entity");
    expect(block("  TVL_LOOKUP_GENERAL:").join("\n")).toContain("how:");
    expect(block("  GRID_POWER_PRICE_GENERAL:").join("\n")).toContain("how:");
  });

  it("GRID names Elering (not ENTSO-E) and lists exactly the served zones", () => {
    expect(yaml).not.toContain("ENTSO");
    const ep = block("  - path: /v1/grid-price").join("\n");
    expect(ep).toContain("Elering dashboard API");
    for (const z of ["TH_NP15_GEN-APND", "TH_SP15_GEN-APND", "TH_ZP26_GEN-APND", "ZONE_A to ZONE_K", "EE, FI, LV, LT"]) {
      expect(ep).toContain(z);
    }
    expect(ep).not.toMatch(/ERCOT|MISO|HB_NORTH/);
  });

  it("FILINGS entity how copies the subject verbatim incl. form type and CIK (A1 r8 wording)", () => {
    expect(yaml).toContain(
      `how: "Copy the subject of the question verbatim, including any SEC form type and CIK (e.g. 'Form 10-Q filings by Tesla, Inc. (CIK 1318605)')."`,
    );
    expect(yaml).not.toContain("without the form type");
    expect(yaml).not.toMatch(/Federal Register/);
  });

  it("errors block points at the fields errorBody() really emits", () => {
    expect(yaml).toContain("\nerrors:\n  message_path: message\n  code_path: code\n\n");
    const body = errorBody(new ApiError(422, "INVALID_PAIR", "x"));
    expect(body.message).toBe("x");
    expect(body.code).toBe("INVALID_PAIR");
  });

  it("the hash format the YAML states (64 lowercase hex, no 0x) is what makeReceipt emits", () => {
    expect(yaml).toContain("64 lowercase hex characters, no 0x prefix");
    const r = makeReceipt("TVL_LOOKUP_GENERAL", "https://example.invalid", "abc", "1/1");
    expect(r.raw_response_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("limitations use the machine-enforced codes MAX_PARAM_SIZE and MAX_PARAM_VALUE", () => {
    expect(yaml).not.toContain("MAX_PARAM_LENGTH");
    expect(yaml).toContain("  - code: MAX_PARAM_SIZE\n");
    for (const p of ["entity", "protocol"]) {
      expect(yaml).toContain(`    param: ${p}\n    property: length\n    value_num: 512\n    operator: lte\n`);
    }
    expect(yaml).toContain("  - code: MAX_PARAM_VALUE\n");
    expect(yaml).toContain("    param: validator_index\n    property: value\n    value_num: 1000000000\n    operator: lte\n");
    // `index` is not a declared input or alias.
    expect(yaml).not.toMatch(/name: index\b/);
  });

  it("docs links point at the hosts that answer 200 (verified live 2026-11-21)", () => {
    expect(block("docs:")).toEqual([
      "  website: https://verireceipt.vercel.app",
      "  documentation: https://verireceipt.vercel.app/docs",
      "  repository: https://github.com/mohamedwael201193/verireceipt",
      "",
    ]);
  });

  it("ends with exactly one trailing newline (YAML_HASH is over the raw bytes)", () => {
    expect(yaml.endsWith("\n")).toBe(true);
    expect(yaml.endsWith("\n\n")).toBe(false);
  });
});
