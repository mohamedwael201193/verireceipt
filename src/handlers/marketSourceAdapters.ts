import type { ObservationSource, SourceApproval } from '../core/observedSources';
import type { PriceQuery, PriceValue, PoolQuery, PoolValue } from './financeObservations';
import {withAnswerClass} from '../core/answerClass';
import { readPublicBody, publicSourceFailure } from '../core/publicSource';
export interface TickerBinding {
    symbol: string;
    coinpaprikaId: string;
}
/** Unconfigured provider factory: no ticker binding is enabled by this file. */
export function coinpaprikaPriceSource(bindings: readonly TickerBinding[], approval: SourceApproval): ObservationSource<PriceQuery, PriceValue> {
    return {
        name: 'CoinPaprika USD ticker', approval,
        read: async (q, signal) => {
            const matches = bindings.filter(x => x.symbol.toUpperCase() === q.symbol.toUpperCase());
            if (matches.length !== 1 || !/^[a-z0-9-]{2,80}$/.test(matches[0].coinpaprikaId))
                throw new Error('ambiguous ticker binding');
            if (signal.aborted)
                throw new Error('aborted');
            const url = 'https://api.coinpaprika.com/v1/tickers/' + matches[0].coinpaprikaId;
            const b = await readPublicBody(url, 200000, 850);
            if (signal.aborted)
                throw new Error('aborted');
            const j = JSON.parse(b.raw);
            // Identity is the reviewed coinpaprikaId plus the binding's own
            // symbol (case-insensitive: the API canonicalises to upper case),
            // never the raw query string and never a search-result position.
            if (j.id !== matches[0].coinpaprikaId || typeof j.symbol !== 'string' || j.symbol.toUpperCase() !== matches[0].symbol.toUpperCase() || typeof j.quotes?.USD?.price !== 'number' || !Number.isFinite(j.quotes.USD.price) || j.quotes.USD.price <= 0 || typeof j.last_updated !== 'string' || !Number.isFinite(Date.parse(j.last_updated)))
                throw new Error('wrong ticker identity/value');
            return { identity: JSON.stringify([matches[0].symbol.toLowerCase()]), sourceUrl: url, rawBody: b.raw, observedAt: j.last_updated, fetchedAt: b.fetchedAt, value: { symbol: matches[0].symbol, priceUsd: j.quotes.USD.price } };
        }
    };
}
export interface PoolBinding {
    pool: string;
    chain: string;
    address: string;
    dexScreenerChain: string;
    dexId?: string;
}
// Canonical EVM chain slugs supported by the exact-pair endpoint. No arbitrary
// URL paths, chain guessing, token-address search or similar-name substitution.
const DEX_EVM_CHAINS=new Set(['ethereum','base','arbitrum','optimism','polygon','bsc','avalanche','linea','scroll','gnosis','zksync','blast','mantle','celo','sonic','unichain']);
/** Unconfigured provider factory: names require a unique reviewed binding. */
export function dexScreenerLiquiditySource(bindings: readonly PoolBinding[], approval: SourceApproval): ObservationSource<PoolQuery, PoolValue> {
    return {
        name: 'DEX Screener named pool reserve liquidity', approval,
        read: async (q, signal) => {
            let failure='binding';
            try {
            const matches = bindings.filter(b => b.chain.toLowerCase() === q.chain.toLowerCase() && (b.pool.toLowerCase() === q.pool.toLowerCase() || b.address.toLowerCase() === q.pool.toLowerCase()));
            const exactAddress=/^0x[0-9a-fA-F]{40}$/.test(q.pool);
            const chain=q.chain.toLowerCase();
            if(matches.length>1 || (!exactAddress && matches.length!==1) || (exactAddress&&!DEX_EVM_CHAINS.has(chain)))
                throw new Error('ambiguous pool binding');
            const p:PoolBinding=matches[0]??{pool:q.pool,chain,address:q.pool,dexScreenerChain:chain};
            if (!/^[a-z0-9-]+$/.test(p.dexScreenerChain) || !/^[A-Za-z0-9]{20,100}$/.test(p.address))
                throw new Error('invalid pool identity');
            if (signal.aborted)
                throw new Error('aborted');
            const url = `https://api.dexscreener.com/latest/dex/pairs/${p.dexScreenerChain}/${p.address}`;
            // Allow normal public-API latency while remaining inside the runner deadline.
            let b;try{b=await readPublicBody(url,200000,2500);}catch(error){failure=publicSourceFailure(error);throw error;}
            failure='aborted';
            if (signal.aborted)
                throw new Error('aborted');
            failure='malformed';
            const j = JSON.parse(b.raw);
            failure='identity_or_value';
            const rows = Array.isArray(j.pairs) ? j.pairs.filter((r: any) => r.chainId === p.dexScreenerChain && typeof r.pairAddress === 'string' && r.pairAddress.toLowerCase() === p.address.toLowerCase() && (!p.dexId || r.dexId === p.dexId)) : [];
            if (rows.length !== 1 || typeof rows[0].liquidity?.usd !== 'number' || !Number.isFinite(rows[0].liquidity.usd) || rows[0].liquidity.usd < 0)
                throw new Error('wrong or duplicate pool identity');
            // The API exposes no per-pair observation timestamp: the
            // observation time is the retrieval time, disclosed as such in
            // the receipted evidence (same pattern as the NOAA archive).
            return { identity: JSON.stringify([q.chain.toLowerCase(), q.pool.toLowerCase()]), sourceUrl: url, rawBody: JSON.stringify({ source_raw_body: b.raw, observed_at_semantics: 'retrieval time; the API exposes no per-pair observation timestamp' }), observedAt: b.fetchedAt, fetchedAt: b.fetchedAt, value: { chain: q.chain, pool: q.pool, liquidityUsd: rows[0].liquidity.usd } };
            }catch(error){try{if(error!==null&&typeof error==='object')withAnswerClass(error,'LIQUIDITY_DEPTH_VERIFY_GENERAL',{dexscreener_failure:failure});}catch{}throw error;}
        }
    };
}
