import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = vi.hoisted(() => {
  const path = `/tmp/tvl-chain-scope-${process.pid}-${Date.now()}.sqlite`;
  process.env.SQLITE_PATH = path;
  delete process.env.DATABASE_URL;
  return path;
});
import { initStorage, closeStorage, getReceiptEvidence } from '../src/core/storage';
import { sha256Hex } from '../src/core/receipt';
import { buildServer } from '../src/server';
import {
  dominantChainTvl, handleTvl, __clearTvlCachesForTests, __seedTvlCachesForTests,
  __setTvlListsCacheDirForTests, __setTvlSeedEnabledForTests,
  __awaitTvlBackgroundRefreshForTests, __awaitTvlProtocolFillForTests,
} from '../src/handlers/tvl';

// Fresh independently selected publisher data, all source values/dates intact.
// Maps isolated below are explicit projections of existing captured keys,
// not claims that the publisher served those projections as full payloads.
// Handler transport is offline over actual captured bodies/parser fields.
// Only an explicitly marked primary503 fault and capture-time clock are controlled.
const source = JSON.parse(readFileSync(join(__dirname, 'fixtures/tvl-chain-scope-real-sources.json'), 'utf8'));
interface Entry { slug: string; name: string; chains: string[]; chainTvls: Record<string, number>; }
const entries = source.metric_catalogs as Entry[];
const family = source.parent_family.children as Entry[];
function namedOnly(entry: Entry): Record<string, number> {
  return Object.fromEntries(Object.entries(entry.chainTvls).filter(([key]) => entry.chains.includes(key)));
}
function nonNamedOnly(entry: Entry): Record<string, number> {
  return Object.fromEntries(Object.entries(entry.chainTvls).filter(([key]) => !entry.chains.includes(key)));
}
function expectedNamed(map: Record<string, number>, names: string[]): number | null {
  const values = Object.entries(map).filter(([key, value]) => names.includes(key) && Number.isFinite(value) && value > 0).map(([, value]) => value);
  return values.length ? Math.max(...values) : null;
}
for (const entry of entries) describe(`captured catalog ${entry.slug}`, () => {
  it('does not promote staking or pool2 above genuine named-chain TVL', () => {
    expect(dominantChainTvl(entry.chainTvls)).toBe(expectedNamed(entry.chainTvls, entry.chains));
  });
  it('retains the same named-chain answer when source object order is reversed', () => {
    expect(dominantChainTvl(Object.fromEntries(Object.entries(entry.chainTvls).reverse())))
      .toBe(expectedNamed(entry.chainTvls, entry.chains));
  });
  it('keeps the genuine named-chain-only projection unchanged', () => {
    expect(dominantChainTvl(namedOnly(entry))).toBe(expectedNamed(entry.chainTvls, entry.chains));
  });
  it('returns unknown for the isolated source non-chain-metric projection', () => {
    expect(Object.keys(nonNamedOnly(entry)).length).toBeGreaterThan(0);
    expect(dominantChainTvl(nonNamedOnly(entry))).toBeNull();
  });
});
for (const entry of family) it(`keeps healthy family child ${entry.slug} scoped to its own largest chain`, () => {
  expect(dominantChainTvl(entry.chainTvls)).toBe(expectedNamed(entry.chainTvls, entry.chains));
});
let cacheDir: string;
beforeAll(async () => { await initStorage(); });
beforeEach(() => {
  __clearTvlCachesForTests();
  cacheDir = mkdtempSync(join(tmpdir(), 'tvl-chain-scope-cache-'));
  __setTvlListsCacheDirForTests(cacheDir); __setTvlSeedEnabledForTests(false);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(source.provenance.protocol_capture));
});
afterEach(async () => {
  await __awaitTvlBackgroundRefreshForTests(); await __awaitTvlProtocolFillForTests();
  __clearTvlCachesForTests(); __setTvlListsCacheDirForTests(null); __setTvlSeedEnabledForTests(true);
  vi.useRealTimers(); rmSync(cacheDir, { recursive: true, force: true });
});
afterAll(async () => {
  await closeStorage(); for (const suffix of ['', '-wal', '-shm']) rmSync(scratch + suffix, { force: true });
});
async function verifyStored(out: Record<string, unknown>, principal: number, context: number | null) {
  expect(out.tvl_usd).toBe(principal); expect(out.chain_tvl_usd).toBe(context); expect(out.verdict).toBe('verified');
  const receipt = out.receipt as { receipt_id: string; raw_response_sha256: string };
  const stored = await getReceiptEvidence(receipt.receipt_id); expect(stored.found).toBe(true);
  const bytes = stored.evidence!; expect(sha256Hex(bytes)).toBe(receipt.raw_response_sha256);
  const pinned = JSON.parse(bytes.toString('utf8')); expect(pinned.reading.tvl_usd).toBe(principal);
  if (pinned.protocol) expect(pinned.reading.chain_tvl_usd).toBe(context);
  const app = buildServer();
  try {
    const meta = await app.inject({ method: 'GET', url: `/receipts/${receipt.receipt_id}` });
    expect(meta.statusCode).toBe(200); expect(meta.json()).toMatchObject({ receipt_id: receipt.receipt_id,
      evidence_available: true, evidence_bytes: bytes.length, raw_response_sha256: receipt.raw_response_sha256 });
    const raw = await app.inject({ method: 'GET', url: `/receipts/${receipt.receipt_id}/raw` });
    expect(raw.statusCode).toBe(200); expect(raw.body).toBe(bytes.toString('utf8'));
    expect(raw.headers['x-raw-sha256']).toBe(receipt.raw_response_sha256);
  } finally { await app.close(); }
  return pinned;
}
function seed() { __seedTvlCachesForTests([...entries, ...family], source.chain_catalog_entries); }
for (const mode of ['primary', 'fallback', 'fallback-then-primary'] as const) it(`${mode}: principal and real SQLite/local HTTP evidence keep metrics out of chain context`, async () => {
  seed(); const entry = entries[0], captured = source.primary_records['metric-bucket-context'];
  const payload = source.protocol_payloads[entry.slug]; let inject503 = mode !== 'primary';
  const fetchImpl: typeof fetch = async input => {
    const url = String(input);
    if (url === captured.evidence_upstream_url) return inject503
      ? new Response('', { status: 503 }) // controlled fault, not a source observation
      : new Response(captured.raw_body, { status: 200 });
    if (url === `https://api.llama.fi/protocol/${entry.slug}`) return new Response(JSON.stringify(payload), { status: 200 });
    throw new Error('Unexpected source in offline captured-data control');
  };
  const first = await handleTvl(captured.query, { fetchImpl });
  const latest = payload.tvl[payload.tvl.length - 1]; expect(latest.totalLiquidityUSD).toBeGreaterThan(0);
  const principal = mode === 'primary' ? JSON.parse(captured.raw_body) : latest.totalLiquidityUSD;
  const map = mode === 'primary' ? entry.chainTvls : payload.currentChainTvls;
  const names = mode === 'primary' ? entry.chains : payload.chains;
  await verifyStored(first, principal, expectedNamed(map, names));
  if (mode !== 'primary') expect(first.as_of).toBe(new Date(latest.date * 1000).toISOString());
  if (mode === 'fallback-then-primary') {
    inject503 = false;
    const next = await handleTvl(captured.query, { fetchImpl });
    await verifyStored(next, JSON.parse(captured.raw_body), expectedNamed(payload.currentChainTvls, payload.chains));
  }
});
for (const kind of ['parent-aggregate', 'version-specific', 'named-chain'] as const) it(`${kind}: keeps the captured principal identity, amount and receipt intact`, async () => {
  seed(); const chain = kind === 'named-chain', record = chain ? source.chain_record : source.primary_records[kind];
  const fetchImpl: typeof fetch = async input => {
    const url = String(input);
    if (url === record.evidence_upstream_url || url === record.upstream_url)
      return new Response(chain ? JSON.stringify(source.chain_history) : record.raw_body, { status: 200 });
    if (url === `https://api.llama.fi/protocol/${source.parent_family.parent_id.slice('parent#'.length)}`)
      return new Response(JSON.stringify(source.parent_payload), { status: 200 });
    throw new Error('Unexpected source in healthy captured-scope control');
  };
  const out = await handleTvl(record.query, { fetchImpl });
  const version = family.find(p => p.slug === record.target.slug);
  const context = chain ? record.expected_principal : version ? expectedNamed(version.chainTvls, version.chains) : null;
  const pinned = await verifyStored(out, record.expected_principal, context);
  expect(out.protocol_or_chain).toBe(record.target.slug ?? record.target.chain);
  if (kind === 'parent-aggregate') expect(pinned.resolution.parent_id).toBe(source.parent_family.parent_id);
});
