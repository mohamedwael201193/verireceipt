// fields-fix: why the node reports non-numeric fields `unavailable` on paid
// calls, and the consumer-side reconciliation. Fixtures are REAL paid
// escrow ask_direct replies (devnode, 2026-11-21) paired with the raw answer
// the node stored under the reply's signal_hash (GET /engine/v1/signal/{hash};
// each payload re-hashed to the same signal_hash with the desk verifier).
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import {
  FIELD_FORMAT,
  formatFor,
  OUTPUT_MAPPING,
  isNumericField,
  mappingFor,
  parserFields,
  readPath,
  reconcileShaped,
  valueMatchesFormat,
  type ShapedReply,
} from "../src/core/shapedFields";

const yaml = readFileSync(resolve(process.cwd(), "miner.yaml"), "utf8");
const FIX = resolve(process.cwd(), "tests/fixtures/node-shaped");
const fixtures = readdirSync(FIX)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ name: f, ...JSON.parse(readFileSync(resolve(FIX, f), "utf8")) })) as Array<{
  name: string;
  node: ShapedReply & { signal_hash: string; result_shape: string };
  raw: Record<string, unknown>;
}>;

/** intent -> field -> {path, unit?} read from miner.yaml's intent_mapping. */
function yamlOutputs(): Record<string, Record<string, { path?: string; unit?: string }>> {
  const lines = yaml.split("\n");
  const start = lines.indexOf("intent_mapping:");
  expect(start).toBeGreaterThan(-1);
  const res: Record<string, Record<string, { path?: string; unit?: string }>> = {};
  let intent = "";
  let inOutput = false;
  let field = "";
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === "" || l.trimStart().startsWith("#")) continue;
    const ind = l.length - l.trimStart().length;
    if (ind === 0) break;
    const kv = /^\s*([A-Za-z0-9_]+):\s*(.*)$/.exec(l);
    if (!kv) continue;
    const [, k, v] = kv;
    if (ind === 2) { intent = k; res[intent] = {}; inOutput = false; }
    else if (ind === 4) inOutput = k === "output";
    else if (inOutput && ind === 6) { field = k; res[intent][field] = {}; }
    else if (inOutput && ind === 8 && (k === "path" || k === "unit")) {
      res[intent][field][k] = v.replace(/^"(.*)"$/, "$1");
    }
  }
  return res;
}

describe("OUTPUT_MAPPING mirrors miner.yaml", () => {
  it("has exactly the yaml's intents, fields, paths and units", () => {
    const declared=yamlOutputs();const deferred=['GAME_RESULT_GENERAL','VESSEL_TELEMETRY_VERIFY_GENERAL'];expect(Object.keys(OUTPUT_MAPPING).filter(i=>!Object.hasOwn(declared,i)).sort()).toEqual(deferred.sort());expect(Object.fromEntries(Object.entries(OUTPUT_MAPPING).filter(([i])=>Object.hasOwn(declared,i)))).toEqual(declared);
  });
  it("every mapped path is a plain top-level key (one pinned exception)", () => {
    // Exception: URL_SAFE_GENERAL.verdict maps at url_check.verdict. The
    // envelope reserves the top-level `verdict` for the verification status,
    // and the yaml standard's output path is a dot path into the answer
    // (anjoman.ai/docs/miners/yaml-config, intent_mapping output path).
    const ALLOWED_NESTED: Record<string, string> = { "URL_SAFE_GENERAL.verdict": "url_check.verdict" };
    for (const [intent, m] of Object.entries(OUTPUT_MAPPING))
      for (const [f, o] of Object.entries(m)) {
        const exception = ALLOWED_NESTED[`${intent}.${f}`];
        if (exception) expect(o.path).toBe(exception);
        else expect(o.path).toBe(f);
      }
  });
});

describe("root cause evidence: real paid replies", () => {
  it("has the 4 captured replies (3 GRID, 1 TVL)", () => {
    expect(fixtures.map((f) => f.node.intent).sort()).toEqual([
      "GRID_POWER_PRICE_GENERAL", "GRID_POWER_PRICE_GENERAL",
      "GRID_POWER_PRICE_GENERAL", "TVL_LOOKUP_GENERAL",
    ]);
  });

  for (const fx of fixtures) {
    describe(fx.name, () => {
      const mapping = OUTPUT_MAPPING[fx.node.intent];

      it("the raw answer holds every mapped field, non-null, at its path", () => {
        for (const o of Object.values(mapping)) {
          const v = readPath(fx.raw, o.path);
          expect(v, o.path).not.toBeUndefined();
          expect(v, o.path).not.toBeNull();
        }
      });

      it("node: ok exactly on unit (code-computed) fields, unavailable on every parser field", () => {
        expect(fx.node.result_shape).toBe("intent");
        for (const [f, o] of Object.entries(mapping)) {
          expect(fx.node.field_status[f], f).toBe(o.unit !== undefined ? "ok" : "unavailable");
        }
        // never `missing` (a mapping/path error) and never `rejected` (type/verbatim)
        expect(Object.values(fx.node.field_status)).not.toContain("missing");
        expect(Object.values(fx.node.field_status)).not.toContain("rejected");
      });

      it("node's ok numbers equal the raw numbers (unit is already canonical)", () => {
        for (const [f, o] of Object.entries(mapping))
          if (o.unit !== undefined) expect(fx.node.result[f]).toBe(readPath(fx.raw, o.path));
      });

      it("reconcile fills each unavailable field from the verified raw answer", () => {
        const r = reconcileShaped(fx.node, fx.raw, { rawVerified: true });
        for (const [f, o] of Object.entries(mapping)) {
          if (o.unit !== undefined) expect(r[f]).toEqual({ value: fx.node.result[f], node_status: "ok", source: "node" });
          else expect(r[f]).toEqual({ value: readPath(fx.raw, o.path), node_status: "unavailable", source: "raw" });
        }
      });

      it("reconcile fills nothing when the raw answer is not hash-verified", () => {
        const r = reconcileShaped(fx.node, fx.raw, { rawVerified: false });
        for (const f of parserFields(fx.node.intent)) expect(r[f]).toEqual({ value: null, node_status: "unavailable", source: "none" });
      });
    });
  }

  it("concrete values recovered (GRID CAISO, TVL Aave V3)", () => {
    const g = fixtures.find((f) => f.name === "grid-caiso.json")!;
    const rg = reconcileShaped(g.node, g.raw, { rawVerified: true });
    expect([rg.node_or_zone.value, rg.market.value, rg.currency.value, rg.interval_start.value])
      .toEqual(["TH_NP15_GEN-APND", "CAISO", "USD", "2026-11-21T11:00:00.000Z"]);
    const t = fixtures.find((f) => f.name === "tvl-aave.json")!;
    const rt = reconcileShaped(t.node, t.raw, { rawVerified: true });
    expect([rt.protocol_or_chain.value, rt.as_of.value]).toEqual(["aave-v3", "2026-11-21T13:26:51.492Z"]);
  });
});

describe("reconcile never overrides real verdicts or numbers", () => {
  const raw = { lmp_usd_per_mwh: 1, node_or_zone: "X", market: "CAISO", interval_start: "2026-01-01T00:00:00Z", currency: "USD" };
  it("missing / rejected stay null; numeric unavailable is not filled from raw", () => {
    const r = reconcileShaped({
      intent: "GRID_POWER_PRICE_GENERAL",
      result: { lmp_usd_per_mwh: null, node_or_zone: null, market: null, interval_start: null, currency: null },
      field_status: { lmp_usd_per_mwh: "unavailable", node_or_zone: "missing", market: "rejected", interval_start: "unavailable", currency: "ok" },
    }, raw, { rawVerified: true });
    expect(r.lmp_usd_per_mwh.source).toBe("none");
    expect(r.node_or_zone).toEqual({ value: null, node_status: "missing", source: "none" });
    expect(r.market).toEqual({ value: null, node_status: "rejected", source: "none" });
    expect(r.interval_start).toEqual({ value: "2026-01-01T00:00:00Z", node_status: "unavailable", source: "raw" });
    expect(r.currency).toEqual({ value: null, node_status: "ok", source: "node" });
  });
  it("unavailable with no raw value stays null", () => {
    const r = reconcileShaped({ intent: "TVL_LOOKUP_GENERAL", result: {}, field_status: { as_of: "unavailable" } }, {}, { rawVerified: true });
    expect(r.as_of.source).toBe("none");
  });
  it("readPath: arrays, absent keys, unsupported segments", () => {
    expect(readPath({ a: [{ b: 2 }] }, "a.0.b")).toBe(2);
    expect(readPath({ a: 1 }, "b")).toBeUndefined();
    expect(() => readPath({}, "a.*")).toThrow();
  });
  it("parser fields per intent (which intents can hit `unavailable`)", () => {
    expect(parserFields("GRID_POWER_PRICE_GENERAL")).toEqual(["node_or_zone", "market", "interval_start", "currency"]);
    expect(parserFields("TVL_LOOKUP_GENERAL")).toEqual(["protocol_or_chain", "as_of"]);
    expect(parserFields("ONCHAIN_TX_LOOKUP_GENERAL")).toEqual(["tx_hash", "status", "from", "to"]);
    expect(parserFields("REGULATORY_FILING_MONITOR_GENERAL")).toEqual(["entity", "filings", "urls"]);
    expect(parserFields("OPTIMAL_EXECUTION_ROUTE_GENERAL")).toEqual([]);
    expect(parserFields("VALIDATOR_PERFORMANCE_VERIFY_GENERAL")).toEqual([]);
  });
});

describe("J2 fields-fix r3: format type, type check, proto guards", () => {
  it("every mapped field has an official format; present units are numeric and format decides numeric safety", () => {
    for (const [intent, fields] of Object.entries(OUTPUT_MAPPING)) {
      expect(FIELD_FORMAT[intent], intent).toBeTruthy();
      expect(Object.keys(FIELD_FORMAT[intent]).sort()).toEqual(Object.keys(fields).sort());
      for (const [f, o] of Object.entries(fields)) {
        if (o.unit !== undefined) expect(isNumericField(intent, f), `${intent}.${f}`).toBe(true);
        expect(isNumericField(intent, f)).toBe(FIELD_FORMAT[intent][f].type === "number");
        if (FIELD_FORMAT[intent][f].type === "number") {
          const unavailable = reconcileShaped({ intent, result: {}, field_status: { [f]: "unavailable" } }, { [f]: 1 }, { rawVerified: true });
          expect(unavailable[f], `${intent}.${f}`).toEqual({ value: null, node_status: "unavailable", source: "none" });
        }
      }
    }
  });
  it("unitless FX is numeric and never filled from raw", () => {
    const intent = "CURRENCY_EXCHANGE_CONVERT";
    expect(OUTPUT_MAPPING[intent].converted_amount).toEqual({ path: "converted_amount" });
    expect(FIELD_FORMAT[intent].converted_amount.type).toBe("number");
    expect(isNumericField(intent, "converted_amount")).toBe(true);
    for (const status of ["unavailable", "missing", "rejected"] as const) {
      const result = reconcileShaped({ intent, result: {}, field_status: { converted_amount: status } }, { converted_amount: 123 }, { rawVerified: true });
      expect(result.converted_amount).toEqual({ value: null, node_status: status, source: "none" });
    }
    const result = reconcileShaped({ intent, result: { converted_amount: 124 }, field_status: { converted_amount: "ok" } }, { converted_amount: 123 }, { rawVerified: true });
    expect(result.converted_amount).toEqual({ value: 124, node_status: "ok", source: "node" });
  });
  it("a string field with a non-string raw value is not filled (J2 Minor 3 / J1 Minor 3)", () => {
    const r = reconcileShaped({
      intent: "GRID_POWER_PRICE_GENERAL",
      result: {},
      field_status: { market: "unavailable", node_or_zone: "unavailable" },
    }, { market: { evil: 1 }, node_or_zone: "TH_NP15_GEN-APND" }, { rawVerified: true });
    expect(r.market).toEqual({ value: null, node_status: "unavailable", source: "none" });
    expect(r.node_or_zone).toEqual({ value: "TH_NP15_GEN-APND", node_status: "unavailable", source: "raw" });
    expect(valueMatchesFormat({ evil: 1 }, { type: "string" })).toBe(false);
  });
  it("numeric is decided by format type, not only by unit (J2 M / J1 Minor 2)", () => {
    expect(isNumericField("GRID_POWER_PRICE_GENERAL", "lmp_usd_per_mwh")).toBe(true);
    expect(isNumericField("GRID_POWER_PRICE_GENERAL", "market")).toBe(false);
    // A numeric format still wins over a mapping that somehow has no unit — covered by type === "number".
    expect(FIELD_FORMAT.TVL_LOOKUP_GENERAL.chain_tvl_usd.type).toBe("number");
  });
  it("intent __proto__ / constructor throw instead of reading Object.prototype (J2 Minor 1)", () => {
    expect(() => parserFields("__proto__")).toThrow(/unknown intent/);
    expect(() => parserFields("constructor")).toThrow(/unknown intent/);
    expect(mappingFor("__proto__")).toBeUndefined();
    expect(() => reconcileShaped({ intent: "__proto__", result: {}, field_status: { constructor: "unavailable" } } as ShapedReply, {}, { rawVerified: true })).toThrow(/unknown intent/);
  });
  it("an own __proto__ key on field_status does not pollute the result prototype (J2 Minor 2)", () => {
    const status = JSON.parse('{"market":"unavailable","__proto__":{"polluted":true}}') as ShapedReply["field_status"];
    const r = reconcileShaped({ intent: "GRID_POWER_PRICE_GENERAL", result: {}, field_status: status }, { market: "CAISO" }, { rawVerified: true });
    expect(Object.getPrototypeOf(r)).toBe(null);
    expect(Object.prototype.hasOwnProperty.call(r, "__proto__")).toBe(false);
    expect((r as { polluted?: unknown }).polluted).toBeUndefined();
    expect(r.market).toEqual({ value: "CAISO", node_status: "unavailable", source: "raw" });
  });
  it("dangerous path segments are rejected", () => {
    expect(() => readPath({}, "constructor")).toThrow(/unsupported path segment/);
    expect(() => readPath({}, "__proto__")).toThrow(/unsupported path segment/);
  });
});

describe("J2 r3 minors: tighter string / url formats", () => {
  it("rejects empty or invalid TX strings", () => {
    const fmt = formatFor("ONCHAIN_TX_LOOKUP_GENERAL", "tx_hash")!;
    expect(valueMatchesFormat("0xabc", fmt, "tx_hash")).toBe(true);
    expect(valueMatchesFormat("", fmt, "tx_hash")).toBe(false);
    expect(valueMatchesFormat("0xnotanaddress", fmt, "tx_hash")).toBe(false);
    expect(valueMatchesFormat("0xGHI", fmt, "tx_hash")).toBe(false);
    expect(valueMatchesFormat("CAISO\u0000", formatFor("GRID_POWER_PRICE_GENERAL", "market"), "market")).toBe(false);
  });
  it("restricts urls to http(s)", () => {
    const fmt = formatFor("REGULATORY_FILING_MONITOR_GENERAL", "urls")!;
    expect(valueMatchesFormat(["https://sec.gov/a"], fmt, "urls")).toBe(true);
    expect(valueMatchesFormat(["http://example.com/a"], fmt, "urls")).toBe(true);
    expect(valueMatchesFormat(["javascript:alert(1)"], fmt, "urls")).toBe(false);
    expect(valueMatchesFormat(["ftp://x"], fmt, "urls")).toBe(false);
  });
});
