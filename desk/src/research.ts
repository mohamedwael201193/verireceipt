// Mission 13 research appendix. Testnet direct asks only. No investment/filing-compliance advice.
// The decision policy is committed to disk BEFORE any paid call by research-packet.ts.
import { createHash } from "node:crypto";
import { MINER_BASE_URL } from "./constants.js";
import type { Fetch } from "./client.js";
import type { VerifyOutput } from "./verify.js";

export const RESEARCH_INTENT = "REGULATORY_FILING_MONITOR_GENERAL";
export interface ResearchPlan {
  version: "research-packet-v1";
  created_at: string;
  cik: string;
  year: number;
  form: "10-Q" | "10-K" | "8-K";
  minimum_count: number;
  max_age_seconds: 300;
  maximum_call_uusdc: "10000";
  network: "eip155:11155111";
  params: { entity: string; period: string };
}
export interface FilingRow { form: string; accession: string; filing_date: string; primary_document: string; source_url?: string }
export interface ResearchResult {
  status: "SUPPORTED" | "NOT_SUPPORTED" | "HOLD";
  reason: string;
  source_name: string | null;
  observed_count: number | null;
  rows: FilingRow[];
  checks: { name: string; ok: boolean }[];
  limits: string[];
}
export const RESEARCH_LIMITS = [
  "Historical SEC filing-coverage research only. Not an investment recommendation or a legal reporting-compliance determination.",
  "Exact form only: amendments are excluded. Calendar filing dates, not the company's fiscal year or reporting period.",
  "Independent parsing of hash-checked stored SEC bytes checks extraction, not the truth of SEC submissions or the contents of the filings.",
  "Direct related-party Sepolia testnet purchase. Not independent adoption, ranked routing, real customer revenue or a whole mission completion claim.",
];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function planHash(p: ResearchPlan): string { return sha(JSON.stringify(p)); }
export function makeResearchPlan(input: { cik: string; year: number; form: string; minimum_count: number }, now = new Date()): ResearchPlan {
  if (typeof input.cik !== "string" || input.cik.trim() !== input.cik || !/^[1-9][0-9]{0,9}$/.test(input.cik)) throw new Error("CIK must be canonical positive digits (1-10), no name guessing");
  if (!Number.isInteger(input.year) || input.year < 1994 || input.year >= now.getUTCFullYear()) throw new Error("Use a completed calendar year from 1994 onward");
  if (!["10-Q", "10-K", "8-K"].includes(input.form)) throw new Error("Supported exact forms: 10-Q, 10-K, 8-K");
  if (!Number.isInteger(input.minimum_count) || input.minimum_count < 1 || input.minimum_count > 1000) throw new Error("minimum_count must be an integer from 1 to 1000");
  return { version: "research-packet-v1", created_at: now.toISOString(), cik: input.cik, year: input.year,
    form: input.form as ResearchPlan["form"], minimum_count: input.minimum_count, max_age_seconds: 300,
    maximum_call_uusdc: "10000", network: "eip155:11155111",
    params: { entity: `Form ${input.form} filings by CIK ${input.cik}`, period: `calendar ${input.year}` } };
}
export function validateResearchPlan(p: ResearchPlan, hash: string, now = new Date()): void {
  const canonical = makeResearchPlan(p, new Date(p.created_at));
  if (JSON.stringify(canonical) !== JSON.stringify(p) || planHash(p) !== hash) throw new Error("Plan has unknown, changed or noncanonical fields");
  const age = now.getTime() - Date.parse(p.created_at);
  if (!Number.isFinite(age) || age < 0 || age > 3600_000) throw new Error("Plan must be created within the last hour, before this run");
}
function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Malformed SEC object");
  return v as Record<string, unknown>;
}
function extractRows(v: unknown): FilingRow[] {
  const o = obj(v);
  const keys = ["form", "accessionNumber", "filingDate", "primaryDocument"] as const;
  const cols = keys.map(k => o[k]);
  if (cols.some(x => !Array.isArray(x)) || cols.some(x => (x as unknown[]).length !== (cols[0] as unknown[]).length)) throw new Error("Malformed SEC column arrays");
  return (cols[0] as unknown[]).map((_, i) => {
    const [form, accession, date, doc] = cols.map(c => (c as unknown[])[i]);
    if (typeof form !== "string" || typeof accession !== "string" || accession.length !== 20 || !/^\d{10}-\d{2}-\d{6}$/.test(accession) ||
        typeof date !== "string" || date.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date || typeof doc !== "string" || /[\s\u0000]/.test(doc) || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(doc) || doc.split("/").some(part => part === ".." || part === "." || part === "")) throw new Error("Invalid SEC filing row");
    return { form, accession, filing_date: date, primary_document: doc };
  });
}
/** Bounded, read-only evidence replay. Never fetches a URL supplied by the answer. */
export async function evaluateResearch(p: ResearchPlan, v: VerifyOutput, f: Fetch = fetch, now = new Date()): Promise<ResearchResult> {
  const checks: ResearchResult["checks"] = [];
  const out: ResearchResult = { status: "HOLD", reason: "Evidence incomplete", source_name: null, observed_count: null, rows: [], checks, limits: [...RESEARCH_LIMITS] };
  const require = (name: string, ok: boolean) => { checks.push({ name, ok }); if (!ok) throw new Error(name); };
  try {
    require("existing signal, payer, miner, intent and raw-byte checks passed", v.verified);
    require("paid request parameters equal frozen policy", JSON.stringify(v.requestParams) === JSON.stringify(p.params) ||
      !!v.requestParams && Object.keys(v.requestParams).length === 2 && v.requestParams.entity === p.params.entity && v.requestParams.period === p.params.period);
    const r = v.minerReceipt;
    require("receipt identifier and exact SEC CIK source", !!r && r.receipt_id.length === 31 && /^rcpt_[A-Z0-9]{26}$/.test(r.receipt_id) && r.upstream_url === `https://data.sec.gov/submissions/CIK${p.cik.padStart(10, "0")}.json`);
    const answer = obj(v.payloadResponse);
    const fetchedAt = obj(answer.receipt).fetched_at;
    const signalTime = Date.parse(v.signalTimestamp ?? "");
    const fetchedTime = typeof fetchedAt === "string" ? Date.parse(fetchedAt) : NaN;
    require("answer was fetched after plan and within freshness bound", Number.isFinite(fetchedTime) && fetchedTime >= Date.parse(p.created_at) && fetchedTime <= now.getTime() && now.getTime() - fetchedTime <= p.max_age_seconds * 1000);
    require("signal timestamp follows plan and is fresh", Number.isFinite(signalTime) && signalTime >= Date.parse(p.created_at) && signalTime <= now.getTime() + 5000 && now.getTime() - signalTime <= p.max_age_seconds * 1000);
    const raw = await f(`${MINER_BASE_URL}/receipts/${r!.receipt_id}/raw`, { signal: AbortSignal.timeout(15000) });
    require("stored SEC main bytes reachable", raw.ok);
    const text = await raw.text();
    require("main bytes SHA256 rechecked for this replay", sha(text) === r!.raw_response_sha256);
    const main = obj(JSON.parse(text));
    require("SEC main document has requested CIK and a name", /^\d{1,10}$/.test(String(main.cik)) && Number(main.cik) === Number(p.cik) && typeof main.name === "string" && main.name.trim().length > 0);
    out.source_name = main.name as string;
    const filings = obj(main.filings);
    const rows = extractRows(filings.recent);
    require("SEC history manifest is an array", Array.isArray(filings.files));
    const start = `${p.year}-01-01`, end = `${p.year}-12-31`;
    const required: string[] = [];
    for (const item of filings.files as unknown[]) {
      const file = obj(item);
      require("valid bounded SEC history manifest", typeof file.name === "string" && new RegExp(`^CIK${p.cik.padStart(10, "0")}-submissions-\\d{3}\\.json$`).test(file.name) &&
        typeof file.filingFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(file.filingFrom) && typeof file.filingTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(file.filingTo) && file.filingFrom <= file.filingTo);
      if ((file.filingFrom as string) <= end && (file.filingTo as string) >= start) required.push(`https://data.sec.gov/submissions/${file.name as string}`);
    }
    require("at most 20 relevant history pages and no duplicate manifests", required.length <= 20 && new Set(required).size === required.length);
    const pages = answer.upstream_pages === undefined ? [] : answer.upstream_pages;
    require("hash-committed history page list available", Array.isArray(pages));
    const ps = (pages as unknown[]).map(obj);
    require("all and only required history pages represented", ps.length === required.length && new Set(ps.map(x => x.url)).size === ps.length && required.every(url => ps.some(x => x.url === url)));
    for (let i = 0; i < ps.length; i++) {
      const page = ps[i];
      require("history digest has correct shape", typeof page.raw_response_sha256 === "string" && /^[0-9a-f]{64}$/.test(page.raw_response_sha256));
      const res = await f(`${MINER_BASE_URL}/receipts/${r!.receipt_id}/pages/${i}/raw`, { signal: AbortSignal.timeout(15000) });
      require("stored history page reachable", res.ok);
      const body = await res.text();
      require("history SHA256 matches committed answer", sha(body) === page.raw_response_sha256);
      rows.push(...extractRows(JSON.parse(body)));
    }
    const unique = new Map<string, FilingRow>();
    let conflict = false;
    for (const row of rows) {
      const previous = unique.get(row.accession);
      if (previous && JSON.stringify(previous) !== JSON.stringify(row)) conflict = true;
      unique.set(row.accession, row);
    }
    require("duplicate accessions do not conflict", !conflict);
    const selected = [...unique.values()].filter(x => x.form === p.form && x.filing_date >= start && x.filing_date <= end)
      .sort((a, b) => b.filing_date.localeCompare(a.filing_date) || a.accession.localeCompare(b.accession));
    require("independent SEC count equals paid answer", Number.isInteger(answer.filing_count) && answer.filing_count === selected.length && v.payloadValue === selected.length);
    require("paid answer uses requested exact form", answer.form_type === p.form);
    if (answer.filings_detail !== undefined) {
      require("paid document links are an array", Array.isArray(answer.filings_detail));
      for (const item of answer.filings_detail as unknown[]) {
        const detail = obj(item);
        const row = selected.find(x => x.accession === detail.accession);
        const expected = row ? `https://www.sec.gov/Archives/edgar/data/${p.cik}/${row.accession.replace(/-/g, "")}/${row.primary_document}` : "";
        require("paid filing links agree with independently parsed SEC rows", !!row && detail.form === row.form && detail.filing_date === row.filing_date && detail.url === expected);
        row!.source_url = detail.url as string;
      }
    }
    out.observed_count = selected.length;
    out.rows = selected;
    out.status = selected.length >= p.minimum_count ? "SUPPORTED" : "NOT_SUPPORTED";
    out.reason = `SEC records show ${selected.length} exact ${p.form} filings with calendar filing dates in ${p.year}; analyst criterion was at least ${p.minimum_count}.`;
  } catch (error) {
    out.reason = error instanceof Error ? error.message : "Evidence replay failed";
    out.observed_count = null;
    out.rows = [];
  }
  return out;
}
export function researchMarkdown(p: ResearchPlan, hash: string, r: ResearchResult): string {
  const clean = (s: string) => s.replace(/[\r\n|<>]/g, " ").replace(/[\\`*_{}[\]()#!]/g, "\\$&");
  return [`# Filing-coverage research appendix`, ``, `Status: ${r.status}`, ``, clean(r.reason), ``,
    `Company: ${clean(r.source_name ?? "unverified")} (CIK ${p.cik})`, ``,
    `Policy: ${p.version}; SHA256 ${hash}; fixed ${p.created_at}`, ``,
    `Exact form ${p.form}, calendar filing year ${p.year}, minimum count ${p.minimum_count}.`, ``,
    `| Form | Filing date | SEC accession | Primary document |`, `|---|---|---|---|`,
    ...r.rows.map(x => `| ${clean(x.form)} | ${x.filing_date} | ${x.accession} | ${x.source_url ? `[${clean(x.primary_document)}](${x.source_url})` : clean(x.primary_document)} |`), ``,
    `SEC submissions source: https://data.sec.gov/submissions/CIK${p.cik.padStart(10, "0")}.json`, ``,
    `## Checks`, ...r.checks.filter(x => !x.ok).map(x => `- FAILED: ${x.name}`),
    `- ${r.checks.filter(x => x.ok).length}/${r.checks.length} checks passed.`, ``,
    `## Limits`, ...r.limits.map(x => `- ${x}`), ``,
    `No-Telegraph baseline: obtain the same SEC main/history files and count the exact form and calendar dates manually. No unmeasured time or money savings are claimed.`, ``].join("\n");
}
