import type { ObservationSource, SourceApproval } from '../core/observedSources';
import type { PriceQuery, PriceValue } from './financeObservations';

/** Bounded keyed GET, same body discipline as readPublicBody plus one
 * header. The API key travels ONLY in that header: never in the URL, the
 * receipted evidence or any error message. */
async function keyedBody(url: string, header: string, key: string, maxBytes: number, timeoutMs: number): Promise<{ raw: string; fetchedAt: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const r = await fetch(url, { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'VeriReceipt/2.0 keyed market observer', [header]: key } });
        if (!r.ok)
            throw new Error(`keyed source HTTP ${r.status}`);
        const size = r.headers.get('content-length');
        if (size && Number(size) > maxBytes) {
            await r.body?.cancel();
            throw new Error('keyed source body limit');
        }
        const reader = r.body?.getReader();
        if (!reader)
            throw new Error('keyed source body missing');
        const parts: Uint8Array[] = [];
        let n = 0;
        try {
            while (true) {
                const x = await reader.read();
                if (x.done)
                    break;
                n += x.value.length;
                if (n > maxBytes) {
                    await reader.cancel();
                    throw new Error('keyed source body limit');
                }
                parts.push(x.value);
            }
        }
        finally {
            reader.releaseLock();
        }
        return { raw: Buffer.concat(parts).toString('utf8'), fetchedAt: new Date().toISOString() };
    }
    finally {
        clearTimeout(timer);
    }
}
function usd(n: unknown): number {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0)
        throw new Error('invalid USD price');
    return n;
}
export interface GeckoTickerBinding {
    symbol: string;
    coingeckoId: string;
}
/** Unconfigured keyed provider factory: no ticker binding is enabled here. */
export function coinGeckoPriceSource(bindings: readonly GeckoTickerBinding[], approval: SourceApproval, apiKey: string): ObservationSource<PriceQuery, PriceValue> {
    if (!apiKey)
        throw new Error('CoinGecko API key required');
    return {
        name: 'CoinGecko USD simple price', approval,
        read: async (q, signal) => {
            const matches = bindings.filter(x => x.symbol.toUpperCase() === q.symbol.toUpperCase());
            if (matches.length !== 1 || !/^[a-z0-9-]{2,80}$/.test(matches[0].coingeckoId))
                throw new Error('ambiguous ticker binding');
            if (signal.aborted)
                throw new Error('aborted');
            const url = `https://api.coingecko.com/api/v3/simple/price?ids=${matches[0].coingeckoId}&vs_currencies=usd&include_last_updated_at=true`;
            const b = await keyedBody(url, 'x-cg-demo-api-key', apiKey, 200000, 850);
            if (signal.aborted)
                throw new Error('aborted');
            const j = JSON.parse(b.raw);
            const row = j?.[matches[0].coingeckoId];
            if (!row || typeof row !== 'object')
                throw new Error('wrong ticker identity/value');
            const price = usd(row.usd);
            if (!Number.isInteger(row.last_updated_at) || row.last_updated_at <= 0)
                throw new Error('provider update time missing');
            return { identity: JSON.stringify([matches[0].symbol.toLowerCase()]), sourceUrl: url, rawBody: b.raw, observedAt: new Date(row.last_updated_at * 1000).toISOString(), fetchedAt: b.fetchedAt, value: { symbol: matches[0].symbol, priceUsd: price } };
        }
    };
}
export interface CmcTickerBinding {
    symbol: string;
    /** Numeric CoinMarketCap asset id as a decimal string. */
    cmcId: string;
}
/** Unconfigured keyed provider factory: no ticker binding is enabled here. */
export function coinMarketCapPriceSource(bindings: readonly CmcTickerBinding[], approval: SourceApproval, apiKey: string): ObservationSource<PriceQuery, PriceValue> {
    if (!apiKey)
        throw new Error('CoinMarketCap API key required');
    return {
        name: 'CoinMarketCap USD latest quote', approval,
        read: async (q, signal) => {
            const matches = bindings.filter(x => x.symbol.toUpperCase() === q.symbol.toUpperCase());
            if (matches.length !== 1 || !/^[1-9][0-9]{0,10}$/.test(matches[0].cmcId))
                throw new Error('ambiguous ticker binding');
            if (signal.aborted)
                throw new Error('aborted');
            const url = `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?id=${matches[0].cmcId}`;
            const b = await keyedBody(url, 'X-CMC_PRO_API_KEY', apiKey, 200000, 850);
            if (signal.aborted)
                throw new Error('aborted');
            const j = JSON.parse(b.raw);
            const row = j?.data?.[matches[0].cmcId];
            if (!row || typeof row.symbol !== 'string' || row.symbol.toUpperCase() !== matches[0].symbol.toUpperCase())
                throw new Error('wrong ticker identity/value');
            const price = usd(row.quote?.USD?.price);
            if (typeof row.quote?.USD?.last_updated !== 'string' || !Number.isFinite(Date.parse(row.quote.USD.last_updated)))
                throw new Error('provider update time missing');
            return { identity: JSON.stringify([matches[0].symbol.toLowerCase()]), sourceUrl: url, rawBody: b.raw, observedAt: row.quote.USD.last_updated, fetchedAt: b.fetchedAt, value: { symbol: matches[0].symbol, priceUsd: price } };
        }
    };
}
