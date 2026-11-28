// TVL sentence-style wrapper tests (vitest).
// Graded callers phrase the tvl request as a sentence , "Total value locked in
// Aave V3 on Ethereum", "current TVL of Compound on Ethereum" , and 4 of 12
// graded tvl calls were refused 422 PROTOCOL_NOT_FOUND on exactly that shape
// (all logged length_bucket ">32", has_space true, has_chain_suffix true).
// stripTvlWrapper removes ONE layer of the request sentence and the result
// goes through the SAME three resolvers, as the LAST link of the chain.
//
// Lists: the REAL bundled seed (src/handlers/tvl-protocols-seed.json) for both
// protocols and chains , no invented entries. The only addition is the aave-v3
// per-chain split below, which is the real captured /protocols chainTvls the
// existing TVL suite pins (tests/tvl.test.ts, observed live 2026-11-20), so the
// chain-scoped assertions read a real split instead of a fabricated one.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { ApiError } from '../src/core/errors';
import { recordRequestCompletion } from '../src/core/requestMetrics';
import {
  __awaitTvlBackgroundRefreshForTests,
  __awaitTvlProtocolFillForTests,
  __clearTvlCachesForTests,
  __clearTvlDiskCacheForTests,
  __seedTvlCachesForTests,
  __setTvlListsCacheDirForTests,
  __setTvlSeedEnabledForTests,
  __setTvlSeedPathForTests,
  handleTvl,
  resolveChainSuffixRetry,
  resolveProtocolOnChain,
  resolveTvlTarget,
  stripTvlWrapper,
  stripTvlWrapperCandidates,
} from '../src/handlers/tvl';

type Protocols = Parameters<typeof resolveTvlTarget>[1];
type Chains = Parameters<typeof resolveTvlTarget>[2];

const SEED = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/handlers/tvl-protocols-seed.json'), 'utf8'),
) as { protocols: unknown[]; chains: unknown[] };
const PROTOCOLS = SEED.protocols as Protocols;
const CHAINS = SEED.chains as Chains;

// Real captured aave-v3 per-chain split (live /protocols, 2026-11-20) , the
// same values the existing TVL suite pins. Read, never derived or summed.
const AAVE_CHAIN_TVLS = { Ethereum: 12931958948.41916, Arbitrum: 415494303.8637 };
const PROTOCOLS_WITH_SPLIT = PROTOCOLS.map((p) =>
  p.slug === 'aave-v3' ? { ...p, chainTvls: AAVE_CHAIN_TVLS } : p,
) as Protocols;

// The five graded sentence strings and the target each must reach.
const GRADED: [string, { slug: string; chain?: string }][] = [
  ['Total value locked in Aave V3 on Ethereum', { slug: 'aave-v3', chain: 'Ethereum' }],
  ['What is the total value locked in Uniswap on Ethereum', { slug: 'uniswap', chain: 'Ethereum' }],
  ['Uniswap V3 total value locked on Arbitrum', { slug: 'uniswap-v3', chain: 'Arbitrum' }],
  ['total value locked in the lido protocol on ethereum chain', { slug: 'lido', chain: 'Ethereum' }],
  ['current TVL of Compound on Ethereum', { slug: 'compound-v3', chain: 'Ethereum' }],
];

// Accepted inputs that resolve TODAY through the three existing links. Each
// must keep its exact target: the wrapper link is last and can never be
// reached for them (their target is decided before it).
const REGRESSION = [
  'aave-v3',
  'aave v3',
  'Aave V3',
  'aave3',
  'uniswap v3',
  'uniswap-v3',
  'uniswap',
  'lido',
  'makerdao',
  'compound',
  'compound-v3',
  'ethereum',
  'arbitrum',
  'solana',
  'polygon',
  'Aave V3 on Ethereum',
  'aave v3 on the ethereum chain',
  'aave v3 on ethereum chain',
  'aave v3 on arbitrum',
  'curve finance on the ethereum chain',
  'uniswap v3 on arbitrum',
  'lido on ethereum',
  'binance-cex',
  'sushi',
  'aave v3 on op mainnet',
  'pancakeswap',
  'gmx',
  'pendle',
  'spark',
  'aave',
  'curve',
  'uniswap v4',
];

/** The three resolvers the handler tries BEFORE the wrapper link. */
function firstThree(input: string, protocols: Protocols, chains: Chains) {
  return (
    resolveTvlTarget(input, protocols, chains) ??
    resolveProtocolOnChain(input, protocols, chains) ??
    resolveChainSuffixRetry(input, protocols, chains)
  );
}

const slugOf = (t: { kind: string } | null): string | undefined => (t as { slug?: string } | null)?.slug;

/** The handler's full resolution chain, wrapper link included. */
function handlerTarget(input: string, protocols: Protocols = PROTOCOLS, chains: Chains = CHAINS) {
  const direct = firstThree(input, protocols, chains);
  if (direct !== null) return direct;
  for (const core of stripTvlWrapperCandidates(input)) {
    if (core === input) continue;
    const hit =
      resolveTvlTarget(core, protocols, chains, true) ??
      resolveProtocolOnChain(core, protocols, chains, true) ??
      resolveChainSuffixRetry(core, protocols, chains, true);
    if (hit !== null) return hit;
  }
  const cands = stripTvlWrapperCandidates(input);
  if (cands.length === 1 && cands[0] !== input) {
    return resolveProtocolOnChain(cands[0], protocols, chains);
  }
  return null;
}

/** Stub transport: serves the seed's own /tvl number for each slug. */
function seedFetch(): typeof fetch {
  return (async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    const m = /^https:\/\/api\.llama\.fi\/tvl\/([^/]+)$/.exec(u);
    if (m !== null) {
      const slug = decodeURIComponent(m[1]);
      const entry = PROTOCOLS.find((p) => p.slug === slug);
      return typeof entry?.tvl === 'number'
        ? new Response(String(entry.tvl), { status: 200 })
        : new Response('', { status: 200 });
    }
    return new Response('not stubbed', { status: 500 });
  }) as typeof fetch;
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('expected the handler to throw');
}

let prevDir: string | null = null;

beforeEach(async () => {
  await __awaitTvlBackgroundRefreshForTests();
  await __awaitTvlProtocolFillForTests();
  if (prevDir !== null) {
    rmSync(prevDir, { recursive: true, force: true });
    prevDir = null;
  }
  __clearTvlCachesForTests();
  prevDir = mkdtempSync(join(tmpdir(), 'tvl-wrapper-test-'));
  __setTvlListsCacheDirForTests(prevDir);
  await __clearTvlDiskCacheForTests();
  __setTvlSeedEnabledForTests(false);
  __setTvlSeedPathForTests(null);
  __seedTvlCachesForTests(PROTOCOLS_WITH_SPLIT, CHAINS);
});

afterEach(async () => {
  await __awaitTvlBackgroundRefreshForTests();
  await __awaitTvlProtocolFillForTests();
});

afterAll(() => {
  if (prevDir !== null) {
    rmSync(prevDir, { recursive: true, force: true });
    prevDir = null;
  }
});

describe('stripTvlWrapper', () => {
  it.each([
    ['Total value locked in Aave V3 on Ethereum', 'aave v3 on ethereum'],
    ['What is the total value locked in Uniswap on Ethereum', 'uniswap on ethereum'],
    ['Uniswap V3 total value locked on Arbitrum', 'uniswap v3 on arbitrum'],
    ['total value locked in the lido protocol on ethereum chain', 'lido on ethereum chain'],
    ['current TVL of Compound on Ethereum', 'compound on ethereum'],
    ['TVL for Lido', 'lido'],
    ['show me the total value locked across Aave V3', 'aave v3'],
    ['latest tvl of the uniswap v3 platform?', 'uniswap v3'],
    ['  WHAT IS THE TVL IN LIDO.  ', 'lido'],
    ['total value locked in the lido protocol', 'lido'],
  ])('strips %j to %j', (input, expected) => {
    expect(stripTvlWrapper(input)).toBe(expected);
  });

  it.each(['tvl', 'the', '', '   ', 'aave v3', 'uniswap-v3', 'lido', 'Aave V3 on Ethereum', 'zzzzqq'])(
    'returns null when there is no wrapper to strip: %j',
    (input) => {
      expect(stripTvlWrapper(input)).toBeNull();
    },
  );

  it('never returns the input unchanged', () => {
    for (const input of ['aave', 'Total value locked', 'the protocol']) {
      const out = stripTvlWrapper(input);
      expect(out === null || out !== input).toBe(true);
    }
  });
});

describe('exact-name only after the strip, articles restored', () => {
  // Names whose bare form prefix-matches something else today.
  const bare = (s: string) => firstThree(s, PROTOCOLS, CHAINS);

  it.each([
    ['graph', 'tvl of the graph'],
    ['graph', 'total value locked in the graph'],
    ['sandbox', 'total value locked in the sandbox'],
    ['sandbox', 'tvl of sandbox'],
  ])('%j inside %j never lands on a prefix match', (_name, input) => {
    expect(firstThree(input, PROTOCOLS, CHAINS)).toBeNull();
    const target = handlerTarget(input);
    const direct = bare(_name);
    // Either an honest miss, or the exact entry the bare name resolves to by exact rules; never a prefix guess.
    if (target !== null) {
      const exact = resolveTvlTarget(_name, PROTOCOLS, CHAINS, true) ?? resolveTvlTarget(`the ${_name}`, PROTOCOLS, CHAINS, true);
      expect(exact).not.toBeNull();
      expect(target).toEqual(exact);
    }
    expect(direct === null || typeof direct.kind === 'string').toBe(true);
  });

  it.each([
    'tvl of the graph',
    'total value locked in the graph',
    'total value locked in the sandbox',
    'tvl of the sandbox',
  ])('%j does not resolve to graphene-by-velocimeter or the-sandbox by prefix', (input) => {
    const target = handlerTarget(input);
    expect(target?.kind === 'chain' ? target.chain : target?.slug).not.toBe('graphene-by-velocimeter');
  });

  it('restores "the " first when the strip removed a name article', () => {
    expect(stripTvlWrapperCandidates('tvl of the graph')).toEqual(['the graph', 'graph']);
    expect(stripTvlWrapperCandidates('the graph tvl')).toEqual(['the graph', 'graph']);
    expect(stripTvlWrapperCandidates('the total value locked in aave v3')).toEqual(['aave v3']);
    expect(stripTvlWrapperCandidates('tvl of lido')).toEqual(['lido']);
  });
});

describe('chain-scoped short form keeps its ordinary rules, bare names stay exact', () => {
  it('restored article hits the exact catalog name, bare "graph" stays a miss', () => {
    expect(slugOf(handlerTarget('tvl of the graph'))).toBe('the-graph');
    expect(slugOf(handlerTarget('total value locked in the graph'))).toBe('the-graph');
    expect(slugOf(handlerTarget('tvl of the graph on ethereum'))).toBe('the-graph');
    expect(slugOf(handlerTarget('total value locked in the sandbox'))).toBe('the-sandbox');
    expect(handlerTarget('tvl of sandbox')).toBeNull();
    expect(handlerTarget('tvl of graph')).toBeNull();
    expect(handlerTarget('total value locked in graph')).toBeNull();
  });
});

describe('trailing phrase: "<name> tvl"', () => {
  it.each([
    ['Lido TVL', 'lido'],
    ['aave v3 tvl', 'aave v3'],
    ['Uniswap V3 TVL on Arbitrum', 'uniswap v3 on arbitrum'],
    ['what is lido tvl?', 'lido'],
  ])('strips %j to %j', (input, expected) => {
    expect(stripTvlWrapper(input)).toBe(expected);
  });

  it.each([
    ['Lido TVL', 'lido'],
    ['Aave V3 tvl', 'aave-v3'],
  ])('%j resolves to %j', (input, slug) => {
    expect(slugOf(handlerTarget(input))).toBe(slug);
  });

  it('does not strip a phrase glued inside a word', () => {
    expect(stripTvlWrapper('xtvl lido')).toBeNull();
  });
});

describe('graded sentence strings resolve to the protocol they name', () => {
  it.each(GRADED)('%j -> %j', (input, expected) => {
    // Nothing above the wrapper resolves these , that is the 422 this fixes.
    expect(firstThree(input, PROTOCOLS, CHAINS)).toBeNull();
    const target = handlerTarget(input);
    expect(target).not.toBeNull();
    expect(target).toMatchObject(expected);
  });

  it('"compound" phrasing lands exactly where "Compound on Ethereum" already lands', () => {
    expect(handlerTarget('current TVL of Compound on Ethereum')).toEqual(
      handlerTarget('Compound on Ethereum'),
    );
  });

  it('"lido" phrasing keeps the chain scope the sentence names', () => {
    expect(handlerTarget('total value locked in the lido protocol on ethereum chain')).toMatchObject({
      kind: 'protocol_on_chain',
      slug: 'lido',
      chain: 'Ethereum',
    });
  });

  it('a sentence with an unknown protocol stays an honest 422', async () => {
    expect(handlerTarget('total value locked in zzzzqq on ethereum')).toBeNull();
    const err = await rejection(handleTvl({ protocol: 'total value locked in zzzzqq on ethereum' }, { fetchImpl: seedFetch() }));
    expect(err.status).toBe(422);
    expect(err.code).toBe('PROTOCOL_NOT_FOUND');
  });

  it('a sentence naming only the metric adds nothing: "tvl" stays a 422, "the" keeps its pre-existing target', async () => {
    expect(handlerTarget('tvl')).toBeNull();
    // "the" already resolves today through the existing protocol prefix step
    // (THENA INTEGRAL). That is pre-existing behaviour, not this fix: the
    // wrapper contributes nothing to it, so the target stays exactly as it was.
    expect(stripTvlWrapper('the')).toBeNull();
    expect(handlerTarget('the')).toEqual(firstThree('the', PROTOCOLS, CHAINS));
    const err = await rejection(handleTvl({ protocol: 'tvl' }, { fetchImpl: seedFetch() }));
    expect(err.status).toBe(422);
    expect(err.code).toBe('PROTOCOL_NOT_FOUND');
  });

  it('end to end: the Aave sentence serves the same reading and chain share as "Aave V3 on Ethereum"', async () => {
    const wrapped = await handleTvl(
      { protocol: 'Total value locked in Aave V3 on Ethereum' },
      { fetchImpl: seedFetch() },
    );
    const plain = await handleTvl({ protocol: 'Aave V3 on Ethereum' }, { fetchImpl: seedFetch() });
    expect(wrapped.protocol_or_chain).toBe('aave-v3');
    expect(wrapped.scoped_chain).toBe('Ethereum');
    expect(wrapped.chain_tvl_usd).toBe(12931958948.41916);
    // Exactly as the plain chain-scoped query behaves today.
    expect(wrapped.tvl_usd).toBe(plain.tvl_usd);
    expect(wrapped.chain_tvl_usd).toBe(plain.chain_tvl_usd);
    expect(wrapped.scoped_chain).toBe(plain.scoped_chain);
    expect(wrapped.verdict).toBe(plain.verdict);
  });

  it.each(GRADED.filter(([q]) => q !== 'Total value locked in Aave V3 on Ethereum'))(
    'end to end: %j gets past resolution (no PROTOCOL_NOT_FOUND)',
    async (input) => {
      const err = await rejection(handleTvl({ protocol: input }, { fetchImpl: seedFetch() }));
      expect(err.code).not.toBe('PROTOCOL_NOT_FOUND');
    },
  );
});

describe('regression: every already-accepted input keeps its exact target', () => {
  it.each(REGRESSION)('%j resolves before the wrapper link and never reaches it', (input) => {
    const direct = firstThree(input, PROTOCOLS, CHAINS);
    expect(direct).not.toBeNull();
    // The wrapper link cannot fire: the chain above it already decided.
    expect(stripTvlWrapper(input)).toBeNull();
    expect(handlerTarget(input)).toEqual(direct);
  });

  it.each([
    ['aave v3', 'protocol', 'aave-v3'],
    ['uniswap v3', 'protocol', 'uniswap-v3'],
    ['lido', 'protocol', 'lido'],
    ['makerdao', 'protocol', 'sky-lending'],
    ['ethereum', 'chain', 'Ethereum'],
  ])('pins the unchanged target for %j', (input, kind, name) => {
    const target = handlerTarget(input);
    expect(target?.kind).toBe(kind);
    expect(target?.kind === 'chain' ? target.chain : target?.slug).toBe(name);
  });
});

describe('refusal class label', () => {
  it('logs has_wrapper_phrase true only for a sentence-shaped refusal, and never the text', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((m: unknown) => {
      lines.push(String(m));
    });
    try {
      recordRequestCompletion('/v1/tvl', 422, 5, {
        query: { protocol: 'total value locked in Zq31337 on ethereum' },
        errorCode: 'PROTOCOL_NOT_FOUND',
      });
      recordRequestCompletion('/v1/tvl', 422, 5, {
        query: { protocol: 'zq31337-on-ethereum' },
        errorCode: 'PROTOCOL_NOT_FOUND',
      });
    } finally {
      spy.mockRestore();
    }
    const refusal = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((o) => o.event === 'refusal_param_class');
    expect(refusal).toHaveLength(2);
    expect(refusal[0]).toMatchObject({ has_wrapper_phrase: true, has_space: true });
    expect(refusal[1]).toMatchObject({ has_wrapper_phrase: false });
    const all = lines.join('\n');
    for (const raw of ['Zq31337', '31337']) expect(all).not.toContain(raw);
  });
});
