import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const fixture = vi.hoisted(() => {
  const path = `/tmp/verireceipt-durability-${process.pid}-${Date.now()}.sqlite`;
  process.env.SQLITE_PATH = path;
  delete process.env.DATABASE_URL;
  return { path };
});
vi.mock("../src/core/storage", async (original) => ({
  ...await original<typeof import("../src/core/storage")>(),
  saveReceipt: vi.fn(),
}));
import { saveReceipt, closeStorage } from "../src/core/storage";
import { errorBody } from "../src/core/errors";
import { diagnosticErrorCode } from "../src/core/requestMetrics";
import { sha256Hex } from "../src/core/receipt";
import { handleTokenHolders, setTokenHoldersFetchForTests } from "../src/handlers/tokenHolders";
import { handleFx } from "../src/handlers/currencyConvert";
import { handleDns } from "../src/handlers/dnsLookup";
import { buildServer } from "../src/server";

// Unit/injection fixtures only. No live sources, evaluator calls or stored production data.
let negativeDns = false;
// The fixture carries the indexer's own contract identity: b05bb71 made
// the handler reject responses whose address/type do not match the
// requested ERC-20 contract, and this body's shape must satisfy that.
const holderBody = JSON.stringify({ address_hash: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", type: "ERC-20", holders_count: "123", symbol: "USDC" });
function fetchFixture(input: unknown): Promise<Response> {
  const url = String(input), date = new Date().toISOString().slice(0, 10);
  let body: unknown;
  if (url.includes("frankfurter")) body = { base: "USD", date, rates: { EUR: 0.91 } };
  else if (url.includes("open.er-api")) body = { result: "success", time_last_update_utc: new Date().toUTCString(), rates: { EUR: 0.91 } };
  else if (url.includes("jsdelivr")) body = { date, usd: { eur: 0.91 } };
  else if (url.includes("dns.google") || url.includes("cloudflare-dns.com") || url.includes("adguard")) {
    body = { Status: negativeDns ? 3 : 0, TC: false,
      Question: [{ name: "example.com.", type: 1 }],
      Answer: negativeDns ? [] : [{ name: "example.com.", type: 1, TTL: 300, data: "93.184.216.34" }] };
  } else return Promise.reject(new Error("unexpected fixture request"));
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}
const cases = [
  { name: "holders", path: "/v1/token-holders?token=USDC&chain=ethereum", call: () => handleTokenHolders({ token: "USDC", chain: "ethereum" }), verdict: "verified" },
  { name: "FX", path: "/v1/fx?from_currency=USD&to_currency=EUR&amount=10", call: () => handleFx({ from_currency: "USD", to_currency: "EUR", amount: "10" }), verdict: "verified" },
  { name: "DNS positive", path: "/v1/dns?name=example.com&record_type=A", call: () => handleDns({ name: "example.com", record_type: "A" }), verdict: "verified" },
  { name: "DNS negative", path: "/v1/dns?name=example.com&record_type=A", call: () => handleDns({ name: "example.com", record_type: "A" }), verdict: "not_found" },
];
const expectedError = { status: 502, code: "RECEIPT_PERSIST_FAILED", message: "receipt evidence could not be stored; answer unavailable" };
beforeEach(() => {
  negativeDns = false;
  vi.mocked(saveReceipt).mockReset().mockResolvedValue(undefined);
  setTokenHoldersFetchForTests(async () => holderBody);
  vi.stubGlobal("fetch", fetchFixture);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  setTokenHoldersFetchForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await closeStorage();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(fixture.path + suffix, { force: true });
});

for (const item of cases) describe(item.name, () => {
  beforeEach(() => { negativeDns = item.name === "DNS negative"; });
  for (const reason of [new Error("synthetic-storage-diagnostic"), Object.assign(new Error("deadline"), { code: "STORAGE_TIMEOUT" }), "untyped persistence rejection"]) {
    it(`refuses a failed persistence attempt (${String(reason)})`, async () => {
      vi.mocked(saveReceipt).mockRejectedValueOnce(reason);
      await expect(item.call()).rejects.toMatchObject(expectedError);
      expect(saveReceipt).toHaveBeenCalledTimes(1);
      expect(console.warn).not.toHaveBeenCalled();
    });
  }
  it("keeps the healthy result and exact receipted evidence hash", async () => {
    const result = await item.call();
    expect(result.verdict).toBe(item.verdict);
    expect(saveReceipt).toHaveBeenCalledTimes(1);
    const [receipt, evidence] = vi.mocked(saveReceipt).mock.calls[0];
    expect(result.receipt).toEqual(receipt);
    expect(receipt.raw_response_sha256).toBe(sha256Hex(evidence!));
    if (item.name === "holders") expect(evidence).toBe(holderBody);
  });
  it("sends HTTP unavailable with no answer, verified status or receipt link", async () => {
    vi.mocked(saveReceipt).mockRejectedValue(new Error("synthetic-storage-diagnostic"));
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: item.path });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: "receipt_persist_failed", code: expectedError.code, message: expectedError.message });
      expect(response.body).not.toContain("synthetic-storage-diagnostic");
      expect(response.body).not.toContain("rcpt_");
      expect(response.body).not.toContain("verified");
    } finally { await app.close(); }
  });
});
it("permits a later healthy save without caching a false successful answer", async () => {
  vi.mocked(saveReceipt).mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(handleTokenHolders({ token: "USDC", chain: "ethereum" })).rejects.toMatchObject(expectedError);
  const result = await handleTokenHolders({ token: "USDC", chain: "ethereum" });
  expect(result.verdict).toBe("verified");
  expect(saveReceipt).toHaveBeenCalledTimes(2);
  expect((result.receipt as { receipt_id: string }).receipt_id).toBe(vi.mocked(saveReceipt).mock.calls[1][0].receipt_id);
});
it("uses a fixed diagnostic category and a bounded public refusal", () => {
  expect(diagnosticErrorCode("RECEIPT_PERSIST_FAILED")).toBe("RECEIPT_PERSIST_FAILED");
  expect(errorBody(new Error("synthetic-storage-diagnostic"))).toEqual({ error: "upstream_unavailable", code: "INTERNAL", message: "internal error" });
});
