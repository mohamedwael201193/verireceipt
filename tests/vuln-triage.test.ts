import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/triage-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetCveTransportForTests(); });
import { handleVulnTriage, resetCveTransportForTests } from "../src/handlers/cveLookup";
import { buildServer } from "../src/server";
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
describe("VULNERABILITY_TRIAGE_GENERAL", () => {
  it("validates before fetching", async () => {
    vi.stubEnv("CVE_NVD_ENABLED", "true");
    await expect(handleVulnTriage({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleVulnTriage({ cve_id: "foo" })).rejects.toMatchObject({ status: 400, code: "INVALID_CVE" });
  });
  it("serves the NVD primary CVSS v3.1 base score, agreeing with the published record", async () => {
    vi.stubEnv("CVE_NVD_ENABLED", "true");
    sources(nvd, mitre);
    const result = await handleVulnTriage({ cve_id: "cve-2021-44228" });
    expect((result.receipt as { intent: string }).intent).toBe("VULNERABILITY_TRIAGE_GENERAL");
    expect(result.cvss_base_score).toBe(10);
    expect(result.cvss_version).toBe("3.1");
    expect(result.confidence).toBe(1);
    expect(String(result.answer)).toContain("not an EPSS probability");
    expect(String(result.answer)).toContain("not endorsed or certified by the NVD");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string };
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    const body = JSON.parse(stored.evidence.toString("utf8"));
    expect(body.contract_note).toContain("not an EPSS probability");
  });
  it("never substitutes a v3.0 assessment for the contracted v3.1", async () => {
    vi.stubEnv("CVE_NVD_ENABLED", "true");
    const v30 = JSON.parse(nvd);
    v30.vulnerabilities[0].cve.metrics.cvssMetricV30 = v30.vulnerabilities[0].cve.metrics.cvssMetricV31;
    delete v30.vulnerabilities[0].cve.metrics.cvssMetricV31;
    v30.vulnerabilities[0].cve.metrics.cvssMetricV30[0].cvssData.version = "3.0";
    v30.vulnerabilities[0].cve.metrics.cvssMetricV30[0].cvssData.vectorString = "CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H";
    sources(JSON.stringify(v30), null);
    await expect(handleVulnTriage({ cve_id: "CVE-2021-44228" })).rejects.toMatchObject({ status: 422, code: "NO_CVSS_V3_1" });
  });
  it("refuses to average disagreeing published v3.1 assessments", async () => {
    vi.stubEnv("CVE_NVD_ENABLED", "true");
    const edited = JSON.parse(mitre);
    edited.containers.adp[1].metrics[0].cvssV3_1.baseScore = 9.0;
    sources(nvd, JSON.stringify(edited));
    await expect(handleVulnTriage({ cve_id: "CVE-2021-44228" })).rejects.toMatchObject({ status: 502, code: "CVE_ASSESSMENTS_DISAGREE" });
  });
  it("a rejected source record can never be outbid by a published score", async () => {
    vi.stubEnv("CVE_NVD_ENABLED", "true");
    const rejected = JSON.parse(mitre); rejected.cveMetadata.state = "REJECTED";
    sources(nvd, JSON.stringify(rejected));
    await expect(handleVulnTriage({ cve_id: "CVE-2021-44228" })).rejects.toMatchObject({ status: 422, code: "CVE_REJECTED" });
  });
  it("with NVD disabled by policy, the published record serves at 0.9 and names the policy", async () => {
    sources(nvd, mitre); // CVE_NVD_ENABLED unset: NVD leg is skipped before any request
    const result = await handleVulnTriage({ cve_id: "CVE-2021-44228" });
    expect(result.cvss_base_score).toBe(10);
    expect(result.confidence).toBe(0.9);
    expect(String(result.answer)).toContain("coverage is degraded");
    expect(String(result.answer)).toContain("NVD access is disabled by source policy");
  });
  it("GET /v1/vulnerability-triage is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/vulnerability-triage" })).toBe(true);
    vi.stubEnv("CVE_NVD_ENABLED", "true");
    sources(nvd, mitre);
    const res = await app.inject({ method: "GET", url: "/v1/vulnerability-triage?cve_id=CVE-2021-44228" });
    expect(res.statusCode).toBe(200);
    expect(res.json().cvss_base_score).toBe(10);
    await app.close();
  });
});
