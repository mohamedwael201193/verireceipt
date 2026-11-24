import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { createHash } from "node:crypto";

const scratch = vi.hoisted(() => {
  const path = `/tmp/validator-persist-control-${process.pid}-${Date.now()}.sqlite`;
  process.env.SQLITE_PATH = path;
  delete process.env.DATABASE_URL;
  return path;
});
vi.mock("../src/core/storage", async (original) => {
  const actual = await original<typeof import("../src/core/storage")>();
  return { ...actual, saveReceipt: vi.fn(actual.saveReceipt) };
});
import { saveReceipt, closeStorage, getReceiptEvidence } from "../src/core/storage";
import { sha256Hex, type Receipt } from "../src/core/receipt";
import { handleValidator, resetValidatorCachesForTests, verifiedCacheSizeForTests } from "../src/handlers/validator";
import { buildServer } from "../src/server";

// Original unit/fault controls only. Not real-chain observations, historical
// evaluation examples, protected inputs, live calls or site demonstration data.
const INDEX = 729041;
const ROOT = "0x" + createHash("sha256").update("original-validator-persistence-control-v1").digest("hex");
const ROOT_BODY = JSON.stringify({ data: { root: ROOT }, finalized: true, execution_optimistic: false });
const BODY = JSON.stringify({ data: { index: String(INDEX), balance: "97000000000", status: "active_ongoing", validator: { effective_balance: "97000000000", pubkey: "0x" + "ab".repeat(48), slashed: false, activation_eligibility_epoch: "0", activation_epoch: "0", exit_epoch: "18446744073709551615", withdrawable_epoch: "18446744073709551615" } }, finalized: true, execution_optimistic: false });
const expected = { status: 502, code: "RECEIPT_PERSIST_FAILED", message: "receipt evidence could not be stored; answer unavailable" };
let validatorFetches = 0;
const transport: typeof fetch = async (input) => {
  const url = String(input);
  if (/\/eth\/v1\/beacon\/states\/[^/]+\/root$/.test(url)) return new Response(ROOT_BODY);
  if (url.endsWith(`/validators/${INDEX}`)) {
    validatorFetches++;
    return new Response(BODY);
  }
  throw new Error("unexpected original-control URL");
};
const call = () => handleValidator({ validator_index: String(INDEX) }, { fetchImpl: transport });
beforeEach(() => {
  resetValidatorCachesForTests();
  validatorFetches = 0;
  vi.mocked(saveReceipt).mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { resetValidatorCachesForTests(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(async () => { await closeStorage(); for (const suffix of ["", "-wal", "-shm"]) rmSync(scratch + suffix, { force: true }); });

describe("validator receipt persistence is required before success and cache", () => {
  for (const [label, reason] of [
    ["storage rejection", new Error("private-storage-fault-control")],
    ["storage timeout", Object.assign(new Error("private-deadline-control"), { code: "STORAGE_TIMEOUT" })],
    ["non-Error rejection", "private-untyped-control"],
  ] as const) {
    it(`refuses ${label} with a fixed public error`, async () => {
      vi.mocked(saveReceipt).mockRejectedValueOnce(reason);
      await expect(call()).rejects.toMatchObject(expected);
      expect(saveReceipt).toHaveBeenCalledTimes(1);
      expect(verifiedCacheSizeForTests()).toBe(0);
      expect(console.warn).not.toHaveBeenCalled();
    });
  }
  it("does not populate the verified cache after a rejected save", async () => {
    vi.mocked(saveReceipt).mockRejectedValueOnce(new Error("private-cache-control"));
    await call().catch(() => undefined);
    expect(verifiedCacheSizeForTests()).toBe(0);
  });
  it("retries storage and fresh validator evidence after a previous failed save", async () => {
    vi.mocked(saveReceipt).mockRejectedValueOnce(new Error("private-recovery-control"));
    await call().catch(() => undefined);
    const firstFetches = validatorFetches;
    const result = await call();
    expect(result.verdict).toBe("verified");
    expect(saveReceipt).toHaveBeenCalledTimes(2);
    expect(validatorFetches).toBeGreaterThan(firstFetches);
    expect(verifiedCacheSizeForTests()).toBe(1);
    expect((result.receipt as Receipt).receipt_id).toBe(vi.mocked(saveReceipt).mock.calls[1][0].receipt_id);
  });
  it("withholds success and caching while storage is pending, then refuses its rejection", async () => {
    let rejectSave!: (reason: Error) => void;
    vi.mocked(saveReceipt).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
    let settled = false;
    const outcome = call().then(value => { settled = true; return { value, error: undefined }; }, error => { settled = true; return { value: undefined, error }; });
    await vi.waitFor(() => expect(saveReceipt).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    expect(verifiedCacheSizeForTests()).toBe(0);
    rejectSave(new Error("private-deferred-control"));
    const result = await outcome;
    expect(result.error).toMatchObject(expected);
    expect(result.value).toBeUndefined();
    expect(verifiedCacheSizeForTests()).toBe(0);
  });
  it("returns an HTTP refusal without a verified answer, receipt link or storage detail", async () => {
    vi.stubGlobal("fetch", transport);
    vi.mocked(saveReceipt).mockRejectedValue(new Error("private-http-control"));
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: `/v1/validator?validator_index=${INDEX}` });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: "receipt_persist_failed", code: expected.code, message: expected.message });
      expect(response.body).not.toMatch(/private-http-control|rcpt_|verified|effective_balance/);
      expect(verifiedCacheSizeForTests()).toBe(0);
    } finally { await app.close(); }
  });
  it("preserves healthy numeric units, receipt hash and post-save cache", async () => {
    const result = await call();
    expect(result.verdict).toBe("verified");
    expect(result.effective_balance).toBe(97000000000);
    expect(result.validator_index).toBe(INDEX);
    expect(result.finalized_state_root).toBe(ROOT);
    const [receipt, raw] = vi.mocked(saveReceipt).mock.calls[0];
    expect(raw).toBe(BODY);
    expect(result.receipt).toEqual(receipt);
    expect(receipt.raw_response_sha256).toBe(sha256Hex(BODY));
    expect(verifiedCacheSizeForTests()).toBe(1);
  });
  it("keeps an already persisted cached response without another storage write", async () => {
    const result = await call();
    const firstFetches = validatorFetches;
    const cached = await call();
    expect(cached).toEqual(result);
    expect(saveReceipt).toHaveBeenCalledTimes(1);
    expect(validatorFetches).toBe(firstFetches);
  });
  it("stores actual healthy evidence retrievable with the same receipt hash", async () => {
    const actual = await vi.importActual<typeof import("../src/core/storage")>("../src/core/storage");
    vi.mocked(saveReceipt).mockImplementationOnce(actual.saveReceipt);
    const result = await call();
    const receipt = result.receipt as Receipt;
    const evidence = await getReceiptEvidence(receipt.receipt_id);
    expect(evidence.found).toBe(true);
    expect(evidence.evidence?.toString("utf8")).toBe(BODY);
    expect(evidence.sha256).toBe(sha256Hex(BODY));
    expect(receipt.raw_response_sha256).toBe(sha256Hex(BODY));
  });
  it("does not store or cache an answer when no current root quorum is available", async () => {
    await expect(handleValidator({ validator_index: String(INDEX) }, { fetchImpl: async () => new Response("not available", { status: 404 }) })).rejects.toMatchObject({ status: 502, code: "QUORUM_UNREACHABLE" });
    expect(saveReceipt).not.toHaveBeenCalled();
    expect(verifiedCacheSizeForTests()).toBe(0);
  });
});
