import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import * as dns from "node:dns/promises";
import * as tls from "node:tls";
import { EventEmitter } from "node:events";
vi.mock("node:tls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:tls")>();
  return { ...actual, connect: vi.fn(actual.connect) };
});
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});
const scratch = mkdtempSync("/tmp/ssl-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
import { certificateVerdict, handleSsl, isPublicTlsAddress, normalizeTlsHost } from "../src/handlers/sslVerification";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";

describe("TLS safety and classification", () => {
  it("rejects URLs, ports, credentials, literal IPs and malformed hosts", () => {
    for (const host of ["", "https://google.com", "google.com:443", "u@google.com", "127.0.0.1", "[::1]", "google.com/a", "localhost", "bad-.com"]) {
      expect(() => normalizeTlsHost(host), host).toThrow();
    }
  });
  it("normalizes case, terminal dot and IDN", () => {
    expect(normalizeTlsHost(" GOOGLE.COM. ")).toBe("google.com");
    expect(normalizeTlsHost("bücher.de")).toBe("xn--bcher-kva.de");
  });
  it("blocks private, loopback, metadata, multicast, reserved, documentation and IPv6 sockets", () => {
    for (const ip of ["0.1.2.3", "10.2.3.4", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.1.1", "192.168.0.1", "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1", "::ffff:127.0.0.1"]) {
      expect(isPublicTlsAddress(ip), ip).toBe(false);
    }
    expect(isPublicTlsAddress("8.8.8.8")).toBe(true);
    expect(isPublicTlsAddress("1.1.1.1")).toBe(true);
  });
  it("requires host", async () => {
    await expect(handleSsl({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
  });
  it("hostname mismatch refutes even an otherwise trusted certificate", () => {
    expect(certificateVerdict(true, null, true)).toBe(false);
    expect(certificateVerdict(true, null, false)).toBe(true);
  });
  it("known certificate errors refute but unknown verification errors refuse", () => {
    for (const code of ["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]) {
      expect(certificateVerdict(false, code, false)).toBe(false);
    }
    expect(() => certificateVerdict(false, "UNEXPECTED_INTERNAL_FAILURE", false)).toThrow();
    expect(() => certificateVerdict(false, null, false)).toThrow();
  });
  it("DNS failure is unavailable, never certificate_valid=false", async () => {
    vi.mocked(dns.lookup).mockRejectedValueOnce(new Error("resolver unavailable"));
    await expect(handleSsl({ host: "example.com" })).rejects.toMatchObject({ status: 502, code: "TLS_DNS_UNAVAILABLE" });
  });
  it("resolved private address is blocked before the TLS connection", async () => {
    vi.mocked(dns.lookup).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);
    await expect(handleSsl({ host: "example.com" })).rejects.toMatchObject({ status: 400, code: "PRIVATE_HOST" });
  });
  it("transient first round failure retries and saves the actual second-round certificate", async () => {
    const before = vi.mocked(tls.connect).mock.calls.length;
    for (let i = 0; i < 2; i++) {
      vi.mocked(tls.connect).mockImplementationOnce((() => {
        const failed = new EventEmitter() as EventEmitter & { destroy: () => void };
        failed.destroy = () => {};
        queueMicrotask(() => failed.emit("error", new Error("transient transport failure")));
        return failed;
      }) as never);
    }
    const liveAddresses = await dns.lookup("google.com", { all: true, family: 4 });
    expect(liveAddresses.length).toBeGreaterThan(0);
    vi.mocked(dns.lookup).mockResolvedValueOnce([liveAddresses[0], liveAddresses[0]] as never);
    // Retry reaches a real Google TLS peer; only the initial transport
    // failures are injected, never the resulting certificate or score.
    const result = await handleSsl({ host: "google.com" });
    expect(result.certificate_valid).toBe(true);
    expect(vi.mocked(tls.connect).mock.calls.length - before).toBe(3);
    const receipt = result.receipt as { receipt_id: string };
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("no retry evidence");
    expect(JSON.parse(stored.evidence.toString()).failed_attempts).toHaveLength(2);
  }, 12000);

  it("both rounds failing still refuse, with at most four TLS attempts", async () => {
    const before = vi.mocked(tls.connect).mock.calls.length;
    for (let i = 0; i < 4; i++) {
      vi.mocked(tls.connect).mockImplementationOnce((() => {
        const failed = new EventEmitter() as EventEmitter & { destroy: () => void };
        failed.destroy = () => {};
        queueMicrotask(() => failed.emit("error", new Error("transport unavailable")));
        return failed;
      }) as never);
    }
    vi.mocked(dns.lookup).mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }, { address: "1.1.1.1", family: 4 }] as never);
    await expect(handleSsl({ host: "example.com" })).rejects.toMatchObject({ status: 502, code: "TLS_PROBE_UNAVAILABLE" });
    expect(vi.mocked(tls.connect).mock.calls.length - before).toBe(4);
  });

  it("mixed public/private answer refuses, no rebinding escape", async () => {
    vi.mocked(dns.lookup).mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }, { address: "169.254.169.254", family: 4 }] as never);
    await expect(handleSsl({ host: "example.com" })).rejects.toMatchObject({ status: 400, code: "PRIVATE_HOST" });
  });
});

describe("real live TLS peers, no simulated certificates", () => {
  for (const [host, expected] of [["google.com", true], ["github.com", true], ["expired.badssl.com", false], ["self-signed.badssl.com", false], ["wrong.host.badssl.com", false]] as const) {
    it(`${host} -> certificate_valid=${expected} with exact DER evidence`, async () => {
      const result = await handleSsl({ host });
      expect(result.certificate_valid).toBe(expected);
      expect(result.verdict).toBe("verified");
      const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string };
      const stored = await getReceiptEvidence(receipt.receipt_id);
      if (!stored.evidence) throw new Error("missing TLS evidence");
      expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
      const evidence = JSON.parse(stored.evidence.toString("utf8"));
      expect(evidence.host).toBe(host);
      expect(evidence.chain_der_base64.length).toBeGreaterThan(0);
      const leaf = new X509Certificate(Buffer.from(evidence.chain_der_base64[0], "base64"));
      expect(leaf.fingerprint256).toBe(result.fingerprint_sha256);
      expect(String(result.answer)).toContain("not a revocation");
    }, 15000);
  }
});
