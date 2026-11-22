import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/cve-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => vi.stubEnv("CVE_NVD_ENABLED", "true"));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetCveTransportForTests(); });
import { parseNvdCve, parseMitreCve, handleCve, cvssSeverity, resetCveTransportForTests } from "../src/handlers/cveLookup";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/cve", name), "utf8");
const nvd = fixture("cve-log4j-nvd.json");
const mitre = fixture("cve-log4j-mitre.json");
function sources(a: string | null, b: string | null): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const raw = String(url).includes("nist.gov") ? a : b;
    if (raw === null) throw new Error("test source outage");
    return new Response(raw, { status: 200 });
  });
}
describe("real source snapshots, retrieved 2026-11-22", () => {
  it("NVD selects the primary v3.1 score, not v2 or a secondary assessor", () => {
    const record = parseNvdCve("CVE-2021-44228", "nvd", nvd);
    expect(record.assessment?.score).toBe(10);
    expect(record.assessment?.version).toBe("3.1");
    expect(record.assessment?.assessor).toContain("nvd@nist.gov");
  });
  it("Log4j finds the CISA supplemental v3 assessment when CNA has none", () => {
    const record = parseMitreCve("CVE-2021-44228", "mitre", mitre);
    expect(record.assessment?.score).toBe(10);
    expect(record.assessment?.assessor).toContain("CISA-ADP");
  });
  it("rejected, wrong-ID and malformed source records cannot serve a score", () => {
    const rejected = JSON.parse(mitre); rejected.cveMetadata.state = "REJECTED";
    expect(() => parseMitreCve("CVE-2021-44228", "u", JSON.stringify(rejected))).toThrow();
    expect(() => parseMitreCve("CVE-2017-0144", "u", mitre)).toThrow();
    expect(() => parseNvdCve("CVE-2021-44228", "u", "{}")).toThrow();
  });
  it("severity thresholds follow CVSS v3", () => {
    expect([0, 0.1, 3.9, 4, 6.9, 7, 8.9, 9, 10].map(cvssSeverity)).toEqual(["NONE", "LOW", "LOW", "MEDIUM", "MEDIUM", "HIGH", "HIGH", "CRITICAL", "CRITICAL"]);
  });
});
describe("CVE handler failure and evidence paths", () => {
  it("validates before fetching", async () => {
    await expect(handleCve({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    for (const id of ["CVE-1-2", "CVE-2024-1234/../../", "foo"]) {
      await expect(handleCve({ cve_id: id })).rejects.toMatchObject({ status: 400, code: "INVALID_CVE" });
    }
  });
  it("agreed score has a saved receipt over both exact original bodies", async () => {
    sources(nvd, mitre);
    const result = await handleCve({ cve_id: "cve-2021-44228" });
    expect(result.cvss_score).toBe(10);
    expect(result.confidence).toBe(1);
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string };
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    const body = JSON.parse(stored.evidence.toString("utf8"));
    expect(body.sources.map((s: { raw_body: string }) => s.raw_body)).toEqual([nvd, mitre]);
  });
  it("kill-each-source still serves the actual other published assessment at 0.9", async () => {
    for (const pair of [[null, mitre], [nvd, null]]) {
      sources(pair[0], pair[1]);
      const result = await handleCve({ cve_id: "CVE-2021-44228" });
      expect(result.cvss_score).toBe(10);
      expect(result.confidence).toBe(0.9);
      expect(String(result.answer)).toContain("coverage is degraded");
    }
  });
  it("hung source is named unavailable after the bounded semantic-check deadline", async () => {
    vi.stubGlobal("fetch", (url: string) => String(url).includes("nist.gov")
      ? new Promise<Response>(() => {})
      : Promise.resolve(new Response(mitre, { status: 200 })));
    const started = Date.now();
    const result = await handleCve({ cve_id: "CVE-2021-44228" });
    expect(Date.now() - started).toBeLessThan(4400);
    expect(result.confidence).toBe(0.9);
    expect(result.cvss_score).toBe(10);
    const receipt = result.receipt as { receipt_id: string };
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(JSON.parse(stored.evidence.toString()).unavailable_sources).toEqual([
      "https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2021-44228",
    ]);
  });

  it("marks a sliced description while preserving the full source in its receipt", async () => {
    const record = JSON.parse(nvd);
    const english = record.vulnerabilities[0].cve.descriptions.find((d: { lang: string }) => d.lang === "en");
    english.value = english.value.repeat(12);
    sources(JSON.stringify(record), null);
    const result = await handleCve({ cve_id: "CVE-2021-44228" });
    expect(String(result.answer)).toContain("description truncated at 1800 characters; full text in receipt");
    const saved = await getReceiptEvidence((result.receipt as { receipt_id: string }).receipt_id);
    expect(saved.evidence?.toString()).toContain(english.value);
  });
  it("all sources down is unavailable, never score zero", async () => {
    sources(null, null);
    await expect(handleCve({ cve_id: "CVE-2021-44228" })).rejects.toMatchObject({ status: 502, code: "CVE_SOURCES_DOWN" });
  });
  it("v2-only source cannot be silently substituted for v3", async () => {
    const onlyV2 = JSON.parse(nvd);
    delete onlyV2.vulnerabilities[0].cve.metrics.cvssMetricV31;
    sources(JSON.stringify(onlyV2), null);
    await expect(handleCve({ cve_id: "CVE-2021-44228" })).rejects.toMatchObject({ status: 422, code: "NO_CVSS_V3" });
  });
  it("injected conflicting assessment refuses, never averages it", async () => {
    const conflict = JSON.parse(mitre);
    const metric = conflict.containers.adp.flatMap((c: any) => c.metrics ?? []).find((m: any) => m.cvssV3_1);
    metric.cvssV3_1.baseScore = 5;
    sources(nvd, JSON.stringify(conflict));
    await expect(handleCve({ cve_id: "CVE-2021-44228" })).rejects.toMatchObject({ status: 502, code: "CVE_ASSESSMENTS_DISAGREE" });
  });
});
