// SECURITY_REVIEW_GENERAL: exact npm or PyPI package/version, or CVE/GHSA id, known-advisory lookup in OSV.
// Contract read 2026-11-23:
// https://devnode.telegraphprotocol.com/engine/v1/intents/SECURITY_REVIEW_GENERAL
// Source semantics: https://google.github.io/osv.dev/post-v1-query/
// Not a source-code audit, exploitability assessment or safety guarantee.
import { badRequest, unprocessable, upstreamUnavailable } from '../core/errors';
import { envelope, makeReceipt } from '../core/receipt';
import { saveReceipt } from '../core/storage';
import { PublicBodyCache, StartBudget } from '../core/publicSource';
const URL = 'https://api.osv.dev/v1/query';
let cache = new PublicBodyCache(64, 5 * 60_000);
let budget = new StartBudget(30, 60_000);
export function parsePackageTarget(target: string | undefined): { name: string; version: string } {
  const match = target && target.length <= 256 && /^(?:npm:)?((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(target);
  if (!match) throw badRequest('INVALID_TARGET', 'target must be an exact npm package@major.minor.patch; no URL, tag, version range or prerelease');
  return { name: match[1], version: `${match[2]}.${match[3]}.${match[4]}` };
}
type Obj = Record<string, any>;
const SEVERITY: Record<string, number> = { CRITICAL: 4, HIGH: 3, MODERATE: 2, MEDIUM: 2, LOW: 1 };
type Eco = 'npm' | 'PyPI';
const normName = (eco: Eco, n: string) => eco === 'PyPI' ? n.toLowerCase().replace(/[-_.]+/g, '-') : n;
function affectedRelease(affected: Obj, version: string, eco: Eco = 'npm'): boolean | null {
  if (Array.isArray(affected.versions) && affected.versions.includes(version)) return true;
  // PyPI: only plain dotted-numeric releases are compared locally; anything else stays an OSV-only match.
  if (eco === 'PyPI' && !/^\d+(\.\d+)*$/.test(version)) return Array.isArray(affected.versions) && affected.versions.length ? false : null;
  const value = version.split('.').map(BigInt);
  const compare = (bound: unknown): number => {
    if (bound === '0') return 1;
    if (typeof bound !== 'string') throw new Error('invalid version bound');
    if (eco === 'PyPI') {
      if (!/^\d+(\.\d+)*$/.test(bound)) throw new Error('unsupported version bound');
      const b = bound.split('.').map(BigInt);
      for (let i = 0; i < Math.max(b.length, value.length); i++) { const x = value[i] ?? 0n, y = b[i] ?? 0n; if (x !== y) return x > y ? 1 : -1; }
      return 0;
    }
    const m = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(bound);
    if (!m) throw new Error('unsupported version bound');
    for (let i=0;i<3;i++) { const b=BigInt(m[i+1] ?? '0'); if (value[i] !== b) return value[i] > b ? 1 : -1; }
    return m[4] ? 1 : 0;
  };
  let unsupported = false;
  for (const range of affected.ranges ?? []) {
    if (!(range.type === 'SEMVER' || (eco === 'PyPI' && range.type === 'ECOSYSTEM')) || !Array.isArray(range.events)) { unsupported = true; continue; }
    try {
      let introduced: unknown = undefined;
      for (const event of range.events) {
        if (event.introduced !== undefined) { introduced = event.introduced; continue; }
        const upper = event.fixed ?? event.last_affected ?? event.limit;
        if (upper === undefined || introduced === undefined) throw new Error('unsupported range event');
        const atUpper = compare(upper);
        if (compare(introduced) >= 0 && (event.last_affected !== undefined ? atUpper <= 0 : atUpper < 0)) return true;
        introduced = undefined;
      }
      if (introduced !== undefined && compare(introduced) >= 0) return true;
    } catch { unsupported = true; }
  }
  return unsupported ? null : false;
}
export function parsePackageAdvisories(raw: string, name: string, version?: string, eco: Eco = 'npm'): { id: string; severity: string; aliases: string[]; versionEvidence: string }[] {
  const d = JSON.parse(raw) as Obj;
  if (!d || typeof d !== 'object' || Array.isArray(d) || d.next_page_token)
    throw new Error('incomplete OSV response');
  if (!Object.hasOwn(d, 'vulns')) {
    if (Object.keys(d).length === 0) return [];
    throw new Error('malformed OSV response');
  }
  if (!Array.isArray(d.vulns)) throw new Error('malformed advisories');
  const records = new Map<string, { id: string; severity: string; aliases: string[]; versionEvidence: string }>();
  for (const v of d.vulns) {
    if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !/^(GHSA-[a-z0-9-]+|CVE-\d{4}-\d+|OSV-[A-Za-z0-9-]+|PYSEC-\d{4}-\d+)$/.test(v.id) ||
        !Array.isArray(v.affected) || !v.affected.some((a: Obj) => a?.package?.ecosystem === eco && typeof a.package.name === 'string' && normName(eco, a.package.name) === normName(eco, name)))
      throw new Error('advisory package identity mismatch');
    if (v.withdrawn) continue;
    let versionEvidence = 'OSV query match';
    if (version) {
      const coverage = v.affected.filter((a: Obj) => a?.package?.ecosystem === eco && typeof a.package.name === 'string' && normName(eco, a.package.name) === normName(eco, name))
        .map((a: Obj) => affectedRelease(a, version, eco));
      if (coverage.includes(true)) versionEvidence = 'locally confirmed version range';
      else if (coverage.includes(null)) versionEvidence = 'OSV matched this version; local range interpretation unavailable';
      else throw new Error('advisory does not explicitly cover requested release');
    }
    const published = Date.parse(v.published), modified = Date.parse(v.modified);
    if (!Number.isFinite(published) || !Number.isFinite(modified) || published > Date.now() + 300_000 || modified > Date.now() + 300_000)
      throw new Error('invalid advisory publication time');
    const severity = typeof v.database_specific?.severity === 'string' ? v.database_specific.severity.toUpperCase() : 'UNSPECIFIED';
    const aliases = Array.isArray(v.aliases) ? v.aliases.filter((x: unknown): x is string => typeof x === 'string' && /^(CVE-\d{4}-\d+|GHSA-[a-z0-9-]+)$/.test(x)) : [];
    records.set(v.id, { id: v.id, severity, aliases, versionEvidence });
  }
  return [...records.values()].sort((a,b) => (SEVERITY[b.severity] ?? 0) - (SEVERITY[a.severity] ?? 0) || a.id.localeCompare(b.id));
}
export type TargetShape = 'npm' | 'pypi' | 'cve' | 'ghsa' | 'url' | 'other';
export type SecurityTarget =
  | { kind: 'package'; ecosystems: Eco[]; name: string; version: string; shape: 'npm' | 'pypi' | 'other' }
  | { kind: 'id'; id: string; shape: 'cve' | 'ghsa' }
  | { kind: 'unsupported'; shape: 'url' | 'other'; label?: string };
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const PYPI_VERSION = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))*(?:(?:a|b|rc)(0|[1-9]\d*))?(?:\.post(0|[1-9]\d*))?(?:\.dev(0|[1-9]\d*))?$/;
const NPM_PREFIX = /^npm:/i, PYPI_PREFIX = /^(?:pip|pypi):/i;
/** Classify without logging or echoing the value. Malformed input in a covered ecosystem stays a 400. */
export function parseSecurityTarget(target: string | undefined): SecurityTarget {
  const bad = () => badRequest('INVALID_TARGET', 'target must be npm:name@x.y.z, pip:name@version, PyPI:name@version, name@x.y.z, or a CVE-/GHSA- id');
  if (!target || target.length > 256 || target !== target.trim()) throw bad();
  const cve = /^CVE-(\d{4})-(\d{4,19})$/i.exec(target);
  if (cve) return { kind: 'id', id: `CVE-${cve[1]}-${cve[2]}`, shape: 'cve' };
  const ghsa = /^GHSA-([23456789cfghjmpqrvwx]{4})-([23456789cfghjmpqrvwx]{4})-([23456789cfghjmpqrvwx]{4})$/i.exec(target);
  if (ghsa) return { kind: 'id', id: `GHSA-${ghsa[1]}-${ghsa[2]}-${ghsa[3]}`.toLowerCase().replace('ghsa-', 'GHSA-'), shape: 'ghsa' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^www\./i.test(target)) return { kind: 'unsupported', shape: 'url' };
  if (NPM_PREFIX.test(target)) { const p = parsePackageTarget(target); return { kind: 'package', ecosystems: ['npm'], ...p, shape: 'npm' }; }
  if (PYPI_PREFIX.test(target)) {
    const m = /^[^:]+:([^@]+)@([^@]+)$/.exec(target);
    if (!m || !PYPI_NAME.test(m[1]) || !PYPI_VERSION.test(m[2])) throw bad();
    return { kind: 'package', ecosystems: ['PyPI'], name: m[1], version: m[2], shape: 'pypi' };
  }
  const eco = /^([a-z][a-z0-9+._-]{0,30}):[^@\s]+@\S+$/i.exec(target);
  if (eco) return { kind: 'unsupported', shape: 'other', label: eco[1].toLowerCase() };
  const m = /^([^@]+)@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(target);
  if (!m) throw bad();
  const version = `${m[2]}.${m[3]}.${m[4]}`;
  const ecosystems: Eco[] = [];
  if (/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(m[1])) ecosystems.push('npm');
  if (PYPI_NAME.test(m[1])) ecosystems.push('PyPI');
  if (!ecosystems.length) throw bad();
  return { kind: 'package', ecosystems, name: m[1], version, shape: 'other' };
}
const QUERY_URL = URL;
const VULN_URL = 'https://api.osv.dev/v1/vulns/';
async function fetchOsv(url: string, init: RequestInit, allow404 = false): Promise<{ url: string; raw: string; fetchedAt: string; status: number }> {
  if (!budget.take()) throw new Error('OSV source rate budget exhausted');
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 4000);
  try {
    const r = await fetch(url, { ...init, redirect: 'error', signal: abort.signal,
      headers: { accept: 'application/json', 'user-agent': 'VeriReceipt/2.0 package advisory observer', ...(init.method === 'POST' ? { 'content-type': 'application/json' } : {}) } });
    if (!r.ok && !(allow404 && r.status === 404)) throw new Error(`OSV HTTP ${r.status}`);
    const reader = r.body?.getReader(); if (!reader) throw new Error('OSV body missing');
    const parts: Uint8Array[] = []; let bytes = 0;
    try { while (true) { const p = await reader.read(); if (p.done) break; bytes += p.value.byteLength;
      if (bytes > 1_000_000) { await reader.cancel(); throw new Error('OSV body limit'); } parts.push(p.value); }
    } finally { reader.releaseLock(); }
    return { url, raw: Buffer.concat(parts).toString('utf8'), fetchedAt: new Date().toISOString(), status: r.status };
  } finally { clearTimeout(timer); }
}
async function query(name: string, version: string, eco: Eco = 'npm') {
  const o = await fetchOsv(QUERY_URL, { method: 'POST', body: JSON.stringify({ package: { name, ecosystem: eco }, version }) });
  parsePackageAdvisories(o.raw, name, version, eco);
  return { url: QUERY_URL, raw: o.raw, fetchedAt: o.fetchedAt };
}
export interface VulnRecord { id: string; aliases: string[]; severity: string; cvss: string[]; packages: string[]; references: string[]; summary: string | null; published: string | null; modified: string | null; withdrawn: boolean }
/** Parse an OSV /v1/vulns/{id} body; refuses a record that is not the requested id or one of its aliases. */
export function parseVulnRecord(raw: string, requested: string): VulnRecord {
  const v = JSON.parse(raw) as Obj;
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.id !== 'string') throw new Error('malformed OSV vulnerability');
  const aliases = Array.isArray(v.aliases) ? v.aliases.filter((x: unknown): x is string => typeof x === 'string' && /^(CVE-\d{4}-\d+|GHSA-[a-z0-9-]+|PYSEC-\d{4}-\d+|OSV-[A-Za-z0-9-]+)$/.test(x)) : [];
  if (!/^(GHSA-[a-z0-9-]+|CVE-\d{4}-\d+|OSV-[A-Za-z0-9-]+|PYSEC-\d{4}-\d+)$/.test(v.id)) throw new Error('unexpected OSV id');
  if (v.id.toUpperCase() !== requested.toUpperCase() && !aliases.some(a => a.toUpperCase() === requested.toUpperCase())) throw new Error('OSV record identity mismatch');
  const packages = [...new Set((Array.isArray(v.affected) ? v.affected : []).map((a: Obj) => typeof a?.package?.name === 'string' && typeof a.package.ecosystem === 'string' ? `${a.package.ecosystem}:${a.package.name}` : '').filter(Boolean))] as string[];
  const cvss = (Array.isArray(v.severity) ? v.severity : []).filter((s: Obj) => typeof s?.type === 'string' && typeof s.score === 'string').map((s: Obj) => `${s.type}: ${s.score}`);
  const references = [...new Set((Array.isArray(v.references) ? v.references : []).map((r: Obj) => r?.url).filter((u: unknown): u is string => typeof u === 'string' && /^https?:\/\//.test(u)))].slice(0, 20) as string[];
  const label = typeof v.database_specific?.severity === 'string' ? v.database_specific.severity.toUpperCase() : 'UNSPECIFIED';
  return { id: v.id, aliases, severity: label, cvss, packages, references, summary: typeof v.summary === 'string' ? v.summary.slice(0, 300) : null,
    published: typeof v.published === 'string' ? v.published : null, modified: typeof v.modified === 'string' ? v.modified : null, withdrawn: !!v.withdrawn };
}
let idCache = new PublicBodyCache(64, 5 * 60_000);
export function resetPackageSecurityForTests(): void { cache = new PublicBodyCache(64, 5 * 60_000); idCache = new PublicBodyCache(64, 5 * 60_000); budget = new StartBudget(30, 60_000); }
async function persist(receipt: ReturnType<typeof makeReceipt>, evidence: string) {
  try { await saveReceipt(receipt, evidence); }
  catch { throw upstreamUnavailable('RECEIPT_PERSIST_FAILED', 'receipt evidence could not be stored; answer unavailable'); }
}
const NOT_AUDIT = 'This is a known-advisory lookup, not a source-code audit, exploitability assessment or complete security review.';
async function handleUnsupported(t: Extract<SecurityTarget, { kind: 'unsupported' }>): Promise<Record<string, unknown>> {
  const now = new Date().toISOString();
  const what = t.shape === 'url' ? 'URL targets' : `the ${t.label ?? 'requested'} ecosystem`;
  const summary = `Ecosystem not covered: ${what} cannot be checked here. Covered: npm and PyPI name@exact-version, and CVE-/GHSA- ids, all via OSV. No advisory lookup ran, so the vulnerability count is unknown, not zero, and nothing here says the target is secure. ${NOT_AUDIT}`;
  const evidence = JSON.stringify({ kind: 'not_covered', target_shape: t.shape, ecosystem_label: t.label ?? null, lookup_performed: false, checked_at: now,
    scope: 'No source was queried. Covered: npm and PyPI exact releases, CVE and GHSA ids.' });
  const receipt = makeReceipt('SECURITY_REVIEW_GENERAL', 'urn:verireceipt:local-not-covered', evidence, 'no lookup performed; target outside covered ecosystems'); receipt.fetched_at = now;
  await persist(receipt, evidence);
  return envelope('SECURITY_REVIEW_GENERAL', { target_shape: t.shape, ecosystem: t.label ?? null, vulnerability_count: null, issues: [], covered: false, summary, observed_at: now },
    receipt, { answer: summary, verdict: 'Inconclusive', confidence: 1, source: 'none queried; target outside covered ecosystems (npm, PyPI, CVE/GHSA ids)' });
}
async function handleIdLookup(t: Extract<SecurityTarget, { kind: 'id' }>): Promise<Record<string, unknown>> {
  let obs;
  try { obs = await idCache.get(t.id, async () => { const o = await fetchOsv(VULN_URL + encodeURIComponent(t.id), { method: 'GET' }, true);
    if (o.status !== 404) parseVulnRecord(o.raw, t.id); else { const j = JSON.parse(o.raw); if (j?.code !== 5) throw new Error('unexpected OSV 404'); }
    return { url: VULN_URL + t.id, raw: o.raw, fetchedAt: o.fetchedAt }; }); }
  catch { throw upstreamUnavailable('OSV_UNAVAILABLE', 'complete OSV vulnerability record unavailable'); }
  const source = VULN_URL + t.id;
  const found = typeof JSON.parse(obs.raw)?.id === 'string';
  const rec = found ? parseVulnRecord(obs.raw, t.id) : null;
  if (rec?.withdrawn) {
    const summary = `OSV marks ${rec.id} as withdrawn, so it is not an active advisory. The vulnerability count is unknown, not zero. ${NOT_AUDIT}`;
    const evidence = JSON.stringify({ target: t.id, source_url: source, fetched_at: obs.fetchedAt, withdrawn: true, source_raw_body: obs.raw });
    const receipt = makeReceipt('SECURITY_REVIEW_GENERAL', source, evidence, 'OSV id lookup; withdrawn record'); receipt.fetched_at = obs.fetchedAt; await persist(receipt, evidence);
    return envelope('SECURITY_REVIEW_GENERAL', { target: t.id, target_shape: t.shape, vulnerability_count: null, issues: [], summary, observed_at: obs.fetchedAt }, receipt,
      { answer: summary, verdict: 'Inconclusive', confidence: 0.85, source: `${source}; retrieved ${obs.fetchedAt}` });
  }
  const evidence = JSON.stringify({ target: t.id, request: { method: 'GET', path: `/v1/vulns/${t.id}` }, source_url: source, fetched_at: obs.fetchedAt, found, record: rec, source_raw_body: obs.raw,
    scope: 'OSV lookup by id; one database; absence from OSV is not proof the id is harmless' });
  const receipt = makeReceipt('SECURITY_REVIEW_GENERAL', source, evidence, 'OSV single database, lookup by advisory id'); receipt.fetched_at = obs.fetchedAt;
  await persist(receipt, evidence);
  if (!rec) {
    const summary = `OSV has no record for ${t.id}. The vulnerability count is unknown, not zero: absence from one database is not proof the id is harmless or that it does not exist elsewhere. ${NOT_AUDIT}`;
    return envelope('SECURITY_REVIEW_GENERAL', { target: t.id, target_shape: t.shape, vulnerability_count: null, issues: [], summary, observed_at: obs.fetchedAt }, receipt,
      { answer: summary, verdict: 'Inconclusive', confidence: 0.85, source: `${source}; retrieved ${obs.fetchedAt}` });
  }
  const sev = rec.cvss.length ? `${rec.severity}; ${rec.cvss.join('; ')}` : rec.severity;
  const summary = `OSV record ${rec.id}${rec.aliases.length ? ` (aliases ${rec.aliases.join(', ')})` : ''}: severity ${sev}; affects ${rec.packages.length ? rec.packages.join(', ') : 'no package named in OSV'}.${rec.summary ? ` ${rec.summary}` : ''} Whether your code is exposed depends on the version and usage. ${NOT_AUDIT}`;
  return envelope('SECURITY_REVIEW_GENERAL', { target: t.id, target_shape: t.shape, vulnerability_count: 1,
    issues: [`${rec.id}${rec.aliases.length ? ` (${rec.aliases.join(', ')})` : ''}; severity ${sev}`],
    aliases: rec.aliases, affected_packages: rec.packages, severity_scores: rec.cvss, references: rec.references, published: rec.published, modified: rec.modified,
    summary, observed_at: obs.fetchedAt }, receipt,
    { answer: `${summary} Needs changes: review the advisory and fixed versions.`, verdict: 'Needs changes', confidence: 0.85,
      source: `${source}; lookup by id; retrieved ${obs.fetchedAt}; cached at most 5 minutes; not a safety guarantee` });
}
async function observePackage(eco: Eco, name: string, version: string) {
  try { return await cache.get(`${eco}:${name}@${version}`, () => query(name, version, eco)); }
  catch { throw upstreamUnavailable('OSV_UNAVAILABLE', 'complete identity-matching package advisory evidence unavailable'); }
}
export function targetShapeOf(target: unknown): TargetShape {
  try { if (typeof target !== 'string') return 'other'; const t = parseSecurityTarget(target);
    return t.kind === 'package' ? (t.shape === 'other' ? 'other' : t.shape) : t.kind === 'id' ? t.shape : t.shape; } catch { return 'other'; }
}
export async function handlePackageSecurity(q: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const t = parseSecurityTarget(q.target);
  if (t.kind === 'unsupported') return handleUnsupported(t);
  if (t.kind === 'id') return handleIdLookup(t);
  let eco: Eco | undefined, observation, advisories: ReturnType<typeof parsePackageAdvisories> = [];
  for (const candidate of t.ecosystems) {
    observation = await observePackage(candidate, t.name, t.version);
    advisories = parsePackageAdvisories(observation.raw, t.name, t.version, candidate);
    if (advisories.length) { eco = candidate; break; }
  }
  if (!advisories.length || !eco || !observation) throw unprocessable('NO_ADVISORY_COVERAGE', `OSV returned no active matching advisories${t.ecosystems.length > 1 ? ' in npm or PyPI' : ''}; absence is not proof of security and no Secure verdict is issued`);
  const target = `${t.name}@${t.version}`;
  const fallbackCount = advisories.filter(a => a.versionEvidence.includes('unavailable')).length;
  const fallbackDisclosure = fallbackCount ? ` For ${fallbackCount} record(s), OSV matched this version but local range interpretation is unavailable.` : '';
  const summary = `OSV reports ${advisories.length} active known advisory record(s) for ${eco} ${target}. This is a package-version advisory lookup, not a source-code audit, exploitability assessment or complete security review.${fallbackDisclosure}`;
  const evidence = JSON.stringify({ target, request: { package: { name: t.name, ecosystem: eco }, version: t.version }, source_url: URL,
    ecosystems_tried: t.ecosystems.slice(0, t.ecosystems.indexOf(eco) + 1), fetched_at: observation.fetchedAt, advisories, source_raw_body: observation.raw,
    scope: `OSV query membership for exact ${eco} package/version; count is unique active OSV record IDs, not alias count or distinct root-cause count; no transitive dependency scan` });
  const receipt = makeReceipt('SECURITY_REVIEW_GENERAL', URL, evidence, `OSV single database, exact ${eco} package/version; known-advisory coverage only`);
  receipt.fetched_at = observation.fetchedAt;
  await persist(receipt, evidence);
  return envelope('SECURITY_REVIEW_GENERAL', { target, ecosystem: eco, vulnerability_count: advisories.length,
    issues: advisories.map(a => `${a.id}${a.aliases.length ? ` (${a.aliases.join(', ')})` : ''}; severity ${a.severity}; ${a.versionEvidence}`), summary,
    observed_at: observation.fetchedAt }, receipt, { answer: `${summary} Needs changes: review the listed advisories and applicable fixes.`,
      verdict: 'Needs changes', confidence: 0.85, source: `${URL}; exact ${eco} package/version; retrieved ${observation.fetchedAt}; cached at most 5 minutes; advisory count is not a safety guarantee` });
}
