import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = vi.hoisted(() => {
  const path = `/tmp/tvl-freshness-${process.pid}-${Date.now()}.sqlite`;
  process.env.SQLITE_PATH = path;
  delete process.env.DATABASE_URL;
  return path;
});
import { closeStorage, getReceiptEvidence, initStorage } from '../src/core/storage';
import { sha256Hex } from '../src/core/receipt';
import { buildServer } from '../src/server';
import {
  __awaitTvlBackgroundRefreshForTests, __awaitTvlProtocolFillForTests,
  __clearTvlCachesForTests, __seedTvlCachesForTests,
  __setTvlListsCacheDirForTests, __setTvlSeedEnabledForTests,
  handleTvl, parseChainReading, parseProtocolReading,
} from '../src/handlers/tvl';

// Genuine independently selected primary-source histories captured22Nov2026.
// Only the execution clock and primary503 outage are controlled. No TVL
// value or source observation date is invented or changed. The chain prefix
// is explicitly a subset of the captured history, not a claimed wire reply
// or a record of what the provider published on an earlier capture date.
const source = JSON.parse(readFileSync(join(__dirname, 'fixtures/tvl-freshness-real-sources.json'), 'utf8'));
const WEEK = 7 * 86400;
type Point = { date: number; tvl: number };
type ProtocolPoint = { date: number; totalLiquidityUSD: number };
const protocolHistory = source.protocol_payload.tvl as ProtocolPoint[];
const protocolPositive = protocolHistory.filter(p => p.totalLiquidityUSD > 0).slice(-1)[0];
const protocolLatest = protocolHistory[protocolHistory.length - 1];
const chainHistory = source.chain_history as Point[];
const chainPositive = chainHistory.filter(p => p.tvl > 0).slice(-1)[0];
const chainPrefix = chainHistory.filter(p => p.date <= chainPositive.date + WEEK);
const chainLatest = chainPrefix[chainPrefix.length - 1];
interface Scenario {
  name: string; query: string; positive: number; positiveDate: number;
  latestDate: number; payload: unknown; parse: () => { tvlUsd: number; asOf: string };
}
const scenarios: Scenario[] = [
  { name: 'protocol captured history', query: source.protocol_entry.slug,
    positive: protocolPositive.totalLiquidityUSD, positiveDate: protocolPositive.date,
    latestDate: protocolLatest.date, payload: source.protocol_payload,
    parse: () => parseProtocolReading(source.protocol_payload) },
  { name: 'chain captured-history prefix', query: source.chain_entry.name,
    positive: chainPositive.tvl, positiveDate: chainPositive.date,
    latestDate: chainLatest.date, payload: chainPrefix,
    parse: () => parseChainReading(chainPrefix) },
];
let cacheDir: string;
beforeAll(async () => { await initStorage(); });
beforeEach(() => {
  __clearTvlCachesForTests();
  cacheDir = mkdtempSync(join(tmpdir(), 'tvl-freshness-cache-'));
  __setTvlListsCacheDirForTests(cacheDir);
  __setTvlSeedEnabledForTests(false);
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(async () => {
  await __awaitTvlBackgroundRefreshForTests();
  await __awaitTvlProtocolFillForTests();
  __clearTvlCachesForTests();
  __setTvlListsCacheDirForTests(null);
  __setTvlSeedEnabledForTests(true);
  vi.useRealTimers();
  rmSync(cacheDir, { recursive: true, force: true });
});
afterAll(async () => {
  await closeStorage();
  for (const suffix of ['', '-wal', '-shm']) rmSync(scratch + suffix, { force: true });
});
const clock = (seconds: number, extraMs = 0) => vi.setSystemTime(new Date(seconds * 1000 + extraMs));
for (const item of scenarios) describe(item.name, () => {
  it('fixture keeps a real zero latest and an older real positive within its relative window', () => {
    expect(item.positive).toBeGreaterThan(0);
    expect(item.latestDate).toBeGreaterThan(item.positiveDate);
    expect(item.latestDate - item.positiveDate).toBeLessThanOrEqual(WEEK);
    clock(item.latestDate);
    expect(item.parse()).toMatchObject({ tvlUsd: item.positive,
      asOf: new Date(item.positiveDate * 1000).toISOString() });
  });
  it('retains a positive exactly seven days old from the execution clock', () => {
    clock(item.positiveDate + WEEK);
    expect(item.parse().tvlUsd).toBe(item.positive);
  });
  it('preserves the existing whole-second boundary through999ms', () => {
    clock(item.positiveDate + WEEK, 999);
    expect(item.parse().tvlUsd).toBe(item.positive);
  });
  it('does not return a positive seven days plus one second old as verified', () => {
    clock(item.positiveDate + WEEK + 1);
    expect(item.parse()).toMatchObject({ tvlUsd: 0,
      asOf: new Date(item.latestDate * 1000).toISOString() });
  });
  it('does not add a six-day latest age to the separate seven-day relative window', () => {
    clock(item.latestDate + 6 * 86400);
    expect(item.parse()).toMatchObject({ tvlUsd: 0,
      asOf: new Date(item.latestDate * 1000).toISOString() });
  });
  it('uses the genuine zero when the latest itself is exactly seven days old', () => {
    clock(item.latestDate + WEEK);
    expect(item.parse().tvlUsd).toBe(0);
  });
  it('still rejects when even the latest point is seven days plus one second old', () => {
    clock(item.latestDate + WEEK + 1);
    expect(item.parse).toThrowError(expect.objectContaining({ status: 502, code: 'DEFILLAMA_BAD_RESPONSE' }));
  });
  for (const [label, seconds, expected] of [
    ['in-bound positive', item.positiveDate + WEEK, item.positive],
    ['out-of-bound positive', item.positiveDate + WEEK + 1, 0],
    ['aged latest', item.latestDate + 6 * 86400, 0],
  ] as const) it(`handler ${label} pins chosen actual observation in real SQLite and local HTTP`, async () => {
    clock(seconds);
    __seedTvlCachesForTests([source.protocol_entry], [source.chain_entry]);
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async input => {
      const url = String(input); calls.push(url);
      if (url === `https://api.llama.fi/tvl/${source.protocol_entry.slug}`)
        return new Response('', { status: 503 }); // controlled primary outage only
      if (url === source.provenance.protocol_url && item.name.startsWith('protocol'))
        return new Response(JSON.stringify(item.payload), { status: 200 });
      if (url === source.provenance.chain_url && item.name.startsWith('chain'))
        return new Response(JSON.stringify(item.payload), { status: 200 });
      throw new Error('Unexpected source in offline freshness control');
    };
    const out = await handleTvl({ protocol: item.query }, { fetchImpl });
    expect(out.tvl_usd).toBe(expected);
    const asOf = new Date((expected > 0 ? item.positiveDate : item.latestDate) * 1000).toISOString();
    expect(out.as_of).toBe(asOf);
    expect(out.verdict).toBe('verified');
    const receipt = out.receipt as { receipt_id: string; raw_response_sha256: string };
    const stored = await getReceiptEvidence(receipt.receipt_id);
    expect(stored.found).toBe(true);
    const evidence = stored.evidence!;
    expect(sha256Hex(evidence)).toBe(receipt.raw_response_sha256);
    const pinned = JSON.parse(evidence.toString('utf8'));
    expect(pinned.reading.tvl_usd).toBe(expected);
    expect(pinned.reading.as_of).toBe(asOf);
    const app = buildServer();
    try {
      const meta = await app.inject({ method: 'GET', url: `/receipts/${receipt.receipt_id}` });
      expect(meta.statusCode).toBe(200);
      expect(meta.json()).toMatchObject({ receipt_id: receipt.receipt_id,
        evidence_available: true, raw_response_sha256: receipt.raw_response_sha256,
        evidence_bytes: evidence.length });
      const raw = await app.inject({ method: 'GET', url: `/receipts/${receipt.receipt_id}/raw` });
      expect(raw.statusCode).toBe(200);
      expect(raw.body).toBe(evidence.toString('utf8'));
      expect(raw.headers['x-raw-sha256']).toBe(receipt.raw_response_sha256);
    } finally { await app.close(); }
    expect(calls).toEqual(item.name.startsWith('protocol')
      ? [`https://api.llama.fi/tvl/${source.protocol_entry.slug}`, source.provenance.protocol_url]
      : [source.provenance.chain_url]);
  });
});
it('complete captured chain history still reports its genuine zero at capture time', () => {
  vi.setSystemTime(new Date(source.provenance.captured_at));
  expect(parseChainReading(chainHistory).tvlUsd).toBe(0);
});
it('complete captured protocol history retains the existing in-bound positive policy at capture time', () => {
  vi.setSystemTime(new Date(source.provenance.captured_at));
  expect(parseProtocolReading(source.protocol_payload).tvlUsd).toBe(protocolPositive.totalLiquidityUSD);
});
