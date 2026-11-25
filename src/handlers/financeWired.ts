import {geckoPoolLiquiditySource} from './geckoPoolLiquidity';
// WIRED finance observation configuration (expansion slice, 2026-11-23).
//
// This is the first file that ENABLES named providers for the finance
// handlers: a reviewed binding list plus a reviewed terms record per
// provider, composed into the primary/fallback runner of
// src/core/observedSources.ts. Doctrine (unchanged): primary/fallback
// order, never averaging; an empty approved list fails closed; provider
// keys travel in headers only (see keyedMarketSources.ts).
//
// Licence posture: the reviewed terms for every provider below do NOT
// grant us commercial redistribution, so commercialUse/redistribution
// stay false. Each source runs under the owner's recorded terms-risk
// acceptance for this testnet hackathon project, recorded on the trusted
// owner channel. Only an opaque dated reference is retained. Personal transport
// identifiers are deliberately excluded from source and receipt metadata.
// The record below is a presence-only pointer to that out-of-band
// message; it is not itself proof of approval (see observedSources.ts).
//
// Address provenance (verified against primary sources 2026-11-23):
//   Chainlink ETH/USD proxy 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419
//     https://data.chain.link/feeds/ethereum/mainnet/eth-usd (heartbeat 3600 s)
//   Chainlink BTC/USD proxy 0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c
//     https://data.chain.link/feeds/ethereum/mainnet/btc-usd (heartbeat 3600 s)
//   Uniswap v3 USDC/WETH 0.05% pool 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640
//     https://dexscreener.com/ethereum/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640
//   CoinPaprika / CoinGecko / CoinMarketCap asset ids are the providers'
//   own canonical ids (btc-bitcoin/eth-ethereum, bitcoin/ethereum, 1/1027).

import { handleCexDepth } from './cexDepth';
import type { ObservationSource, SourceApproval } from '../core/observedSources';
import { createFinanceObservationHandlers, type FinanceSourceLists, type PriceQuery, type PriceValue, type PoolQuery, type PoolValue, type YieldQuery, type YieldValue } from './financeObservations';
import { chainlinkPriceSource, type FeedBinding } from './chainlinkSource';
import { createPinnedFeedReader, type PinnedRpcLeg } from './pinnedFeedReader';
import { coinpaprikaPriceSource, dexScreenerLiquiditySource, type PoolBinding, type TickerBinding } from './marketSourceAdapters';
import { coinGeckoPriceSource, coinMarketCapPriceSource, type CmcTickerBinding, type GeckoTickerBinding } from './keyedMarketSources';
import { MAINNET_RPCS } from '../config/chains';
import { aaveYieldSource, type AaveReserveBinding } from './aaveYieldSource';

/** Presence-only pointer to the owner's trusted-channel instruction described in
 * the header. Authenticity is established out-of-band; a passing
 * approved() check is never citable as proof of approval. */
const OWNER_RISK_ACCEPTANCE = {
    sourceReference: 'owner-risk-acceptance-2026-11-23',
    scope: 'testnet-hackathon' as const,
    acceptedAt: '2026-11-23',
};
function termsRiskApproval(termsUrl: string, checkedAt: string): SourceApproval {
    return { termsUrl, checkedAt, commercialUse: false, redistribution: false, ownerRiskAcceptance: { ...OWNER_RISK_ACCEPTANCE } };
}
export const CHAINLINK_APPROVAL = termsRiskApproval('https://chain.link/terms', '2026-11-23');
export const COINPAPRIKA_APPROVAL = termsRiskApproval('https://docs.coinpaprika.com/api-plans', '2026-11-23');
export const COINGECKO_APPROVAL = termsRiskApproval('https://www.coingecko.com/en/api_terms', '2026-11-23');
export const COINMARKETCAP_APPROVAL = termsRiskApproval('https://coinmarketcap.com/api/terms/v1/', '2026-11-23');
export const GECKOTERMINAL_APPROVAL = termsRiskApproval('https://www.coingecko.com/en/api_terms', '2026-11-24');
export const DEXSCREENER_APPROVAL = termsRiskApproval('https://docs.dexscreener.com/api/api-terms-and-conditions', '2026-11-23');
/** On-chain public state carries no provider terms; the record keeps the
 * shared approval-gate shape and the same owner-risk pointer as above. */
export const AAVE_V3_APPROVAL = termsRiskApproval('https://aave.com/docs/aave-v3/smart-contracts/view-contracts', '2026-11-23');

/** Reviewed Chainlink USD feed bindings (Ethereum mainnet, chainId 1).
 * maxAgeMs is each feed's own published heartbeat. */
export const CHAINLINK_USD_FEEDS: readonly FeedBinding[] = [
    { symbol: 'ETH', chainId: '1', proxy: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', registryUrl: 'https://data.chain.link/feeds/ethereum/mainnet/eth-usd', maxAgeMs: 3600000 },
    { symbol: 'BTC', chainId: '1', proxy: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', registryUrl: 'https://data.chain.link/feeds/ethereum/mainnet/btc-usd', maxAgeMs: 3600000 },
];
export const COINPAPRIKA_TICKERS: readonly TickerBinding[] = [
    { symbol: 'ETH', coinpaprikaId: 'eth-ethereum' },
    { symbol: 'BTC', coinpaprikaId: 'btc-bitcoin' },
];
export const COINGECKO_TICKERS: readonly GeckoTickerBinding[] = [
    { symbol: 'ETH', coingeckoId: 'ethereum' },
    { symbol: 'BTC', coingeckoId: 'bitcoin' },
];
export const COINMARKETCAP_TICKERS: readonly CmcTickerBinding[] = [
    { symbol: 'ETH', cmcId: '1027' },
    { symbol: 'BTC', cmcId: '1' },
];
/** Reviewed representative pools, never search-position matching. Pair token0/token1
 * verified on two Ethereum RPCs 2026-11-25; captured bodies in liquidity-address fixtures.
 * Names are not unique across venues/fees; resolved address and selection are disclosed. */
export const DEXSCREENER_POOLS: readonly PoolBinding[] = [
    { pool: 'USDC/WETH 0.05%', chain: 'ethereum', address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', dexScreenerChain: 'ethereum', dexId: 'uniswap',pairAlias:'USDC/WETH',tokenAddresses:['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'] },
    {pool:'UNI/WETH representative',chain:'ethereum',address:'0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801',dexScreenerChain:'ethereum',dexId:'uniswap',pairAlias:'UNI/WETH',tokenAddresses:['0x1f9840a85d5af5bf1d1762f925bdaddc4201f984','0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']},
];

/** Reviewed Aave v3 Ethereum reserve bindings. dataProvider and
 * underlying addresses verified 2026-11-23 against the official
 * aave-address-book module AaveV3Ethereum.json. */
export const AAVE_V3_RESERVES: readonly AaveReserveBinding[] = [
    { project: 'aave-v3', symbol: 'USDC', chain: 'ethereum', chainId: '1', underlying: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', dataProvider: '0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD', registryUrl: 'https://assets.aave.com/address-book/releases/latest/modules/AaveV3Ethereum.json' },
    { project: 'aave-v3', symbol: 'WETH', chain: 'ethereum', chainId: '1', underlying: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', dataProvider: '0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD', registryUrl: 'https://assets.aave.com/address-book/releases/latest/modules/AaveV3Ethereum.json' },
    { project: 'aave-v3', symbol: 'USDT', chain: 'ethereum', chainId: '1', underlying: '0xdAC17F958D2ee523a2206206994597C13D831ec7', dataProvider: '0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD', registryUrl: 'https://assets.aave.com/address-book/releases/latest/modules/AaveV3Ethereum.json' },
    { project: 'aave-v3', symbol: 'DAI', chain: 'ethereum', chainId: '1', underlying: '0x6B175474E89094C44Da98b954EedeAC495271d0F', dataProvider: '0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD', registryUrl: 'https://assets.aave.com/address-book/releases/latest/modules/AaveV3Ethereum.json' },
];

/** All three MAINNET_RPCS legs are keyless public endpoints, so the
 * evidence URL equals the RPC URL and no credential can leak into a
 * receipt. A future keyed RPC leg MUST get a separate credential-free
 * evidenceUrl (see pinnedFeedReader.ts). */
export function ethereumPinnedLegs(): readonly PinnedRpcLeg[] {
    return MAINNET_RPCS.map(u => ({ rpcUrl: u, evidenceUrl: u }));
}

export interface WiredFinanceHandlers {
    price: (q: Record<string, string | undefined>) => Promise<Record<string, unknown>>;
    liquidity: (q: Record<string, string | undefined>) => Promise<Record<string, unknown>>;
    yield: (q: Record<string, string | undefined>) => Promise<Record<string, unknown>>;
    priceSourceNames: readonly string[];
    liquiditySourceNames: readonly string[];
    yieldSourceNames: readonly string[];
}

/** Composed primary/fallback finance handlers.
 * Price order: Chainlink pinned on-chain state (primary), then
 * CoinPaprika, then the keyed failover legs CoinGecko and CoinMarketCap
 * ONLY when their API keys are present in the environment (blank or
 * whitespace-only keys are ignored, matching 22e2a402). No key means the
 * leg is silently absent; the answer shape is unchanged.
 * Yield: explicitly safe-head (not finalized) on-chain Aave v3 reserve liquidity rate over the same pinned
 * legs; incentives and rewards excluded, disclosed in the answer. */
export function createWiredFinanceHandlers(env: NodeJS.ProcessEnv = process.env): WiredFinanceHandlers {
    const price: ObservationSource<PriceQuery, PriceValue>[] = [
        chainlinkPriceSource(CHAINLINK_USD_FEEDS, createPinnedFeedReader(ethereumPinnedLegs()), CHAINLINK_APPROVAL),
        coinpaprikaPriceSource(COINPAPRIKA_TICKERS, COINPAPRIKA_APPROVAL),
    ];
    const geckoKey = (env.COINGECKO_API_KEY ?? '').trim();
    if (geckoKey)
        price.push(coinGeckoPriceSource(COINGECKO_TICKERS, COINGECKO_APPROVAL, geckoKey));
    const cmcKey = (env.COINMARKETCAP_API_KEY ?? '').trim();
    if (cmcKey)
        price.push(coinMarketCapPriceSource(COINMARKETCAP_TICKERS, COINMARKETCAP_APPROVAL, cmcKey));
    const liquidity: ObservationSource<PoolQuery, PoolValue>[] = [
        dexScreenerLiquiditySource(DEXSCREENER_POOLS, DEXSCREENER_APPROVAL),
        geckoPoolLiquiditySource(DEXSCREENER_POOLS,GECKOTERMINAL_APPROVAL),
    ];
    const yieldSources: ObservationSource<YieldQuery, YieldValue>[] = [
        aaveYieldSource(AAVE_V3_RESERVES, ethereumPinnedLegs(), AAVE_V3_APPROVAL, { blockTag: 'safe' }),
    ];
    const lists: FinanceSourceLists = { price, liquidity, yield: yieldSources };
    const handlers = createFinanceObservationHandlers(lists);
    return {
        price: handlers.price,
        liquidity: q => ['gemini','bitstamp'].includes(q.chain?.toLowerCase() ?? '') ? handleCexDepth(q) : handlers.liquidity(q),
        yield: handlers.yield,
        priceSourceNames: price.map(s => s.name),
        liquiditySourceNames: liquidity.map(s => s.name),
        yieldSourceNames: yieldSources.map(s => s.name),
    };
}

/** Health attribution only: same reviewed exact binding and normalization as source.
 * Unsupported input is a local refusal, not evidence that any RPC service failed. */
export function isBoundYieldQuery(q:Record<string,string|undefined>):boolean{
 return AAVE_V3_RESERVES.filter(b=>b.project.toLowerCase()===q.project?.trim().toLowerCase()&&b.symbol.toUpperCase()===q.symbol?.trim().toUpperCase()&&b.chain.toLowerCase()===q.chain?.trim().toLowerCase()).length===1;
}
