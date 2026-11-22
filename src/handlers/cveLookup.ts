// CVE_LOOKUP_CVSS: real CVSS v3 assessments from the published CVE record.
// NVD is disabled by default. Literal CVE_NVD_ENABLED=true opts in only
// after aggregate egress request ownership has been verified operationally.
// Exact source bodies are saved, with assessor/version/vector disclosed.
// No CVSS v2/v4 substitution, no averaging of different assessments.
// NVD keyless access is limited to 5 requests per rolling 30 seconds.
// HTTP 429 is a failed source, not a zero score: the published CVE record
// remains the fallback. A shared per-CVE short-TTL cache/rate budget is
// enforced per process below. This is NOT an aggregate egress budget across
// overlapping deployments. NVD activation requires a single-egress-owner check.
// https://devnode.telegraphprotocol.com/engine/v1/intents/CVE_LOOKUP_CVSS
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { PublicBodyCache, StartBudget, readPublicBody } from "../core/publicSource";
export const INTENT = "CVE_LOOKUP_CVSS";
interface Assessment { score: number; version: string; vector: string; assessor: string }
interface SourceRecord { url: string; raw: string; assessment: Assessment | null; description: string; published: string | null; references: string[]; fetchedAt?: string }
type Obj = Record<string, any>;
class RejectedCveRecord extends Error {}
function assessment(data: Obj | undefined, assessor: string): Assessment | null {
  if (!data || !["3.0", "3.1"].includes(data.version) || typeof data.baseScore !== "number" ||
      !Number.isFinite(data.baseScore) || data.baseScore < 0 || data.baseScore > 10 ||
      typeof data.vectorString !== "string" || !data.vectorString.startsWith(`CVSS:${data.version}/`)) return null;
  return { score: data.baseScore, version: data.version, vector: data.vectorString, assessor };
}
export function parseNvdCve(id: string, url: string, raw: string): SourceRecord {
  const json = JSON.parse(raw) as Obj;
  if (!Array.isArray(json.vulnerabilities)) throw new Error("malformed NVD result");
  const cve = json.vulnerabilities.find((v: Obj) => v.cve?.id === id)?.cve;
  if (!cve) throw new Error("NVD record does not match requested CVE ID");
  if (cve.vulnStatus === "Rejected") throw new RejectedCveRecord("NVD record is rejected");
  let selected: Assessment | null = null;
  for (const key of ["cvssMetricV31", "cvssMetricV30"]) {
    const metrics = cve.metrics?.[key];
    if (!Array.isArray(metrics)) continue;
    const sorted = [...metrics].sort((a, b) => Number(b.type === "Primary") - Number(a.type === "Primary"));
    for (const metric of sorted) {
      selected = assessment(metric.cvssData, `NVD assessment by ${String(metric.source ?? "unspecified")}`);
      if (selected) break;
    }
    if (selected) break;
  }
  return { url, raw, assessment: selected,
    description: cve.descriptions?.find((d: Obj) => d.lang === "en")?.value ?? "",
    published: typeof cve.published === "string" ? cve.published : null,
    references: Array.isArray(cve.references) ? cve.references.map((r: Obj) => r.url).filter((s: unknown) => typeof s === "string") : [] };
}
export function parseMitreCve(id: string, url: string, raw: string): SourceRecord {
  const json = JSON.parse(raw) as Obj;
  if (json.cveMetadata?.cveId === id && json.cveMetadata?.state === 'REJECTED') throw new RejectedCveRecord('CVE record is rejected');
  if (json.cveMetadata?.cveId !== id || json.cveMetadata?.state !== "PUBLISHED" || !json.containers?.cna) {
    throw new Error("CVE record is not a matching published record");
  }
  const cna = json.containers.cna;
  const containers = [cna, ...(Array.isArray(json.containers.adp) ? json.containers.adp : [])];
  let selected: Assessment | null = null;
  // Prefer v3.1 over v3.0, then the CNA over supplemental assessments.
  for (const key of ["cvssV3_1", "cvssV3_0"]) {
    for (const container of containers) {
      for (const metric of Array.isArray(container.metrics) ? container.metrics : []) {
        selected = assessment(metric[key], `CVE record: ${String(container.providerMetadata?.shortName ?? container.providerMetadata?.orgId ?? "unspecified assessor")}`);
        if (selected) break;
      }
      if (selected) break;
    }
    if (selected) break;
  }
  return { url, raw, assessment: selected,
    description: cna.descriptions?.find((d: Obj) => d.lang === "en")?.value ?? "",
    published: typeof json.cveMetadata.datePublished === "string" ? json.cveMetadata.datePublished : null,
    references: Array.isArray(cna.references) ? cna.references.map((r: Obj) => r.url).filter((s: unknown) => typeof s === "string") : [] };
}
let sourceCache = new PublicBodyCache(128, 60_000);
let nvdBudget = new StartBudget(5, 30_001);
let nextNvdStart = 0;
let nvdStoppedUntil = 0;
/** Tests reset only. Production state lives for the process lifetime. */
export function resetCveTransportForTests(): void {
  sourceCache = new PublicBodyCache(128, 60_000); nvdBudget = new StartBudget(5, 30_001);
  nextNvdStart = 0; nvdStoppedUntil = 0;
}
async function fetchRecord(url: string, parse: (raw: string) => SourceRecord): Promise<SourceRecord> {
  const body = await sourceCache.get(url, async () => {
    if (url.startsWith('https://services.nvd.nist.gov/')) {
      const now = Date.now();
      if (now < nvdStoppedUntil || now < nextNvdStart || !nvdBudget.take()) throw new Error('NVD shared process budget unavailable');
      nextNvdStart = now + 6001;
    }
    try {
      const value = await readPublicBody(url, 1_000_000, 3500);
      // Do not cache a wrong-ID, rejected or malformed body.
      parse(value.raw);
      return value;
    } catch (error) {
      if (url.startsWith('https://services.nvd.nist.gov/') && /HTTP (403|429)/.test(String(error))) nvdStoppedUntil = Date.now() + 30 * 60_000;
      throw error;
    }
  });
  return { ...parse(body.raw), fetchedAt: body.fetchedAt };
}
// Wait for both enabled sources up to their bounded transport deadline.
// Returning early could hide a matching semantic REJECTED record.
async function collectRecords(tasks: Promise<SourceRecord>[]): Promise<Array<PromiseSettledResult<SourceRecord> | undefined>> {
  return new Promise((resolve) => {
    const results: Array<PromiseSettledResult<SourceRecord> | undefined> = Array.from({ length: tasks.length }, () => undefined);
    let finished = false;
    let count = 0;
    const wall = setTimeout(done, 3700);
    function done(): void {
      if (finished) return;
      finished = true;
      clearTimeout(wall);
      resolve(results.slice());
    }
    tasks.forEach((task, i) => task.then((value) => {
      if (finished) return;
      results[i] = { status: "fulfilled", value }; count++;
      if (count === tasks.length) done();
    }, (reason) => {
      if (finished) return;
      results[i] = { status: "rejected", reason }; count++;
      if (count === tasks.length) done();
    }));
  });
}
export function cvssSeverity(score: number): string {
  return score === 0 ? "NONE" : score < 4 ? "LOW" : score < 7 ? "MEDIUM" : score < 9 ? "HIGH" : "CRITICAL";
}
export async function handleCve(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const id = query.cve_id?.trim().toUpperCase();
  if (!id) throw badRequest("MISSING_PARAM", "cve_id is required");
  if (!/^CVE-\d{4}-\d{4,19}$/.test(id)) throw badRequest("INVALID_CVE", "cve_id must have CVE-YYYY-NNNN format");
  const nvd = `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${id}`;
  const mitre = `https://cveawg.mitre.org/api/cve/${id}`;
  // Fail closed by default. Enabling NVD requires separately verified aggregate
  // egress ownership across every process/deployment sharing the public IP.
  const nvdEnabled = process.env.CVE_NVD_ENABLED === "true";
  const outcomes = await collectRecords([
    nvdEnabled ? fetchRecord(nvd, (raw) => parseNvdCve(id, nvd, raw)) : Promise.reject(new Error("NVD disabled by source policy")),
    fetchRecord(mitre, (raw) => parseMitreCve(id, mitre, raw)),
  ]);
  if (outcomes.some(r => r?.status === 'rejected' && r.reason instanceof RejectedCveRecord)) {
    throw unprocessable('CVE_REJECTED', `a matching source marks ${id} rejected; refusing another source's published score`);
  }
  const records = outcomes.flatMap((r) => r?.status === "fulfilled" ? [r.value] : []);
  if (!records.length) throw upstreamUnavailable("CVE_SOURCES_DOWN", `no source returned a usable record for ${id}`);
  const candidates = records.filter((r): r is SourceRecord & { assessment: Assessment } => r.assessment !== null);
  if (!candidates.length) throw unprocessable("NO_CVSS_V3", `no published CVSS v3 assessment found for ${id}; v2/v4 scores are not substituted`);
  if (new Set(candidates.map(c => c.assessment.version)).size > 1) {
    throw upstreamUnavailable('CVE_VERSION_DISAGREEMENT', 'published assessments use different CVSS v3 minor versions; refusing to compare them as agreement');
  }
  const scores = candidates.map((c) => c.assessment.score);
  if (Math.max(...scores) - Math.min(...scores) > 0.30000001) {
    throw upstreamUnavailable("CVE_ASSESSMENTS_DISAGREE", `published CVSS v3 assessments disagree for ${id}: ` +
      candidates.map((c) => `${c.assessment.assessor} v${c.assessment.version}=${c.assessment.score}`).join("; ") + "; refusing to average them");
  }
  // Source order makes NVD primary when present, otherwise the CVE CNA/
  // supplemental record. The exact winning assessor is always named.
  const winner = candidates[0];
  const chosen = winner.assessment;
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ cve_id: id, as_of: asOf, selected: chosen, nvd_enabled: nvdEnabled,
    source_policy: nvdEnabled ? "NVD explicitly enabled; aggregate egress ownership required" : "NVD disabled; published CVE record only, degraded single-source coverage",
    sources: records.map((r) => ({ url: r.url, assessment: r.assessment, raw_body: r.raw, fetched_at: r.fetchedAt })),
    unavailable_sources: outcomes.flatMap((r, i) => r?.status !== "fulfilled" ? [i === 0 ? nvd : mitre] : []) });
  const receipt = makeReceipt(INTENT, winner.url, evidence, `${candidates.length}/2 published CVSS v3 assessments; source agreement, not independent scoring`);
  receipt.fetched_at = winner.fetchedAt ?? asOf;
  await saveReceipt(receipt, evidence);
  const assessmentText = candidates.map((c) => `${c.assessment.assessor}: CVSS ${c.assessment.version} ${c.assessment.score}`).join("; ");
  return envelope(INTENT, { cve_id: id, cvss_score: chosen.score, severity: cvssSeverity(chosen.score),
    description: winner.description, published: winner.published, references: winner.references,
    cvss_version: chosen.version, vector: chosen.vector, as_of: asOf }, receipt, {
    answer: `${id}: ${chosen.score}/10 (${cvssSeverity(chosen.score)}), CVSS ${chosen.version}, ${chosen.assessor}. ` +
      `Vector: ${chosen.vector}. Published assessments: ${assessmentText}. ` +
      `${winner.description.slice(0, 1800)}${winner.description.length > 1800 ? " [description truncated at 1800 characters; full text in receipt]" : ""} ` +
      (candidates.length === 1 ? "Only one usable CVSS v3 assessment was available; coverage is degraded. " : "") +
      (!nvdEnabled ? "NVD access is disabled by source policy. " : "") +
      "This is a published base severity score, not a prediction of exploitation or your environment's risk. " +
      (records.some(r => r.url === nvd) ? "This product uses data from the NVD API but is not endorsed or certified by the NVD." : "Published CVE record data; no NVD API data used in this response."),
    verdict: "verified", confidence: candidates.length === 2 && scores[0] === scores[1] ? 1 : 0.9,
    source: `${candidates.map((r) => r.url).join(" + ")}; ${nvdEnabled ? "NVD primary when available, CVE record fallback" : "NVD disabled; published CVE record only, degraded single-source coverage"}; selected assessment is not an average; source fetched ${winner.fetchedAt ?? asOf}; checked ${asOf}`,
  });
}
