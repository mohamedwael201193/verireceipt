// SECURITY_REVIEW_GENERAL: exact npm package/version known-advisory scan.
// Contract read 2026-11-23:
// https://devnode.telegraphprotocol.com/engine/v1/intents/SECURITY_REVIEW_GENERAL
// Source semantics: https://google.github.io/osv.dev/post-v1-query/
// Not a source-code audit, exploitability assessment or safety guarantee.
import { badRequest, unprocessable, upstreamUnavailable } from '../core/errors';
import { envelope, makeReceipt } from '../core/receipt';
import { saveReceipt } from '../core/storage';
import { PublicBodyCache, StartBudget } from '../core/publicSource';
const URL = 'https://api.osv.dev/v1/query';
const cache = new PublicBodyCache(64, 5 * 60_000);
const budget = new StartBudget(30, 60_000);
export function parsePackageTarget(target: string | undefined): { name: string; version: string } {
  const match = target && target.length <= 256 && /^(?:npm:)?((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(target);
  if (!match) throw badRequest('INVALID_TARGET', 'target must be an exact npm package@major.minor.patch; no URL, tag, version range or prerelease');
  return { name: match[1], version: `${match[2]}.${match[3]}.${match[4]}` };
}
type Obj = Record<string, any>;
const SEVERITY: Record<string, number> = { CRITICAL: 4, HIGH: 3, MODERATE: 2, MEDIUM: 2, LOW: 1 };
function affectedRelease(affected: Obj, version: string): boolean {
  if (Array.isArray(affected.versions) && affected.versions.includes(version)) return true;
  const value = version.split('.').map(BigInt);
  const compare = (bound: unknown): number => {
    if (bound === '0') return 1;
    if (typeof bound !== 'string') throw new Error('invalid version bound');
    const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(bound);
    if (!m) throw new Error('unsupported version bound');
    for (let i=0;i<3;i++) { const b=BigInt(m[i+1]); if (value[i] !== b) return value[i] > b ? 1 : -1; }
    return m[4] ? 1 : 0; // stable release follows any prerelease at the same triple
  };
  for (const range of affected.ranges ?? []) {
    if (range.type !== 'SEMVER' || !Array.isArray(range.events)) continue;
    let active = false;
    for (const event of range.events) {
      if (event.introduced !== undefined) active = compare(event.introduced) >= 0;
      else if (event.fixed !== undefined && compare(event.fixed) >= 0) active = false;
      else if (event.last_affected !== undefined && compare(event.last_affected) > 0) active = false;
      else if (event.limit !== undefined && compare(event.limit) >= 0) active = false;
      else if (!['fixed','last_affected','limit'].some(k => event[k] !== undefined)) throw new Error('unsupported range event');
    }
    if (active) return true;
  }
  return false;
}
export function parsePackageAdvisories(raw: string, name: string, version?: string): { id: string; severity: string; aliases: string[] }[] {
  const d = JSON.parse(raw) as Obj;
  if (!d || typeof d !== 'object' || Array.isArray(d) || d.next_page_token)
    throw new Error('incomplete OSV response');
  if (!Object.hasOwn(d, 'vulns')) {
    if (Object.keys(d).length === 0) return [];
    throw new Error('malformed OSV response');
  }
  if (!Array.isArray(d.vulns)) throw new Error('malformed advisories');
  const records = new Map<string, { id: string; severity: string; aliases: string[] }>();
  for (const v of d.vulns) {
    if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !/^(GHSA-[a-z0-9-]+|CVE-\d{4}-\d+|OSV-[A-Za-z0-9-]+)$/.test(v.id) ||
        !Array.isArray(v.affected) || !v.affected.some((a: Obj) => a?.package?.ecosystem === 'npm' && a.package.name === name))
      throw new Error('advisory package identity mismatch');
    if (v.withdrawn) continue;
    if (version && !v.affected.some((a: Obj) => a?.package?.ecosystem === 'npm' && a.package.name === name && affectedRelease(a, version)))
      throw new Error('advisory does not explicitly cover requested release');
    const published = Date.parse(v.published), modified = Date.parse(v.modified);
    if (!Number.isFinite(published) || !Number.isFinite(modified) || modified < published || published > Date.now() + 300_000 || modified > Date.now() + 300_000)
      throw new Error('invalid advisory publication time');
    const severity = typeof v.database_specific?.severity === 'string' ? v.database_specific.severity.toUpperCase() : 'UNSPECIFIED';
    const aliases = Array.isArray(v.aliases) ? v.aliases.filter((x: unknown): x is string => typeof x === 'string' && /^(CVE-\d{4}-\d+|GHSA-[a-z0-9-]+)$/.test(x)) : [];
    records.set(v.id, { id: v.id, severity, aliases });
  }
  return [...records.values()].sort((a,b) => (SEVERITY[b.severity] ?? 0) - (SEVERITY[a.severity] ?? 0) || a.id.localeCompare(b.id));
}
async function query(name: string, version: string) {
  if (!budget.take()) throw new Error('OSV source rate budget exhausted');
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 4000);
  try {
    const r = await fetch(URL, { method: 'POST', redirect: 'error', signal: abort.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'VeriReceipt/2.0 package advisory observer' },
      body: JSON.stringify({ package: { name, ecosystem: 'npm' }, version }) });
    if (!r.ok) throw new Error(`OSV HTTP ${r.status}`);
    const reader = r.body?.getReader(); if (!reader) throw new Error('OSV body missing');
    const parts: Uint8Array[] = []; let bytes = 0;
    try { while (true) { const p = await reader.read(); if (p.done) break; bytes += p.value.byteLength;
      if (bytes > 1_000_000) { await reader.cancel(); throw new Error('OSV body limit'); } parts.push(p.value); }
    } finally { reader.releaseLock(); }
    const raw = Buffer.concat(parts).toString('utf8');
    parsePackageAdvisories(raw, name, version);
    return { url: URL, raw, fetchedAt: new Date().toISOString() };
  } finally { clearTimeout(timer); }
}
export async function handlePackageSecurity(q: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const { name, version } = parsePackageTarget(q.target);
  let observation;
  try { observation = await cache.get(`${name}@${version}`, () => query(name, version)); }
  catch { throw upstreamUnavailable('OSV_UNAVAILABLE', 'complete identity-matching package advisory evidence unavailable'); }
  const advisories = parsePackageAdvisories(observation.raw, name, version);
  if (!advisories.length) throw unprocessable('NO_ADVISORY_COVERAGE', 'OSV returned no active matching advisories; absence is not proof of security and no Secure verdict is issued');
  const target = `${name}@${version}`;
  const summary = `OSV reports ${advisories.length} active known advisory record(s) for npm ${target}. This is a package-version advisory lookup, not a source-code audit, exploitability assessment or complete security review.`;
  const evidence = JSON.stringify({ target, request: { package: { name, ecosystem: 'npm' }, version }, source_url: URL,
    fetched_at: observation.fetchedAt, advisories, source_raw_body: observation.raw,
    scope: 'OSV query membership for exact npm package/version; count is unique active OSV record IDs, not alias count or distinct root-cause count; no transitive dependency scan' });
  const receipt = makeReceipt('SECURITY_REVIEW_GENERAL', URL, evidence, 'OSV single database, exact package/version; known-advisory coverage only');
  receipt.fetched_at = observation.fetchedAt;
  try { await saveReceipt(receipt, evidence); }
  catch { throw upstreamUnavailable('RECEIPT_PERSIST_FAILED', 'receipt evidence could not be stored; answer unavailable'); }
  return envelope('SECURITY_REVIEW_GENERAL', { target, vulnerability_count: advisories.length,
    issues: advisories.map(a => `${a.id}${a.aliases.length ? ` (${a.aliases.join(', ')})` : ''}; severity ${a.severity}`), summary,
    observed_at: observation.fetchedAt }, receipt, { answer: `${summary} Needs changes: review the listed advisories and applicable fixes.`,
      verdict: 'Needs changes', confidence: 0.85, source: `${URL}; exact npm package/version; retrieved ${observation.fetchedAt}; cached at most 5 minutes; advisory count is not a safety guarantee` });
}
