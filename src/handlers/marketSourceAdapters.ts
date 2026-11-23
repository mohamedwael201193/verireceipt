import type { ObservationSource, SourceApproval } from '../core/observedSources';
import type { PriceQuery, PriceValue, PoolQuery, PoolValue } from './financeObservations';
import { readPublicBody } from '../core/publicSource';
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
/** Unconfigured provider factory: no pool binding is enabled by this file. */
export function dexScreenerLiquiditySource(bindings: readonly PoolBinding[], approval: SourceApproval): ObservationSource<PoolQuery, PoolValue> {
    return {
        name: 'DEX Screener named pool reserve liquidity', approval,
        read: async (q, signal) => {
            const matches = bindings.filter(b => b.chain.toLowerCase() === q.chain.toLowerCase() && (b.pool.toLowerCase() === q.pool.toLowerCase() || b.address.toLowerCase() === q.pool.toLowerCase()));
            if (matches.length !== 1)
                throw new Error('ambiguous pool binding');
            const p = matches[0];
            if (!/^[a-z0-9-]+$/.test(p.dexScreenerChain) || !/^[A-Za-z0-9]{20,100}$/.test(p.address))
                throw new Error('invalid pool identity');
            if (signal.aborted)
                throw new Error('aborted');
            const url = `https://api.dexscreener.com/latest/dex/pairs/${p.dexScreenerChain}/${p.address}`;
            const b = await readPublicBody(url, 200000, 850);
            if (signal.aborted)
                throw new Error('aborted');
            const j = JSON.parse(b.raw);
            const rows = Array.isArray(j.pairs) ? j.pairs.filter((r: any) => r.chainId === p.dexScreenerChain && r.pairAddress?.toLowerCase() === p.address.toLowerCase() && (!p.dexId || r.dexId === p.dexId)) : [];
            if (rows.length !== 1 || typeof rows[0].liquidity?.usd !== 'number' || !Number.isFinite(rows[0].liquidity.usd) || rows[0].liquidity.usd < 0)
                throw new Error('wrong or duplicate pool identity');
            // The API exposes no per-pair observation timestamp: the
            // observation time is the retrieval time, disclosed as such in
            // the receipted evidence (same pattern as the NOAA archive).
            return { identity: JSON.stringify([q.chain.toLowerCase(), q.pool.toLowerCase()]), sourceUrl: url, rawBody: JSON.stringify({ source_raw_body: b.raw, observed_at_semantics: 'retrieval time; the API exposes no per-pair observation timestamp' }), observedAt: b.fetchedAt, fetchedAt: b.fetchedAt, value: { chain: q.chain, pool: q.pool, liquidityUsd: rows[0].liquidity.usd } };
        }
    };
}
