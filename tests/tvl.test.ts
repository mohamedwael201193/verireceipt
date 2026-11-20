// TVL handler tests (vitest).
// Unit tests use LOCAL FIXTURES via an injected fetch transport (same seam as
// the filings handler) — no network, deterministic. Live tests hit the real
// DeFiLlama API with the default fetch and report the exact numbers observed.

import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApiError } from '../src/core/errors';
import {
  __clearTvlCachesForTests,
  __clearTvlDiskCacheForTests,
  __seedTvlCachesForTests,
  __seedTvlDiskCacheForTests,
  __setTvlListsCacheDirForTests,
  dominantChainTvl,
  handleTvl,
  parseChainReading,
  parseProtocolReading,
  resolveTvlTarget,
  warmLists,
} from '../src/handlers/tvl';

// ---------------------------------------------------------------------------
// Now-relative fixture dates (round 5): every fixture "latest" point is
// derived from Date.now() at module load, so the suite passes on any date.
// The 7-day latest-point recency bound (B2a) made fixed 2026-11-20 dates
// self-expire ~2026-11-27: on 2026-11-28 the fixed latest points were >7d
// old and every success-path fixture test failed on the horizon, not on
// the code. Relative offsets are preserved to the day (1d between points,
// 72d / 97d / 136d stale positives, +1307s solarflare latest) — day-exact,
// not second-exact: the solarflare stale-positive gap drifted 9,600s on
// re-basing (R4 8,391,707s → R5 8,382,107s); only the absolute anchor moved. Live observation dates in comments (2026-11-20)
// are provenance, not fixture dates, and stay. Intentionally-stale shapes
// (renvm / mirror / oxygen, 2023-2025) stay fixed: their staleness IS
// the test. The two 60s-budget elapsed assertions use performance.now()
// (a monotonic clock) instead of Date.now() so they also hold under a
// mocked clock (round-5 mock-artifact fix).
// ---------------------------------------------------------------------------
const DAY_S = 86400;
const NOW_S = Math.floor(Date.now() / 1000);
const LATEST_S = NOW_S;
const PREV_S = NOW_S - DAY_S;
const LATEST_ISO = new Date(LATEST_S * 1000).toISOString();
const PREV_ISO = new Date(PREV_S * 1000).toISOString();
const LATEST_DATE = LATEST_ISO.slice(0, 10);

// ---------------------------------------------------------------------------
// Local fixtures (values copied from real DeFiLlama responses observed
// 2026-11-20; small snapshots used as deterministic test data)
// ---------------------------------------------------------------------------

const PROTOCOLS_FIXTURE = [
  { slug: 'aave-v3', name: 'Aave V3', symbol: 'AAVE' },
  // Live tvl (2026-11-20): v3 $1,254,368,528 > v4 $1,026,499,429 — the
  // round-4 largest-wins sort keeps "uniswap" -> v3 even if v4 is listed
  // first; without tvl here the sort would tie and list order would decide.
  { slug: 'uniswap-v3', name: 'Uniswap V3', symbol: 'UNI', tvl: 1254368528 },
  { slug: 'uniswap-v4', name: 'Uniswap V4', symbol: 'UNI', tvl: 1026499429 },
  { slug: 'lido', name: 'Lido', symbol: 'LDO' },
  // Live DeFiLlama lists chains as dummy protocol entries (tvl null, module
  // dummy.js) — e.g. slug "ethereum". They must defer to the real chain of
  // the same name. The category is NOT the signal: live dummies carry
  // "Chain", "Canonical Bridge", "Yield", "Gaming", "Chain Bribes", ...
  { slug: 'ethereum', name: 'Ethereum', symbol: '-', category: 'Chain', tvl: null },
  { slug: 'solana', name: 'Solana', symbol: 'SOL', category: 'Canonical Bridge', tvl: null },
  { slug: 'tezos', name: 'Tezos', symbol: 'XTZ', category: 'Canonical Bridge', tvl: null },
  { slug: 'bitcoin', name: 'Bitcoin', symbol: 'BTC', category: 'Canonical Bridge', tvl: null },
  { slug: 'avalanche', name: 'Avalanche', symbol: 'AVAX', category: 'Canonical Bridge', tvl: null },
  { slug: 'cardano', name: 'Cardano', symbol: 'ADA', category: 'Chain', tvl: null },
  { slug: 'acala', name: 'Acala', symbol: 'ACA', category: 'Chain', tvl: null },
  { slug: 'merlin', name: 'Merlin', symbol: 'MERL', category: 'Chain', tvl: null },
  { slug: 'bouncebit', name: 'BounceBit', symbol: 'BB', category: 'Chain', tvl: null },
  { slug: 'oasys', name: 'Oasys', symbol: 'OAS', category: 'Chain', tvl: null },
  { slug: 'berachain', name: 'Berachain', symbol: 'BERA', category: 'Chain', tvl: null },
  // B2 decoys (live 2026-11-20): real protocols that carry a chain's token
  // symbol, and the chain's own TVL-less dummy. The chain must win by its
  // own name over the symbol-steal.
  { slug: 'metis', name: 'Metis', symbol: 'METIS', category: 'Canonical Bridge', tvl: null },
  { slug: 'metis-bridge', name: 'Metis Bridge', symbol: 'METIS', category: 'Canonical Bridge', tvl: 6210807 },
  { slug: 'flow', name: 'Flow', symbol: 'FLOW', category: 'Chain', tvl: null },
  { slug: 'flowswap-v3', name: 'FlowSwap V3', symbol: 'FLOW', category: 'Dexs', tvl: 2379104 },
  { slug: 'flare', name: 'Flare', symbol: 'FLR', category: 'Chain', tvl: null },
  { slug: 'solarflare', name: 'Solarflare', symbol: 'FLARE', category: 'Dexs', tvl: 0 },
  { slug: 'sonic', name: 'Sonic', symbol: 'S', category: 'Chain', tvl: null },
  { slug: 'sonic-icp', name: 'Sonic ICP', symbol: 'SONIC', category: 'Dexs', tvl: 1233 },
  { slug: 'ton', name: 'TON', symbol: 'GRAM', category: 'Chain', tvl: null },
  { slug: 'tokamak-network-staking', name: 'Tokamak Network Staking', symbol: 'TON', category: 'Staking Pool', tvl: 0 },
  { slug: 'stable', name: 'Stable', symbol: '-', category: 'Chain', tvl: null },
  { slug: 'usdfi-lending', name: 'USDFI Lending', symbol: 'STABLE', category: 'Lending', tvl: 70856 },
  // B1 decoys (live 2026-11-20): TVL-carrying protocols sharing a chain
  // ticker — the chain must still win the ticker query.
  { slug: 'solana-farm', name: 'Solana Farm', symbol: 'SOL', category: 'Dexs', tvl: 175 },
  { slug: 'avalanche-core-bridge', name: 'Avalanche Core Bridge', symbol: 'AVAX', category: 'Canonical Bridge', tvl: 120338559 },
  { slug: 'ethereum-foundation', name: 'Ethereum Foundation', symbol: 'ETH', category: 'Foundation', tvl: null },
  // "dot": no Polkadot chain exists in /v2/chains (live 2026-11-20), so the
  // genuine protocol match wins — acala-lcdot, the largest DOT carrier.
  // acala-liquid-staking ($1,310,074 live) is the second-largest DOT
  // carrier and is listed FIRST here on purpose: the round-4 sort must
  // still pick acala-lcdot by tvl, not by list order.
  { slug: 'acala-liquid-staking', name: 'Acala Liquid Staking', symbol: 'DOT', category: 'Liquid Staking', tvl: 1310074 },
  { slug: 'acala-lcdot', name: 'Acala LCDOT', symbol: 'DOT', category: 'Liquid Staking', tvl: 1669938 },
  // "the": first-wins in list order — thena-integral is the largest THE
  // carrier live (1,629,700 vs thena-v1 1,217,665).
  { slug: 'thena-integral', name: 'THENA INTEGRAL', symbol: 'THE', category: 'Dexs', tvl: 1629700 },
  { slug: 'thena-v1', name: 'THENA V1', symbol: 'THE', category: 'Dexs', tvl: 1217665 },
  // 1–2-char live shapes (must NOT resolve under the >= 3-char rule):
  // "aa" -> astarter-launch-ispo (symbol AA), "x" -> slug "x",
  // "us" -> ultrasolid-v3 (symbol US).
  { slug: 'astarter-launch-ispo', name: 'Astarter Launch ISPO', symbol: 'AA', category: 'Staking Pool', tvl: 31731 },
  { slug: 'x', name: 'X', symbol: 'X', category: 'Services', tvl: 0 },
  { slug: 'ultrasolid-v3', name: 'Ultrasolid V3', symbol: 'US', category: 'Dexs', tvl: 12345 },
  // "FRAX" is the slug of a real protocol (Frax) — it wins at step 1,
  // before the Fraxtal chain's FRAX ticker is consulted.
  { slug: 'frax', name: 'Frax', symbol: 'FRAX', category: 'Stablecoin', tvl: 1000000 },
  // Space-name chains whose protocol entry shares the exact name (live
  // 2026-11-20): the chain wins by its own name; each protocol stays
  // reachable by its slug.
  { slug: 'immutable-zkevm', name: 'Immutable zkEVM', symbol: 'IMX', category: 'Chain', tvl: 10894533 },
  { slug: 'zklink-nova', name: 'zkLink Nova', symbol: '-', category: 'Chain', tvl: 1603230 },
  { slug: 'zero-network', name: 'Zero Network', symbol: '-', category: 'Chain', tvl: 416616 },
  { slug: 'form-network', name: 'Form Network', symbol: 'FORM', category: 'Chain', tvl: 26066 },
  // ...but a same-named entry that DOES carry TVL is a real protocol and wins.
  // Live: Fraxtal, category "Chain", symbol FXTL, tvl 160,967,170, real
  // 662-point history (verified 2026-11-20; the old fixture said FRAX /
  // 160,886,763 — both stale).
  { slug: 'fraxtal', name: 'Fraxtal', symbol: 'FXTL', category: 'Chain', tvl: 160967170 },
  // Symbol collision: BNB is shared. Live: binance-cex is the largest
  // protocol carrying it (tvl 109,405,735,889) and must win largest-wins.
  // The second entry is fixture-only (deterministic largest-wins pin, not
  // a live claim) and is listed FIRST on purpose: the round-4 sort must
  // still pick binance-cex by tvl, not by list order.
  { slug: 'bnb-staking', name: 'BNB Staking', symbol: 'BNB', tvl: 1000 },
  { slug: 'binance-cex', name: 'Binance CEX', symbol: 'BNB', tvl: 109405735889 },
  // Round-4 BLOCKER 1 shadows (live 2026-11-20): TVL-carrying protocols
  // whose slug/name starts with a chain name. Before the reorder they
  // won the prefix step over the chain; after it the chain prefix wins.
  // Values are the live tvl from the 2026-11-20 lists.
  { slug: 'solayer-restaking', name: 'Solayer Restaking', symbol: 'LAYER', category: 'Restaking', tvl: 7224796 },
  { slug: 'ether.fi-stake', name: 'ether.fi Stake', symbol: 'ETHFI', category: 'Liquid Staking', tvl: 3288909646 },
  { slug: 'ethena-usde', name: 'Ethena USDe', symbol: 'ENA', category: 'Basis Trading', tvl: 4894607846 },
  { slug: 'flarebank-bank', name: 'FlareBank BANK', symbol: 'BANK', category: 'Reserve Currency', tvl: 167103 },
  { slug: 'sonic-gateway', name: 'Sonic Gateway', symbol: '-', category: 'Canonical Bridge', tvl: 3420306 },
  { slug: 'bitcow', name: 'bitCow', symbol: '-', category: 'Dexs', tvl: 177931 },
  { slug: 'bouncebit-prime', name: 'BounceBit Prime', symbol: '-', category: 'Basis Trading', tvl: 11443688 },
  { slug: 'polygon-bridge', name: 'Polygon Bridge', symbol: 'POL', category: 'Canonical Bridge', tvl: 2153007964 },
  // Round-4 B2b placeholders with NO chain counterpart (live 2026-11-20):
  // tvl null, no chain named RenVM / Mirror / Oxygen exists. They must
  // never resolve as protocols — a query naming only one of them is a 422.
  // (Their live /protocol histories are dead feeds: renvm last point $0
  // @ 2025-06-11, mirror $0 @ 2023-10-12, oxygen $55,916 @ 2025-06-11 —
  // the B2a recency bound would 502 them even if they did resolve.)
  { slug: 'renvm', name: 'RenVM', symbol: 'REN', category: 'Bridge', tvl: null },
  { slug: 'mirror', name: 'Mirror', symbol: 'MIR', category: 'Derivatives', tvl: null },
  { slug: 'oxygen', name: 'Oxygen', symbol: 'OXY', category: 'Lending', tvl: null },
  // Round-4 M3 ambiguous tickers (live 2026-11-20): "bch" resolves by
  // protocol prefix to BCHPad (symbol BPAD, tvl $0 — its live history is
  // stale, so the live reading 502s); "xrp" is a prefix of the XRPL chain
  // name, so after the BLOCKER 1 reorder the XRPL chain wins the prefix
  // step. XRPL DEX (symbol "-", tvl $27,548,255 live) is listed so the
  // pre-reorder behaviour is visible in the fixture.
  { slug: 'bchpad', name: 'BCHPad', symbol: 'BPAD', category: 'Launchpad', tvl: 0 },
  { slug: 'xrpl-dex', name: 'XRPL DEX', symbol: '-', category: 'Dexs', tvl: 27548254 },
];

const CHAINS_FIXTURE = [
  { name: 'Ethereum', gecko_id: 'ethereum', tokenSymbol: 'ETH', tvl: 35974180659 },
  { name: 'Arbitrum', gecko_id: 'arbitrum', tvl: 123456789 },
  { name: 'Solana', gecko_id: 'solana', tokenSymbol: 'SOL', tvl: 888 },
  { name: 'Tezos', gecko_id: 'tezos', tokenSymbol: 'XTZ' },
  { name: 'Bitcoin', gecko_id: 'bitcoin', tokenSymbol: 'BTC', tvl: 3111736181 },
  { name: 'Avalanche', gecko_id: 'avalanche-2', tokenSymbol: 'AVAX', tvl: 537875458 },
  { name: 'Cardano', gecko_id: 'cardano', tokenSymbol: 'ADA', tvl: 43991420 },
  { name: 'Acala', gecko_id: 'acala', tokenSymbol: 'ACA', tvl: 186562 },
  { name: 'Merlin', gecko_id: 'merlin-chain', tokenSymbol: 'MERL', tvl: 6430552 },
  { name: 'BounceBit', gecko_id: 'bouncebit', tokenSymbol: 'BB', tvl: 0 },
  { name: 'Oasys', gecko_id: 'oasys', tokenSymbol: 'OAS', tvl: 168250 },
  { name: 'Berachain', gecko_id: 'berachain-bera', tokenSymbol: 'BERA', tvl: 26801061 },
  { name: 'Metis', gecko_id: 'metis-token', tokenSymbol: 'METIS', tvl: 1647261 },
  { name: 'Flow', gecko_id: 'flow', tokenSymbol: 'FLOW', tvl: 7864569 },
  { name: 'Flare', gecko_id: 'flare-networks', tokenSymbol: 'FLR', tvl: 134575332 },
  { name: 'Sonic', gecko_id: 'sonic-3', tokenSymbol: 'S', tvl: 11072500 },
  { name: 'TON', gecko_id: 'the-open-network', tokenSymbol: 'GRAM', tvl: 43575386 },
  { name: 'Stable', gecko_id: 'stable-2', tokenSymbol: 'STABLE', tvl: 71897470 },
  { name: 'Polygon', gecko_id: 'polygon-ecosystem-token', tokenSymbol: 'POL', tvl: 592168767 },
  { name: 'Fraxtal', gecko_id: 'frax-share', tokenSymbol: 'FRAX', tvl: 15628994 },
  { name: 'AB', gecko_id: 'newton-project', tokenSymbol: 'AB', tvl: 229765 },
  // Ambiguous ticker: BOTH BSC and Binance carry tokenSymbol BNB live, so
  // the chain-ticker step must NOT fire for "BNB" — binance-cex wins.
  { name: 'BSC', gecko_id: 'binance-smart-chain', tokenSymbol: 'BNB', tvl: 1000000 },
  { name: 'Binance', gecko_id: 'binance', tokenSymbol: 'BNB', tvl: 2000000 },
  // Round-4 M3 ambiguous tickers (live 2026-11-20, /v2/chains): BCH is
  // shared by Bitcoincash ($4,531,391) and smartBCH ($38,499); XRP is
  // shared by XRPL ($30,937,367) and XRPL EVM ($22,363). The chain-ticker
  // step must NOT fire for "bch" / "xrp" — both tickers are ambiguous.
  { name: 'Bitcoincash', gecko_id: 'bitcoin-cash', tokenSymbol: 'BCH', tvl: 4531391 },
  { name: 'smartBCH', gecko_id: null, tokenSymbol: 'BCH', tvl: 38499 },
  { name: 'XRPL', gecko_id: 'ripple', tokenSymbol: 'XRP', tvl: 30937366 },
  { name: 'XRPL EVM', gecko_id: 'ripple', tokenSymbol: 'XRP', tvl: 22362 },
  // Space-name chains (live 2026-11-20; Zero Network / Form Network have
  // null gecko_id and null tokenSymbol in /v2/chains).
  { name: 'Immutable zkEVM', gecko_id: 'immutable-x', tokenSymbol: 'IMX', tvl: 10951111 },
  { name: 'zkLink Nova', gecko_id: 'zklink', tokenSymbol: 'ZKL', tvl: 0 },
  { name: 'Zero Network', gecko_id: null, tvl: 0 },
  { name: 'Form Network', gecko_id: null, tvl: 0 },
  // Held space-name chains (live 2026-11-20).
  { name: 'OP Mainnet', gecko_id: 'optimism', tokenSymbol: 'OP', tvl: 368230307 },
  { name: 'Arbitrum Nova', gecko_id: null, tvl: 146885 },
  { name: 'X Layer', gecko_id: 'okb', tvl: 208651302 },
  { name: 'Polygon zkEVM', gecko_id: null, tvl: 0 },
  { name: 'ZKsync Era', gecko_id: 'zksync', tokenSymbol: 'ZK', tvl: 10592383 },
  { name: 'Hyperliquid L1', gecko_id: 'hyperliquid', tokenSymbol: 'HYPE', tvl: 2219021508 },
];

// Real observed values: /protocol/aave-v3 last tvl point 15121752429 @
// the now-relative latest point (observed live 2026-11-20); currentChainTvls Ethereum 12931958948.41916 (dominant),
// Arbitrum 415494303.8637; Ethereum-borrowed must be ignored. The bare
// "borrowed" aggregate key (aave-v3 live: 10494199350.46) must be ignored too.
const AAVE_PROTOCOL_FIXTURE = {
  id: '1599',
  name: 'Aave V3',
  symbol: 'AAVE',
  tvl: [
    { date: PREV_S, totalLiquidityUSD: 15000000000 },
    { date: LATEST_S, totalLiquidityUSD: 15121752429 },
  ],
  currentChainTvls: {
    Ethereum: 12931958948.41916,
    Arbitrum: 415494303.8637,
    'Ethereum-borrowed': 8788295065.67177,
    borrowed: 10494199350.46,
  },
};

// Same protocol but with no per-chain split at all -> chain_tvl_usd null.
const LIDO_PROTOCOL_FIXTURE = {
  id: '1',
  name: 'Lido',
  symbol: 'LDO',
  tvl: [{ date: LATEST_S, totalLiquidityUSD: 30000000000 }],
};

// Real observed value: /v2/historicalChainTvl/Ethereum last point
// 35974180659 @ the now-relative latest point (observed live 2026-11-20).
const ETH_CHAIN_HISTORY_FIXTURE = [
  { date: PREV_S, tvl: 35000000000 },
  { date: LATEST_S, tvl: 35974180659 },
];

// Live observed value: /protocol/binance-cex tvl 109,405,735,889.
const BINANCE_CEX_PROTOCOL_FIXTURE = {
  id: '2',
  name: 'Binance CEX',
  symbol: 'BNB',
  tvl: [{ date: LATEST_S, totalLiquidityUSD: 109405735889 }],
  currentChainTvls: { Ethereum: 1000000000 },
};

// Live-shape chain histories for the fixture transport (values from the
// real /v2/historicalChainTvl responses observed 2026-11-20; one point
// unless the case needs two). BounceBit / Polygon zkEVM carry the live
// dead-chain shape: last positive months back, latest point $0 today.
const CHAIN_HISTORIES: Record<string, Array<{ date: number; tvl: number }>> = {
  Ethereum: ETH_CHAIN_HISTORY_FIXTURE,
  Solana: [{ date: LATEST_S, tvl: 4686171520 }],
  Bitcoin: [{ date: LATEST_S, tvl: 3111736181 }],
  Avalanche: [{ date: LATEST_S, tvl: 537875458 }],
  Cardano: [{ date: LATEST_S, tvl: 43991420 }],
  Metis: [{ date: LATEST_S, tvl: 1647261 }],
  Flow: [{ date: LATEST_S, tvl: 7864569 }],
  Flare: [{ date: LATEST_S, tvl: 134575332 }],
  Sonic: [{ date: LATEST_S, tvl: 11072500 }],
  TON: [{ date: LATEST_S, tvl: 43575386 }],
  Stable: [{ date: LATEST_S, tvl: 71897470 }],
  Polygon: [{ date: LATEST_S, tvl: 592168767 }],
  Tezos: [{ date: LATEST_S, tvl: 123456 }],
  BounceBit: [
    { date: LATEST_S - 72 * DAY_S, tvl: 1 },
    { date: LATEST_S, tvl: 0 },
  ],
  Bitcoincash: [{ date: LATEST_S, tvl: 4531391 }],
  XRPL: [{ date: LATEST_S, tvl: 30937366 }],
  'Polygon zkEVM': [
    { date: LATEST_S - 136 * DAY_S, tvl: 330113 },
    { date: LATEST_S, tvl: 0 },
  ],
};

// Live-shape protocol payloads for slugs the fixture transport must answer
// beyond aave-v3 / lido / binance-cex.
const PROTOCOL_PAYLOADS: Record<string, unknown> = {
  'acala-lcdot': {
    tvl: [{ date: LATEST_S, totalLiquidityUSD: 1669938 }],
    currentChainTvls: { Acala: 1669938 },
  },
  'thena-integral': {
    tvl: [{ date: LATEST_S, totalLiquidityUSD: 1629700 }],
    currentChainTvls: { 'BNB Chain': 1629700 },
  },
  // Fixture-only payload (pins bch -> bchpad RESOLUTION end to end; the
  // live bchpad history was stale at the R4 live run, so the live reading
  // 502s then — re-probed live 2026-11-20 11:26 UTC, latest $0 @ 08:49:59 UTC,
  // so it now verifies $0).
  bchpad: {
    tvl: [{ date: LATEST_S, totalLiquidityUSD: 0 }],
    currentChainTvls: {},
  },
};

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
    if (u === 'https://api.llama.fi/protocol/binance-cex') {
      return new Response(JSON.stringify(BINANCE_CEX_PROTOCOL_FIXTURE), { status: 200 });
    }
    const protoMatch = u.match(/^https:\/\/api\.llama\.fi\/protocol\/([^/]+)$/);
    if (protoMatch) {
      const payload = PROTOCOL_PAYLOADS[decodeURIComponent(protoMatch[1])];
      if (payload !== undefined) {
        return new Response(JSON.stringify(payload), { status: 200 });
      }
    }
    const chainMatch = u.match(/^https:\/\/api\.llama\.fi\/v2\/historicalChainTvl\/(.+)$/);
    if (chainMatch) {
      const history = CHAIN_HISTORIES[decodeURIComponent(chainMatch[1])];
      if (history !== undefined) {
        return new Response(JSON.stringify(history), { status: 200 });
      }
    }
    return new Response('not found in fixture transport', { status: 404 });
  }) as typeof fetch;
}

/**
 * Stub transport for the lists endpoints: the lists URLs answer with the
 * given status/body, while the /protocol/aave-v3 reading still answers from
 * the fixture (so a test can tell whether the handler served stale lists or
 * failed closed). Tracks how often each lists URL was called.
 */
function listsStubFetch(
  status: number,
  body: string,
): { fetchImpl: typeof fetch; listsCalls: string[] } {
  const listsCalls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    if (u === 'https://api.llama.fi/protocols' || u === 'https://api.llama.fi/v2/chains') {
      listsCalls.push(u);
      return new Response(body, { status });
    }
    if (u === 'https://api.llama.fi/protocol/aave-v3') {
      return new Response(JSON.stringify(AAVE_PROTOCOL_FIXTURE), { status: 200 });
    }
    return new Response('not found in stub transport', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, listsCalls };
}

/**
 * Stub transport for the lists endpoints with SEPARATE bodies per list:
 * the lists URLs answer with the given status/bodies, while the
 * /protocol/aave-v3 reading still answers from the fixture (so a test can
 * tell whether the handler served stale lists, fresh lists, or failed
 * closed). Tracks how often each lists URL was called.
 */
function dualListsStubFetch(
  status: number,
  protocolsBody: string,
  chainsBody: string,
): { fetchImpl: typeof fetch; listsCalls: string[] } {
  const listsCalls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    if (u === 'https://api.llama.fi/protocols') {
      listsCalls.push(u);
      return new Response(protocolsBody, { status });
    }
    if (u === 'https://api.llama.fi/v2/chains') {
      listsCalls.push(u);
      return new Response(chainsBody, { status });
    }
    if (u === 'https://api.llama.fi/protocol/aave-v3') {
      return new Response(JSON.stringify(AAVE_PROTOCOL_FIXTURE), { status: 200 });
    }
    return new Response('not found in stub transport', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, listsCalls };
}

beforeEach(() => {
  __clearTvlCachesForTests();
  // Disk cache goes to a fresh temp dir per test: no test may read or write
  // the repo's real ./data cache, and no test may leak disk state to another.
  __setTvlListsCacheDirForTests(mkdtempSync(join(tmpdir(), 'tvl-test-')));
  __clearTvlDiskCacheForTests();
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

  it('>512 chars -> 400 PROTOCOL_TOO_LONG (513-char input)', async () => {
    try {
      await handleTvl({ protocol: 'x'.repeat(513) }, { fetchImpl: fixtureFetch() });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 400, 'PROTOCOL_TOO_LONG');
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

  it('"solana" resolves as a CHAIN: its dummy entry is category "Canonical Bridge", tvl null', () => {
    // Live: Solana's protocols-list entry is category "Canonical Bridge"
    // with tvl null — the old category === "Chain" check let it win as a
    // protocol, and /protocol/solana returns tvl: [] -> 502, while the live
    // chain TVL is $4,704,309,160. The skip is TVL-based, not category-based.
    expect(resolveTvlTarget('solana', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'chain',
      chain: 'Solana',
      displayName: 'Solana',
      confidence: 1.0,
    });
  });

  it('a same-named entry WITH tvl still wins as a protocol ("fraxtal", tvl 160,967,170, symbol FXTL)', () => {
    expect(resolveTvlTarget('fraxtal', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'protocol',
      slug: 'fraxtal',
      displayName: 'Fraxtal',
      confidence: 1.0,
    });
  });

  it('"uniswap" prefix-resolves to uniswap-v3 with confidence 0.9 (largest TVL wins, not v4)', () => {
    const target = resolveTvlTarget('uniswap', PROTOCOLS_FIXTURE, CHAINS_FIXTURE);
    expect(target?.kind).toBe('protocol');
    if (target?.kind === 'protocol') {
      expect(target.slug).toBe('uniswap-v3');
      expect(target.confidence).toBe(0.9);
    }
  });

  it('"tezo" prefix-resolves to the Tezos chain, not the tvl-less "tezos" stub', () => {
    expect(resolveTvlTarget('tezo', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'chain',
      chain: 'Tezos',
      displayName: 'Tezos',
      confidence: 0.9,
    });
  });

  it('sentinel symbol "-" never matches (DeFiLlama null-symbol sentinel)', () => {
    expect(resolveTvlTarget('-', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toBeNull();
  });

  it('1-char "a" never resolves (the >= 3-char rule covers exact matches too)', () => {
    expect(resolveTvlTarget('a', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toBeNull();
  });

  it('2-char "ab" never resolves — even though chain AB exists in the fixture (live: AB chain TVL $229,765)', () => {
    expect(resolveTvlTarget('ab', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toBeNull();
  });

  it('shared symbol "BNB" resolves first-wins to binance-cex (largest carrier)', () => {
    const target = resolveTvlTarget('BNB', PROTOCOLS_FIXTURE, CHAINS_FIXTURE);
    expect(target?.kind).toBe('protocol');
    if (target?.kind === 'protocol') {
      expect(target.slug).toBe('binance-cex');
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

  it('dominant chain ignores the bare "borrowed" aggregate key', () => {
    expect(
      dominantChainTvl({ Ethereum: 100, borrowed: 10494199350.46 }),
    ).toBe(100);
    expect(dominantChainTvl({ borrowed: 10494199350.46 })).toBeNull();
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
      asOf: LATEST_ISO,
    });
  });

  it('parseProtocolReading with no chain split -> chainTvlUsd null', () => {
    expect(parseProtocolReading(LIDO_PROTOCOL_FIXTURE)).toEqual({
      tvlUsd: 30000000000,
      chainTvlUsd: null,
      asOf: LATEST_ISO,
    });
  });

  it('parseProtocolReading skips a negative latest point, falls back to the previous positive point', () => {
    expect(
      parseProtocolReading({
        tvl: [
          { date: PREV_S, totalLiquidityUSD: 15000000000 },
          { date: LATEST_S, totalLiquidityUSD: -5 },
        ],
      }),
    ).toEqual({
      tvlUsd: 15000000000,
      chainTvlUsd: null,
      asOf: PREV_ISO,
    });
  });

  it('parseProtocolReading with an all-negative history -> 502 DEFILLAMA_BAD_RESPONSE', () => {
    try {
      parseProtocolReading({
        tvl: [
          { date: PREV_S, totalLiquidityUSD: -1 },
          { date: LATEST_S, totalLiquidityUSD: -5 },
        ],
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });

  it('parseChainReading takes the last history point', () => {
    expect(parseChainReading(ETH_CHAIN_HISTORY_FIXTURE)).toEqual({
      tvlUsd: 35974180659,
      asOf: LATEST_ISO,
    });
  });

  it('parseChainReading skips a negative latest point, falls back to the previous positive point', () => {
    expect(
      parseChainReading([
        { date: PREV_S, tvl: 35000000000 },
        { date: LATEST_S, tvl: -5 },
      ]),
    ).toEqual({
      tvlUsd: 35000000000,
      asOf: PREV_ISO,
    });
  });

  it('parseChainReading with an all-negative history -> 502 DEFILLAMA_BAD_RESPONSE', () => {
    try {
      parseChainReading([
        { date: PREV_S, tvl: -1 },
        { date: LATEST_S, tvl: -5 },
      ]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });
});

describe('handleTvl with fixture transport', () => {
  it('envelope shape for protocol "aave-v3"', async () => {
    const out = await handleTvl({ protocol: 'aave-v3' }, { fetchImpl: fixtureFetch() });
    expect(out.protocol_or_chain).toBe('aave-v3');
    expect(out.tvl_usd).toBe(15121752429);
    expect(out.chain_tvl_usd).toBe(12931958948.41916);
    expect(out.as_of).toBe(LATEST_ISO);
    expect(out.answer).toBe(`Aave V3 has a total value locked of $15,121,752,429 as of ${LATEST_DATE}.`);
    expect(out.verdict).toBe('verified');
    expect(out.confidence).toBe(1.0);
    expect(out.source).toBe('DeFiLlama API (https://api.llama.fi/protocol/aave-v3)');
    const receipt = out.receipt as Record<string, unknown>;
    expect(receipt).toBeDefined();
    expect(typeof receipt.receipt_id).toBe('string');
    expect((receipt.receipt_id as string).startsWith('rcpt_')).toBe(true);
    expect(receipt.intent).toBe('TVL_LOOKUP_GENERAL');
    expect(receipt.upstream_url).toBe('https://api.llama.fi/protocol/aave-v3');
    expect(receipt.raw_response_sha256).toMatch(/^[0-9a-f]{64}$/);
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
    expect(out.as_of).toBe(LATEST_ISO);
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

  it('"-" (sentinel symbol) -> 422, not a confident match', async () => {
    try {
      await handleTvl({ protocol: '-' }, { fetchImpl: fixtureFetch() });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 422, 'PROTOCOL_NOT_FOUND');
    }
  });

  it('1-char "a" -> 422, not a prefix guess', async () => {
    try {
      await handleTvl({ protocol: 'a' }, { fetchImpl: fixtureFetch() });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 422, 'PROTOCOL_NOT_FOUND');
    }
  });

  it('2-char "ab" -> 422, not a prefix guess', async () => {
    try {
      await handleTvl({ protocol: 'ab' }, { fetchImpl: fixtureFetch() });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 422, 'PROTOCOL_NOT_FOUND');
    }
  });

  it('"BNB" resolves first-wins to binance-cex through the handler', async () => {
    const out = await handleTvl({ protocol: 'BNB' }, { fetchImpl: fixtureFetch() });
    expect(out.protocol_or_chain).toBe('binance-cex');
    expect(out.tvl_usd).toBe(109405735889);
    expect(out.confidence).toBe(0.9);
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

describe('handleTvl stale-cache bounds (stubbed lists)', () => {
  const STALE_25H = Date.now() - 25 * 60 * 60 * 1000;
  const STALE_8D = Date.now() - 8 * 24 * 60 * 60 * 1000;

  it('500 with a <7d stale cache -> stale lists served (not a 502)', async () => {
    __seedTvlCachesForTests(PROTOCOLS_FIXTURE, CHAINS_FIXTURE, STALE_25H);
    const { fetchImpl, listsCalls } = listsStubFetch(500, 'upstream error');
    const out = await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
    expect(out.protocol_or_chain).toBe('aave-v3');
    expect(out.tvl_usd).toBe(15121752429);
    expect(listsCalls.length).toBeGreaterThan(0);
  });

  it('500 with a >7d stale cache -> 502 (stale bound exceeded)', async () => {
    __seedTvlCachesForTests(PROTOCOLS_FIXTURE, CHAINS_FIXTURE, STALE_8D);
    const { fetchImpl } = listsStubFetch(500, 'upstream error');
    try {
      await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_UNAVAILABLE');
    }
  });

  it('403 with a seeded stale cache -> 502 (4xx never reuses stale)', async () => {
    __seedTvlCachesForTests(PROTOCOLS_FIXTURE, CHAINS_FIXTURE, STALE_25H);
    const { fetchImpl } = listsStubFetch(403, 'forbidden');
    try {
      await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_UNAVAILABLE');
    }
  });

  it('malformed 200 (HTML body) with a seeded stale cache -> 502 (no stale reuse)', async () => {
    __seedTvlCachesForTests(PROTOCOLS_FIXTURE, CHAINS_FIXTURE, STALE_25H);
    const { fetchImpl } = listsStubFetch(200, '<html>not json</html>');
    try {
      await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });

  it('no cache at all + lists fetch fails -> 502 DEFILLAMA_UNAVAILABLE', async () => {
    const failing: typeof fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    try {
      await handleTvl({ protocol: 'aave-v3' }, { fetchImpl: failing });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_UNAVAILABLE');
    }
  });

  it(
    'fetch that never resolves -> 502 within the cold-path lists budget (60s, round 4 / M1)',
    { timeout: 90000 },
    async () => {
      const hanging: typeof fetch = ((url: string | URL | Request, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal) {
            if (signal.aborted) {
              reject(new DOMException('aborted', 'AbortError'));
              return;
            }
            signal.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }
          // Never resolves on its own; only the AbortController ends it.
        });
      }) as typeof fetch;
      const started = performance.now();
      try {
        await handleTvl({ protocol: 'aave-v3' }, { fetchImpl: hanging });
        expect.unreachable('should have thrown');
      } catch (err) {
        const elapsed = performance.now() - started;
        expectApiError(err, 502, 'DEFILLAMA_UNAVAILABLE');
        expect(elapsed).toBeGreaterThanOrEqual(59000);
        expect(elapsed).toBeLessThan(70000);
      }
    },
  );
});

describe('handleTvl disk-persisted lists cache + warmLists (stubbed)', () => {
  it('persisted <24h disk cache is used with NO network call to the lists', async () => {
    __seedTvlDiskCacheForTests(PROTOCOLS_FIXTURE, CHAINS_FIXTURE, Date.now() - 60 * 60 * 1000);
    // The lists transport throws: the request can only succeed if loadLists
    // served the disk cache. (The background refresh triggered by the disk
    // path calls the same transport and swallows its failure, so the
    // throw itself is not counted — success of the request is the proof.)
    const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u === 'https://api.llama.fi/protocols' || u === 'https://api.llama.fi/v2/chains') {
        throw new Error('lists fetch must not be needed when disk cache is fresh');
      }
      if (u === 'https://api.llama.fi/protocol/aave-v3') {
        return new Response(JSON.stringify(AAVE_PROTOCOL_FIXTURE), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const out = await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
    expect(out.protocol_or_chain).toBe('aave-v3');
    expect(out.tvl_usd).toBe(15121752429);
  });

  it('persisted >7d disk cache is ignored (lists are fetched live)', async () => {
    __seedTvlDiskCacheForTests(
      PROTOCOLS_FIXTURE,
      CHAINS_FIXTURE,
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    );
    let listsCalls = 0;
    const counting = (async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u === 'https://api.llama.fi/protocols' || u === 'https://api.llama.fi/v2/chains') {
        listsCalls++;
      }
      return fixtureFetch()(url);
    }) as typeof fetch;
    const out = await handleTvl({ protocol: 'aave-v3' }, { fetchImpl: counting });
    expect(out.protocol_or_chain).toBe('aave-v3');
    expect(out.tvl_usd).toBe(15121752429);
    expect(listsCalls).toBe(2);
  });

  it('warmLists() populates the in-memory cache and writes the disk cache', async () => {
    await warmLists({ fetchImpl: fixtureFetch() });
    // Disk files exist in the test temp dir and carry a fresh fetched_at.
    // (The temp dir path is internal; existence is proven by a second
    // warmLists-free handler call with a lists-throwing transport.)
    const listsOnlyThrow: typeof fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'https://api.llama.fi/protocols' || u === 'https://api.llama.fi/v2/chains') {
        throw new Error('lists fetch must not be called after warmLists');
      }
      if (u === 'https://api.llama.fi/protocol/aave-v3') {
        return new Response(JSON.stringify(AAVE_PROTOCOL_FIXTURE), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const out = await handleTvl({ protocol: 'aave-v3' }, { fetchImpl: listsOnlyThrow });
    expect(out.protocol_or_chain).toBe('aave-v3');
    expect(out.tvl_usd).toBe(15121752429);
  });

  it('warmLists() writes tvl-protocols.json / tvl-chains.json to the cache dir', async () => {
    await warmLists({ fetchImpl: fixtureFetch() });
    // Re-derive the temp dir from the test hook: the dir holds exactly the
    // two persisted files with a fresh fetched_at. The temp dir itself is
    // not exported, so prove the write by clearing memory and serving a
    // request from disk alone (no network for the lists). The lists
    // transport throws: the request can only succeed if the disk files
    // warmLists wrote are read back. (The background refresh triggered by
    // the disk path calls the same transport and swallows its failure.)
    __clearTvlCachesForTests();
    const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u === 'https://api.llama.fi/protocols' || u === 'https://api.llama.fi/v2/chains') {
        throw new Error('lists fetch must not be called: disk cache must serve');
      }
      if (u === 'https://api.llama.fi/protocol/aave-v3') {
        return new Response(JSON.stringify(AAVE_PROTOCOL_FIXTURE), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const out = await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
    expect(out.protocol_or_chain).toBe('aave-v3');
    expect(out.tvl_usd).toBe(15121752429);
  });
});

// ---------------------------------------------------------------------------
// Round-3 pins: B1 (chain tickers), B2 (chain by its own name), B3 (>= 3 chars)
// ---------------------------------------------------------------------------

describe('resolveTvlTarget round-3 (B1 chain tickers)', () => {
  it.each([
    ['sol', 'Solana'],
    ['SOL', 'Solana'],
    ['btc', 'Bitcoin'],
    ['BTC', 'Bitcoin'],
    ['avax', 'Avalanche'],
    ['ada', 'Cardano'],
    ['eth', 'Ethereum'],
  ])('"%s" resolves to the %s chain (confidence 0.9)', (query, chain) => {
    expect(resolveTvlTarget(query, PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'chain',
      chain,
      displayName: chain,
      confidence: 0.9,
    });
  });

  it('"sol" resolves to the Solana chain even though solana-farm ($175) carries the SOL symbol', () => {
    const target = resolveTvlTarget('sol', PROTOCOLS_FIXTURE, CHAINS_FIXTURE);
    expect(target?.kind).toBe('chain');
  });

  it('"avax" resolves to the Avalanche chain even though avalanche-core-bridge ($120M) carries the AVAX symbol', () => {
    const target = resolveTvlTarget('avax', PROTOCOLS_FIXTURE, CHAINS_FIXTURE);
    expect(target?.kind).toBe('chain');
  });

  it('"eth" resolves to the Ethereum chain even though the ethereum-foundation dummy carries the ETH symbol', () => {
    const target = resolveTvlTarget('eth', PROTOCOLS_FIXTURE, CHAINS_FIXTURE);
    expect(target?.kind).toBe('chain');
  });

  it('"dot" resolves to acala-lcdot (genuine protocol): no Polkadot chain exists in /v2/chains live', () => {
    expect(resolveTvlTarget('dot', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'protocol',
      slug: 'acala-lcdot',
      displayName: 'Acala LCDOT',
      confidence: 0.9,
    });
  });

  it('"pol" resolves to the Polygon chain (unique POL ticker beats the polygon-bridge symbol match)', () => {
    expect(resolveTvlTarget('pol', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'chain',
      chain: 'Polygon',
      displayName: 'Polygon',
      confidence: 0.9,
    });
  });

  it('"xtz" resolves to the Tezos chain (unique XTZ ticker beats the tvl-less tezos dummy)', () => {
    expect(resolveTvlTarget('xtz', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'chain',
      chain: 'Tezos',
      displayName: 'Tezos',
      confidence: 0.9,
    });
  });

  it('"BNB" still resolves first-wins to binance-cex: the BNB ticker is ambiguous (BSC and Binance both carry it), so the chain-ticker step does not fire', () => {
    const target = resolveTvlTarget('BNB', PROTOCOLS_FIXTURE, CHAINS_FIXTURE);
    expect(target?.kind).toBe('protocol');
    if (target?.kind === 'protocol') {
      expect(target.slug).toBe('binance-cex');
      expect(target.confidence).toBe(0.9);
    }
  });

  it('"FRAX" resolves to the Frax protocol (slug exact wins before the Fraxtal chain ticker)', () => {
    expect(resolveTvlTarget('FRAX', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'protocol',
      slug: 'frax',
      displayName: 'Frax',
      confidence: 1.0,
    });
  });

  it('"  sol  " (surrounding whitespace) still resolves to the Solana chain', () => {
    expect(resolveTvlTarget('  sol  ', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'chain',
      chain: 'Solana',
      displayName: 'Solana',
      confidence: 0.9,
    });
  });
});

describe('resolveTvlTarget round-3 (B2 chain by its own name)', () => {
  it.each([
    ['metis', 'Metis'],
    ['flow', 'Flow'],
    ['flare', 'Flare'],
    ['sonic', 'Sonic'],
    ['ton', 'TON'],
    ['stable', 'Stable'],
  ])('"%s" resolves to the %s chain (confidence 1.0), not the protocol carrying its token symbol', (query, chain) => {
    expect(resolveTvlTarget(query, PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'chain',
      chain,
      displayName: chain,
      confidence: 1.0,
    });
  });

  it.each([
    ['bitcoin', 'Bitcoin'],
    ['acala', 'Acala'],
    ['merlin', 'Merlin'],
    ['bouncebit', 'BounceBit'],
    ['oasys', 'Oasys'],
    ['berachain', 'Berachain'],
  ])('"%s" resolves as the %s chain (TVL-less placeholder)', (query, chain) => {
    expect(resolveTvlTarget(query, PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'chain',
      chain,
      displayName: chain,
      confidence: 1.0,
    });
  });

  it('"Immutable zkEVM" resolves as the chain (chain-before-name); its slug still resolves as the protocol', () => {
    expect(resolveTvlTarget('Immutable zkEVM', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'chain',
      chain: 'Immutable zkEVM',
      displayName: 'Immutable zkEVM',
      confidence: 1.0,
    });
    expect(resolveTvlTarget('immutable-zkevm', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'protocol',
      slug: 'immutable-zkevm',
      displayName: 'Immutable zkEVM',
      confidence: 1.0,
    });
  });

  it.each(['zkLink Nova', 'Zero Network', 'Form Network'])(
    '"%s" resolves as the chain, not the same-named TVL-carrying protocol',
    (query) => {
      const target = resolveTvlTarget(query, PROTOCOLS_FIXTURE, CHAINS_FIXTURE);
      expect(target?.kind).toBe('chain');
    },
  );

  it.each([
    ['OP Mainnet', 'OP Mainnet'],
    ['Arbitrum Nova', 'Arbitrum Nova'],
    ['X Layer', 'X Layer'],
    ['Polygon zkEVM', 'Polygon zkEVM'],
    ['ZKsync Era', 'ZKsync Era'],
    ['Hyperliquid L1', 'Hyperliquid L1'],
  ])('held space-name chain "%s" resolves as the chain', (query, chain) => {
    expect(resolveTvlTarget(query, PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'chain',
      chain,
      displayName: chain,
      confidence: 1.0,
    });
  });
});

describe('resolveTvlTarget round-3 (B3 >= 3-char rule, exact matches included)', () => {
  it.each(['a', 'ab', 'aa', 'x', 's', 'go', 'us'])(
    '1–2-char "%s" never resolves (422), even though a live exact match exists for it',
    (query) => {
      expect(resolveTvlTarget(query, PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toBeNull();
    },
  );

  it('"the" still resolves to thena-integral (largest-wins: thena-integral is the largest THE carrier; no protocol named THENA exists)', () => {
    expect(resolveTvlTarget('the', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'protocol',
      slug: 'thena-integral',
      displayName: 'THENA INTEGRAL',
      confidence: 0.9,
    });
  });

  it('adversarial / malformed inputs never resolve (no injection, no SSRF-shaped input, no unicode confusion)', () => {
    const bad = [
      "' OR '1'='1",
      "aave-v3'; DROP TABLE receipts; --",
      '../../etc/passwd',
      '..%2f..%2fetc%2fpasswd',
      'https://evil.example/x',
      'http://169.254.169.254/latest/meta-data/',
      '${jndi:ldap://evil.example/x}',
      '<script>alert(1)</script>',
      'Sólana',
      'ＡＡＶＥ',
      '🚀',
      'aave-v3\u0000',
      'aave\u0000-v3',
      '\u0000',
      'aave-v3%00',
    ];
    for (const query of bad) {
      expect(resolveTvlTarget(query, PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toBeNull();
    }
  });

  it('"aave-v3\\n" resolves (trailing newline is trimmed like other whitespace)', () => {
    expect(resolveTvlTarget('aave-v3\n', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'protocol',
      slug: 'aave-v3',
      displayName: 'Aave V3',
      confidence: 1.0,
    });
  });
});

// ---------------------------------------------------------------------------
// Round-3 pins: B4 (7-day fallback bound, genuine zero, future-date guard)
// ---------------------------------------------------------------------------

describe('parseProtocolReading / parseChainReading round-3 (B4)', () => {
  // Live shapes: dates are now-relative (LATEST_S = now at module load,
  // round 5); the values are the live shapes observed 2026-11-20.
  it('bouncebit shape: $1 72d before the latest point, latest $0 today -> reports 0, never the stale $1', () => {
    expect(
      parseChainReading([
        { date: LATEST_S - 72 * DAY_S, tvl: 1 },
        { date: LATEST_S, tvl: 0 },
      ]),
    ).toEqual({ tvlUsd: 0, asOf: LATEST_ISO });
  });

  it('Polygon zkEVM shape: $330,113 136d before the latest point, latest $0 today -> reports 0', () => {
    expect(
      parseChainReading([
        { date: LATEST_S - 136 * DAY_S, tvl: 330113 },
        { date: LATEST_S, tvl: 0 },
      ]),
    ).toEqual({ tvlUsd: 0, asOf: LATEST_ISO });
  });

  it('solarflare shape: $10,138 97d before the latest point, latest $0 -> reports 0 (protocol path)', () => {
    expect(
      parseProtocolReading({
        tvl: [
          { date: LATEST_S - 97 * DAY_S, totalLiquidityUSD: 10138 },
          { date: LATEST_S + 1307, totalLiquidityUSD: 0 },
        ],
      }),
    ).toEqual({
      tvlUsd: 0,
      chainTvlUsd: null,
      asOf: new Date((LATEST_S + 1307) * 1000).toISOString(),
    });
  });

  it('all-zero history -> tvl_usd 0 (protocol and chain), not a 502', () => {
    expect(
      parseProtocolReading({
        tvl: [
          { date: PREV_S, totalLiquidityUSD: 0 },
          { date: LATEST_S, totalLiquidityUSD: 0 },
        ],
      }),
    ).toEqual({
      tvlUsd: 0,
      chainTvlUsd: null,
      asOf: LATEST_ISO,
    });
    expect(
      parseChainReading([
        { date: PREV_S, tvl: 0 },
        { date: LATEST_S, tvl: 0 },
      ]),
    ).toEqual({ tvlUsd: 0, asOf: LATEST_ISO });
  });

  it('negative latest + positive 10 days before -> 502 (beyond the 7-day bound)', () => {
    const latest = LATEST_S;
    const stale = latest - 10 * 86400;
    expect(() =>
      parseProtocolReading({
        tvl: [
          { date: stale, totalLiquidityUSD: 15000000000 },
          { date: latest, totalLiquidityUSD: -5 },
        ],
      }),
    ).toThrowError();
    try {
      parseProtocolReading({
        tvl: [
          { date: stale, totalLiquidityUSD: 15000000000 },
          { date: latest, totalLiquidityUSD: -5 },
        ],
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
    try {
      parseChainReading([
        { date: stale, tvl: 15000000000 },
        { date: latest, tvl: -5 },
      ]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });

  it('negative latest + positive 6 days before -> falls back (inside the 7-day bound)', () => {
    const latest = LATEST_S;
    const recent = latest - 6 * 86400;
    expect(
      parseProtocolReading({
        tvl: [
          { date: recent, totalLiquidityUSD: 15000000000 },
          { date: latest, totalLiquidityUSD: -5 },
        ],
      }),
    ).toEqual({
      tvlUsd: 15000000000,
      chainTvlUsd: null,
      asOf: new Date(recent * 1000).toISOString(),
    });
    expect(
      parseChainReading([
        { date: recent, tvl: 15000000000 },
        { date: latest, tvl: -5 },
      ]),
    ).toEqual({ tvlUsd: 15000000000, asOf: new Date(recent * 1000).toISOString() });
  });

  it('negative latest + positive exactly 7 days before -> falls back (bound is inclusive)', () => {
    const latest = LATEST_S;
    const edge = latest - 7 * 86400;
    expect(
      parseChainReading([
        { date: edge, tvl: 15000000000 },
        { date: latest, tvl: -5 },
      ]),
    ).toEqual({ tvlUsd: 15000000000, asOf: new Date(edge * 1000).toISOString() });
  });

  it('empty history -> 502 (protocol and chain)', () => {
    try {
      parseProtocolReading({ tvl: [] });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
    try {
      parseChainReading([]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });

  it('missing / null / non-array history -> 502', () => {
    for (const bad of [{}, { tvl: null }, { tvl: 'nope' }, { tvl: [null, undefined] }]) {
      try {
        parseProtocolReading(bad as never);
        expect.unreachable('should have thrown');
      } catch (err) {
        expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
      }
    }
    for (const bad of [null, undefined, {}, 'nope', [null]]) {
      try {
        parseChainReading(bad as never);
        expect.unreachable('should have thrown');
      } catch (err) {
        expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
      }
    }
  });

  it('huge history (5,000 points) still returns the last point', () => {
    const lastDate = LATEST_S; // now-relative (round 5): was a fixed 2026-11-20 date
    const points = Array.from({ length: 5000 }, (_, i) => ({
      date: lastDate - (4999 - i) * 86400,
      tvl: 1000 + i,
    }));
    expect(parseChainReading(points)).toEqual({
      tvlUsd: 5999,
      asOf: new Date(lastDate * 1000).toISOString(),
    });
  });

  it('future-dated latest point (now + 2d) is skipped; the earlier positive point is served', () => {
    const nowS = Math.floor(Date.now() / 1000);
    expect(
      parseChainReading([
        { date: nowS - 86400, tvl: 123456 },
        { date: nowS + 2 * 86400, tvl: 999999 },
      ]),
    ).toEqual({ tvlUsd: 123456, asOf: new Date((nowS - 86400) * 1000).toISOString() });
    expect(
      parseProtocolReading({
        tvl: [
          { date: nowS - 86400, totalLiquidityUSD: 123456 },
          { date: nowS + 2 * 86400, totalLiquidityUSD: 999999 },
        ],
      }),
    ).toEqual({
      tvlUsd: 123456,
      chainTvlUsd: null,
      asOf: new Date((nowS - 86400) * 1000).toISOString(),
    });
  });

  it('all-future history -> 502 (no usable point)', () => {
    const nowS = Math.floor(Date.now() / 1000);
    try {
      parseChainReading([{ date: nowS + 3 * 86400, tvl: 123456 }]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });

  it('a point within the 24h future tolerance (now + 12h) is still accepted', () => {
    const nowS = Math.floor(Date.now() / 1000);
    expect(parseChainReading([{ date: nowS + 12 * 3600, tvl: 777 }])).toEqual({
      tvlUsd: 777,
      asOf: new Date((nowS + 12 * 3600) * 1000).toISOString(),
    });
  });
});

// ---------------------------------------------------------------------------
// Round-3 pins: handler end-to-end (B1/B2/B3), refusal matrix, adversarial
// ---------------------------------------------------------------------------

describe('handleTvl round-3 end-to-end (B1/B2 tickers and names)', () => {
  it.each([
    ['sol', 'Solana', 4686171520, 0.9],
    ['btc', 'Bitcoin', 3111736181, 0.9],
    ['avax', 'Avalanche', 537875458, 0.9],
    ['eth', 'Ethereum', 35974180659, 0.9],
  ])('"%s" -> %s chain TVL via the handler', async (query, chain, tvl, conf) => {
    const out = await handleTvl({ protocol: query }, { fetchImpl: fixtureFetch() });
    expect(out.protocol_or_chain).toBe(chain);
    expect(out.tvl_usd).toBe(tvl);
    expect(out.chain_tvl_usd).toBe(tvl);
    expect(out.verdict).toBe('verified');
    expect(out.confidence).toBe(conf);
  });

  it('"dot" -> acala-lcdot protocol via the handler (no Polkadot chain live)', async () => {
    const out = await handleTvl({ protocol: 'dot' }, { fetchImpl: fixtureFetch() });
    expect(out.protocol_or_chain).toBe('acala-lcdot');
    expect(out.tvl_usd).toBe(1669938);
    expect(out.confidence).toBe(0.9);
  });

  it.each([
    ['metis', 'Metis', 1647261],
    ['flow', 'Flow', 7864569],
    ['flare', 'Flare', 134575332],
    ['sonic', 'Sonic', 11072500],
    ['ton', 'TON', 43575386],
    ['stable', 'Stable', 71897470],
  ])('"%s" -> %s chain TVL via the handler (B2)', async (query, chain, tvl) => {
    const out = await handleTvl({ protocol: query }, { fetchImpl: fixtureFetch() });
    expect(out.protocol_or_chain).toBe(chain);
    expect(out.tvl_usd).toBe(tvl);
    expect(out.confidence).toBe(1.0);
  });

  it('"the" -> thena-integral via the handler (largest-wins)', async () => {
    const out = await handleTvl({ protocol: 'the' }, { fetchImpl: fixtureFetch() });
    expect(out.protocol_or_chain).toBe('thena-integral');
    expect(out.tvl_usd).toBe(1629700);
    expect(out.confidence).toBe(0.9);
  });

  it('"bouncebit" reports a genuine $0 (latest point $0 today; stale $1 from 72d back is NOT served)', async () => {
    const out = await handleTvl({ protocol: 'bouncebit' }, { fetchImpl: fixtureFetch() });
    expect(out.protocol_or_chain).toBe('BounceBit');
    expect(out.tvl_usd).toBe(0);
    expect(out.as_of).toBe(LATEST_ISO);
    expect(out.verdict).toBe('verified');
    expect(out.answer).toBe(`BounceBit has a total value locked of $0 as of ${LATEST_DATE}.`);
  });

  it('"Polygon zkEVM" reports a genuine $0 (latest point $0 today; stale $330,113 from 136d back is NOT served)', async () => {
    const out = await handleTvl({ protocol: 'Polygon zkEVM' }, { fetchImpl: fixtureFetch() });
    expect(out.protocol_or_chain).toBe('Polygon zkEVM');
    expect(out.tvl_usd).toBe(0);
    expect(out.as_of).toBe(LATEST_ISO);
    expect(out.verdict).toBe('verified');
  });
});

describe('handleTvl refusal matrix (400 / 422 / 502)', () => {
  it.each(['ab', 'aa', 'x', 's', 'a', 'go', 'us'])(
    '1–2-char "%s" -> 422 PROTOCOL_NOT_FOUND via the handler',
    async (query) => {
      try {
        await handleTvl({ protocol: query }, { fetchImpl: fixtureFetch() });
        expect.unreachable('should have thrown');
      } catch (err) {
        expectApiError(err, 422, 'PROTOCOL_NOT_FOUND');
      }
    },
  );

  it.each([
    "' OR '1'='1",
    "aave-v3'; DROP TABLE receipts; --",
    '../../etc/passwd',
    'https://evil.example/x',
    'http://169.254.169.254/latest/meta-data/',
    '${jndi:ldap://evil.example/x}',
    '<script>alert(1)</script>',
    'Sólana',
    'ＡＡＶＥ',
    '🚀',
    'aave-v3\u0000',
    'aave\u0000-v3',
  ])('adversarial "%s" -> 422, never a fetch to an attacker URL', async (query) => {
    try {
      await handleTvl({ protocol: query }, { fetchImpl: fixtureFetch() });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 422, 'PROTOCOL_NOT_FOUND');
    }
  });

  it('an SSRF-shaped input never causes a fetch outside the DeFiLlama hosts', async () => {
    const fetched: string[] = [];
    const recording = (async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      fetched.push(u);
      return fixtureFetch()(u);
    }) as typeof fetch;
    try {
      await handleTvl({ protocol: 'https://evil.example/x' }, { fetchImpl: recording });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 422, 'PROTOCOL_NOT_FOUND');
    }
    expect(fetched.length).toBeGreaterThan(0);
    for (const u of fetched) {
      expect(u.startsWith('https://api.llama.fi/')).toBe(true);
    }
    expect(fetched.some((u) => u.includes('evil'))).toBe(false);
  });

  it('non-string protocol (null / number) -> 400 MISSING_PROTOCOL, not a raw TypeError', async () => {
    for (const bad of [null, 123, {}, true]) {
      try {
        await handleTvl({ protocol: bad as never }, { fetchImpl: fixtureFetch() });
        expect.unreachable('should have thrown');
      } catch (err) {
        expectApiError(err, 400, 'MISSING_PROTOCOL');
      }
    }
  });

  it('non-breaking-space-only protocol -> 400 MISSING_PROTOCOL', async () => {
    try {
      await handleTvl({ protocol: ' ' }, { fetchImpl: fixtureFetch() });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 400, 'MISSING_PROTOCOL');
    }
  });

  it('10,000-char protocol -> 400 PROTOCOL_TOO_LONG', async () => {
    try {
      await handleTvl({ protocol: 'x'.repeat(10000) }, { fetchImpl: fixtureFetch() });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 400, 'PROTOCOL_TOO_LONG');
    }
  });

  it('exactly-512-char protocol passes the length check and -> 422 (boundary)', async () => {
    try {
      await handleTvl({ protocol: 'x'.repeat(512) }, { fetchImpl: fixtureFetch() });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 422, 'PROTOCOL_NOT_FOUND');
    }
  });

  it('reading fetch 404 / 500 -> 502 DEFILLAMA_UNAVAILABLE (protocol and chain paths)', async () => {
    for (const status of [404, 500]) {
      const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
        const u = String(url);
        if (u === 'https://api.llama.fi/protocols') {
          return new Response(JSON.stringify(PROTOCOLS_FIXTURE), { status: 200 });
        }
        if (u === 'https://api.llama.fi/v2/chains') {
          return new Response(JSON.stringify(CHAINS_FIXTURE), { status: 200 });
        }
        return new Response('upstream error', { status });
      }) as typeof fetch;
      for (const query of ['aave-v3', 'ethereum']) {
        try {
          await handleTvl({ protocol: query }, { fetchImpl });
          expect.unreachable('should have thrown');
        } catch (err) {
          expectApiError(err, 502, 'DEFILLAMA_UNAVAILABLE');
        }
      }
    }
  });

  it('reading fetch HTML / malformed JSON / empty history / all-negative -> 502 DEFILLAMA_BAD_RESPONSE', async () => {
    const badBodies = [
      '<html>not json</html>',
      '{not json',
      JSON.stringify({}),
      JSON.stringify({ tvl: null }),
      JSON.stringify({ tvl: [] }),
      JSON.stringify({
        tvl: [
          { date: PREV_S, totalLiquidityUSD: -1 },
          { date: LATEST_S, totalLiquidityUSD: -5 },
        ],
      }),
    ];
    for (const body of badBodies) {
      const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
        const u = String(url);
        if (u === 'https://api.llama.fi/protocols') {
          return new Response(JSON.stringify(PROTOCOLS_FIXTURE), { status: 200 });
        }
        if (u === 'https://api.llama.fi/v2/chains') {
          return new Response(JSON.stringify(CHAINS_FIXTURE), { status: 200 });
        }
        if (u === 'https://api.llama.fi/protocol/aave-v3') {
          return new Response(body, { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch;
      try {
        await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
        expect.unreachable('should have thrown');
      } catch (err) {
        expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
      }
    }
    // Chain path: empty / non-array history -> 502.
    for (const body of ['[]', '{"tvl":1}', '<html>err</html>']) {
      const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
        const u = String(url);
        if (u === 'https://api.llama.fi/protocols') {
          return new Response(JSON.stringify(PROTOCOLS_FIXTURE), { status: 200 });
        }
        if (u === 'https://api.llama.fi/v2/chains') {
          return new Response(JSON.stringify(CHAINS_FIXTURE), { status: 200 });
        }
        if (u.startsWith('https://api.llama.fi/v2/historicalChainTvl/')) {
          return new Response(body, { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch;
      try {
        await handleTvl({ protocol: 'ethereum' }, { fetchImpl });
        expect.unreachable('should have thrown');
      } catch (err) {
        expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Round-3 pins: lists-outage cases, M1 disk-age matrix, warmLists, M3 cold
// ---------------------------------------------------------------------------

describe('handleTvl lists-outage cases (stubbed lists)', () => {
  it('one list down, the other OK -> 502 (both lists are required)', async () => {
    const protocolsOk: typeof fetch = (async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u === 'https://api.llama.fi/protocols') {
        return new Response(JSON.stringify(PROTOCOLS_FIXTURE), { status: 200 });
      }
      if (u === 'https://api.llama.fi/v2/chains') throw new Error('chains down');
      if (u === 'https://api.llama.fi/protocol/aave-v3') {
        return new Response(JSON.stringify(AAVE_PROTOCOL_FIXTURE), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    try {
      await handleTvl({ protocol: 'aave-v3' }, { fetchImpl: protocolsOk });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_UNAVAILABLE');
    }
    // Part 1's partial success seeds the in-memory + disk caches (the
    // protocols list loaded fine before the chains fetch failed), so the
    // caches must be cleared before part 2 or it would reuse them.
    __clearTvlCachesForTests();
    __clearTvlDiskCacheForTests();
    const chainsOk: typeof fetch = (async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u === 'https://api.llama.fi/protocols') throw new Error('protocols down');
      if (u === 'https://api.llama.fi/v2/chains') {
        return new Response(JSON.stringify(CHAINS_FIXTURE), { status: 200 });
      }
      if (u === 'https://api.llama.fi/protocol/aave-v3') {
        return new Response(JSON.stringify(AAVE_PROTOCOL_FIXTURE), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    try {
      await handleTvl({ protocol: 'aave-v3' }, { fetchImpl: chainsOk });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_UNAVAILABLE');
    }
  });

  it('lists 429 (4xx) with a 25h stale memory cache -> 502, no stale reuse', async () => {
    __seedTvlCachesForTests(PROTOCOLS_FIXTURE, CHAINS_FIXTURE, Date.now() - 25 * 60 * 60 * 1000);
    const { fetchImpl } = listsStubFetch(429, 'rate limited');
    try {
      await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_UNAVAILABLE');
    }
  });

  it('lists 200 with an empty array -> 502 (an empty registry is malformed, never a 422)', async () => {
    const { fetchImpl } = listsStubFetch(200, '[]');
    try {
      await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });

  it('lists 200 with a non-array body -> 502 (memory-only, no disk)', async () => {
    const { fetchImpl } = listsStubFetch(200, '{"error":"oops"}');
    try {
      await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });

  it('lists 200 with entries missing required fields -> 502', async () => {
    const { fetchImpl } = dualListsStubFetch(
      200,
      JSON.stringify([{ slug: 'aave-v3' }]),
      JSON.stringify([{ name: 'Ethereum' }]),
    );
    try {
      await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
    // Part 1's chains side loaded fine (valid list) and seeded the caches
    // before the protocols side failed, so clear them before part 2.
    __clearTvlCachesForTests();
    __clearTvlDiskCacheForTests();
    const { fetchImpl: fetchImpl2 } = dualListsStubFetch(
      200,
      JSON.stringify(PROTOCOLS_FIXTURE),
      JSON.stringify([{ gecko_id: 'ethereum' }]),
    );
    try {
      await handleTvl({ protocol: 'aave-v3' }, { fetchImpl: fetchImpl2 });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });

  it('lists 200 with non-object entries -> 502', async () => {
    const { fetchImpl } = listsStubFetch(200, '[1,2,3]');
    try {
      await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });
});

describe('handleTvl disk-age matrix (M1: 24h–7d disk goes live-first)', () => {
  const MARKER_PROTOCOLS = [{ slug: 'disk-marker', name: 'Disk Marker', symbol: 'DM', tvl: 1 }];
  const MARKER_CHAINS = [{ name: 'Disk Chain', gecko_id: 'disk-chain' }];

  it('disk 25h + lists 403 -> 502 (no stale reuse)', async () => {
    __seedTvlDiskCacheForTests(PROTOCOLS_FIXTURE, CHAINS_FIXTURE, Date.now() - 25 * 60 * 60 * 1000);
    const { fetchImpl } = listsStubFetch(403, 'forbidden');
    try {
      await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_UNAVAILABLE');
    }
  });

  it('disk 25h + lists 200-HTML -> 502 (no stale reuse)', async () => {
    __seedTvlDiskCacheForTests(PROTOCOLS_FIXTURE, CHAINS_FIXTURE, Date.now() - 25 * 60 * 60 * 1000);
    const { fetchImpl } = listsStubFetch(200, '<html>not json</html>');
    try {
      await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });

  it('disk 25h + lists 200-non-array -> 502 (no stale reuse)', async () => {
    __seedTvlDiskCacheForTests(PROTOCOLS_FIXTURE, CHAINS_FIXTURE, Date.now() - 25 * 60 * 60 * 1000);
    const { fetchImpl } = listsStubFetch(200, '{"error":"oops"}');
    try {
      await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });

  it('disk 25h + lists 200-empty-array -> 502 (no stale reuse)', async () => {
    __seedTvlDiskCacheForTests(PROTOCOLS_FIXTURE, CHAINS_FIXTURE, Date.now() - 25 * 60 * 60 * 1000);
    const { fetchImpl } = listsStubFetch(200, '[]');
    try {
      await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });

  it('disk 25h + lists 500 -> stale disk lists served (transient tolerance)', async () => {
    __seedTvlDiskCacheForTests(PROTOCOLS_FIXTURE, CHAINS_FIXTURE, Date.now() - 25 * 60 * 60 * 1000);
    const { fetchImpl, listsCalls } = listsStubFetch(500, 'upstream error');
    const out = await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
    expect(out.protocol_or_chain).toBe('aave-v3');
    expect(out.tvl_usd).toBe(15121752429);
    expect(listsCalls.length).toBeGreaterThan(0);
  });

  it('disk 25h + lists network error -> stale disk lists served (transient tolerance)', async () => {
    __seedTvlDiskCacheForTests(PROTOCOLS_FIXTURE, CHAINS_FIXTURE, Date.now() - 25 * 60 * 60 * 1000);
    const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u === 'https://api.llama.fi/protocol/aave-v3') {
        return new Response(JSON.stringify(AAVE_PROTOCOL_FIXTURE), { status: 200 });
      }
      throw new Error('network down');
    }) as typeof fetch;
    const out = await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
    expect(out.protocol_or_chain).toBe('aave-v3');
    expect(out.tvl_usd).toBe(15121752429);
  });

  it('disk 25h + lists live OK -> fresh live lists served (not the stale disk marker)', async () => {
    __seedTvlDiskCacheForTests(MARKER_PROTOCOLS, MARKER_CHAINS, Date.now() - 25 * 60 * 60 * 1000);
    const { fetchImpl, listsCalls } = dualListsStubFetch(
      200,
      JSON.stringify(PROTOCOLS_FIXTURE),
      JSON.stringify(CHAINS_FIXTURE),
    );
    const out = await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
    expect(out.protocol_or_chain).toBe('aave-v3');
    expect(out.tvl_usd).toBe(15121752429);
    expect(listsCalls.length).toBe(2);
  });

  it('disk 1h + lists 403 -> disk served (fresh <24h disk is not invalidated by a 403)', async () => {
    __seedTvlDiskCacheForTests(PROTOCOLS_FIXTURE, CHAINS_FIXTURE, Date.now() - 60 * 60 * 1000);
    const { fetchImpl } = listsStubFetch(403, 'forbidden');
    const out = await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
    expect(out.protocol_or_chain).toBe('aave-v3');
    expect(out.tvl_usd).toBe(15121752429);
  });

  it('disk 23h + lists 403 -> disk served (still inside the 24h fresh window)', async () => {
    __seedTvlDiskCacheForTests(PROTOCOLS_FIXTURE, CHAINS_FIXTURE, Date.now() - 23 * 60 * 60 * 1000);
    const { fetchImpl } = listsStubFetch(403, 'forbidden');
    const out = await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
    expect(out.protocol_or_chain).toBe('aave-v3');
    expect(out.tvl_usd).toBe(15121752429);
  });

  it('disk 6.9d + lists 500 -> stale disk lists served (inside the 7d bound)', async () => {
    __seedTvlDiskCacheForTests(
      PROTOCOLS_FIXTURE,
      CHAINS_FIXTURE,
      Date.now() - 6.9 * 24 * 60 * 60 * 1000,
    );
    const { fetchImpl } = listsStubFetch(500, 'upstream error');
    const out = await handleTvl({ protocol: 'aave-v3' }, { fetchImpl });
    expect(out.protocol_or_chain).toBe('aave-v3');
    expect(out.tvl_usd).toBe(15121752429);
  });

  it('malformed disk cache ([1,2,3]) is treated as absent and the live lists are used', async () => {
    __seedTvlDiskCacheForTests(
      [1, 2, 3] as never,
      [{ name: 'Ethereum' }] as never,
      Date.now() - 60 * 60 * 1000,
    );
    const out = await handleTvl({ protocol: 'aave-v3' }, { fetchImpl: fixtureFetch() });
    expect(out.protocol_or_chain).toBe('aave-v3');
    expect(out.tvl_usd).toBe(15121752429);
  });
});

describe('warmLists round-3 (M2 gaps)', () => {
  it('warmLists() with a dead lists endpoint resolves, never throws', async () => {
    const dead = (async () => {
      throw new Error('lists endpoint dead');
    }) as typeof fetch;
    await expect(warmLists({ fetchImpl: dead })).resolves.toBeUndefined();
  });

  it('warmLists() with a 500 lists endpoint resolves, never throws', async () => {
    const http500 = (async () => new Response('err', { status: 500 })) as typeof fetch;
    await expect(warmLists({ fetchImpl: http500 })).resolves.toBeUndefined();
  });

  it('warmLists() with a hanging endpoint resolves within its short test budget (timeoutMs override)', async () => {
    const hanging = ((url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }
      });
    }) as typeof fetch;
    const started = performance.now();
    await warmLists({ fetchImpl: hanging, timeoutMs: 100 });
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe('handleTvl cold start (M3: 60s cold lists budget, round 4 / M1)', () => {
  it(
    'cold request with lists arriving after 6s SUCCEEDS (the old 4.5s budget would 502)',
    { timeout: 30000 },
    async () => {
      const delayed = (async (url: string | URL | Request): Promise<Response> => {
        const u = String(url);
        if (u === 'https://api.llama.fi/protocols' || u === 'https://api.llama.fi/v2/chains') {
          await new Promise((resolve) => setTimeout(resolve, 6000));
          return fixtureFetch()(u);
        }
        return fixtureFetch()(u);
      }) as typeof fetch;
      const out = await handleTvl({ protocol: 'aave-v3' }, { fetchImpl: delayed });
      expect(out.protocol_or_chain).toBe('aave-v3');
      expect(out.tvl_usd).toBe(15121752429);
    },
  );

  it(
    'cold request with lists that NEVER arrive -> 502 after the 60s cold budget (not the old 10s)',
    { timeout: 90000 },
    async () => {
      const hanging: typeof fetch = ((url: string | URL | Request, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal) {
            if (signal.aborted) {
              reject(new DOMException('aborted', 'AbortError'));
              return;
            }
            signal.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }
          // Never resolves on its own; only the AbortController ends it.
        });
      }) as typeof fetch;
      const started = performance.now();
      try {
        await handleTvl({ protocol: 'aave-v3' }, { fetchImpl: hanging });
        expect.unreachable('should have thrown');
      } catch (err) {
        const elapsed = performance.now() - started;
        expectApiError(err, 502, 'DEFILLAMA_UNAVAILABLE');
        // Pins the NEW 60s budget: the abort must fire at ~60s (59–70s
        // window allows scheduling slack), not at the old 10s.
        expect(elapsed).toBeGreaterThanOrEqual(59000);
        expect(elapsed).toBeLessThan(70000);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Round-4 pins: BLOCKER 1 (chain prefix before protocol prefix), B2a
// (7-day latest-point recency bound), B2b (unconditional placeholder
// skip), M1 (60s cold budget — see cold-start block above), M2
// (deterministic largest-wins sort), M3 (ambiguous tickers)
// ---------------------------------------------------------------------------

describe('resolveTvlTarget round-4 (BLOCKER 1: chain prefix beats protocol prefix)', () => {
  it.each([
    ['solan', 'Solana'],
    ['avalan', 'Avalanche'],
    ['ethe', 'Ethereum'],
    ['boun', 'BounceBit'],
    ['meti', 'Metis'],
    ['poly', 'Polygon'],
  ])(
    '"%s" resolves to the %s chain (confidence 0.9), not the TVL-carrying protocol shadowing it',
    (query, chain) => {
      expect(resolveTvlTarget(query, PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
        kind: 'chain',
        chain,
        displayName: chain,
        confidence: 0.9,
      });
    },
  );

  it.each([
    ['sola', 'Solana', 'solayer-restaking'],
    ['ether', 'Ethereum', 'ether.fi-stake'],
    ['flar', 'Flare', 'flarebank-bank'],
    ['soni', 'Sonic', 'sonic-gateway'],
    ['bitc', 'Bitcoin', 'bitcow'],
    ['polyg', 'Polygon', 'polygon-bridge'],
  ])(
    '"%s" resolves to the %s chain, not the resolver-level shadow %s',
    (query, chain) => {
      expect(resolveTvlTarget(query, PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
        kind: 'chain',
        chain,
        displayName: chain,
        confidence: 0.9,
      });
    },
  );

  it('"uniswap" still prefix-resolves to uniswap-v3: no chain name starts with "uniswap", so the reorder is safe', () => {
    expect(resolveTvlTarget('uniswap', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'protocol',
      slug: 'uniswap-v3',
      displayName: 'Uniswap V3',
      confidence: 0.9,
    });
  });

  it.each([
    ['OP Mainnet', 'OP Mainnet'],
    ['Arbitrum Nova', 'Arbitrum Nova'],
    ['X Layer', 'X Layer'],
    ['Polygon zkEVM', 'Polygon zkEVM'],
    ['ZKsync Era', 'ZKsync Era'],
    ['Hyperliquid L1', 'Hyperliquid L1'],
  ])('held space-name chain "%s" still resolves as the chain after the reorder', (query, chain) => {
    expect(resolveTvlTarget(query, PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'chain',
      chain,
      displayName: chain,
      confidence: 1.0,
    });
  });

  it('"fraxtal" still wins as a protocol after the reorder (same-named entry WITH TVL)', () => {
    expect(resolveTvlTarget('fraxtal', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'protocol',
      slug: 'fraxtal',
      displayName: 'Fraxtal',
      confidence: 1.0,
    });
  });
});

describe('handleTvl round-4 end-to-end (BLOCKER 1 prefix queries)', () => {
  it.each([
    ['solan', 'Solana', 4686171520, 0.9],
    ['avalan', 'Avalanche', 537875458, 0.9],
    ['ethe', 'Ethereum', 35974180659, 0.9],
    ['meti', 'Metis', 1647261, 0.9],
    ['poly', 'Polygon', 592168767, 0.9],
  ])('"%s" -> %s chain TVL via the handler', async (query, chain, tvl, conf) => {
    const out = await handleTvl({ protocol: query }, { fetchImpl: fixtureFetch() });
    expect(out.protocol_or_chain).toBe(chain);
    expect(out.tvl_usd).toBe(tvl);
    expect(out.chain_tvl_usd).toBe(tvl);
    expect(out.verdict).toBe('verified');
    expect(out.confidence).toBe(conf);
  });

  it('"boun" -> BounceBit chain $0 via the handler (the B4 genuine-zero case is no longer defeated by bouncebit-prime)', async () => {
    const out = await handleTvl({ protocol: 'boun' }, { fetchImpl: fixtureFetch() });
    expect(out.protocol_or_chain).toBe('BounceBit');
    expect(out.tvl_usd).toBe(0);
    expect(out.as_of).toBe(LATEST_ISO);
    expect(out.verdict).toBe('verified');
  });
});

describe('parseProtocolReading / parseChainReading round-4 (B2a recency bound)', () => {
  // Real stale shapes, verified live 2026-11-20 ~08:34 UTC from the real
  // /protocol/{slug} payloads (see ~/workspace/tvl-r4-scratch/proto-*.json).
  it('renvm shape: last positive $28,991,172 @ 2024-10-29, latest $0 @ 2025-06-11 -> 502 (17 months stale)', () => {
    try {
      parseProtocolReading({
        tvl: [
          { date: 1730160000, totalLiquidityUSD: 28991172 },
          { date: 1749600000, totalLiquidityUSD: 0 },
        ],
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });

  it('mirror shape: last positive $594,167 @ 2023-01-19, latest $0 @ 2023-10-12 -> 502 (3+ years stale)', () => {
    try {
      parseProtocolReading({
        tvl: [
          { date: 1674086400, totalLiquidityUSD: 594167 },
          { date: 1697068800, totalLiquidityUSD: 0 },
        ],
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });

  it('oxygen shape: STALE POSITIVE latest $55,916 @ 2025-06-11 -> 502 (a stale positive is never verified as current TVL)', () => {
    try {
      parseProtocolReading({
        tvl: [
          { date: 1749513600, totalLiquidityUSD: 54241 },
          { date: 1749600000, totalLiquidityUSD: 55916 },
        ],
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
    try {
      parseChainReading([
        { date: 1749513600, tvl: 54241 },
        { date: 1749600000, tvl: 55916 },
      ]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });

  it('latest point exactly 7 days old -> served (bound is inclusive)', () => {
    const nowS = Math.floor(Date.now() / 1000);
    const edge = nowS - 7 * 86400;
    expect(
      parseProtocolReading({ tvl: [{ date: edge, totalLiquidityUSD: 123456 }] }),
    ).toEqual({ tvlUsd: 123456, chainTvlUsd: null, asOf: new Date(edge * 1000).toISOString() });
    expect(parseChainReading([{ date: edge, tvl: 123456 }])).toEqual({
      tvlUsd: 123456,
      asOf: new Date(edge * 1000).toISOString(),
    });
  });

  it('latest point 7 days + 1s old -> 502 (protocol and chain)', () => {
    const nowS = Math.floor(Date.now() / 1000);
    const stale = nowS - 7 * 86400 - 1;
    try {
      parseProtocolReading({ tvl: [{ date: stale, totalLiquidityUSD: 123456 }] });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
    try {
      parseChainReading([{ date: stale, tvl: 123456 }]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });

  it('live fresh latest (today) -> served', () => {
    const nowS = Math.floor(Date.now() / 1000);
    expect(
      parseProtocolReading({ tvl: [{ date: nowS - 3600, totalLiquidityUSD: 123456 }] }),
    ).toEqual({
      tvlUsd: 123456,
      chainTvlUsd: null,
      asOf: new Date((nowS - 3600) * 1000).toISOString(),
    });
    expect(parseChainReading([{ date: nowS - 3600, tvl: 123456 }])).toEqual({
      tvlUsd: 123456,
      asOf: new Date((nowS - 3600) * 1000).toISOString(),
    });
  });

  it('NEGATIVE latest (fresh) + positive 8 days back -> 502 (the consistent probe: only out-of-bound positives)', () => {
    const nowS = Math.floor(Date.now() / 1000);
    const stale = nowS - 8 * 86400;
    try {
      parseProtocolReading({
        tvl: [
          { date: stale, totalLiquidityUSD: 15000000000 },
          { date: nowS - 3600, totalLiquidityUSD: -5 },
        ],
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
    try {
      parseChainReading([
        { date: stale, tvl: 15000000000 },
        { date: nowS - 3600, tvl: -5 },
      ]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });

  it('correct B4 rule restated: FRESH latest $0 + positive 8 days back -> reports 0 (never the stale positive, never a 502)', () => {
    const nowS = Math.floor(Date.now() / 1000);
    const stale = nowS - 8 * 86400;
    expect(
      parseProtocolReading({
        tvl: [
          { date: stale, totalLiquidityUSD: 15000000000 },
          { date: nowS - 3600, totalLiquidityUSD: 0 },
        ],
      }),
    ).toEqual({
      tvlUsd: 0,
      chainTvlUsd: null,
      asOf: new Date((nowS - 3600) * 1000).toISOString(),
    });
    expect(
      parseChainReading([
        { date: stale, tvl: 15000000000 },
        { date: nowS - 3600, tvl: 0 },
      ]),
    ).toEqual({ tvlUsd: 0, asOf: new Date((nowS - 3600) * 1000).toISOString() });
  });

  it('STALE latest $0 (8 days old, no in-bound positive) -> 502, not a genuine zero: a dead feed is not a fresh $0', () => {
    const nowS = Math.floor(Date.now() / 1000);
    const stale = nowS - 8 * 86400;
    try {
      parseProtocolReading({ tvl: [{ date: stale, totalLiquidityUSD: 0 }] });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
    try {
      parseChainReading([{ date: stale, tvl: 0 }]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });
});

describe('handleTvl round-4 (B2a stale reading -> 502 through the handler)', () => {
  it('stale protocol history (oxygen shape) -> 502 DEFILLAMA_BAD_RESPONSE, never verified', async () => {
    const stalePayload = {
      tvl: [
        { date: 1749513600, totalLiquidityUSD: 54241 },
        { date: 1749600000, totalLiquidityUSD: 55916 },
      ],
    };
    try {
      await handleTvl({ protocol: 'lido' }, { fetchImpl: fixtureFetch(stalePayload) });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });

  it('stale chain history -> 502 DEFILLAMA_BAD_RESPONSE, never verified', async () => {
    const staleChainFetch = (async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u === 'https://api.llama.fi/protocols') {
        return new Response(JSON.stringify(PROTOCOLS_FIXTURE), { status: 200 });
      }
      if (u === 'https://api.llama.fi/v2/chains') {
        return new Response(JSON.stringify(CHAINS_FIXTURE), { status: 200 });
      }
      if (u.startsWith('https://api.llama.fi/v2/historicalChainTvl/')) {
        return new Response(
          JSON.stringify([{ date: 1749600000, tvl: 55916 }]),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    try {
      await handleTvl({ protocol: 'ethereum' }, { fetchImpl: staleChainFetch });
      expect.unreachable('should have thrown');
    } catch (err) {
      expectApiError(err, 502, 'DEFILLAMA_BAD_RESPONSE');
    }
  });
});

describe('resolveTvlTarget round-4 (B2b: TVL-less placeholders never resolve)', () => {
  it.each(['renvm', 'RenVM', 'mirror', 'Mirror', 'oxygen', 'Oxygen'])(
    '"%s" never resolves (placeholder with no chain counterpart -> null, handler 422)',
    (query) => {
      expect(resolveTvlTarget(query, PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toBeNull();
    },
  );

  it.each(['renvm', 'mirror', 'oxygen'])(
    '"%s" -> 422 PROTOCOL_NOT_FOUND via the handler (never verified with a 2023/2025 as_of)',
    async (query) => {
      try {
        await handleTvl({ protocol: query }, { fetchImpl: fixtureFetch() });
        expect.unreachable('should have thrown');
      } catch (err) {
        expectApiError(err, 422, 'PROTOCOL_NOT_FOUND');
      }
    },
  );

  it('a placeholder slug still defers to its chain when one exists ("solana" -> Solana chain)', () => {
    expect(resolveTvlTarget('solana', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'chain',
      chain: 'Solana',
      displayName: 'Solana',
      confidence: 1.0,
    });
  });
});

describe('resolveTvlTarget round-4 (M2: deterministic largest-wins sort)', () => {
  it('"the" still resolves to thena-integral when the list order is REVERSED (thena-v1 first)', () => {
    const reversed = [...PROTOCOLS_FIXTURE].reverse();
    expect(resolveTvlTarget('the', reversed, CHAINS_FIXTURE)).toEqual({
      kind: 'protocol',
      slug: 'thena-integral',
      displayName: 'THENA INTEGRAL',
      confidence: 0.9,
    });
  });

  it('"uniswap" still resolves to uniswap-v3 when the list order is REVERSED (v4 first)', () => {
    const reversed = [...PROTOCOLS_FIXTURE].reverse();
    expect(resolveTvlTarget('uniswap', reversed, CHAINS_FIXTURE)).toEqual({
      kind: 'protocol',
      slug: 'uniswap-v3',
      displayName: 'Uniswap V3',
      confidence: 0.9,
    });
  });

  it('"dot" still resolves to acala-lcdot when a smaller DOT carrier is listed first (fixture order already does this)', () => {
    expect(resolveTvlTarget('dot', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'protocol',
      slug: 'acala-lcdot',
      displayName: 'Acala LCDOT',
      confidence: 0.9,
    });
    const reversed = [...PROTOCOLS_FIXTURE].reverse();
    expect(resolveTvlTarget('dot', reversed, CHAINS_FIXTURE)).toEqual({
      kind: 'protocol',
      slug: 'acala-lcdot',
      displayName: 'Acala LCDOT',
      confidence: 0.9,
    });
  });

  it('"BNB" still resolves to binance-cex when the list order is REVERSED (bnb-staking first in the fixture)', () => {
    const reversed = [...PROTOCOLS_FIXTURE].reverse();
    expect(resolveTvlTarget('BNB', reversed, CHAINS_FIXTURE)).toEqual({
      kind: 'protocol',
      slug: 'binance-cex',
      displayName: 'Binance CEX',
      confidence: 0.9,
    });
  });

  it('"poly" still resolves to the Polygon chain when Polygon zkEVM is listed first (larger TVL wins the chain-prefix step)', () => {
    const reversedChains = [...CHAINS_FIXTURE].reverse();
    expect(resolveTvlTarget('poly', PROTOCOLS_FIXTURE, reversedChains)).toEqual({
      kind: 'chain',
      chain: 'Polygon',
      displayName: 'Polygon',
      confidence: 0.9,
    });
  });

  it('exact protocol name with two same-named entries -> largest TVL wins, either list order', () => {
    const smallFirst = [
      { slug: 'dup-small', name: 'Dup Name', symbol: 'D1', tvl: 10 },
      { slug: 'dup-big', name: 'Dup Name', symbol: 'D2', tvl: 999 },
    ];
    const bigFirst = [...smallFirst].reverse();
    for (const protos of [smallFirst, bigFirst]) {
      expect(resolveTvlTarget('Dup Name', protos, [])).toEqual({
        kind: 'protocol',
        slug: 'dup-big',
        displayName: 'Dup Name',
        confidence: 0.9,
      });
    }
  });

  it('exact chain name with two same-named chains -> largest TVL wins, either list order', () => {
    const smallFirst = [
      { name: 'Dup Chain', gecko_id: 'dup-1', tvl: 10 },
      { name: 'Dup Chain', gecko_id: 'dup-2', tvl: 999 },
    ];
    const bigFirst = [...smallFirst].reverse();
    for (const chains of [smallFirst, bigFirst]) {
      expect(resolveTvlTarget('Dup Chain', [], chains)).toEqual({
        kind: 'chain',
        chain: 'Dup Chain',
        displayName: 'Dup Chain',
        confidence: 1.0,
      });
    }
  });
});

describe('resolveTvlTarget round-4 (M3: ambiguous tickers)', () => {
  it('"bch" resolves to bchpad (protocol prefix): BCH is shared by Bitcoincash and smartBCH, so no chain wins the uniqueness gate', () => {
    expect(resolveTvlTarget('bch', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'protocol',
      slug: 'bchpad',
      displayName: 'BCHPad',
      confidence: 0.9,
    });
  });

  it('"xrp" resolves to the XRPL chain (chain prefix, post-reorder): XRP is shared by XRPL and XRPL EVM, so the ticker gate does not fire — but "xrp" IS a prefix of the XRPL chain name, and the BLOCKER 1 chain-prefix-first rule sends it to the chain, not to xrpl-dex', () => {
    expect(resolveTvlTarget('xrp', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'chain',
      chain: 'XRPL',
      displayName: 'XRPL',
      confidence: 0.9,
    });
  });

  it('both ambiguous-ticker chains stay reachable by exact name ("Bitcoincash", "XRPL")', () => {
    expect(resolveTvlTarget('Bitcoincash', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'chain',
      chain: 'Bitcoincash',
      displayName: 'Bitcoincash',
      confidence: 1.0,
    });
    expect(resolveTvlTarget('XRPL', PROTOCOLS_FIXTURE, CHAINS_FIXTURE)).toEqual({
      kind: 'chain',
      chain: 'XRPL',
      displayName: 'XRPL',
      confidence: 1.0,
    });
  });

  it('"bch" -> bchpad via the handler (fixture payload; the LIVE bchpad history is stale, so the live reading 502s)', async () => {
    const out = await handleTvl({ protocol: 'bch' }, { fetchImpl: fixtureFetch() });
    expect(out.protocol_or_chain).toBe('bchpad');
    expect(out.tvl_usd).toBe(0);
    expect(out.confidence).toBe(0.9);
  });

  it('"Bitcoincash" / "XRPL" return their chain TVLs via the handler', async () => {
    const bch = await handleTvl({ protocol: 'Bitcoincash' }, { fetchImpl: fixtureFetch() });
    expect(bch.protocol_or_chain).toBe('Bitcoincash');
    expect(bch.tvl_usd).toBe(4531391);
    const xrp = await handleTvl({ protocol: 'XRPL' }, { fetchImpl: fixtureFetch() });
    expect(xrp.protocol_or_chain).toBe('XRPL');
    expect(xrp.tvl_usd).toBe(30937366);
  });
});

describe('handleTvl round-4 (answer carries the as_of date)', () => {
  it('a reading dated 3 days ago names that date in the answer (never presented as current without its date)', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const threeDaysAgo = nowS - 3 * 86400;
    const dateStr = new Date(threeDaysAgo * 1000).toISOString().slice(0, 10);
    const payload = {
      tvl: [{ date: threeDaysAgo, totalLiquidityUSD: 123456789 }],
      currentChainTvls: { Ethereum: 123456789 },
    };
    const out = await handleTvl({ protocol: 'lido' }, { fetchImpl: fixtureFetch(payload) });
    expect(out.answer).toBe(`Lido has a total value locked of $123,456,789 as of ${dateStr}.`);
    expect(out.as_of).toBe(new Date(threeDaysAgo * 1000).toISOString());
  });

  it('a chain reading dated 3 days ago names that date in the answer', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const threeDaysAgo = nowS - 3 * 86400;
    const dateStr = new Date(threeDaysAgo * 1000).toISOString().slice(0, 10);
    const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u === 'https://api.llama.fi/protocols') {
        return new Response(JSON.stringify(PROTOCOLS_FIXTURE), { status: 200 });
      }
      if (u === 'https://api.llama.fi/v2/chains') {
        return new Response(JSON.stringify(CHAINS_FIXTURE), { status: 200 });
      }
      if (u.startsWith('https://api.llama.fi/v2/historicalChainTvl/')) {
        return new Response(
          JSON.stringify([{ date: threeDaysAgo, tvl: 35974180659 }]),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const out = await handleTvl({ protocol: 'ethereum' }, { fetchImpl });
    expect(out.answer).toBe(`Ethereum has a total value locked of $35,974,180,659 as of ${dateStr}.`);
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

describe('handleTvl live round-3 pins (real DeFiLlama)', () => {
  it('"sol" resolves live to the Solana chain (B1)', { timeout: 120000 }, async () => {
    __clearTvlCachesForTests();
    const out = await handleTvl({ protocol: 'sol' });
    console.log('LIVE sol tvl_usd =', out.tvl_usd, '| as_of =', out.as_of);
    expect(out.protocol_or_chain).toBe('Solana');
    expect(typeof out.tvl_usd).toBe('number');
    expect(out.tvl_usd as number).toBeGreaterThan(1e9);
    expect(out.verdict).toBe('verified');
  });

  it('"metis" resolves live to the Metis chain (B2)', { timeout: 120000 }, async () => {
    __clearTvlCachesForTests();
    const out = await handleTvl({ protocol: 'metis' });
    console.log('LIVE metis tvl_usd =', out.tvl_usd, '| as_of =', out.as_of);
    expect(out.protocol_or_chain).toBe('Metis');
    expect(typeof out.tvl_usd).toBe('number');
    expect(out.tvl_usd as number).toBeGreaterThan(0);
    expect(out.verdict).toBe('verified');
  });

  it('"bouncebit" reports a genuine live $0 (B4)', { timeout: 120000 }, async () => {
    __clearTvlCachesForTests();
    const out = await handleTvl({ protocol: 'bouncebit' });
    console.log('LIVE bouncebit tvl_usd =', out.tvl_usd, '| as_of =', out.as_of);
    expect(out.protocol_or_chain).toBe('BounceBit');
    expect(out.tvl_usd).toBe(0);
    expect(out.verdict).toBe('verified');
  });
});

describe('handleTvl live round-4 pins (real DeFiLlama)', () => {
  it('"solan" resolves live to the Solana chain, not solana-farm (BLOCKER 1)', { timeout: 180000 }, async () => {
    __clearTvlCachesForTests();
    const out = await handleTvl({ protocol: 'solan' });
    console.log('LIVE solan tvl_usd =', out.tvl_usd, '| as_of =', out.as_of);
    expect(out.protocol_or_chain).toBe('Solana');
    expect(typeof out.tvl_usd).toBe('number');
    expect(out.tvl_usd as number).toBeGreaterThan(1e9);
    expect(out.verdict).toBe('verified');
  });

  it('"ethe" resolves live to the Ethereum chain, not ethena-usde (BLOCKER 1)', { timeout: 180000 }, async () => {
    __clearTvlCachesForTests();
    const out = await handleTvl({ protocol: 'ethe' });
    console.log('LIVE ethe tvl_usd =', out.tvl_usd, '| as_of =', out.as_of);
    expect(out.protocol_or_chain).toBe('Ethereum');
    expect(typeof out.tvl_usd).toBe('number');
    expect(out.tvl_usd as number).toBeGreaterThan(1e9);
    expect(out.verdict).toBe('verified');
  });

  it('"boun" resolves live to the BounceBit chain $0, not bouncebit-prime (BLOCKER 1 + B4 genuine zero)', { timeout: 180000 }, async () => {
    __clearTvlCachesForTests();
    const out = await handleTvl({ protocol: 'boun' });
    console.log('LIVE boun tvl_usd =', out.tvl_usd, '| as_of =', out.as_of);
    expect(out.protocol_or_chain).toBe('BounceBit');
    expect(out.tvl_usd).toBe(0);
    expect(out.verdict).toBe('verified');
  });
});
