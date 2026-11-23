import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/vendor-verify-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
import { handleVendorVerify, parseVatNumber } from "../src/handlers/vendorVerify";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";

// Fixtures are real VIES bodies retrieved 2026-11-23.
const FX = join(__dirname, "fixtures/vendor-verify");
const LU_VALID = readFileSync(join(FX, "vies-lu-valid.json"), "utf8");
const DE_INVALID = readFileSync(join(FX, "vies-de-invalid.json"), "utf8");

function stub(opts: { down?: boolean; body?: string; status?: number } = {}): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url);
    requested.push(u);
    if (u.includes("ec.europa.eu")) {
      if (opts.down) throw new Error("vies outage");
      if (opts.status) return new Response("err", { status: opts.status });
      return new Response(opts.body ?? (u.includes("/LU/") ? LU_VALID : DE_INVALID), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  return requested;
}

describe("VENDOR_VERIFY_GENERAL", () => {
  it("a real valid EU VAT number answers valid=true with the registered name, scoping the claim", async () => {
    stub();
    const result = await handleVendorVerify({ vendor: "Amazon", vat_number: "LU26375245" });
    expect(result.valid).toBe(true);
    expect(result.registered_name).toContain("AMAZON");
    expect(String(result.answer)).toContain("valid and currently registered");
    expect(String(result.answer)).toContain("verifies the number only");
  });
  it("an invalid number answers valid=false without calling the vendor bad", async () => {
    stub();
    const result = await handleVendorVerify({ vendor: "Nobody", vat_number: "DE000000000" });
    expect(result.valid).toBe(false);
    expect(String(result.answer)).toContain("NOT currently valid");
    expect(String(result.answer)).toContain("not a judgment");
  });
  it("vat formats with spaces, dashes, dots and lowercase are normalized before the lookup", async () => {
    const requested = stub();
    const result = await handleVendorVerify({ vendor: "Amazon", vat_number: "lu 263-752.45" });
    expect(result.valid).toBe(true);
    expect(requested[0]).toContain("/ms/LU/vat/26375245");
  });
  it("non-EU country codes are refused 422 (no other registry is guessed)", async () => {
    stub();
    await expect(handleVendorVerify({ vendor: "X", vat_number: "US123456789" })).rejects.toMatchObject({ status: 422, code: "VIES_SCOPE" });
  });
  it("missing and malformed params are 400", async () => {
    stub();
    await expect(handleVendorVerify({ vat_number: "LU26375245" })).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleVendorVerify({ vendor: "X" })).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleVendorVerify({ vendor: "X", vat_number: "26375245" })).rejects.toMatchObject({ status: 400, code: "INVALID_VAT" });
  });
  it("fails closed 502 when VIES is down, errors, or returns a service-limitation userError", async () => {
    stub({ down: true });
    await expect(handleVendorVerify({ vendor: "Amazon", vat_number: "LU26375245" })).rejects.toMatchObject({ status: 502, code: "VIES_UNREACHABLE" });
    stub({ status: 500 });
    await expect(handleVendorVerify({ vendor: "Amazon", vat_number: "LU26375245" })).rejects.toMatchObject({ status: 502 });
    stub({ body: JSON.stringify({ isValid: false, userError: "MS_MAX_CONCURRENT_REQ" }) });
    await expect(handleVendorVerify({ vendor: "Amazon", vat_number: "LU26375245" })).rejects.toMatchObject({ status: 502, code: "VIES_ERROR" });
  });
  it("the receipt is persisted over the exact upstream body", async () => {
    stub();
    const result = await handleVendorVerify({ vendor: "Amazon", vat_number: "LU26375245" });
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("VENDOR_VERIFY_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    expect(String(stored.evidence)).toContain("AMAZON");
    expect(String(stored.evidence)).toContain("does NOT confirm");
    // The exact upstream body is embedded verbatim in the evidence.
    expect(String(stored.evidence)).toContain(JSON.stringify(LU_VALID).slice(1, 60));
  });
  it("parseVatNumber accepts EU shapes and rejects garbage", () => {
    expect(parseVatNumber("LU26375245")).toEqual({ cc: "LU", num: "26375245" });
    expect(parseVatNumber(" DE 000000000 ")).toEqual({ cc: "DE", num: "000000000" });
    expect(parseVatNumber("26375245")).toBeNull();
    expect(parseVatNumber("L1O234")).toBeNull();
  });
  it("GET /v1/vendor-verify is wired and returns the envelope", async () => {
    stub();
    const app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/v1/vendor-verify?vendor=Amazon&vat_number=LU26375245" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { receipt: { intent: string }; valid: boolean };
    expect(body.receipt.intent).toBe("VENDOR_VERIFY_GENERAL");
    expect(body.valid).toBe(true);
    await app.close();
  });
});
