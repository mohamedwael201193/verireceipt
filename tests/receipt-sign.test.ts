// Ed25519 receipt signing (S2, 2026-11-22) — src/core/receiptSign.ts,
// the signer hook in core/receipt.ts, the well-known route, and the
// metadata-route signature. All keys here are THROWAWAY test keypairs
// generated in-process; no real key material exists in this repo.
import { generateKeyPairSync } from "crypto";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join, resolve } from "path";
import { afterEach, describe, expect, it } from "vitest";

const SCRATCH = resolve(process.cwd(), "..", "receipt-sign-test-scratch");
mkdirSync(SCRATCH, { recursive: true });
process.env.SQLITE_PATH = join(mkdtempSync(join(SCRATCH, "db-")), "verireceipt.sqlite");
process.env.PUBLIC_BASE_URL = "https://verireceipt.example";
delete process.env.VERIRECEIPT_RECEIPT_SIGNING_KEY;

import { envelope, makeReceipt, setReceiptSigner, type Receipt } from "../src/core/receipt";
import {
  configureReceiptSigningFromEnv,
  RECEIPT_SIGNATURE_PAYLOAD,
  RECEIPT_SIGNED_FIELDS,
  RECEIPT_SIGNING_KEY_ENV,
  receiptSigningPayload,
  receiptSigningPublicInfo,
  signReceipt,
  verifyReceiptSignature,
} from "../src/core/receiptSign";
import { buildServer } from "../src/server";
import { saveReceipt } from "../src/core/db";
import { __setStorageBackendForTests } from "../src/core/storage";
__setStorageBackendForTests("sqlite");

function throwawayKeypair(): { privateB64: string; publicB64: string; privatePem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateB64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicB64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

const SAMPLE = {
  receipt_id: "rcpt_" + "A".repeat(26),
  intent: "ONCHAIN_TX_LOOKUP_GENERAL",
  upstream_url: "https://example.invalid/rpc",
  raw_response_sha256: "a".repeat(64),
  quorum_votes: "leg1,leg2",
  fetched_at: "2026-11-22T00:00:00.000Z",
};

afterEach(() => {
  configureReceiptSigningFromEnv({}); // reset module key state
  setReceiptSigner(null);
  delete process.env[RECEIPT_SIGNING_KEY_ENV];
});

describe("receiptSign key configuration", () => {
  it("accepts base64 PKCS#8 and PEM, rejects garbage and non-Ed25519 keys", () => {
    const k = throwawayKeypair();
    expect(configureReceiptSigningFromEnv({ [RECEIPT_SIGNING_KEY_ENV]: k.privateB64 })).toBe(true);
    expect(receiptSigningPublicInfo()!.public_key).toBe(k.publicB64);

    expect(configureReceiptSigningFromEnv({ [RECEIPT_SIGNING_KEY_ENV]: k.privatePem })).toBe(true);
    expect(receiptSigningPublicInfo()!.public_key).toBe(k.publicB64);

    expect(configureReceiptSigningFromEnv({ [RECEIPT_SIGNING_KEY_ENV]: "not-a-key" })).toBe(false);
    expect(receiptSigningPublicInfo()).toBeNull();

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaB64 = rsa.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    expect(configureReceiptSigningFromEnv({ [RECEIPT_SIGNING_KEY_ENV]: rsaB64 })).toBe(false);
    expect(receiptSigningPublicInfo()).toBeNull();

    expect(configureReceiptSigningFromEnv({})).toBe(false);
  });
});

describe("receiptSign sign/verify", () => {
  it("round-trips and is deterministic (Ed25519)", () => {
    const k = throwawayKeypair();
    configureReceiptSigningFromEnv({ [RECEIPT_SIGNING_KEY_ENV]: k.privateB64 });
    const sig1 = signReceipt(SAMPLE)!;
    const sig2 = signReceipt(SAMPLE)!;
    expect(sig1).toBe(sig2);
    expect(Buffer.from(sig1, "base64")).toHaveLength(64);
    expect(verifyReceiptSignature(SAMPLE, sig1, k.publicB64)).toBe(true);
  });

  it("returns undefined with no key configured", () => {
    configureReceiptSigningFromEnv({});
    expect(signReceipt(SAMPLE)).toBeUndefined();
  });

  it("fails verification on any signed-field tamper, wrong key, or bad signature", () => {
    const k = throwawayKeypair();
    configureReceiptSigningFromEnv({ [RECEIPT_SIGNING_KEY_ENV]: k.privateB64 });
    const sig = signReceipt(SAMPLE)!;

    expect(verifyReceiptSignature({ ...SAMPLE, fetched_at: "2026-11-23T00:00:00.000Z" }, sig, k.publicB64)).toBe(false);
    expect(verifyReceiptSignature({ ...SAMPLE, raw_response_sha256: "b".repeat(64) }, sig, k.publicB64)).toBe(false);
    expect(verifyReceiptSignature({ ...SAMPLE, receipt_id: "rcpt_" + "B".repeat(26) }, sig, k.publicB64)).toBe(false);

    const other = throwawayKeypair();
    expect(verifyReceiptSignature(SAMPLE, sig, other.publicB64)).toBe(false);

    const mangled = Buffer.from(sig, "base64");
    mangled[0] ^= 1;
    expect(verifyReceiptSignature(SAMPLE, mangled.toString("base64"), k.publicB64)).toBe(false);
    expect(verifyReceiptSignature(SAMPLE, "!!!not-base64!!!", k.publicB64)).toBe(false);
    expect(verifyReceiptSignature(SAMPLE, sig, "!!!not-a-key!!!")).toBe(false);
  });

  it("payload is key-order independent and carries the domain tag + exactly the signed fields", () => {
    const reordered = {
      fetched_at: SAMPLE.fetched_at,
      quorum_votes: SAMPLE.quorum_votes,
      raw_response_sha256: SAMPLE.raw_response_sha256,
      upstream_url: SAMPLE.upstream_url,
      intent: SAMPLE.intent,
      receipt_id: SAMPLE.receipt_id,
    };
    expect(receiptSigningPayload(reordered).equals(receiptSigningPayload(SAMPLE))).toBe(true);
    const parsed = JSON.parse(receiptSigningPayload(SAMPLE).toString("utf8"));
    expect(parsed.payload).toBe(RECEIPT_SIGNATURE_PAYLOAD);
    expect(Object.keys(parsed).sort()).toEqual([...RECEIPT_SIGNED_FIELDS, "payload"].sort());
    // audit_url and friends must NOT be in the payload even if present.
    expect(receiptSigningPayload({ ...SAMPLE, audit_url: "https://x" } as typeof SAMPLE).equals(receiptSigningPayload(SAMPLE))).toBe(true);
  });
});

describe("envelope signer hook (signing at finalization)", () => {
  it("attaches a verifiable signature when a signer is registered", () => {
    const k = throwawayKeypair();
    configureReceiptSigningFromEnv({ [RECEIPT_SIGNING_KEY_ENV]: k.privateB64 });
    setReceiptSigner(signReceipt);
    const r: Receipt = makeReceipt("ONCHAIN_TX_LOOKUP_GENERAL", "https://example.invalid/rpc", '{"ok":true}', "leg1");
    // Not signed at creation: fields are not final until envelope().
    expect("signature" in r).toBe(false);
    envelope(r.intent, { block_number: 1 }, r, { answer: "a", verdict: "verified", confidence: 1, source: "s" });
    expect(typeof r.signature).toBe("string");
    expect(verifyReceiptSignature(r, r.signature!, k.publicB64)).toBe(true);
  });

  it("covers handler-finalized fields: a fetched_at set AFTER makeReceipt is inside the signature", () => {
    const k = throwawayKeypair();
    configureReceiptSigningFromEnv({ [RECEIPT_SIGNING_KEY_ENV]: k.privateB64 });
    setReceiptSigner(signReceipt);
    const r = makeReceipt("GRID_POWER_PRICE_GENERAL", "https://iso.example/feed", '{"lmp":1}', "1/1 cache row");
    // The gridPrice/emailSecurity pattern: override fetched_at with the
    // real upstream fetch time after creation, before envelope.
    r.fetched_at = "2026-11-22T01:02:03.000Z";
    envelope(r.intent, { lmp_usd_per_mwh: 1 }, r, { answer: "a", verdict: "verified", confidence: 1, source: "s" });
    expect(verifyReceiptSignature(r, r.signature!, k.publicB64)).toBe(true);
    // And the pre-override value must NOT verify.
    expect(verifyReceiptSignature({ ...r, fetched_at: "2026-11-22T09:09:09.000Z" }, r.signature!, k.publicB64)).toBe(false);
  });

  it("omits the field entirely with no signer", () => {
    const r = makeReceipt("TVL_LOOKUP_GENERAL", "https://example.invalid/api", "{}", "");
    envelope(r.intent, { tvl_usd: 1 }, r, { answer: "a", verdict: "verified", confidence: 1, source: "s" });
    expect("signature" in r).toBe(false);
  });
});

describe("signing routes (real server, throwaway key)", () => {
  it("well-known 404 SIGNING_NOT_CONFIGURED without a key; 200 with the public contract with one", async () => {
    delete process.env[RECEIPT_SIGNING_KEY_ENV];
    const appOff = buildServer();
    const off = await appOff.inject("/.well-known/verireceipt.json");
    expect(off.statusCode).toBe(404);
    expect(off.json().code).toBe("SIGNING_NOT_CONFIGURED");
    await appOff.close();

    const k = throwawayKeypair();
    process.env[RECEIPT_SIGNING_KEY_ENV] = k.privateB64;
    const appOn = buildServer();
    const on = await appOn.inject("/.well-known/verireceipt.json");
    expect(on.statusCode).toBe(200);
    const doc = on.json();
    expect(doc.alg).toBe("Ed25519");
    expect(doc.public_key).toBe(k.publicB64);
    expect(doc.key_id).toMatch(/^ed25519-[0-9a-f]{16}$/);
    expect(doc.payload).toBe(RECEIPT_SIGNATURE_PAYLOAD);
    expect(doc.signed_fields).toEqual([...RECEIPT_SIGNED_FIELDS]);
    await appOn.close();
  });

  it("serves a verifiable signature on stored receipt metadata, legacy rows included", async () => {
    const k = throwawayKeypair();
    process.env[RECEIPT_SIGNING_KEY_ENV] = k.privateB64;
    const app = buildServer();
    await app.ready();

    // Legacy-shaped row: written WITHOUT a signature (as old builds did);
    // the serve path must sign it now, over exactly the served fields.
    const stored = makeReceipt("TVL_LOOKUP_GENERAL", "https://api.llama.fi/protocol/curve-dex", '{"tvl":1}', "");
    delete stored.signature;
    saveReceipt(stored, '{"tvl":1}');

    const meta = await app.inject(`/receipts/${stored.receipt_id}`);
    expect(meta.statusCode).toBe(200);
    const body = meta.json();
    expect(typeof body.signature).toBe("string");
    expect(body.signature_alg).toBe("Ed25519");
    expect(
      verifyReceiptSignature(
        {
          receipt_id: body.receipt_id,
          intent: body.intent,
          upstream_url: body.upstream_url,
          raw_response_sha256: body.raw_response_sha256,
          quorum_votes: body.quorum_votes,
          fetched_at: body.fetched_at,
        },
        body.signature,
        k.publicB64,
      ),
    ).toBe(true);

    // Tamper check through the served shape: a flipped digest must fail.
    expect(
      verifyReceiptSignature(
        {
          receipt_id: body.receipt_id,
          intent: body.intent,
          upstream_url: body.upstream_url,
          raw_response_sha256: "0".repeat(64),
          quorum_votes: body.quorum_votes,
          fetched_at: body.fetched_at,
        },
        body.signature,
        k.publicB64,
      ),
    ).toBe(false);
    await app.close();
  });
});
