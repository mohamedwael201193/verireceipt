import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/vendor-vat-derivation-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
vi.mock("../src/handlers/sanctionsScreening", () => ({
  handleSanctionsScreen: vi.fn(async () => ({ matched: false, matches: [], lists: ["OFAC SDN", "UN Consolidated"], match_score: 0, receipt: { receipt_id: "fixture-subreceipt" } })),
}));
import { handleVendorVerify, deriveVatCountry } from "../src/handlers/vendorVerify";
import { answerDiagnostics } from "../src/core/answerClass";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
import { resetGleifForTests } from "../src/handlers/gleifRegistry";

const FX = join(__dirname, "fixtures/vendor-verify");
// Real VIES REST bodies fetched 2026-11-28 for ES A15075062 (valid) and
// ES A15075063 (invalid). They are the only real captures this file mocks.
const ES_VALID = readFileSync(join(FX, "vies-es-valid-20261128.json"), "utf8");
const ES_INVALID = readFileSync(join(FX, "vies-es-invalid-20261128.json"), "utf8");
const GLEIF = readFileSync(join(__dirname, "fixtures/vendor-name/apple.json"), "utf8");

// Synthetic test doubles of the VIES REST response shape, NOT real captures:
// used only for the DE/AT legal-form cases so the suite never invents a real
// registration for a number we do not own.
function syntheticVies(num: string, valid: boolean): string {
  return JSON.stringify({
    isValid: valid, requestDate: "2026-11-28T00:00:00.000Z", userError: valid ? "VALID" : "INVALID",
    name: "---", address: "---", requestIdentifier: "", originalVatNumber: num, vatNumber: num,
    viesApproximate: { name: "---", street: "---", postalCode: "---", city: "---", companyType: "---", matchName: 3, matchStreet: 3, matchPostalCode: 3, matchCity: 3, matchCompanyType: 3 },
  });
}

function stub(opts: { vies?: (u: string) => Response } = {}): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url);
    requested.push(u);
    if (u.includes("ec.europa.eu")) {
      if (opts.vies) return opts.vies(u);
      return new Response(u.includes("A15075063") ? ES_INVALID : ES_VALID);
    }
    if (u.includes("api.gleif.org")) return new Response(GLEIF);
    throw new Error(`unexpected fetch ${u}`);
  });
  return requested;
}

afterEach(() => { resetGleifForTests(); vi.unstubAllGlobals(); });

describe("deriveVatCountry", () => {
  it("derives ES from a Sociedad Limitada suffix and a Spanish-format number", () => {
    expect(deriveVatCountry("LUXURYSUN IBIZA, S.L.", "A15075062"))
      .toEqual({ cc: "ES", num: "A15075062", suffix: "S.L.", candidates: ["ES"] });
    expect(deriveVatCountry("DIRECT TIP 24 SL.", "A15075063"))
      .toEqual({ cc: "ES", num: "A15075063", suffix: "SL.", candidates: ["ES"] });
  });
  it("normalizes case, spaces, dots and hyphens in the number", () => {
    expect(deriveVatCountry("Luxurysun Ibiza, s.l.", "a 150-750.62"))
      .toEqual({ cc: "ES", num: "A15075062", suffix: "s.l.", candidates: ["ES"] });
  });
  it("splits GmbH between DE and AT by national format only", () => {
    expect(deriveVatCountry("Foo GmbH", "123456789")?.cc).toBe("DE");
    expect(deriveVatCountry("Foo GmbH", "U12345678")?.cc).toBe("AT");
  });
  it("handles multi-token and punctuated legal forms", () => {
    expect(deriveVatCountry("Foo S.p.A.", "12345678901")?.cc).toBe("IT");
    expect(deriveVatCountry("Foo Sp. z o.o.", "1234567890")?.cc).toBe("PL");
    expect(deriveVatCountry("Foo Sociedad Limitada", "A15075062")?.cc).toBe("ES");
    expect(deriveVatCountry("Foo SARL", "12345678901")?.cc).toBe("FR");
  });
  it("refuses an ambiguous candidate set instead of picking a country", () => {
    // S.A. names seven member states and an 8-digit block fits both LU and RO.
    expect(deriveVatCountry("Foo S.A.", "12345678")).toBeNull();
  });
  it("derives nothing without a known legal form or a matching format", () => {
    expect(deriveVatCountry("Acme Widgets Ltd", "12345678")).toBeNull();
    expect(deriveVatCountry("Foo S.L.", "12345")).toBeNull();
    expect(deriveVatCountry("Foo AB", "12345678")).toBeNull();
  });
});

describe("VENDOR_VERIFY_GENERAL with a country derived from the vendor", () => {
  it("runs the real VIES lookup for the derived country and answers valid=true", async () => {
    const requested = stub();
    const out = await handleVendorVerify({ vendor: "LUXURYSUN IBIZA, S.L.", vat_number: "A15075062" });
    expect(out.valid).toBe(true);
    expect(out.vat_number).toBe("ESA15075062");
    expect(out.vat_country_derived).toBe(true);
    expect(out.vat_country_basis).toBe("vendor legal form S.L. and national number format");
    expect(requested).toHaveLength(1);
    expect(requested[0]).toBe("https://ec.europa.eu/taxation_customs/vies/rest-api/ms/ES/vat/A15075062");
    expect(String(out.answer)).toContain("No country prefix was supplied; ES was derived from the vendor's legal form (S.L.) and the number's format. VIES reply: valid.");
    expect(String(out.answer)).toContain("verifies the number only");
    expect(answerDiagnostics("VENDOR_VERIFY_GENERAL", out).answerClass)
      .toEqual({ vat_has_country_prefix: false, vat_length_bucket: "normal", vat_derivation: "derived" });
    expect(JSON.stringify(out)).not.toContain("vat_derivation");
  });
  it("reports valid=false from the real VIES reply for the invalid number", async () => {
    stub();
    const out = await handleVendorVerify({ vendor: "DIRECT TIP 24 SL.", vat_number: "A15075063" });
    expect(out.valid).toBe(false);
    expect(out.vat_number).toBe("ESA15075063");
    expect(String(out.answer)).toContain("No country prefix was supplied; ES was derived from the vendor's legal form (SL.) and the number's format. VIES reply: invalid.");
    expect(String(out.answer)).toContain("NOT currently valid");
  });
  it("keeps the receipt over the exact upstream body and records the derivation", async () => {
    stub();
    const out = await handleVendorVerify({ vendor: "LUXURYSUN IBIZA, S.L.", vat_number: "A15075062" });
    const receipt = out.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    expect(String(stored.evidence)).toContain(JSON.stringify(ES_VALID).slice(1, 60));
    const evidence = JSON.parse(String(stored.evidence)) as { vat_country_derivation: { derived: boolean; country: string; suffix: string; basis: string } };
    expect(evidence.vat_country_derivation).toMatchObject({ derived: true, country: "ES", suffix: "S.L.", basis: "vendor legal form S.L. and national number format" });
  });
  it("uses the derived country for a GmbH number and reaches VIES with DE / AT", async () => {
    const requested = stub({ vies: (u) => new Response(syntheticVies(u.includes("/AT/") ? "U12345678" : "123456789", true)) });
    const de = await handleVendorVerify({ vendor: "Foo GmbH", vat_number: "123456789" });
    expect(de.valid).toBe(true);
    expect(de.vat_number).toBe("DE123456789");
    const at = await handleVendorVerify({ vendor: "Foo GmbH", vat_number: "U12345678" });
    expect(at.valid).toBe(true);
    expect(at.vat_number).toBe("ATU12345678");
    expect(requested.some((u) => u.includes("/ms/DE/vat/123456789"))).toBe(true);
    expect(requested.some((u) => u.includes("/ms/AT/vat/U12345678"))).toBe(true);
  });
  it("never calls VIES when the legal form is ambiguous, unknown or mismatched", async () => {
    const requested = stub();
    const ambiguous = await handleVendorVerify({ vendor: "Foo S.A.", vat_number: "12345678" });
    expect(ambiguous.valid).toBeNull();
    expect(ambiguous.vat_country_derived).toBeUndefined();
    expect(answerDiagnostics("VENDOR_VERIFY_GENERAL", ambiguous).answerClass).toMatchObject({ vat_derivation: "ambiguous" });
    expect(String(ambiguous.answer)).toContain("vat_number had no country prefix, so no VIES lookup was made");

    const unknown = await handleVendorVerify({ vendor: "Acme Widgets Ltd", vat_number: "12345678" });
    expect(unknown.valid).toBeNull();
    expect(answerDiagnostics("VENDOR_VERIFY_GENERAL", unknown).answerClass).toMatchObject({ vat_derivation: "no_suffix" });

    const mismatch = await handleVendorVerify({ vendor: "LUXURYSUN IBIZA, S.L.", vat_number: "12345" });
    expect(mismatch.valid).toBeNull();
    expect(answerDiagnostics("VENDOR_VERIFY_GENERAL", mismatch).answerClass).toMatchObject({ vat_derivation: "format_mismatch" });

    expect(requested.some((u) => u.includes("ec.europa.eu"))).toBe(false);
  });
  it("falls back to name-only research when VIES fails for a derived country, never a guess", async () => {
    let attempts = 0;
    stub({ vies: () => { attempts++; return new Response("service unavailable", { status: 503 }); } });
    const out = await handleVendorVerify({ vendor: "LUXURYSUN IBIZA, S.L.", vat_number: "A15075062" });
    expect(attempts).toBe(3);
    expect(out.valid).toBeNull();
    expect(out.vat_number).toBeNull();
    expect(out.verdict).toBe("no_data");
    expect(out.checks_completed).toEqual(["gleif", "sanctions"]);
    expect(String(out.answer)).toContain("a member state was derived from the vendor legal form and the number format, but the VIES lookup failed");
    expect(String(out.answer)).toContain("VAT validity is unknown (valid:null)");
    expect(answerDiagnostics("VENDOR_VERIFY_GENERAL", out).answerClass).toMatchObject({ vat_derivation: "derived" });
  });
  it("treats a transport timeout on the derived lookup the same way", async () => {
    stub({ vies: () => { throw new Error("vies timeout"); } });
    const out = await handleVendorVerify({ vendor: "DIRECT TIP 24 SL.", vat_number: "A15075063" });
    expect(out.valid).toBeNull();
    expect(out.checks_completed).toEqual(["gleif", "sanctions"]);
  });
  it("leaves prefixed and malformed input exactly as before", async () => {
    const requested = stub();
    const prefixed = await handleVendorVerify({ vendor: "Amazon", vat_number: "LU26375245" });
    expect(prefixed.valid).toBe(true);
    expect(prefixed.vat_country_derived).toBeUndefined();
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain("/ms/LU/vat/26375245");
    expect(answerDiagnostics("VENDOR_VERIFY_GENERAL", prefixed).answerClass).toBeUndefined();

    const malformed = await handleVendorVerify({ vendor: "Apple Inc.", vat_number: "DE!@bad" });
    expect(malformed.valid).toBeNull();
    expect(answerDiagnostics("VENDOR_VERIFY_GENERAL", malformed).answerClass)
      .toEqual({ vat_has_country_prefix: true, vat_length_bucket: "normal" });
    expect(requested.filter((u) => u.includes("ec.europa.eu"))).toHaveLength(1);
  });
});
