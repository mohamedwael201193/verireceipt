// Tests for src/handlers/dnsLookup.ts (DNS_RECORD_LOOKUP_GENERAL).
// Handler paths are driven by a stubbed global fetch (all three DoH
// resolvers); the LIVE tests at the bottom hit the real keyless
// resolvers. Hermetic DB via a unique scratch SQLITE_PATH per run.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";

const SCRATCH_PARENT = resolve(process.cwd(), "..", "tmp");
mkdirSync(SCRATCH_PARENT, { recursive: true });
const SCRATCH_DIR = mkdtempSync(join(SCRATCH_PARENT, "dns-test-"));
process.env.SQLITE_PATH = join(SCRATCH_DIR, "verireceipt.sqlite");

afterAll(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

import { sha256Hex } from "../src/core/receipt";
import { ApiError } from "../src/core/errors";
import { getReceiptEvidence } from "../src/core/storage";
import { INTENT, handleDns, isValidDnsName, parseDohVerdict } from "../src/handlers/dnsLookup";

const SHA256_RE = /^[0-9a-f]{64}$/;

/** DoH JSON body: records = [data,...] for the requested type code;
 * status 0 NOERROR, 3 NXDOMAIN. */
function dohBody(typeCode: number, records: string[], status = 0): string {
  return JSON.stringify({
    Status: status,
    TC: false,
    RD: true,
    RA: true,
    Question: [{ name: "example.com.", type: typeCode }],
    Answer: records.map((data) => ({ name: "example.com.", type: typeCode, TTL: 300, data })),
  });
}

interface StubOpts {
  google?: string | "ERR" | "HANG";
  cloudflare?: string | "ERR" | "HANG";
  adguard?: string | "ERR" | "HANG";
}

/** Stub global fetch across all three DoH resolvers. "ERR" = resolver
 * down; "HANG" = resolver never answers (the 4 s budget is NOT
 * shortened in tests — the failover assertions prove a hung resolver
 * never delays the answer). */
function stubResolvers(opts: StubOpts): void {
  const fetchStub = (url: unknown) => {
    const u = String(url);
    const pick = (body: string | "ERR" | "HANG" | undefined, label: string): Promise<Response> => {
      if (body === "ERR") return Promise.reject(new Error(`${label} down`));
      if (body === "HANG") return new Promise<Response>(() => {});
      if (body === undefined) return Promise.reject(new Error(`unexpected fetch to ${u}`));
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    if (u.includes("dns.google")) return pick(opts.google, "google");
    if (u.includes("cloudflare-dns.com")) return pick(opts.cloudflare, "cloudflare");
    if (u.includes("adguard")) return pick(opts.adguard, "adguard");
    return Promise.reject(new Error(`unexpected fetch to ${u}`));
  };
  vi.stubGlobal("fetch", fetchStub);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function expectApiError(p: Promise<unknown>, status: number, code: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status).toBe(status);
    expect(e.code).toBe(code);
    return;
  }
  throw new Error(`expected ApiError ${status} ${code}, but the handler resolved`);
}

const A_YES = dohBody(1, ["93.184.216.34"]);
const A_NO = dohBody(1, []);
const A_NX = dohBody(1, [], 3);

describe("validation", () => {
  it("missing params -> 400 MISSING_PARAM", async () => {
    await expectApiError(handleDns({}), 400, "MISSING_PARAM");
    await expectApiError(handleDns({ name: "example.com" }), 400, "MISSING_PARAM");
    await expectApiError(handleDns({ record_type: "A" }), 400, "MISSING_PARAM");
  });

  it("record_type outside the contract enum -> 400 INVALID_RECORD_TYPE", async () => {
    await expectApiError(handleDns({ name: "example.com", record_type: "DNSKEY" }), 400, "INVALID_RECORD_TYPE");
    await expectApiError(handleDns({ name: "example.com", record_type: "ANY" }), 400, "INVALID_RECORD_TYPE");
  });

  it("hostname table: valid shapes pass, invalid shapes 400 INVALID_NAME", () => {
    const valid = ["example.com", "sub.example.co.uk", "example.com.", "EXAMPLE.com", "_dmarc.example.com", "a-b.example.org"];
    const invalid = ["", "example", "example.c", "-bad.example.com", "bad-.example.com", "example!.com", "exa mple.com", "example.com/", "http://example.com"];
    for (const v of valid) expect(isValidDnsName(v), v).toBe(true);
    for (const v of invalid) expect(isValidDnsName(v), v).toBe(false);
  });

  it("invalid name -> 400 INVALID_NAME before any resolver call", async () => {
    await expectApiError(handleDns({ name: "not a domain", record_type: "A" }), 400, "INVALID_NAME");
  });
});

describe("parseDohVerdict", () => {
  it("counts only answers matching the requested type code", () => {
    const mixed = JSON.stringify({
      Status: 0,
      Answer: [
        { name: "www.example.com.", type: 5, TTL: 300, data: "example.com." }, // CNAME, not A
        { name: "example.com.", type: 1, TTL: 300, data: "93.184.216.34" },
      ],
    });
    const v = parseDohVerdict("r", "u", mixed, 1);
    expect(v.hasRecord).toBe(true);
    expect(v.records).toEqual(["93.184.216.34"]);
    const cnameOnly = parseDohVerdict("r", "u", mixed, 28); // AAAA
    expect(cnameOnly.hasRecord).toBe(false);
  });

  it("NXDOMAIN -> hasRecord false with status 3 kept", () => {
    const v = parseDohVerdict("r", "u", A_NX, 1);
    expect(v.hasRecord).toBe(false);
    expect(v.status).toBe(3);
  });

  it("malformed or inconclusive responses never become absence evidence", () => {
    for (const body of ["not json", "null", "[]", "{}", '{"Status":2}', '{"Status":5}',
      '{"Status":0,"TC":true}', '{"Status":0,"Answer":{}}',
      '{"Status":0,"Answer":[{"type":1}]}', dohBody(1, ["192.0.2.1"], 3)]) {
      expect(() => parseDohVerdict("r", "u", body, 1)).toThrow();
    }
  });
});

describe("handleDns stubbed resolvers", () => {
  it("all three agree YES -> has_record 1 at 1.0, real records in the answer, receipt persisted", async () => {
    stubResolvers({ google: A_YES, cloudflare: A_YES, adguard: A_YES });
    const result = await handleDns({ name: "example.com", record_type: "A" });
    expect(result.has_record).toBe(true);
    expect(result.confidence).toBe(1.0);
    expect(String(result.answer)).toContain("93.184.216.34");
    expect(String(result.answer)).toContain("all answering resolvers agree on existence");
    const receipt = result.receipt as Record<string, unknown>;
    expect(receipt.intent).toBe(INTENT);
    expect(String(receipt.receipt_id)).toMatch(/^rcpt_/);
    expect(String(receipt.raw_response_sha256)).toMatch(SHA256_RE);
    const stored = await getReceiptEvidence(String(receipt.receipt_id));
    expect(stored.found).toBe(true);
    if (!stored.evidence) throw new Error("receipt evidence missing");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    const evidence = JSON.parse(stored.evidence.toString("utf8")) as { resolvers: Array<{ raw_body: string }> };
    expect(evidence.resolvers).toHaveLength(3);
    for (const r of evidence.resolvers) expect(r.raw_body).toBe(A_YES);
  });

  it("all three agree NO -> has_record 0 at 1.0", async () => {
    stubResolvers({ google: A_NO, cloudflare: A_NO, adguard: A_NO });
    const result = await handleDns({ name: "example.com", record_type: "AAAA" });
    expect(result.has_record).toBe(false);
    expect(result.confidence).toBe(1.0);
    expect(result.verdict).toBe("not_found");
  });

  it("NXDOMAIN from all resolvers -> has_record 0 with NXDOMAIN named in the answer", async () => {
    stubResolvers({ google: A_NX, cloudflare: A_NX, adguard: A_NX });
    const result = await handleDns({ name: "nonexistent-xyz123.example.com", record_type: "A" });
    expect(result.has_record).toBe(false);
    expect(String(result.answer)).toContain("NXDOMAIN");
  });

  it("2 YES vs 1 NO refuses instead of hiding disagreement behind a majority", async () => {
    stubResolvers({ google: A_YES, cloudflare: A_YES, adguard: A_NO });
    await expectApiError(handleDns({ name: "example.com", record_type: "A" }), 502, "DNS_RESOLVERS_DISAGREE");
  });

  it("1 YES vs 2 NO refuses instead of declaring absence", async () => {
    stubResolvers({ google: A_YES, cloudflare: A_NO, adguard: A_NO });
    await expectApiError(handleDns({ name: "example.com", record_type: "A" }), 502, "DNS_RESOLVERS_DISAGREE");
  });

  it("one YES vs one NO with third down refuses, no arbitrary tie-break", async () => {
    stubResolvers({ google: A_YES, cloudflare: A_NO, adguard: "ERR" });
    await expectApiError(handleDns({ name: "example.com", record_type: "A" }), 502, "DNS_RESOLVERS_DISAGREE");
  });

  it("SERVFAIL from all resolvers refuses, never a false-negative record result", async () => {
    const fail = dohBody(1, [], 2);
    stubResolvers({ google: fail, cloudflare: fail, adguard: fail });
    await expectApiError(handleDns({ name: "example.com", record_type: "A" }), 502, "DNS_RESOLVERS_DOWN");
  });

  it("different positive values are disclosed by resolver, not conflated", async () => {
    stubResolvers({ google: A_YES, cloudflare: dohBody(1, ["192.0.2.1"]), adguard: A_YES });
    const result = await handleDns({ name: "example.com", record_type: "A" });
    expect(result.has_record).toBe(true);
    expect(String(result.answer)).toContain("Cloudflare [DNS status 0]: 192.0.2.1");
    expect(String(result.answer)).toContain("Google Public DNS [DNS status 0]: 93.184.216.34");
  });

  it("kill-each-resolver failover: any one resolver down -> still answers at 0.9 with it named", async () => {
    for (const down of ["google", "cloudflare", "adguard"] as const) {
      vi.unstubAllGlobals();
      stubResolvers({ google: A_YES, cloudflare: A_YES, adguard: A_YES, [down]: "ERR" });
      const result = await handleDns({ name: "example.com", record_type: "A" });
      expect(result.has_record).toBe(true);
      expect(result.confidence).toBe(0.9);
      expect(String(result.source)).toContain("resolvers failed:");
    }
  });

  it("a HUNG resolver never delays the answer beyond the straggler grace", async () => {
    stubResolvers({ google: A_YES, cloudflare: A_YES, adguard: "HANG" });
    const started = Date.now();
    const result = await handleDns({ name: "example.com", record_type: "A" });
    const wall = Date.now() - started;
    expect(result.has_record).toBe(true);
    expect(wall).toBeLessThan(3500); // grace 800 ms, never the 4 s budget
  });

  it("only one resolver answering -> its verdict at 0.9 with failures named", async () => {
    stubResolvers({ google: A_NO, cloudflare: "ERR", adguard: "ERR" });
    const result = await handleDns({ name: "example.com", record_type: "A" });
    expect(result.has_record).toBe(false);
    expect(result.confidence).toBe(0.9);
    expect(String(result.source)).toContain("Cloudflare");
    expect(String(result.source)).toContain("AdGuard");
  });

  it("all resolvers erroring -> 502 DNS_RESOLVERS_DOWN, never an invented record", async () => {
    stubResolvers({ google: "ERR", cloudflare: "ERR", adguard: "ERR" });
    await expectApiError(handleDns({ name: "example.com", record_type: "A" }), 502, "DNS_RESOLVERS_DOWN");
  });

  it("all ten contract record types reach their numeric DoH query and return real evidence", async () => {
    for (const [type, code] of Object.entries({ A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, CAA: 257 })) {
      vi.unstubAllGlobals();
      const body = dohBody(code, ["record-data"]);
      stubResolvers({ google: body, cloudflare: body, adguard: body });
      const result = await handleDns({ name: "example.com", record_type: type.toLowerCase() });
      expect(result.has_record).toBe(true);
      expect(result.record_type).toBe(type);
      expect(result.records).toEqual(["record-data"]);
    }
  });

  it("truncated answer says 10 of N shown while structured records stay complete", async () => {
    const records = Array.from({ length: 12 }, (_, i) => `192.0.2.${i + 1}`);
    const body = dohBody(1, records);
    stubResolvers({ google: body, cloudflare: body, adguard: body });
    const result = await handleDns({ name: "example.com", record_type: "A" });
    expect(result.records).toEqual(records);
    expect(String(result.answer)).toContain("10 of 12 shown");
    expect(String(result.answer)).not.toContain("192.0.2.12");
  });

  it("null MX is an existing DNS record but explicitly means no email delivery", async () => {
    const mx = dohBody(15, ["0 ."]);
    stubResolvers({ google: mx, cloudflare: mx, adguard: mx });
    const result = await handleDns({ name: "example.com", record_type: "MX" });
    expect(result.has_record).toBe(true);
    expect(String(result.answer)).toContain("accepts no email");
  });

  it("MX records carry real values (priority + exchange) in the answer", async () => {
    const mx = dohBody(15, ["10 mail.example.com.", "20 mail2.example.com."]);
    stubResolvers({ google: mx, cloudflare: mx, adguard: mx });
    const result = await handleDns({ name: "example.com", record_type: "MX" });
    expect(result.has_record).toBe(true);
    expect(String(result.answer)).toContain("10 mail.example.com.");
  });
});

describe("handleDns live (real keyless DoH resolvers, no mocks)", () => {
  it("example.com A -> has_record true from at least two real resolvers", async () => {
    const result = await handleDns({ name: "example.com", record_type: "A" });
    expect(result.has_record).toBe(true);
    expect((result.resolvers_used as string[]).length).toBeGreaterThanOrEqual(2);
    const receipt = result.receipt as Record<string, unknown>;
    const stored = await getReceiptEvidence(String(receipt.receipt_id));
    expect(stored.found).toBe(true);
  }, 20000);

  it("a name with no TXT record -> has_record false, honestly", async () => {
    // A deliberately nonexistent subdomain gives a real negative result.
    const result = await handleDns({ name: "nonexistent-subdomain-zz9q7.example.com", record_type: "TXT" });
    expect(result.has_record).toBe(false);
  }, 20000);

  it("github.com MX -> real records listed in the answer", async () => {
    const result = await handleDns({ name: "github.com", record_type: "MX" });
    expect(result.has_record).toBe(true);
    expect(String(result.answer)).toMatch(/\d+ \S+/);
  }, 20000);
});
