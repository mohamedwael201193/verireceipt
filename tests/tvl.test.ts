// TVL handler tests (vitest).
// Unit tests use LOCAL FIXTURES via an injected fetch transport (same seam as
// the filings handler) — no network, deterministic. Live tests hit the real
// DeFiLlama API with the default fetch and report the exact numbers observed.

import { describe, expect, it, beforeEach } from 'vitest';
import { ApiError } from '../src/core/errors';
import {
  __clearTvlCachesForTests,
  __seedTvlCachesForTests,
  dominantChainTvl,
  handleTvl,
  parseChainReading,
  parseProtocolReading,
  resolveTvlTarget,
} from '../src/handlers/tvl';

// ---------------------------------------------------------------------------
// Local fixtures (values copied from real DeFiLlama responses observed
// 2026-11-20; small snapshots used as deterministic test data)
// ---------------------------------------------------------------------------

const PROTOCOLS_FIXTURE = [
  { slug: 'aave-v3', name: 'Aave V3', symbol: 'AAVE' },
  { slug: 'uniswap-v3', name: 'Uniswap V3', symbol: 'UNI' },
  { slug: 'lido', name: 'Lido', symbol: 'LDO' },
  // Live DeFiLlama lists chains as dummy protocol entries (category "Chain",
  // tvl null, module dummy.js) — e.g. slug "ethereum". They must defer to
  // the real chain of the same name.
  { slug: 'ethereum', name: 'Ethereum', symbol: '-', category: 'Chain', tvl: null },
  // ...but a same-named entry that DOES carry TVL is a real protocol and wins.
  { slug: 'solana', name: 'Solana', symbol: 'SOL', category: 'Chain', tvl: 999 },
];

const CHAINS_FIXTURE = [
  { name: 'Ethereum', gecko_id: 'ethereum', tvl: 35974180659 },
  { name: 'Arbitrum', gecko_id: 'arbitrum', tvl: 123456789 },
  { name: 'Solana', gecko_id: 'solana', tvl: 888 },
];

// Real observed values: /protocol/aave-v3 last tvl point 15121752429 @
// 1795142400; currentChainTvls Ethereum 12931958948.41916 (dominant),
// Arbitrum 415494303.8637; Ethereum-borrowed must be ignored.
const AAVE_PROTOCOL_FIXTURE = {
  id: '1599',
  name: 'Aave V3',
  symbol: 'AAVE',
  tvl: [
    { date: 1795056000, totalLiquidityUSD: 15000000000 },
    { date: 1795142400, totalLiquidityUSD: 15121752429 },
  ],
  currentChainTvls: {
    Ethereum: 12931958948.41916,
    Arbitrum: 415494303.8637,
    'Ethereum-borrowed': 8788295065.67177,
  },
};

// Same protocol but with no per-chain split at all -> chain_tvl_usd null.
const LIDO_PROTOCOL_FIXTURE = {
  id: '1',
  name: 'Lido',
  symbol: 'LDO',
  tvl: [{ date: 1795142400, totalLiquidityUSD: 30000000000 }],
};

// Real observed value: /v2/historicalChainTvl/Ethereum last point
// 35974180659 @ 1795132800.
const ETH_CHAIN_HISTORY_FIXTURE = [
  { date: 1795056000, tvl: 35000000000 },
  { date: 1795132800, tvl: 35974180659 },
];

/**
 * Fixture transport: answers the exact DeFiLlama URLs the handler fetches,
 * from the local fixtures above. Anything else is a test bug -> 404.
 */
function fixtureFetch(protocolPayload: unknown = AAVE_PROTOCOL_FIXTURE): typeof fetch {
  return (async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    if (u === 'https://api.llama.fi/protocols') {
      return new Response(JSON.stringify(PROTOCOLS_FIXTURE), { status: 200 });
    }
    if (u === 'https://api.llama.fi/v2/chains') {
      return new Response(JSON.stringify(CHAINS_FIXTURE), { status: 200 });
    }
    if (u === 'https://api.llama.fi/protocol/aave-v3') {
      return new Response(JSON.stringify(AAVE_PROTOCOL_FIXTURE), { status: 200 });
    }
    if (u === 'https://api.llama.fi/protocol/lido') {
      return new Response(JSON.stringify(protocolPayload), { status: 200 });
    }
    if (u === 'https://api.llama.fi/v2/historicalChainTvl/Ethereum') {
      return new Response(JSON.stringify(ETH_CHAIN_HISTORY_FIXTURE), { status: 200 });
    }
    return new Response('not found in fixture transport', { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  __clearTvlCachesForTests();
});

function expectApiError(err: unknown, status: number, code: string): void {
  expect(err).toBeInstanceOf(ApiError);
  const apiErr = err as ApiError;
  expect(apiErr.status).toBe(status);
  expect(apiErr.code).toBe(code);
}

// ---------------------------------------------------------------------------
// Unit tests (local fixtures, no network)
// ---------------------------------------------------------------------------

describe('handleTvl validation', () => {
  it('missing protocol -> 400', async () => {
    await expect(handleTvl({})).rejects.toThrowError();
    try {
      await handleTvl({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 400, 'MISSING_PROTOCOL');
    }
  });

  it('empty / whitespace protocol -> 400', async () => {
    for (const bad of ['', '   ']) {
      try {
        await handleTvl({ protocol: bad }, { fetchImpl: fixtureFetch() });
        expect.unreachable('should have thrown');
      } catch (err) {
        expectApiError(err, 400, 'MISSING_PROTOCOL');
      }
    }
  });
});

describe('resolveTvlTarget (slug normalization, fixtures)', () => {
  it('"aave-v3" resolves to slug aave-v3 with confidence 1.0', () => {
    expect(resolveTvlTarget('aave-v3', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'protocol',
      slug: 'aave-v3',
      displayName: 'Aave V3',
      confidence: 1.0,
    });
  });

  it('"Aave V3" resolves to slug aave-v3 with confidence 0.9', () => {
    expect(resolveTvlTarget('Aave V3', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'protocol',
      slug: 'aave-v3',
      displayName: 'Aave V3',
      confidence: 0.9,
    });
  });

  it('"AAVE" symbol resolves to slug aave-v3 with confidence 0.9', () => {
    const target = resolveTvlTarget('AAVE', PROTOCOLS_FIXTURE, CHAINS_FIXTURE);
    expect(target?.kind).toBe('protocol');
    if (target?.kind === 'protocol') {
      expect(target.slug).toBe('aave-v3');
      expect(target.confidence).toBe(0.9);
    }
  });

  it('"ethereum" resolves as a chain, not a protocol', () => {
    expect(resolveTvlTarget('ethereum', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'chain',
      chain: 'Ethereum',
      displayName: 'Ethereum',
      confidence: 1.0,
    });
  });

  it('"ethereum" defers to the chain even though a dummy protocol stub shares the slug', () => {
    // The fixture protocols list contains the live dummy entry
    // { slug: "ethereum", category: "Chain", tvl: null }. If it won the
    // match, the handler would fetch /protocol/ethereum, which has no TVL
    // history. The chain must win.
    const target = resolveTvlTarget('ethereum', PROTOCOLS_FIXTURE, CHAINS_FIXTURE);
    expect(target?.kind).toBe('chain');
  });

  it('a same-named entry WITH tvl still wins as a protocol ("solana")', () => {
    expect(resolveTvlTarget('solana', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'protocol',
      slug: 'solana',
      displayName: 'Solana',
      confidence: 1.0,
    });
  });

  it('"uniswap" prefix-resolves to uniswap-v3 with confidence 0.9', () => {
    const target = resolveTvlTarget('uniswap', PROTOCOLS_FIXTURE, CHAINS_FIXTURE);
    expect(target?.kind).toBe('protocol');
    if (target?.kind === 'protocol') {
      expect(target.slug).toBe('uniswap-v3');
      expect(target.confidence).toBe(0.9);
    }
  });

  it('unresolvable input returns null', () => {
    expect(resolveTvlTarget('zzzznotreal', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toBeNull();
  });
});

describe('dominantChainTvl / parsing (fixtures)', () => {
  it('dominant chain ignores *-borrowed entries', () => {
    expect(
      dominantChainTvl({
        Ethereum: 12931958948.41916,
        Arbitrum: 415494303.8637,
        'Ethereum-borrowed': 8788295065.67177,
      }),
    ).toBe(12931958948.41916);
  });

  it('chain_tvl_usd null handling: missing/empty/all-zero split -> null', () => {
    expect(dominantChainTvl(undefined)).toBeNull();
    expect(dominantChainTvl(null)).toBeNull();
    expect(dominantChainTvl({})).toBeNull();
    expect(dominantChainTvl({ Ethereum: 0 })).toBeNull();
  });

  it('parseProtocolReading takes the last tvl point + dominant chain', () => {
    expect(parseProtocolReading(AAVE_PROTOCOL_FIXTURE)).toEqual({
      tvlUsd: 15121752429,
      chainTvlUsd: 12931958948.41916,
      asOf: new Date(1795142400 * 1000).toISOString(),
    });
  });

  it('parseProtocolReading with no chain split -> chainTvlUsd null', () => {
    expect(parseProtocolReading(LIDO_PROTOCOL_FIXTURE)).toEqual({
      tvlUsd: 30000000000,
      chainTvlUsd: null,
      asOf: new Date(1795142400 * 1000).toISOString(),
    });
  });

  it('parseChainReading takes the last history point', () => {
    expect(parseChainReading(ETH_CHAIN_HISTORY_FIXTURE)).toEqual({
      tvlUsd: 35974180659,
      asOf: new Date(1795132800 * 1000).toISOString(),
    });
  });
});

describe('handleTvl with fixture transport', () => {
  it('envelope shape for protocol "aave-v3"', async () => {
    const out = await handleTvl({ protocol: 'aave-v3' }, { fetchImpl: fixtureFetch() });
    expect(out.protocol_or_chain).toBe('aave-v3');
    expect(out.tvl_usd).toBe(15121752429);
    expect(out.chain_tvl_usd).toBe(12931958948.41916);
    expect(out.as_of).toBe(new Date(1795142400 * 1000).toISOString());
    expect(out.answer).toBe('Aave V3 has a total value locked of $15,121,752,429.');
    expect(out.verdict).toBe('verified');
    expect(out.confidence).toBe(1.0);
    expect(out.source).toBe('DeFiLlama API (https://api.llama.fi/protocol/aave-v3)');
    const receipt = out.receipt as Record<string, unknown>;
    expect(receipt).toBeDefined();
    expect(typeof receipt.receipt_id).toBe('string');
    expect((receipt.receipt_id as string).startsWith('rcpt_')).toBe(true);
    expect(receipt.intent).toBe('TVL_LOOKUP_GENERAL');
    expect(receipt.upstream_url).toBe('https://api.llama.fi/protocol/aave-v3');
    expect(receipt.raw_response_sha256).toMatch(/^0x[0-9a-f]{64}$/);
    expect(receipt.quorum_votes).toBe('1/1 primary source');
    expect(typeof receipt.fetched_at).toBe('string');
    expect(typeof receipt.audit_url).toBe('string');
  });

  it('slug normalization through the handler: "Aave V3" -> aave-v3, confidence 0.9', async () => {
    const out = await handleTvl({ protocol: 'Aave V3' }, { fetchImpl: fixtureFetch() });
    expect(out.protocol_or_chain).toBe('aave-v3');
    expect(out.tvl_usd).toBe(15121752429);
    expect(out.confidence).toBe(0.9);
  });

  it('chain path through the handler: "ethereum" -> Ethereum chain TVL', async () => {
    const out = await handleTvl({ protocol: 'ethereum' }, { fetchImpl: fixtureFetch() });
    expect(out.protocol_or_chain).toBe('Ethereum');
    expect(out.tvl_usd).toBe(35974180659);
    // For a chain lookup the TVL on the named chain IS the chain TVL.
    expect(out.chain_tvl_usd).toBe(35974180659);
    expect(out.as_of).toBe(new Date(1795132800 * 1000).toISOString());
    expect(out.confidence).toBe(1.0);
    expect(out.source).toBe(
      'DeFiLlama API (https://api.llama.fi/v2/historicalChainTvl/Ethereum)',
    );
  });

  it('chain_tvl_usd null handling through the handler: no split -> null, never 0', async () => {
    const out = await handleTvl(
      { protocol: 'lido' },
      { fetchImpl: fixtureFetch(LIDO_PROTOCOL_FIXTURE) },
    );
    expect(out.protocol_or_chain).toBe('lido');
    expect(out.tvl_usd).toBe(30000000000);
    expect(out.chain_tvl_usd).toBeNull();
  });

  it('unresolvable protocol -> 422 PROTOCOL_NOT_FOUND', async () => {
    try {
      await handleTvl({ protocol: 'zzzznotreal' }, { fetchImpl: fixtureFetch() });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 422, 'PROTOCOL_NOT_FOUND');
    }
  });

  it('seeded lists cache is used (lists fetch never called)', async () => {
    __seedTvlCachesForTests(PROTOCOLS_FIXTURE, CHAINS_FIXTURE);
    const listsOnlyThrow: typeof fetch = (async () => {
      throw new Error('lists fetch must not be called when cache is seeded');
    }) as typeof fetch;
    // The reading fetch still goes through the fixture transport; combine by
    // routing: lists URLs throw, protocol URL answered from fixture.
    const combined: typeof fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'https://api.llama.fi/protocol/aave-v3') {
        return new Response(JSON.stringify(AAVE_PROTOCOL_FIXTURE), { status: 200 });
      }
      return listsOnlyThrow(u);
    }) as typeof fetch;
    const out = await handleTvl({ protocol: 'aave-v3' }, { fetchImpl: combined });
    expect(out.protocol_or_chain).toBe('aave-v3');
    expect(out.tvl_usd).toBe(15121752429);
  });
});

// ---------------------------------------------------------------------------
// Live tests (REAL DeFiLlama, default fetch, no fixtures)
// ---------------------------------------------------------------------------

describe('handleTvl live (real DeFiLlama)', () => {
  it('protocol "aave-v3" returns tvl_usd > 1e9', { timeout: 60000 }, async () => {
    __clearTvlCachesForTests();
    const out = await handleTvl({ protocol: 'aave-v3' });
    console.log('LIVE aave-v3 tvl_usd =', out.tvl_usd, '| as_of =', out.as_of);
    expect(typeof out.tvl_usd).toBe('number');
    expect(out.tvl_usd as number).toBeGreaterThan(1e9);
    expect(out.protocol_or_chain).toBe('aave-v3');
    expect(out.verdict).toBe('verified');
  });

  it('protocol "ethereum" (chain path) returns tvl_usd > 0', { timeout: 60000 }, async () => {
    __clearTvlCachesForTests();
    const out = await handleTvl({ protocol: 'ethereum' });
    console.log('LIVE ethereum tvl_usd =', out.tvl_usd, '| as_of =', out.as_of);
    expect(typeof out.tvl_usd).toBe('number');
    expect(out.tvl_usd as number).toBeGreaterThan(0);
    expect(out.protocol_or_chain).toBe('Ethereum');
  });

  it('protocol "zzzznotreal" returns 422', { timeout: 60000 }, async () => {
    __clearTvlCachesForTests();
    try {
      await handleTvl({ protocol: 'zzzznotreal' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 422, 'PROTOCOL_NOT_FOUND');
    }
  });
});
