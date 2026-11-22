import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
vi.mock("../src/core/storage", () => ({ saveReceipt: vi.fn() }));
import { saveReceipt } from "../src/core/storage";
import { handleRouteWithRpcs, expectedBlockHeight } from "../src/handlers/optimalRoute";
import { sha256Hex } from "../src/core/receipt";

// Original loopback-only adversarial fixtures, not source/evaluator examples.
// Simulated chain changes are test controls, never live evidence or site data.
const servers: Server[] = [];
const hashA = "0x" + "a1".repeat(32);
const hashB = "0x" + "b2".repeat(32);
const word = (n: bigint) => n.toString(16).padStart(64, "0");
type Mode = "healthy" | "reorg-before" | "reorg-after-first" | "unsupported";
type State = { calls: Array<{ url: string; params: unknown[] }>; count: number; number: number; timestamp: number };
const state = (): State => ({ calls: [], count: 0, number: expectedBlockHeight(Math.floor(Date.now() / 1000)), timestamp: Math.floor(Date.now() / 1000) });
async function fixture(s: State, amount: bigint, mode: Mode, delta = 0): Promise<string> {
  let url = "";
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let result: unknown;
      let error: { code: number; message: string } | undefined;
      if (body.method === "eth_blockNumber") result = `0x${(s.number + delta).toString(16)}`;
      else if (body.method === "eth_getBlockByNumber") result = {
        number: `0x${(s.number + delta).toString(16)}`, hash: delta ? hashB : hashA,
        parentHash: delta ? hashA : "0x" + "cc".repeat(32), timestamp: `0x${(s.timestamp + 12 * delta).toString(16)}`,
      };
      else if (body.method === "eth_call") {
        s.calls.push({ url, params: body.params });
        const ref = body.params[1];
        const hashBound = ref !== null && typeof ref === "object";
        const canonical = hashBound && ref.blockHash === hashA && ref.requireCanonical === true;
        const index = s.count++;
        if (hashBound && (!canonical || mode === "reorg-before" || (mode === "reorg-after-first" && index > 0))) {
          error = { code: -32000, message: "test fixture: requested hash is no longer canonical" };
        } else if (hashBound && mode === "unsupported") {
          error = { code: -32602, message: "test fixture: hash identifier unsupported" };
        } else {
          // Number tags follow the replacement branch. Hash-bound successes
          // retain state A, even if that block later ceases to be canonical.
          const onReplacement = !hashBound && (mode === "reorg-before" || (mode === "reorg-after-first" && index > 0));
          const out = amount + (onReplacement ? amount / 400n : 0n);
          const data = String(body.params[0].data);
          result = "0x" + (data.startsWith("0xd06ca61f")
            ? word(32n) + word(2n) + word(amount < 2_000_000n ? 1_000_000n : 10n ** 18n) + word(out)
            : data.startsWith("0x5e0d443f") ? word(out)
              : word(out) + word(1n) + word(0n) + word(100_000n));
        }
      } else error = { code: -32601, message: "unexpected loopback method" };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(error ? { error } : { result }) }));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return url;
}
async function run(pair: string, amount: bigint, mode: Mode, mixed = false, adjacent = false) {
  const s = state();
  const urls = await Promise.all([fixture(s, amount, mode), fixture(s, amount, mixed ? "healthy" : mode, adjacent ? 1 : 0), fixture(s, amount, mixed ? "healthy" : mode, adjacent ? 1 : 0)]);
  const result = await handleRouteWithRpcs({ pair }, urls).catch(error => error);
  return { s, urls, result };
}
function expectBound(s: State) {
  expect(s.calls.length).toBeGreaterThan(0);
  for (const call of s.calls) expect(call.params[1]).toEqual({ blockHash: hashA, requireCanonical: true });
}
beforeEach(() => {
  vi.mocked(saveReceipt).mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  })));
});
for (const [pair, amount] of [["ETH/USDC", 3_200_000_000n], ["USDT/USDC", 1_000_000n]] as const) {
  it(`${pair}: every successful venue/tier uses one canonical hash and the stored receipt binds it`, async () => {
    const { s, result } = await run(pair, amount, "healthy");
    expect(result.verdict).toBe("verified");
    expect(result.amount_out).toBe(Number(amount));
    expect(result.block_number).toBe(s.number);
    expectBound(s);
    const [receipt, raw] = vi.mocked(saveReceipt).mock.calls[0];
    const evidence = JSON.parse(raw!.toString());
    expect(evidence.block_hash).toBe(hashA);
    expect(evidence.block_number).toBe(s.number);
    expect(evidence.request.params[1]).toEqual({ blockHash: hashA, requireCanonical: true });
    expect(receipt.raw_response_sha256).toBe(sha256Hex(raw!));
    expect(result.receipt).toEqual(receipt);
  });
  it(`${pair}: a reorg after headers but before quotes cannot return replacement-state data`, async () => {
    const { s, result } = await run(pair, amount, "reorg-before");
    expect(result).toMatchObject({ status: 502, code: "ALL_QUOTERS_FAILED" });
    expect(result.amount_out).toBeUndefined();
    expect(saveReceipt).not.toHaveBeenCalled();
    expectBound(s);
  });
  it(`${pair}: a mid-quote reorg cannot mix replacement-state amounts into surviving state-A evidence`, async () => {
    const { s, result } = await run(pair, amount, "reorg-after-first");
    expect(result.verdict).toBe("verified");
    expect(result.amount_out).toBe(Number(amount));
    expect(result.confidence).toBe(0.9);
    expectBound(s);
    const evidence = JSON.parse(vi.mocked(saveReceipt).mock.calls[0][1]!.toString());
    expect(evidence.block_hash).toBe(hashA);
  });
  it(`${pair}: unsupported hash objects fail over without weakening to a number tag`, async () => {
    const { s, urls, result } = await run(pair, amount, "unsupported", true);
    expect(result.verdict).toBe("verified");
    expectBound(s);
    const [receipt] = vi.mocked(saveReceipt).mock.calls[0];
    expect(receipt.upstream_url).not.toBe(urls[0]);
  });
  it(`${pair}: all unsupported hash providers fail closed, never retry with a number`, async () => {
    const { s, result } = await run(pair, amount, "unsupported");
    expect(result).toMatchObject({ status: 502, code: "ALL_QUOTERS_FAILED" });
    expect(saveReceipt).not.toHaveBeenCalled();
    expectBound(s);
  });
  it(`${pair}: an adjacent-header quorum pins calls to the minimum block's hash`, async () => {
    const { s, result } = await run(pair, amount, "healthy", false, true);
    expect(result.verdict).toBe("verified");
    expect(result.block_number).toBe(s.number);
    expectBound(s);
  });
}
it("hash binding cannot bypass receipt persistence failure", async () => {
  vi.mocked(saveReceipt).mockRejectedValueOnce(new Error("synthetic isolated storage failure"));
  const { result } = await run("ETH/USDC", 3_200_000_000n, "healthy");
  expect(result).toMatchObject({ status: 502, code: "RECEIPT_PERSIST_FAILED" });
  expect(result.responseBody).toBeUndefined();
});
