// Handler-level signing-finalization controls (S2 r1, 2026-11-22).
// Adapted from the reviewer's r146 reproduction: the grid cached path
// and the email-security path both finalize receipt.fetched_at AFTER
// makeReceipt. These tests pin that the INLINE receipt signature (the
// one in the answer envelope) verifies against the final fields and
// equals the stored-metadata signature byte-for-byte (Ed25519 is
// deterministic over identical final fields). Throwaway keypair only.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "sign-finalization-"));
process.env.SQLITE_PATH = join(dir, "db.sqlite");
process.env.PUBLIC_BASE_URL = "https://verireceipt.example";

import { saveGridPrice } from "../src/core/db";
import { __setStorageBackendForTests, closeStorage } from "../src/core/storage";
import { buildServer } from "../src/server";
import type { FastifyInstance } from "fastify";
import { handleGridPrice } from "../src/handlers/gridPrice";
import { handleEmailSecurity } from "../src/handlers/emailSecurity";
import { verifyReceiptSignature, type ReceiptSignable } from "../src/core/receiptSign";

__setStorageBackendForTests("sqlite");

const keys = generateKeyPairSync("ed25519");
const privateB64 = keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const publicB64 = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
process.env.VERIRECEIPT_RECEIPT_SIGNING_KEY = privateB64;

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/email-security", name), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
// Building the server registers the receipt signer from the env key
// (server.ts boot path) — handler calls below sign through that hook.
let app: FastifyInstance;
beforeAll(() => {
  app = buildServer();
});
afterAll(async () => {
  await app.close();
  delete process.env.VERIRECEIPT_RECEIPT_SIGNING_KEY;
  await closeStorage();
  rmSync(dir, { recursive: true, force: true });
});

type SignedReceipt = ReceiptSignable & { signature: string };

async function expectInlineEqualsStored(receipt: SignedReceipt): Promise<void> {
  expect(typeof receipt.signature).toBe("string");
  expect(verifyReceiptSignature(receipt, receipt.signature, publicB64)).toBe(true);
  const res = await app.inject("/receipts/" + receipt.receipt_id);
  expect(res.statusCode).toBe(200);
  const stored = res.json();
  expect(verifyReceiptSignature(stored, stored.signature, publicB64)).toBe(true);
  // Same final fields, deterministic scheme: one signature everywhere.
  expect(stored.signature).toBe(receipt.signature);
  expect(stored.fetched_at).toBe(receipt.fetched_at);
}

describe("signing after field finalization (handler controls)", () => {
  it("route refusal path (bypasses envelope): the NO_ROUTE receipt carries a verifiable inline signature", async () => {
    // Reviewer r151: routeUnavailable assembles its own response body.
    const response = await app.inject("/v1/route?pair=BTC%2FUSDC");
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe("NO_ROUTE");
    const receipt = body.receipt as SignedReceipt;
    expect(receipt).toBeTruthy();
    expect(typeof receipt.signature).toBe("string");
    expect(verifyReceiptSignature(receipt, receipt.signature, publicB64)).toBe(true);
    const meta = await app.inject("/receipts/" + receipt.receipt_id);
    expect(meta.statusCode).toBe(200);
    expect(meta.json().signature).toBe(receipt.signature);
  });

  it("grid cached path: fetched_at is the cache ingest time AND the inline signature verifies", async () => {
    const interval = new Date(Math.floor((Date.now() - 7200_000) / 900_000) * 900_000).toISOString();
    const ingestedAt = new Date(Date.now() - 60_000).toISOString();
    saveGridPrice("EE", interval, 123.45, "Elering EE", ingestedAt);
    const result = await handleGridPrice({ node_or_zone: "EE", interval_start: interval });
    const receipt = result.receipt as SignedReceipt;
    expect(receipt.fetched_at).toBe(ingestedAt); // finalized override, not creation time
    await expectInlineEqualsStored(receipt);
  });

  it("email-security path: fetched_at is the resolver fetch time AND the inline signature verifies", async () => {
    const google = fixture("dns-google-nodata.json");
    const cloudflare = fixture("dns-cloudflare-nodata-exact-accept.json");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) =>
      new Response(String(input).includes("dns.google") ? google : cloudflare),
    ));
    const result = await handleEmailSecurity({ domain: "www.iana.org.", record_type: "mx" });
    const receipt = result.receipt as SignedReceipt;
    await expectInlineEqualsStored(receipt);
  });
});
