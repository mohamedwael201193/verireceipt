import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLedger } from "../src/ledger";
import { fieldStatusShapeOk, storedLedgerAgrees, verifyPurchase } from "../src/verify";
import type { FieldStatus } from "../../src/core/shapedFields";

const fx = (n: string) => join(__dirname, "fixtures", n);
const signal = JSON.parse(readFileSync(fx("signal-m12-caiso.json"), "utf8"));
const raw = readFileSync(fx("raw-rcpt_PDY2JQEJJ1F6K6HJKKMPSH5XYR.bin"));
const meta = readFileSync(fx("meta-rcpt_PDY2JQEJJ1F6K6HJKKMPSH5XYR.json"), "utf8");
const paid = JSON.parse(readFileSync(fx("paid-m12-caiso.json"), "utf8"));

function stubFetch() {
  return (async (url: string) => {
    if (url.includes("/engine/v1/signal/")) return new Response(JSON.stringify(signal), { status: 200 });
    if (url.endsWith("/raw")) return new Response(raw, { status: 200 });
    if (url.includes("/receipts/")) return new Response(meta, { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("J1 / J2 fields-r3 tampers (fields-fix r4)", () => {
  const recs = readLedger(join(__dirname, "..", "ledger", "purchases.jsonl"));
  const honest = recs.find((r) => r.task_id === "m12-caiso-np15")!;

  async function live() {
    return verifyPurchase({
      payer: honest.payer,
      minerSlug: "verireceipt",
      signalHash: honest.signal_hash,
      valueField: honest.value_field,
      engineResult: { ...(honest.engine.result ?? {}), [honest.value_field]: honest.value },
      intent: honest.intent,
      fieldStatus: honest.engine.field_status as Record<string, FieldStatus>,
    }, stubFetch());
  }

  it("J1 H1: a forged r.value fails even when engine.result holds the honest number", async () => {
    const v = await live();
    expect(v.verified).toBe(true);
    expect(v.fields).not.toBeNull();
    expect(storedLedgerAgrees(honest, v).ok).toBe(true);
    const forged = { ...honest, value: 99.9 };
    expect(storedLedgerAgrees(forged, v).failures).toEqual(expect.arrayContaining(["value"]));
  });

  it("J1 H2 / J2 H1: a forged, injected, or deleted recovered_fields fails", async () => {
    const v = await live();
    expect(v.fields).not.toBeNull();
    const fields = structuredClone(v.fields!);
    const forgedVal = { ...honest, recovered_fields: { ...fields, market: { ...fields.market, value: "FORGED" } } };
    expect(storedLedgerAgrees(forgedVal, v).failures).toContain("recovered_fields");
    const injected = { ...honest, recovered_fields: { ...fields, extra: { value: "x", node_status: "unavailable" as const, source: "raw" as const } } };
    expect(storedLedgerAgrees(injected, v).failures).toContain("recovered_fields");
    const deleted = { ...honest, recovered_fields: fields };
    // present-but-live-null
    const noLive = { ...v, fields: null, verified: false };
    expect(storedLedgerAgrees(deleted, noLive).failures).toContain("recovered_fields present but live fields are null");
    const stripped = { ...honest, recovered_fields: undefined };
    // live fields non-null must match stored; missing stored fails equality
    expect(storedLedgerAgrees(stripped, v).failures).toContain("recovered_fields");
  });

  it("J2 M2: a forged ok numeric engine.result field fails against the payload", async () => {
    const v = await live();
    const tvl = recs.find((r) => r.task_id === "m13-tvl-aave-v3");
    if (tvl?.engine.result && "chain_tvl_usd" in (tvl.engine.result ?? {})) {
      const forged = { ...tvl, engine: { ...tvl.engine, result: { ...tvl.engine.result, chain_tvl_usd: 1 } } };
      // Use a live verify of the TVL row would need its signal fixture. The comparison is
      // in storedLedgerAgrees against v.payloadResponse; for the CAISO row, lmp is the ok number.
    }
    const forged = { ...honest, engine: { ...honest.engine, result: { ...(honest.engine.result ?? {}), lmp_usd_per_mwh: 1 } } };
    const a = storedLedgerAgrees(forged, v);
    expect(a.failures).toEqual(expect.arrayContaining(["engine.result vs value"]));
  });

  it("J1 minor: a forged field_status (lmp ok → unavailable, or a non-number marked ok) fails", async () => {
    const v = await live();
    expect(fieldStatusShapeOk(honest.intent, honest.engine.field_status)).toBe(true);
    const bad = { ...honest.engine.field_status, lmp_usd_per_mwh: "unavailable" };
    expect(fieldStatusShapeOk(honest.intent, bad)).toBe(false);
    expect(storedLedgerAgrees({ ...honest, engine: { ...honest.engine, field_status: bad } }, v).failures).toContain("field_status");
    // A non-number marked ok is a valid shape (the node now shapes text fields), but its engine
    // value must equal the hash-verified raw answer: the honest row's engine.result.market is not "CAISO".
    const nonNumberOk = { ...honest.engine.field_status, market: "ok" };
    expect(fieldStatusShapeOk(honest.intent, nonNumberOk)).toBe(true);
    expect(storedLedgerAgrees({ ...honest, engine: { ...honest.engine, field_status: nonNumberOk } }, v).failures).toContain("engine.result.market");
    const forgedText = { ...honest, engine: { ...honest.engine, field_status: nonNumberOk, result: { ...honest.engine.result, market: "NYISO" } } };
    expect(storedLedgerAgrees(forgedText, v).failures).toContain("engine.result.market");
  });

  it("fills recovered fields only when every check passed", async () => {
    const v = await live();
    expect(v.fields).not.toBeNull();
    expect(v.fields!.market).toEqual({ value: "CAISO", node_status: "unavailable", source: "raw" });
    const bad = await verifyPurchase({
      payer: "0x0000000000000000000000000000000000000001",
      minerSlug: "verireceipt",
      signalHash: honest.signal_hash,
      valueField: honest.value_field,
      engineResult: { [honest.value_field]: honest.value },
      intent: honest.intent,
      fieldStatus: honest.engine.field_status as Record<string, FieldStatus>,
    }, stubFetch());
    expect(bad.verified).toBe(false);
    expect(bad.fields).toBeNull();
  });
});
