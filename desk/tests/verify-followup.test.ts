import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLedger } from "../src/ledger";
import { catalogAgrees, TASK_CATALOG } from "../src/missions";
import { storedLedgerAgrees, uniquePurchaseIds, verifyPurchase, type VerifyOutput } from "../src/verify";
import type { FieldStatus } from "../../src/core/shapedFields";

const fx = (n: string) => join(__dirname, "fixtures", n);
const signal = JSON.parse(readFileSync(fx("signal-m12-caiso.json"), "utf8"));
const raw = readFileSync(fx("raw-rcpt_PDY2JQEJJ1F6K6HJKKMPSH5XYR.bin"));
const meta = readFileSync(fx("meta-rcpt_PDY2JQEJJ1F6K6HJKKMPSH5XYR.json"), "utf8");

function stubFetch() {
  return (async (url: string) => {
    if (url.includes("/engine/v1/signal/")) return new Response(JSON.stringify(signal), { status: 200 });
    if (url.endsWith("/raw")) return new Response(raw, { status: 200 });
    if (url.includes("/receipts/")) return new Response(meta, { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("desk-d-followup tampers (J2 M1, J1/J2 minors)", () => {
  const recs = readLedger(join(__dirname, "..", "ledger", "purchases.jsonl"));
  const caiso = recs.find((r) => r.task_id === "m12-caiso-np15")!;
  const nyiso = recs.find((r) => r.task_id === "m12-nyiso-zone-j")!;

  async function live(): Promise<VerifyOutput> {
    return verifyPurchase({
      payer: caiso.payer,
      minerSlug: "verireceipt",
      signalHash: caiso.signal_hash,
      valueField: caiso.value_field,
      engineResult: { ...(caiso.engine.result ?? {}), [caiso.value_field]: caiso.value },
      intent: caiso.intent,
      fieldStatus: caiso.engine.field_status as Record<string, FieldStatus>,
    }, stubFetch());
  }

  it("T40: swapping task_id/title between the two GRID rows fails the catalog pin on node_or_zone and market", async () => {
    const v = await live();
    expect(storedLedgerAgrees(caiso, v).ok).toBe(true);
    expect(TASK_CATALOG["m12-caiso-np15"].node_or_zone).toBe("TH_NP15_GEN-APND");
    expect(TASK_CATALOG["m12-caiso-np15"].market).toBe("CAISO");
    expect(TASK_CATALOG["m12-nyiso-zone-j"].node_or_zone).toBe("ZONE_J");
    expect(TASK_CATALOG["m12-nyiso-zone-j"].market).toBe("NYISO");
    const swapped = { ...caiso, task_id: nyiso.task_id, title: nyiso.title };
    expect(catalogAgrees(swapped)).toBe(false);
    expect(storedLedgerAgrees(swapped, v).failures).toContain("catalog");
  });

  it("T40b: two rows with the same task_id fail uniqueness", () => {
    expect(uniquePurchaseIds(recs).ok).toBe(true);
    expect(uniquePurchaseIds([caiso, { ...nyiso, task_id: caiso.task_id }]).failures.join(" ")).toMatch(/duplicate task_id/);
  });

  it("the same task may be bought once per epoch: a later-epoch row of the same task passes, a same-epoch repeat fails", () => {
    const later = recs.find((r) => r.task_id === "m12-caiso-np15" && r.telegraph_receipt.epoch_id !== caiso.telegraph_receipt.epoch_id);
    expect(later).toBeTruthy();
    expect(uniquePurchaseIds([caiso, later!]).ok).toBe(true);
    const sameEpoch = { ...later!, telegraph_receipt: { ...later!.telegraph_receipt, epoch_id: caiso.telegraph_receipt.epoch_id } };
    expect(uniquePurchaseIds([caiso, sameEpoch]).failures.join(" ")).toMatch(/duplicate task_id/);
  });

  it("J1 Minor 3: missing or non-string title, bought_at, or miner fails (not skipped)", async () => {
    const v = await live();
    const { title: _t, ...noTitle } = caiso;
    expect(storedLedgerAgrees(noTitle as typeof caiso, v).failures).toContain("catalog");
    expect(storedLedgerAgrees({ ...caiso, title: ["NYISO"] as unknown as string }, v).failures).toContain("catalog");
    const { bought_at: _b, ...noBought } = caiso;
    expect(storedLedgerAgrees(noBought as typeof caiso, v).failures).toContain("bought_at");
    expect(storedLedgerAgrees({ ...caiso, bought_at: 1795267605 as unknown as string }, v).failures).toContain("bought_at");
    const { miner: _m, ...receipt } = caiso.telegraph_receipt;
    expect(storedLedgerAgrees({ ...caiso, telegraph_receipt: receipt }, v).failures).toContain("miner");
    expect(storedLedgerAgrees({ ...caiso, telegraph_receipt: { ...caiso.telegraph_receipt, miner: 6152 as unknown as string } }, v).failures).toContain("miner");
  });

  it("J2 Minor: nonce uniqueness is case-insensitive", () => {
    expect(uniquePurchaseIds([caiso, { ...nyiso, nonce: caiso.nonce.toUpperCase() }]).failures.join(" ")).toMatch(/duplicate nonce/);
  });
});
