import { badRequest } from '../core/errors';
import { observeFromSources, type ObservationSource } from '../core/observedSources';
export interface PriceQuery {
    symbol: string;
}
export interface PriceValue {
    symbol: string;
    priceUsd: number;
}
export interface PoolQuery {
    pool: string;
    chain: string;
}
export interface PoolValue {
    pool: string;
    chain: string;
    liquidityUsd: number;
}
export interface YieldQuery {
    project: string;
    symbol: string;
    chain: string;
}
export interface YieldValue {
    project: string;
    symbol: string;
    chain: string;
    supplyApyBps: number;
    components: string;
}
export interface FinanceSourceLists {
    price: readonly ObservationSource<PriceQuery, PriceValue>[];
    liquidity: readonly ObservationSource<PoolQuery, PoolValue>[];
    yield: readonly ObservationSource<YieldQuery, YieldValue>[];
}
function required(value: string | undefined, name: string): string { const s = value?.trim(); if (!s || s.length > 256 || /[\x00-\x1f]/.test(s))
    throw badRequest('INVALID_PARAM', `${name} is required and must be at most 256 printable characters`); return s; }
function range(n: number, min: number, max: number): void { if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max)
    throw new Error('observation outside canonical range'); }
const key = (...xs: string[]) => JSON.stringify(xs.map(s => s.toLowerCase()));
/** Source lists are developer-owned reviewed code. No provider is enabled here. */
export function createFinanceObservationHandlers(lists: FinanceSourceLists) {
    return {
        price: async (q: Record<string, string | undefined>) => {
            const symbol = required(q.symbol, 'symbol').toUpperCase();
            if (!/^[A-Z0-9][A-Z0-9._-]{1,31}$/.test(symbol))
                throw badRequest('INVALID_SYMBOL', 'symbol syntax is invalid');
            return observeFromSources({ symbol }, lists.price, { intent: 'CRYPTO_PRICE_USD', identity: q => key(q.symbol), validate: v => { if (v.symbol !== symbol)
                    throw new Error('asset identity mismatch'); range(v.priceUsd, .0001, 1e7); }, fields: v => ({ symbol: v.symbol, price_usd: v.priceUsd, price: v.priceUsd, currency: 'USD' }), answer: v => `${v.symbol}: ${v.priceUsd} USD per unit.`, maxAgeMs: 60000, sourceTimeoutMs: 900, scope: 'Named provider quote, not an executable offer or market-wide consensus.' });
        },
        liquidity: async (q: Record<string, string | undefined>) => {
            const query = { pool: required(q.pool, 'pool'), chain: required(q.chain, 'chain').toLowerCase() };
            return observeFromSources(query, lists.liquidity, { intent: 'LIQUIDITY_DEPTH_VERIFY_GENERAL', identity: q => key(q.chain, q.pool), validate: v => { if (key(v.chain, v.pool) !== key(query.chain, query.pool))
                    throw new Error('pool identity mismatch'); range(v.liquidityUsd, 1, 1e12); }, fields: v => ({ pool: v.pool, chain: v.chain, liquidity_usd: v.liquidityUsd }), answer: v => `${v.pool} on ${v.chain}: ${v.liquidityUsd} USD total pool reserves.`, maxAgeMs: 5 * 60000, sourceTimeoutMs: 3000, totalTimeoutMs: 3000, stopAfterTimeout: true, scope: 'Total reserve liquidity in USD, not executable depth at a slippage threshold. No similar-name pool substitution.' });
        },
        yield: async (q: Record<string, string | undefined>) => {
            const query = { project: required(q.project, 'project').toLowerCase(), symbol: required(q.symbol, 'symbol').toUpperCase(), chain: required(q.chain, 'chain').toLowerCase() };
            return observeFromSources(query, lists.yield, { intent: 'CRYPTO_YIELD_RATE_GENERAL', identity: q => key(q.project, q.symbol, q.chain), validate: v => { if (key(v.project, v.symbol, v.chain) !== key(query.project, query.symbol, query.chain))
                    throw new Error('yield pool identity mismatch'); range(v.supplyApyBps, 0, 100000); if (typeof v.components !== 'string' || !v.components.trim())
                    throw new Error('yield component disclosure required'); }, fields: v => ({ project: v.project, symbol: v.symbol, chain: v.chain, supply_apy: v.supplyApyBps, yield_components: v.components }), answer: v => `${v.project} ${v.symbol} on ${v.chain}: supply APY ${v.supplyApyBps} basis points (${v.supplyApyBps / 100}%). Components: ${v.components}.`, maxAgeMs: 15 * 60000, sourceTimeoutMs: 5000, scope: 'Observed supply APY, not a guaranteed future return; basis points, not percent. Ambiguous matching pools must be refused by the source adapter.' });
        }
    };
}
export const unconfiguredFinanceHandlers = createFinanceObservationHandlers({ price: [], liquidity: [], yield: [] });
