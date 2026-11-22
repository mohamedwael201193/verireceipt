// End-to-end tests for scripts/verify.mjs (S2, 2026-11-22).
//
// The script is a CLIENT of the service contract, so it is tested against
// a minimal in-process HTTP service (node:http) that implements exactly
// that contract with a throwaway Ed25519 keypair — no repo server code,
// no real key material, no external network. This keeps the verifier
// honestly independent: if the service ever drifts from the documented
// payload rule, this test still pins the CONTRACT side.
import { createHash, generateKeyPairSync, sign as edSign } from "crypto";
import { createServer, type Server } from "http";
import { execFile } from "child_process";
import { resolve } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { stableStringify } from "../src/core/receipt";

const PAYLOAD_TAG = "verireceipt-receipt-v1";
const SIGNED_FIELDS = [
  "receipt_id",
  "intent",
  "upstream_url",
  "raw_response_sha256",
  "quorum_votes",
  "fetched_at",
] as const;
const SCRIPT = resolve(process.cwd(), "scripts/verify.mjs");

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const rsaPair = generateKeyPairSync("rsa", { modulusLength: 512 });
const rsaPublicB64 = rsaPair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const publicB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const keyId = "ed25519-" + createHash("sha256").update(Buffer.from(publicB64, "base64")).digest("hex").slice(0, 16);

const EVIDENCE = '{"blockNumber":"0x2e","status":"0x1"}';
const DIGEST = createHash("sha256").update(EVIDENCE).digest("hex");

function signedMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    receipt_id: "rcpt_" + "V".repeat(26),
    intent: "ONCHAIN_TX_LOOKUP_GENERAL",
    upstream_url: "https://rpc.example.invalid",
    raw_response_sha256: DIGEST,
    quorum_votes: "leg1,leg2",
    fetched_at: "2026-11-22T00:00:00.000Z",
    audit_url: "https://service.invalid/receipts/rcpt_" + "V".repeat(26),
    ...overrides,
  };
  const picked: Record<string, unknown> = { payload: PAYLOAD_TAG };
  for (const f of SIGNED_FIELDS) picked[f] = meta[f] ?? null;
  const sig = edSign(null, Buffer.from(stableStringify(picked), "utf8"), privateKey);
  meta.signature = sig.toString("base64");
  meta.signature_alg = "Ed25519";
  return meta;
}

let server: Server;
let base: string;

// Routes:
//   /receipts/<ok-id>          signed metadata, evidence at /raw
//   /receipts/<unsigned-id>    metadata WITHOUT signature; well-known 404
//   /receipts/<badhash-id>     metadata digest does not match /raw bytes
//   anything else              404
const OK_ID = "rcpt_" + "V".repeat(26);
const UNSIGNED_ID = "rcpt_" + "U".repeat(26);
const BADHASH_ID = "rcpt_" + "B".repeat(26);
const WRONGID_ID = "rcpt_" + "W".repeat(26);

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Paths under /rsa serve the same contract but with an RSA-512 key in
    // the well-known document (reviewer r147: key-type binding).
    let pathname = url.pathname;
    let useRsa = false;
    if (pathname.startsWith("/rsa")) {
      useRsa = true;
      pathname = pathname.slice(4) || "/";
    }
    const send = (status: number, body: unknown) => {
      const data = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json" }).end(data);
    };
    if (pathname === `/.well-known/verireceipt.json`) {
      const pub = useRsa ? rsaPublicB64 : publicB64;
      return send(200, { alg: "Ed25519", key_id: useRsa ? "rsa-review" : keyId, public_key: pub, payload: PAYLOAD_TAG });
    }
    const m = pathname.match(/^\/receipts\/(rcpt_[A-Z0-9]{26})(\/raw)?$/);
    if (!m) return send(404, { code: "RECEIPT_NOT_FOUND" });
    const [id, rawSuffix] = [m[1], m[2]];
    if (id === OK_ID) {
      if (rawSuffix) return send(200, EVIDENCE);
      return send(200, signedMeta());
    }
    if (id === UNSIGNED_ID) {
      const meta = signedMeta({ receipt_id: id });
      delete meta.signature;
      delete meta.signature_alg;
      if (rawSuffix) return send(200, EVIDENCE);
      return send(200, meta);
    }
    if (id === BADHASH_ID) {
      if (rawSuffix) return send(200, '{"tampered":true}');
      return send(200, signedMeta({ receipt_id: id }));
    }
    // Reviewer r147: a service answering a DIFFERENT (validly signed)
    // receipt than the one asked for must fail target binding.
    if (id === WRONGID_ID) {
      if (rawSuffix) return send(200, EVIDENCE);
      return send(200, signedMeta({ receipt_id: OK_ID }));
    }
    return send(404, { code: "RECEIPT_NOT_FOUND" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

function runVerify(...args: string[]): Promise<{ status: number; out: string }> {
  // ASYNC on purpose: the mock service lives in THIS process's event
  // loop, so a sync spawn would deadlock (parent blocked while the child
  // waits for an HTTP answer the parent cannot serve).
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [SCRIPT, ...args], { encoding: "utf8" }, (err, stdout, stderr) => {
      const status = err && typeof err.code === "number" ? err.code : err ? -1 : 0;
      resolvePromise({ status, out: (stdout ?? "") + (stderr ?? "") });
    });
  });
}

describe("scripts/verify.mjs", () => {
  it("PASS: hash + Ed25519 signature verify against the live contract", async () => {
    const r = await runVerify(OK_ID, "--base", base);
    expect(r.status).toBe(0);
    expect(r.out).toContain("hash:    OK");
    expect(r.out).toContain(`sign:    OK Ed25519 signature verifies (key_id ${keyId})`);
    expect(r.out).toContain("PASS");
  });

  it("PASS via an audit URL (base taken from the URL)", async () => {
    const r = await runVerify(`${base}/receipts/${OK_ID}`);
    expect(r.status).toBe(0);
    expect(r.out).toContain("PASS");
  });

  it("UNSIGNED (exit 2): hash verified, receipt carries no signature", async () => {
    const r = await runVerify(UNSIGNED_ID, "--base", base);
    expect(r.status).toBe(2);
    expect(r.out).toContain("hash:    OK");
    expect(r.out).toContain("UNSIGNED");
  });

  it("FAIL (exit 1): served bytes do not match the recorded digest", async () => {
    const r = await runVerify(BADHASH_ID, "--base", base);
    expect(r.status).toBe(1);
    expect(r.out).toContain("evidence hash mismatch");
  });

  it("FAIL (exit 1): unknown receipt id", async () => {
    const r = await runVerify("rcpt_" + "Z".repeat(26), "--base", base);
    expect(r.status).toBe(1);
    expect(r.out).toContain("HTTP 404");
  });

  it("FAIL (exit 1): rejects a malformed target", async () => {
    const r = await runVerify("not-a-receipt", "--base", base);
    expect(r.status).toBe(1);
  });

  it("FAIL (exit 1): validly signed metadata for a DIFFERENT receipt id (target binding, r147)", async () => {
    const r = await runVerify(WRONGID_ID, "--base", base);
    expect(r.status).toBe(1);
    expect(r.out).toContain("different receipt_id");
  });

  it("FAIL (exit 1): an RSA key labeled Ed25519 is rejected from the parsed key type (r147)", async () => {
    const r = await runVerify(OK_ID, "--base", `${base}/rsa`);
    expect(r.status).toBe(1);
    expect(r.out).toContain("not ed25519");
  });
});
