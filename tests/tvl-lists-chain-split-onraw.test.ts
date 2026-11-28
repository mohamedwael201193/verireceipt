import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = vi.hoisted(() => {
  const path = `/tmp/tvl-lists-onraw-${process.pid}-${Date.now()}.sqlite`;
  process.env.SQLITE_PATH = path;
  delete process.env.DATABASE_URL;
  return path;
});
import { closeStorage, initStorage } from '../src/core/storage';
import {
  __awaitTvlBackgroundRefreshForTests, __awaitTvlProtocolFillForTests,
  __clearTvlCachesForTests, __setTvlListsCacheDirForTests, __setTvlSeedEnabledForTests,
  handleTvl, warmLists,
} from '../src/handlers/tvl';

// Entries are cut unedited from one live GET https://api.llama.fi/protocols
// response (captured 2026-11-28 17:03Z): aave-v3 (TVL rank 3), arrakis-modular
// (rank 300, outside the top 200, has chainTvls), the-graph (plain chains 0,
// staking keys only), synthetix-v1+v2 (no chainTvls). The transport replays
// that projection locally through the real warmLists -> loadOneList onRaw path
// (not the seed helper); the chain list carries only chain names, and /tvl
// replays each entry's own listed tvl. No live network.
interface Entry { slug: string; name: string; tvl: number | null; chainTvls: Record<string, number> }
const entries = JSON.parse(readFileSync(join(__dirname, 'fixtures/tvl-protocols-live-extract-20261128.json'), 'utf8')) as Entry[];
const bySlug = (slug: string) => entries.find(e => e.slug === slug)!;
const PROTOCOLS = 'https://api.llama.fi/protocols';
const CHAINS = 'https://api.llama.fi/v2/chains';
const chains = ['Ethereum', 'Base', 'Arbitrum', 'Solana'].map(name => ({ name }));
let cacheDir: string;
let calls: string[];
let served: Entry[] = entries;
const fetchImpl: typeof fetch = async input => {
  const url = String(input); calls.push(url);
  if (url === PROTOCOLS) return new Response(JSON.stringify(served));
  if (url === CHAINS) return new Response(JSON.stringify(chains));
  const e = entries.find(x => url === `https://api.llama.fi/tvl/${x.slug}`);
  if (e) return new Response(JSON.stringify(e.tvl));
  if (url.startsWith('https://api.llama.fi/protocol/')) return new Response('', { status: 503 });
  throw new Error('Unexpected source: ' + url);
};
const fills = () => calls.filter(u => u.startsWith('https://api.llama.fi/protocol/'));
async function refusal(protocol: string) {
  try { await handleTvl({ protocol }, { fetchImpl }); } catch (err) { return err as { status?: number; code?: string }; }
  throw new Error('expected a refusal');
}

async function warm() { __clearTvlCachesForTests(); await warmLists({ fetchImpl }); calls = []; }
beforeAll(async () => { await initStorage(); });
beforeEach(async () => {
  __clearTvlCachesForTests(); calls = []; served = entries;
  cacheDir = mkdtempSync(join(tmpdir(), 'tvl-onraw-cache-'));
  __setTvlListsCacheDirForTests(cacheDir); __setTvlSeedEnabledForTests(false);
  await warm();
});
afterEach(async () => {
  await __awaitTvlBackgroundRefreshForTests(); await __awaitTvlProtocolFillForTests();
  __clearTvlCachesForTests(); __setTvlListsCacheDirForTests(null); __setTvlSeedEnabledForTests(true);
  rmSync(cacheDir, { recursive: true, force: true });
});
afterAll(async () => {
  await closeStorage();
  for (const suffix of ['', '-wal', '-shm']) rmSync(scratch + suffix, { force: true });
});

describe('chain-scoped TVL is served from the live lists via the real onRaw path', () => {
  it('answers "Aave V3 on Base" on the first call with the Base bucket and starts no fill', async () => {
    const out = await handleTvl({ protocol: 'Aave V3 on Base' }, { fetchImpl });
    expect(out.chain_tvl_usd).toBe(bySlug('aave-v3').chainTvls.Base);
    expect(out.tvl_usd).toBe(bySlug('aave-v3').tvl);
    expect(fills()).toEqual([]);
  });
  it('answers an entry outside the top 200 (arrakis-modular on Base)', async () => {
    const out = await handleTvl({ protocol: 'Arrakis Modular on Base' }, { fetchImpl });
    expect(out.chain_tvl_usd).toBe(bySlug('arrakis-modular').chainTvls.Base);
    expect(fills()).toEqual([]);
  });
  it('a chain with no recorded TVL is 422 CHAIN_TVL_NONE, no fill', async () => {
    const err = await refusal('Aave V3 on Solana');
    expect([err.status, err.code]).toEqual([422, 'CHAIN_TVL_NONE']);
    expect(fills()).toEqual([]);
  });
  it('a protocol without chainTvls still refuses 502 CHAIN_SPLIT_UNAVAILABLE and starts the fill', async () => {
    // The only real chainTvls-less entry in the capture (synthetix-v1+v2) is a
    // TVL-less placeholder the resolver skips, so the same real arrakis-modular
    // entry is served with its chainTvls key removed (the sole change).
    served = entries.map(e => e.slug === 'arrakis-modular'
      ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'chainTvls')) as unknown as Entry : e);
    __setTvlListsCacheDirForTests(mkdtempSync(join(tmpdir(), 'tvl-onraw-cache2-')));
    await warm();
    const err = await refusal('Arrakis Modular on Base');
    expect([err.status, err.code]).toEqual([502, 'CHAIN_SPLIT_UNAVAILABLE']);
    await __awaitTvlProtocolFillForTests('arrakis-modular');
    expect(fills()).toEqual(['https://api.llama.fi/protocol/arrakis-modular']);
  });
  it('staking and borrowed keys are never the answer', async () => {
    // the-graph: plain chains are 0 and only staking keys are positive.
    const graph = await refusal('The Graph on Ethereum');
    expect([graph.status, graph.code]).toEqual([502, 'CHAIN_SPLIT_UNAVAILABLE']);
    // aave-v3 Ethereum answer is the plain bucket, not Ethereum-borrowed.
    const out = await handleTvl({ protocol: 'Aave V3 on Ethereum' }, { fetchImpl });
    expect(out.chain_tvl_usd).toBe(bySlug('aave-v3').chainTvls.Ethereum);
    expect(out.chain_tvl_usd).not.toBe(bySlug('aave-v3').chainTvls['Ethereum-borrowed']);
  });
});
