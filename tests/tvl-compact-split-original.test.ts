import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = vi.hoisted(() => {
  const path = `/tmp/tvl-compact-split-${process.pid}-${Date.now()}.sqlite`;
  process.env.SQLITE_PATH = path;
  delete process.env.DATABASE_URL;
  return path;
});
import { closeStorage, getReceiptEvidence, initStorage } from '../src/core/storage';
import { sha256Hex } from '../src/core/receipt';
import {
  __awaitTvlBackgroundRefreshForTests, __awaitTvlProtocolFillForTests,
  __clearTvlCachesForTests, __fetchTvlTextForTests, __getTvlChainSplitForTests,
  __seedTvlCachesForTests, __setTvlListsCacheDirForTests, __setTvlSeedEnabledForTests,
  handleTvl, stripProtocolEntries, warmLists,
} from '../src/handlers/tvl';

// Original restart controls, frozen before the handler edit. All positive
// numbers below come from the dated ordinary-source projection. Transports
// replay projections locally, not claimed wire replies or current observations.
// Corruption/time/byte-limit cases are explicit local fault controls. No live
// network, production receipt write, protected example or other handler input.
interface Entry { slug: string; name: string; symbol: string; tvl: number; chainTvls: Record<string, number> }
const source = JSON.parse(readFileSync(join(__dirname, 'fixtures/tvl-compact-split-source.json'), 'utf8'));
const subjects = source.subjects as { entry: Entry; expected_chain_tvl_usd: number }[];
const entries = subjects.map(s => s.entry);
const PROTOCOLS = 'https://api.llama.fi/protocols';
const CHAINS = 'https://api.llama.fi/v2/chains';
// Only the existing validator's required chain identity is needed by these
// protocol-only controls. Its name is an actual key in both source records.
const chains = [{ name: 'Ethereum' }];
const HOUR = 3600000;
const NOW = Date.parse('2026-11-22T13:10:00Z');
let cacheDir: string;
const protocolPath = () => join(cacheDir, 'tvl-protocols.json');
function disk(): Record<string, any> { return JSON.parse(readFileSync(protocolPath(), 'utf8')); }
function persist(value: unknown) { writeFileSync(protocolPath(), JSON.stringify(value)); }
function metadata(at: number = NOW): Record<string, any> {
  return { version: 1, source: PROTOCOLS, fetched_at: at,
    values: subjects.map(s => [s.entry.slug, s.expected_chain_tvl_usd]) };
}
function transport(lists: boolean) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async input => {
    const url = String(input); calls.push(url);
    if (lists && url === PROTOCOLS) return new Response(JSON.stringify(entries));
    if (lists && url === CHAINS) return new Response(JSON.stringify(chains));
    const subject = subjects.find(s => url === `https://api.llama.fi/tvl/${s.entry.slug}`);
    if (subject) return new Response(JSON.stringify(subject.entry.tvl));
    // A failed optional fill must not erase a successful principal reading.
    if (subjects.some(s => url === `https://api.llama.fi/protocol/${s.entry.slug}`))
      return new Response('', { status: 503 });
    throw new Error('Unexpected source in isolated compact-split control');
  };
  return { fetchImpl, calls };
}
async function capture(at = NOW) {
  vi.setSystemTime(at);
  await warmLists({ fetchImpl: transport(true).fetchImpl });
  vi.setSystemTime(NOW);
}
async function assertReceipt(out: Record<string, unknown>, subject: typeof subjects[number], context: number | null) {
  expect(out.verdict).toBe('verified');
  expect(out.tvl_usd).toBe(subject.entry.tvl);
  expect(out.chain_tvl_usd).toBe(context);
  const receipt = out.receipt as { receipt_id: string; raw_response_sha256: string };
  const stored = await getReceiptEvidence(receipt.receipt_id);
  expect(stored.found).toBe(true);
  expect(sha256Hex(stored.evidence!)).toBe(receipt.raw_response_sha256);
  expect(JSON.parse(stored.evidence!.toString('utf8')).reading).toMatchObject({
    tvl_usd: subject.entry.tvl, chain_tvl_usd: context,
  });
}
beforeAll(async () => { await initStorage(); });
beforeEach(() => {
  __clearTvlCachesForTests();
  cacheDir = mkdtempSync(join(tmpdir(), 'tvl-compact-split-cache-'));
  __setTvlListsCacheDirForTests(cacheDir); __setTvlSeedEnabledForTests(false);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
});
afterEach(async () => {
  await __awaitTvlBackgroundRefreshForTests(); await __awaitTvlProtocolFillForTests();
  __clearTvlCachesForTests(); __setTvlListsCacheDirForTests(null); __setTvlSeedEnabledForTests(true);
  vi.useRealTimers(); rmSync(cacheDir, { recursive: true, force: true });
});
afterAll(async () => {
  await closeStorage();
  for (const suffix of ['', '-wal', '-shm']) rmSync(scratch + suffix, { force: true });
});

describe('ordinary-source compact split persistence', () => {
  it('writes a versioned exact-source snapshot bound to the same catalog fetch time', async () => {
    await capture();
    expect(disk().chain_splits).toEqual(metadata());
  });
  it('keeps raw maps out of stripped entries and adds only compact scalar tuples', async () => {
    await capture(); const saved = disk();
    expect(saved.data).toEqual(stripProtocolEntries(entries));
    expect(JSON.stringify(saved)).not.toContain('chainTvls');
    expect(Buffer.byteLength(JSON.stringify(saved)) - Buffer.byteLength(JSON.stringify(saved.data))).toBeLessThan(1024);
    expect(readdirSync(cacheDir).filter(name => name.includes('.tmp-'))).toEqual([]);
  });
  it('retains the original eight-hour-old source timestamp after warm restoration', async () => {
    await capture(NOW - 8 * HOUR); __clearTvlCachesForTests();
    await warmLists({ fetchImpl: transport(false).fetchImpl });
    expect(disk().fetched_at).toBe(NOW - 8 * HOUR);
    expect(disk().chain_splits?.fetched_at).toBe(NOW - 8 * HOUR);
    expect(__getTvlChainSplitForTests(entries[0].slug)).toBe(subjects[0].expected_chain_tvl_usd);
  });
  for (const subject of subjects) for (const mode of ['startup-warm', 'direct-disk-request'] as const) {
    it(`${subject.entry.slug}: ${mode} restores context without catalog/fill fetches and receipts it`, async () => {
      await capture(); __clearTvlCachesForTests(); const local = transport(false);
      if (mode === 'startup-warm') await warmLists({ fetchImpl: local.fetchImpl });
      const out = await handleTvl({ protocol: subject.entry.slug }, { fetchImpl: local.fetchImpl });
      await assertReceipt(out, subject, subject.expected_chain_tvl_usd);
      await __awaitTvlProtocolFillForTests();
      expect(local.calls).toEqual([`https://api.llama.fi/tvl/${subject.entry.slug}`]);
    });
  }
  it('a legacy stripped cache remains usable with honest null context', async () => {
    await capture(); const saved = disk(); delete saved.chain_splits; persist(saved);
    __clearTvlCachesForTests(); const local = transport(false);
    await warmLists({ fetchImpl: local.fetchImpl });
    const out = await handleTvl({ protocol: entries[0].slug }, { fetchImpl: local.fetchImpl });
    await assertReceipt(out, subjects[0], null);
    expect(local.calls.filter(url => url === PROTOCOLS || url === CHAINS)).toEqual([]);
  });
  it('an older disk snapshot does not replace a newer in-memory source projection', async () => {
    await capture(NOW - 2 * HOUR); __clearTvlCachesForTests();
    // Exact captured Ethereum-only projection, no number is invented.
    const current = entries.map(p => ({ ...p, chainTvls: { Ethereum: p.chainTvls.Ethereum } }));
    __seedTvlCachesForTests(current, chains, NOW - HOUR);
    await warmLists({ fetchImpl: transport(false).fetchImpl });
    expect(__getTvlChainSplitForTests(entries[0].slug)).toBe(entries[0].chainTvls.Ethereum);
  });
  it('does not serve aged restored context when a newer legacy list becomes usable', async () => {
    await capture(); __clearTvlCachesForTests();
    await warmLists({ fetchImpl: transport(false).fetchImpl });
    vi.setSystemTime(NOW + 25 * HOUR);
    const saved = disk(); saved.fetched_at = NOW + 25 * HOUR; delete saved.chain_splits; persist(saved);
    const chainPath = join(cacheDir, 'tvl-chains.json');
    const chainDisk = JSON.parse(readFileSync(chainPath, 'utf8'));
    chainDisk.fetched_at = NOW + 25 * HOUR; writeFileSync(chainPath, JSON.stringify(chainDisk));
    const out = await handleTvl({ protocol: entries[0].slug }, { fetchImpl: transport(false).fetchImpl });
    await assertReceipt(out, subjects[0], null);
  });
  it('a newer empty snapshot clears older context instead of retaining a missing value', async () => {
    await capture(); const saved = disk(); saved.chain_splits = { ...metadata(), values: [] }; persist(saved);
    __clearTvlCachesForTests(); __seedTvlCachesForTests(entries, chains, NOW - HOUR);
    await warmLists({ fetchImpl: transport(false).fetchImpl });
    expect(__getTvlChainSplitForTests(entries[0].slug)).toBeUndefined();
  });
});

const invalidMetadata: [string, (value: Record<string, any>) => void][] = [
  ['unknown version', m => { m.version = 2; }],
  ['wrong source', m => { m.source = CHAINS; }],
  ['mismatched older source timestamp', m => { m.fetched_at -= 1; }],
  ['mismatched newer source timestamp', m => { m.fetched_at += 1; }],
  ['non-numeric source timestamp', m => { m.fetched_at = String(NOW); }],
  ['missing source timestamp', m => { delete m.fetched_at; }],
  ['non-array values', m => { m.values = {}; }],
  ['extra tuple item', m => { m.values[0].push('unexpected'); }],
  ['missing tuple value', m => { m.values[0].pop(); }],
  ['unknown slug', m => { m.values[0][0] = 'not-in-this-catalog'; }],
  ['duplicate slug', m => { m.values.push([...m.values[0]]); }],
  ['zero split', m => { m.values[0][1] = 0; }],
  ['negative split', m => { m.values[0][1] = -1; }],
  ['null split', m => { m.values[0][1] = null; }],
  ['string split', m => { m.values[0][1] = String(m.values[0][1]); }],
];
for (const [name, corrupt] of invalidMetadata) it(`ignores optional metadata with ${name} without breaking the list`, async () => {
  await capture(); const saved = disk(); saved.chain_splits = metadata(); corrupt(saved.chain_splits); persist(saved);
  __clearTvlCachesForTests(); const local = transport(false);
  await warmLists({ fetchImpl: local.fetchImpl });
  expect(__getTvlChainSplitForTests(entries[0].slug)).toBeUndefined();
  expect(local.calls).toEqual([]);
});
for (const [name, age] of [['exactly 24h old', 24 * HOUR], ['seven days old', 7 * 24 * HOUR], ['future dated', -1000]] as const) {
  it(`does not restore context from a ${name} source snapshot`, async () => {
    await capture(); const saved = disk(); saved.fetched_at = NOW - age;
    saved.chain_splits = metadata(saved.fetched_at); persist(saved);
    __clearTvlCachesForTests(); await warmLists({ fetchImpl: transport(false).fetchImpl });
    expect(__getTvlChainSplitForTests(entries[0].slug)).toBeUndefined();
  });
}
// Cap raised 2 MiB -> 40 MiB 2026-11-23: real /protocol/{slug} umbrella
// payloads are 11-31 MB (aave measured 11,108,531 B), and the fill is
// load-bearing for chain-scoped answers. The bound still bites, higher.
for (const headers of [{}, { 'content-length': '1' }] as Record<string, string>[]) it(`still cancels protocol streams over 40MiB with headers ${JSON.stringify(headers)}`, async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(40 * 1024 * 1024)); controller.enqueue(new Uint8Array(1));
  }, cancel() { cancelled = true; } });
  const fetchImpl: typeof fetch = async () => new Response(body, { headers });
  await expect(__fetchTvlTextForTests('https://api.llama.fi/protocol/antimatter', fetchImpl, 1000))
    .rejects.toMatchObject({ code: 'DEFILLAMA_RESPONSE_TOO_LARGE' });
  expect(cancelled).toBe(true);
});
it('still accepts exactly 40MiB at the protocol text boundary', async () => {
  const fetchImpl: typeof fetch = async () => new Response(' '.repeat(40 * 1024 * 1024));
  const text = await __fetchTvlTextForTests('https://api.llama.fi/protocol/antimatter', fetchImpl, 1000);
  expect(Buffer.byteLength(text)).toBe(40 * 1024 * 1024);
});
