// CVE_LOOKUP_CVSS: real CVSS v3 assessments from NVD and the CVE record.
// Exact source bodies are saved, with assessor/version/vector disclosed.
// No CVSS v2/v4 substitution, no averaging of different assessments.
// https://devnode.telegraphprotocol.com/engine/v1/intents/CVE_LOOKUP_CVSS
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
export const INTENT = "CVE_LOOKUP_CVSS";
interface Assessment { score: number; version: string; vector: string; assessor: string }
interface SourceRecord { url: string; raw: string; assessment: Assessment | null; description: string; published: string | null; references: string[] }
type Obj = Record<string, any>;
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
  if (!cve) return { url, raw, assessment: null, description: "", published: null, references: [] };
  if (cve.vulnStatus === "Rejected") throw new Error("NVD record is rejected");
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
async function fetchRecord(url: string, parse: (raw: string) => SourceRecord): Promise<SourceRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
    return parse(await response.text());
  } finally { clearTimeout(timer); }
}
// Wait for both assessments when healthy. Once one usable v3 score is
// available, a hung second source gets only 800ms grace, not its full
// 3.5s budget. Its fetch still has its own abort deadline.
async function collectRecords(tasks: Promise<SourceRecord>[]): Promise<Array<PromiseSettledResult<SourceRecord> | undefined>> {
  return new Promise((resolve) => {
    const results: Array<PromiseSettledResult<SourceRecord> | undefined> = Array.from({ length: tasks.length }, () => undefined);
    let finished = false;
    let count = 0;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const wall = setTimeout(done, 3700);
    function done(): void {
      if (finished) return;
      finished = true;
      clearTimeout(wall);
      if (grace) clearTimeout(grace);
      resolve(results.slice());
    }
    tasks.forEach((task, i) => task.then((value) => {
      if (finished) return;
      results[i] = { status: "fulfilled", value }; count++;
      if (count === tasks.length) done();
      else if (value.assessment && !grace) grace = setTimeout(done, 800);
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
  const outcomes = await collectRecords([
    fetchRecord(nvd, (raw) => parseNvdCve(id, nvd, raw)),
    fetchRecord(mitre, (raw) => parseMitreCve(id, mitre, raw)),
  ]);
  const records = outcomes.flatMap((r) => r?.status === "fulfilled" ? [r.value] : []);
  if (!records.length) throw upstreamUnavailable("CVE_SOURCES_DOWN", `no source returned a usable record for ${id}`);
  const candidates = records.filter((r): r is SourceRecord & { assessment: Assessment } => r.assessment !== null);
  if (!candidates.length) throw unprocessable("NO_CVSS_V3", `no published CVSS v3 assessment found for ${id}; v2/v4 scores are not substituted`);
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
  const evidence = JSON.stringify({ cve_id: id, as_of: asOf, selected: chosen,
    sources: records.map((r) => ({ url: r.url, assessment: r.assessment, raw_body: r.raw })),
    unavailable_sources: outcomes.flatMap((r, i) => r?.status !== "fulfilled" ? [i === 0 ? nvd : mitre] : []) });
  const receipt = makeReceipt(INTENT, winner.url, evidence, `${candidates.length}/2 published CVSS v3 assessments; source agreement, not independent scoring`);
  await saveReceipt(receipt, evidence);
  const assessmentText = candidates.map((c) => `${c.assessment.assessor}: CVSS ${c.assessment.version} ${c.assessment.score}`).join("; ");
  return envelope(INTENT, { cve_id: id, cvss_score: chosen.score, severity: cvssSeverity(chosen.score),
    description: winner.description, published: winner.published, references: winner.references,
    cvss_version: chosen.version, vector: chosen.vector, as_of: asOf }, receipt, {
    answer: `${id}: ${chosen.score}/10 (${cvssSeverity(chosen.score)}), CVSS ${chosen.version}, ${chosen.assessor}. ` +
      `Vector: ${chosen.vector}. Published assessments: ${assessmentText}. ` +
      `${winner.description.slice(0, 1800)} ` +
      (candidates.length === 1 ? "Only one usable CVSS v3 assessment was available; coverage is degraded. " : "") +
      "This is a published base severity score, not a prediction of exploitation or your environment's risk.",
    verdict: "verified", confidence: candidates.length === 2 && scores[0] === scores[1] ? 1 : 0.9,
    source: `${candidates.map((r) => r.url).join(" + ")}; NVD primary when available, CVE record fallback; selected assessment is not an average; observed ${asOf}`,
  });
}
