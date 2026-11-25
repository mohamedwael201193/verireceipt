// The personal-agent heartbeat (mission #197): fresh answers are reused
// inside their declared window, stale ones re-bought, spend reserved before
// signing against the shared daily cap, failed payments and conflicting
// provider answers HOLD instead of serving an invented answer.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareDecimals, diffBps, runHeartbeat, type Memo, type Watch } from "../src/personalAgent";
import type { SpendLedger } from "../src/gate";
import type { verifyPurchase } from "../src/verify";

const live402 = readFileSync(join(__dirname, "fixtures", "challenge-774921.json"), "utf8");
const acct = privateKeyToAccount(generatePrivateKey());
const makePayer = () => ({ address: acct.address, signMessage: vi.fn((message: string) => acct.signMessage({ message })) });
const from = acct.address.toLowerCase();
const H1 = "0x" + "11".repeat(32);
const H2 = "0x" + "22".repeat(32);

function node(results: Record<string, { value: string; hash: string }>, failPaid = false) {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/v1/ledger/account/")) return new Response(JSON.stringify({ available: "1000000", balance: "1", deposited: "1", unbilled: "0", charged: "0" }));
    const h = new Headers(init?.headers);
    if (!h.get("X-PAYMENT")) {
      const askedMiner = /\/v1\/ask\/([^/?]+)/.exec(url)?.[1] ?? "774921";
      return new Response(live402.replaceAll("/v1/ask/774921", `/v1/ask/${askedMiner}`), { status: 402 });
    }
    if (failPaid) return new Response("upstream down", { status: 503 });
    const miner = /\/v1\/ask\/([^/?]+)/.exec(url)?.[1] ?? "774921";
    const r = results[miner];
    if (!r) return new Response("unknown miner", { status: 404 });
    const receipt = Buffer.from(JSON.stringify({
      receipt_hash: "0x" + "ab".repeat(32), rail: "escrow", payer: from, miner, intent: "GRID_POWER_PRICE_GENERAL",
      amount_uusdc: "10000", epoch_id: 31, settlement: "epoch", chain: "telegraph", timestamp: Math.floor(Date.now() / 1000),
    })).toString("base64");
    return new Response(JSON.stringify({ miner_id: miner, result: { lmp_usd_per_mwh: Number(r.value) }, field_status: {}, signal_hash: r.hash }), { status: 200, headers: { "x-payment-response": receipt } });
  });
  return { f: f as unknown as typeof fetch };
}

const verifyStub = (values: Record<string, string>) =>
  (vi.fn(async (input: { signalHash: string }) => ({
    verified: true,
    checks: [{ name: "stub", ok: true, detail: "injected verifier" }],
    minerReceipt: null,
    rawSha256: null,
    rawBytes: null,
    payloadValue: values[input.signalHash],
    intentId: "GRID_POWER_PRICE_GENERAL",
    request: null,
    requestParams: null,
    signalTimestamp: "2026-11-25T05:55:00Z",
    fields: { lmp_usd_per_mwh: { value: values[input.signalHash] } },
    payloadResponse: null,
  })) as unknown as typeof verifyPurchase);

const dirs: string[] = [];
function workspace() {
  const d = mkdtempSync(join(tmpdir(), "heartbeat-"));
  dirs.push(d);
  const spend: SpendLedger = {
    reservationsFile: join(d, "reservations.jsonl"),
    lockFile: join(d, "spend.lock"),
    readSettlementSnapshot: () => ({ settledTodayUusdc: 0n, settledNonces: new Set<string>() }),
    settledTodayUusdc: () => 0n,
    settledNonces: () => new Set<string>(),
  };
  return { dir: d, memosFile: join(d, "memos.jsonl"), spend };
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const NOW = new Date("2026-11-25T06:00:00Z");
const watch = (over: Partial<Watch> = {}): Watch => ({
  id: "w-caiso",
  intent: "GRID_POWER_PRICE_GENERAL",
  params: { node_or_zone: "TH_NP15_GEN-APND" },
  field: "lmp_usd_per_mwh",
  rule: { op: "lte", value: "100" },
  max_age_seconds: 3600,
  rationale: "test watch",
  ...over,
});
const opts = (w: ReturnType<typeof workspace>, over: Record<string, unknown> = {}) => ({
  spend: w.spend,
  memosFile: w.memosFile,
  f: node({ "774921": { value: "61.5", hash: H1 } }).f,
  verify: verifyStub({ [H1]: "61.5" }),
  now: () => NOW,
  ...over,
});
const priorMemo = (over: Partial<Memo> = {}): Memo => ({
  version: 1, watch_id: "w-caiso", at: "2026-11-25T05:30:00.000Z", status: "PASS",
  result: "60.25", source: "paid purchase · GRID_POWER_PRICE_GENERAL · miner 774921", uncertainty: "signal 2026-11-25T05:25:00Z",
  rule: { op: "lte", value: "100" }, rule_outcome: "inside", reason: null,
  receipts: [{ miner_id: "774921", nonce: "n0", receipt_hash: "0x" + "ab".repeat(32), charge_uusdc: "10000" }],
  day_cost_uusdc: "10000",
  ...over,
});
const memos = (w: ReturnType<typeof workspace>): Memo[] =>
  readFileSync(w.memosFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Memo);

describe("compareDecimals / diffBps", () => {
  it("compares exact decimals with mixed precision and signs", () => {
    expect(compareDecimals("61.50", "61.5")).toBe(0);
    expect(compareDecimals("61.4", "61.5")).toBe(-1);
    expect(compareDecimals("100.0001", "100")).toBe(1);
    expect(compareDecimals("-2", "1")).toBe(-1);
    expect(compareDecimals("123456789012345678901234567890", "123456789012345678901234567891")).toBe(-1);
    expect(compareDecimals("1e3", "1000")).toBeNull();
  });
  it("diffBps is exact and symmetric on magnitude", () => {
    expect(diffBps("61.5", "61.5")).toBe(0);
    expect(diffBps("100", "100.5")).toBe(49); // 0.5/100.5 = 49.75 bps, floor
    expect(diffBps("0", "0")).toBe(0);
  });
});

describe("runHeartbeat", () => {
  it("buys a stale watch, verifies, evaluates the rule and writes a PASS memo with receipt and day cost", async () => {
    const w = workspace();
    const payer = makePayer();
    const out = await runHeartbeat(payer, [watch()], opts(w));
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.status).toBe("PASS");
    expect(m.result).toBe("61.5");
    expect(m.rule_outcome).toBe("inside");
    expect(m.receipts).toHaveLength(1);
    expect(m.receipts[0].charge_uusdc).toBe("10000");
    expect(m.day_cost_uusdc).toBe("10000");
    expect(m.source).toContain("verified end to end");
    expect(payer.signMessage).toHaveBeenCalledOnce();
    const r = JSON.parse(readFileSync(w.spend.reservationsFile, "utf8").trim());
    expect(r.kind).toBe("heartbeat");
    expect(r.amount_uusdc).toBe("10000");
    expect(memos(w)).toHaveLength(1);
  });
  it("reuses a fresh verified answer instead of paying again", async () => {
    const w = workspace();
    appendFileSync(w.memosFile, JSON.stringify(priorMemo()) + "\n");
    const payer = makePayer();
    const out = await runHeartbeat(payer, [watch()], opts(w));
    expect(out[0].status).toBe("REUSED");
    expect(out[0].result).toBe("60.25");
    expect(out[0].receipts).toEqual([]);
    expect(out[0].day_cost_uusdc).toBe("10000");
    expect(payer.signMessage).not.toHaveBeenCalled();
  });
  it("re-buys when the cached answer is older than the declared window", async () => {
    const w = workspace();
    appendFileSync(w.memosFile, JSON.stringify(priorMemo({ at: "2026-11-25T01:00:00.000Z" })) + "\n");
    const payer = makePayer();
    const out = await runHeartbeat(payer, [watch()], opts(w));
    expect(out[0].status).toBe("PASS");
    expect(out[0].result).toBe("61.5");
    expect(out[0].day_cost_uusdc).toBe("20000");
    expect(payer.signMessage).toHaveBeenCalledOnce();
  });
  it("SKIPs with a logged reason when the daily cap is already consumed, and never signs", async () => {
    const w = workspace();
    writeFileSync(w.spend.reservationsFile, JSON.stringify({ kind: "gate", nonce: "gate-run", amount_uusdc: "2000000", reserved_at: NOW.toISOString() }) + "\n");
    const payer = makePayer();
    const out = await runHeartbeat(payer, [watch()], opts(w));
    expect(out[0].status).toBe("SKIP");
    expect(out[0].reason).toMatch(/daily cap/);
    expect(out[0].result).toBeNull();
    expect(out[0].receipts).toEqual([]);
    expect(payer.signMessage).not.toHaveBeenCalled();
  });
  it("HOLDs a failed payment and serves no invented answer", async () => {
    const w = workspace();
    const payer = makePayer();
    const out = await runHeartbeat(payer, [watch()], opts(w, { f: node({ "774921": { value: "61.5", hash: H1 } }, true).f }));
    expect(out[0].status).toBe("HOLD");
    expect(out[0].reason).toMatch(/failed payment/);
    expect(out[0].result).toBeNull();
  });
  it("HOLDs when the paid answer fails end-to-end verification and records the charge", async () => {
    const w = workspace();
    const badVerify = (vi.fn(async () => ({
      verified: false, checks: [{ name: "delivery", ok: false, detail: "raw bytes differ" }], minerReceipt: null,
      rawSha256: null, rawBytes: null, payloadValue: undefined, intentId: null, request: null, requestParams: null,
      signalTimestamp: null, fields: null, payloadResponse: null,
    })) as unknown as typeof verifyPurchase);
    const out = await runHeartbeat(makePayer(), [watch()], opts(w, { verify: badVerify }));
    expect(out[0].status).toBe("HOLD");
    expect(out[0].reason).toMatch(/failed end-to-end verification/);
    expect(out[0].receipts).toHaveLength(1);
  });
  it("HOLDs conflicting provider answers with both receipts and no served value", async () => {
    const w = workspace();
    const payer = makePayer();
    const out = await runHeartbeat(
      payer,
      [watch({ cross_check: { miner_id: "774999", tolerance_bps: 50 } })],
      opts(w, {
        f: node({ "774921": { value: "61.5", hash: H1 }, "774999": { value: "60.0", hash: H2 } }).f,
        verify: verifyStub({ [H1]: "61.5", [H2]: "60.0" }),
      }),
    );
    expect(out[0].status).toBe("HOLD");
    expect(out[0].reason).toMatch(/conflicting provider answers/);
    expect(out[0].result).toBeNull();
    expect(out[0].receipts).toHaveLength(2);
    expect(out[0].day_cost_uusdc).toBe("20000");
  });
  it("PASSes a cross-check within tolerance and says so in the source line", async () => {
    const w = workspace();
    const out = await runHeartbeat(
      makePayer(),
      [watch({ cross_check: { miner_id: "774999", tolerance_bps: 100 } })],
      opts(w, {
        f: node({ "774921": { value: "61.5", hash: H1 }, "774999": { value: "61.45", hash: H2 } }).f,
        verify: verifyStub({ [H1]: "61.5", [H2]: "61.45" }),
      }),
    );
    expect(out[0].status).toBe("PASS");
    expect(out[0].source).toContain("cross-checked against miner 774999");
    expect(out[0].receipts).toHaveLength(2);
  });
});
