import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { createHash } from "node:crypto";

const scratch = vi.hoisted(() => {
  const path = `/tmp/mapped-persistence-control-${process.pid}-${Date.now()}.sqlite`;
  process.env.SQLITE_PATH = path;
  delete process.env.DATABASE_URL;
  return path;
});
vi.mock("../src/core/storage", async original => {
  const actual = await original<typeof import("../src/core/storage")>();
  return { ...actual, saveReceipt: vi.fn(actual.saveReceipt), getGridPrice: vi.fn(),
    getGridRevalidate: vi.fn(), markGridRevalidateAttempt: vi.fn(), saveGridPrice: vi.fn() };
});
import { saveReceipt, getReceiptEvidence, closeStorage, getGridPrice, getGridRevalidate, markGridRevalidateAttempt, saveGridPrice } from "../src/core/storage";
import { sha256Hex, type Receipt } from "../src/core/receipt";
import { handleTx } from "../src/handlers/txLookup";
import { handleGridPrice } from "../src/handlers/gridPrice";
import { handleTvl, __seedTvlCachesForTests, __clearTvlCachesForTests, __awaitTvlProtocolFillForTests, __setTvlSeedEnabledForTests, __setTvlListsCacheDirForTests } from "../src/handlers/tvl";
import { buildServer } from "../src/server";

// Original offline persistence fault controls only. All transport and row
// fixtures below are newly constructed, not real observations, historical
// evaluator examples, protected inputs or site demonstration data.
const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
const HASH = "0x" + hex("original-mapped-persistence-transaction-v1");
const FROM = "0x" + hex("original-mapped-persistence-sender-v1").slice(0, 40);
const TO = "0x" + hex("original-mapped-persistence-recipient-v1").slice(0, 40);
const BLOCK = "0x6d3";
const VALUE = "0x" + (1_250_000_000_000_000_000n).toString(16);
const PROTOCOL = "Original Proof Protocol";
const SLUG = "original-proof-protocol";
const CHAIN = "OriginalProofChain";
const TVL = 7654321.25;
const PRICE = 13.625;
type TxState = "confirmed" | "reverted" | "pending" | "not_found";
let txState: TxState;
let fallbackTvl: boolean;
let oldGrid: boolean;
const interval = () => new Date(Math.floor(Date.now() / 3600000) * 3600000 - (oldGrid ? 12 * 86400000 : 3600000)).toISOString();
const expected = { status: 502, code: "RECEIPT_PERSIST_FAILED", message: "receipt evidence could not be stored; answer unavailable" };
function rpcResult(method: string, params: unknown[]) {
  if (params[0] !== HASH) throw new Error("unexpected original-control transaction");
  if (method === "eth_getTransactionByHash") return txState === "not_found" ? null :
    { hash: HASH, from: FROM, to: TO, value: VALUE, blockNumber: txState === "pending" ? null : BLOCK };
  if (method === "eth_getTransactionReceipt") return txState === "not_found" || txState === "pending" ? null :
    { transactionHash: HASH, from: FROM, to: TO, blockNumber: BLOCK, status: txState === "reverted" ? "0x0" : "0x1" };
  throw new Error("unexpected original-control RPC method");
}
const transport: typeof fetch = async (input, init) => {
  const url = String(input);
  if (init?.method === "POST") {
    const payload = JSON.parse(String(init.body));
    const answer = (q: { id: number; method: string; params: unknown[] }) => ({ jsonrpc: "2.0", id: q.id, result: rpcResult(q.method, q.params) });
    return new Response(JSON.stringify(Array.isArray(payload) ? payload.map(answer) : answer(payload)));
  }
  if (url.endsWith(`/tvl/${SLUG}`)) return fallbackTvl ? new Response("original fallback control", { status: 503 }) : new Response(String(TVL));
  if (url.endsWith(`/protocol/${SLUG}`)) return new Response(JSON.stringify({
    tvl: [{ date: Math.floor(Date.now() / 1000), totalLiquidityUSD: TVL }], currentChainTvls: { [CHAIN]: TVL },
  }));
  if (url.endsWith(`/v2/historicalChainTvl/${CHAIN}`)) return new Response(JSON.stringify([{ date: Math.floor(Date.now() / 1000), tvl: TVL }]));
  throw new Error("unexpected original-control request: " + url);
};
interface Scenario { name: string; kind: "tx" | "grid" | "tvl"; setup: () => void; call: () => Promise<Record<string, unknown>>; path: () => string; verdict: string; pending?: boolean }
const cases: Scenario[] = [
  ...(["confirmed", "reverted", "pending", "not_found"] as const).map(state => ({
    name: `TX ${state}`, kind: "tx" as const, setup: () => { txState = state; },
    call: () => handleTx({ tx_hash: HASH, chain: "ethereum" }), path: () => `/v1/tx?tx_hash=${HASH}&chain=ethereum`,
    verdict: state === "confirmed" ? "verified" : state, pending: state === "confirmed",
  })),
  ...([false, true] as const).map(old => ({
    name: old ? "GRID post-close unconfirmed" : "GRID provisional verified", kind: "grid" as const, setup: () => { oldGrid = old; },
    call: () => handleGridPrice({ node_or_zone: "EE", interval_start: interval() }),
    path: () => `/v1/grid-price?node_or_zone=EE&interval_start=${encodeURIComponent(interval())}`,
    verdict: old ? "unverified" : "verified", pending: !old,
  })),
  { name: "TVL primary scalar", kind: "tvl", setup: () => {}, call: () => handleTvl({ protocol: PROTOCOL }, { fetchImpl: transport }),
    path: () => `/v1/tvl?protocol=${encodeURIComponent(PROTOCOL)}`, verdict: "verified", pending: true },
  { name: "TVL protocol-history fallback", kind: "tvl", setup: () => { fallbackTvl = true; }, call: () => handleTvl({ protocol: PROTOCOL }, { fetchImpl: transport }),
    path: () => `/v1/tvl?protocol=${encodeURIComponent(PROTOCOL)}`, verdict: "verified", pending: true },
  { name: "TVL chain history", kind: "tvl", setup: () => {}, call: () => handleTvl({ protocol: CHAIN }, { fetchImpl: transport }),
    path: () => `/v1/tvl?protocol=${encodeURIComponent(CHAIN)}`, verdict: "verified", pending: true },
];
beforeEach(() => {
  txState = "confirmed"; fallbackTvl = false; oldGrid = false;
  vi.mocked(saveReceipt).mockReset().mockResolvedValue(undefined);
  vi.mocked(getGridPrice).mockReset().mockImplementation(async () => ({ lmp_usd_per_mwh: PRICE, market: "Elering EE",
    ingested_at: oldGrid ? new Date(Date.parse(interval()) + 900000).toISOString() : new Date(Date.now() - 30000).toISOString(),
    upstream_url: "https://example.invalid/original-grid-control" }));
  vi.mocked(getGridRevalidate).mockReset().mockResolvedValue(null);
  vi.mocked(markGridRevalidateAttempt).mockReset().mockResolvedValue(undefined);
  vi.mocked(saveGridPrice).mockReset().mockResolvedValue(undefined);
  __clearTvlCachesForTests(); __setTvlSeedEnabledForTests(false); __setTvlListsCacheDirForTests(scratch + ".lists");
  __seedTvlCachesForTests([{ slug: SLUG, name: PROTOCOL, tvl: TVL, chainTvls: { [CHAIN]: TVL } }], [{ name: CHAIN, tvl: TVL }]);
  vi.stubGlobal("fetch", transport);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(async () => { await __awaitTvlProtocolFillForTests(); __clearTvlCachesForTests(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(async () => {
  __setTvlListsCacheDirForTests(null); __setTvlSeedEnabledForTests(true); await closeStorage();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(scratch + suffix, { force: true });
  rmSync(scratch + ".lists", { recursive: true, force: true });
});
for (const item of cases) describe(item.name, () => {
  beforeEach(item.setup);
  for (const [label, reason] of [
    ["Error", new Error("private-original-storage-control")],
    ["timeout", Object.assign(new Error("private-original-deadline-control"), { code: "STORAGE_TIMEOUT" })],
    ["untyped rejection", "private-original-untyped-control"],
  ] as const) it(`refuses a rejected evidence save (${label}) before any answer`, async () => {
    vi.mocked(saveReceipt).mockRejectedValueOnce(reason);
    const outcome = await item.call().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    expect(saveReceipt).toHaveBeenCalledTimes(1);
    expect(outcome.error).toMatchObject(expected);
    expect(outcome.value).toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
  });
  it("preserves a healthy result and exact retrievable evidence hash", async () => {
    const actual = await vi.importActual<typeof import("../src/core/storage")>("../src/core/storage");
    vi.mocked(saveReceipt).mockImplementationOnce(actual.saveReceipt);
    const result = await item.call();
    expect(result.verdict).toBe(item.verdict);
    expect(saveReceipt).toHaveBeenCalledTimes(1);
    const [receipt, raw] = vi.mocked(saveReceipt).mock.calls[0];
    expect(result.receipt).toEqual(receipt);
    expect(receipt.raw_response_sha256).toBe(sha256Hex(raw!));
    const evidence = await getReceiptEvidence(receipt.receipt_id);
    expect(evidence.found).toBe(true); expect(evidence.evidence?.toString("utf8")).toBe(raw);
    expect(evidence.sha256).toBe(receipt.raw_response_sha256);
    if (item.kind === "tx") {
      expect(result.status).toBe(txState); expect(result.tx_hash).toBe(HASH);
      expect(result.value_eth).toBe(txState === "not_found" ? null : 1.25);
      expect(result.block_number).toBe(txState === "pending" || txState === "not_found" ? null : 0x6d3);
    } else if (item.kind === "grid") {
      expect(result.lmp_usd_per_mwh).toBe(PRICE); expect(result.node_or_zone).toBe("EE");
      expect(result.confidence).toBe(oldGrid ? 0.5 : 1);
    } else { expect(result.tvl_usd).toBe(TVL); expect(result.protocol_or_chain).toBe(item.name === "TVL chain history" ? CHAIN : SLUG); }
  });
  it("retries evidence storage on a later healthy request without treating source observations as a saved answer", async () => {
    vi.mocked(saveReceipt).mockRejectedValueOnce(new Error("private-original-recovery-control"));
    await item.call().catch(() => undefined);
    const result = await item.call();
    expect(saveReceipt).toHaveBeenCalledTimes(2); expect(result.verdict).toBe(item.verdict);
    expect((result.receipt as Receipt).receipt_id).toBe(vi.mocked(saveReceipt).mock.calls[1][0].receipt_id);
  });
  it("sends a fixed HTTP502 without an answer, receipt link or private storage detail", async () => {
    vi.mocked(saveReceipt).mockRejectedValue(new Error("private-original-http-control"));
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: item.path() });
      expect(saveReceipt).toHaveBeenCalledTimes(1);
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: "receipt_persist_failed", code: expected.code, message: expected.message });
      expect(response.body).not.toMatch(/private-original-http-control|rcpt_|verified|confidence/);
    } finally { await app.close(); }
  });
  if (item.pending) it("withholds success during a pending save and refuses its later rejection", async () => {
    let rejectSave!: (reason: Error) => void;
    vi.mocked(saveReceipt).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
    let settled = false;
    const outcome = item.call().then(value => { settled = true; return { value, error: undefined }; }, error => { settled = true; return { value: undefined, error }; });
    await vi.waitFor(() => expect(saveReceipt).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false); rejectSave(new Error("private-original-deferred-control"));
    const result = await outcome; expect(result.error).toMatchObject(expected); expect(result.value).toBeUndefined();
  });
});
