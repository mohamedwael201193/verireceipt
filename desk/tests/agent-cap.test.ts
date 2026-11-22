// runDesk must join the shared reservation journal (reviewer: the ordinary
// purchase path signed past reservations that the gate had journaled).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDesk } from "../src/agent";
import type { SpendLedger } from "../src/gate";

const live402 = readFileSync(join(__dirname, "fixtures", "challenge-774921.json"), "utf8");
const acct = privateKeyToAccount(generatePrivateKey());
const makePayer = () => ({ address: acct.address, signMessage: vi.fn((message: string) => acct.signMessage({ message })) });
const from = acct.address.toLowerCase();

function node() {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/v1/ledger/account/")) return new Response(JSON.stringify({ available: "1000000", balance: "1", deposited: "1", unbilled: "0", charged: "0" }));
    const h = new Headers(init?.headers);
    if (!h.get("X-PAYMENT")) return new Response(live402, { status: 402 });
    const receipt = Buffer.from(JSON.stringify({
      receipt_hash: "0x" + "ab".repeat(32), rail: "escrow", payer: from, miner: "6152", intent: "ONCHAIN_TX_LOOKUP_GENERAL",
      amount_uusdc: "10000", epoch_id: 31, settlement: "epoch", chain: "telegraph", timestamp: Math.floor(Date.now() / 1000),
    })).toString("base64");
    // No signal_hash: verification is skipped, the record lands UNVERIFIED.
    return new Response(JSON.stringify({ result: { block_number: 1 } }), { status: 200, headers: { "x-payment-response": receipt } });
  });
  return { f: f as unknown as typeof fetch };
}

const dirs: string[] = [];
function workspace(over: Partial<SpendLedger> = {}) {
  const d = mkdtempSync(join(tmpdir(), "desk-cap-"));
  dirs.push(d);
  const spend: SpendLedger = {
    reservationsFile: join(d, "reservations.jsonl"),
    lockFile: join(d, "spend.lock"),
    readSettlementSnapshot: () => ({ settledTodayUusdc: 0n, settledNonces: new Set<string>() }),
    settledTodayUusdc: () => 0n,
    settledNonces: () => new Set<string>(),
    ...over,
  };
  return { dir: d, ledgerFile: join(d, "purchases.jsonl"), spend };
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const opts = (w: ReturnType<typeof workspace>) => ({
  ledgerFile: w.ledgerFile,
  minerIds: ["774921", "6160", "6152"],
  taskIds: ["m13-tx-desk-deposit"],
  f: node().f,
  spend: w.spend,
});

describe("runDesk shared cap", () => {
  it("refuses to sign when journaled reservations already consume the daily cap", async () => {
    const w = workspace();
    writeFileSync(w.spend.reservationsFile, JSON.stringify({ kind: "gate", nonce: "gate-run", amount_uusdc: "2000000", reserved_at: new Date().toISOString() }) + "\n");
    const payer = makePayer();
    await expect(runDesk(payer, opts(w))).rejects.toThrow(/daily cap/);
    expect(payer.signMessage).not.toHaveBeenCalled();
    // No new reservation was journaled.
    expect(readFileSync(w.spend.reservationsFile, "utf8").trim().split("\n")).toHaveLength(1);
  });
  it("journals the desk purchase into the shared reservations file before signing", async () => {
    const w = workspace();
    const payer = makePayer();
    payer.signMessage = vi.fn((message: string) => {
      const lines = readFileSync(w.spend.reservationsFile, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const r = JSON.parse(lines[0]);
      expect(r.kind).toBe("desk");
      expect(r.amount_uusdc).toBe("10000");
      return acct.signMessage({ message });
    });
    const records = await runDesk(payer, opts(w));
    expect(records).toHaveLength(1);
    const r = JSON.parse(readFileSync(w.spend.reservationsFile, "utf8").trim().split("\n")[0]);
    expect(records[0].nonce).toBe(r.nonce);
    expect(payer.signMessage).toHaveBeenCalledOnce();
  });
});
