import { afterAll, afterEach, it, expect, vi } from 'vitest';
import { rmSync } from 'node:fs';
const fixture = vi.hoisted(() => { process.env.SQLITE_PATH = '/tmp/vr-finance-wired-' + process.pid + '.sqlite'; delete process.env.DATABASE_URL; return { path: process.env.SQLITE_PATH }; });
vi.mock('../src/core/storage', async original => ({ ...await original<typeof import('../src/core/storage')>(), saveReceipt: vi.fn(async () => { }) }));
import { saveReceipt, closeStorage } from '../src/core/storage';
import {
    CHAINLINK_USD_FEEDS, COINPAPRIKA_TICKERS, COINGECKO_TICKERS, COINMARKETCAP_TICKERS, DEXSCREENER_POOLS,
    CHAINLINK_APPROVAL, COINPAPRIKA_APPROVAL, COINGECKO_APPROVAL, COINMARKETCAP_APPROVAL, DEXSCREENER_APPROVAL,
    createWiredFinanceHandlers, ethereumPinnedLegs,
} from '../src/handlers/financeWired';
import { buildServer } from '../src/server';

const OWNER_REFERENCE = 'owner-risk-acceptance-2026-11-23';
afterEach(() => vi.clearAllMocks());
afterAll(async () => { await closeStorage(); for (const s of ['', '-wal', '-shm']) rmSync(fixture.path + s, { force: true }); });

it('Chainlink bindings carry the verified ETH/USD and BTC/USD mainnet proxies with their own heartbeats', () => {
    expect(CHAINLINK_USD_FEEDS.map(b => b.symbol).sort()).toEqual(['BTC', 'ETH']);
    for (const b of CHAINLINK_USD_FEEDS) {
        expect(b.chainId).toBe('1');
        expect(/^0x[0-9a-fA-F]{40}$/.test(b.proxy)).toBe(true);
        expect(new URL(b.registryUrl).protocol).toBe('https:');
        expect(b.maxAgeMs).toBe(3600000);
    }
    expect(CHAINLINK_USD_FEEDS.find(b => b.symbol === 'ETH')!.proxy).toBe('0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419');
    expect(CHAINLINK_USD_FEEDS.find(b => b.symbol === 'BTC')!.proxy).toBe('0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c');
});

it('ticker bindings name the providers own canonical asset ids for exactly BTC and ETH', () => {
    expect(COINPAPRIKA_TICKERS.map(b => `${b.symbol}:${b.coinpaprikaId}`).sort()).toEqual(['BTC:btc-bitcoin', 'ETH:eth-ethereum']);
    expect(COINGECKO_TICKERS.map(b => `${b.symbol}:${b.coingeckoId}`).sort()).toEqual(['BTC:bitcoin', 'ETH:ethereum']);
    expect(COINMARKETCAP_TICKERS.map(b => `${b.symbol}:${b.cmcId}`).sort()).toEqual(['BTC:1', 'ETH:1027']);
});

it('reviewed pool bindings retain the verified USDC/WETH pool and add UNI/WETH', () => {
    expect(DEXSCREENER_POOLS.length).toBe(2);
    const p = DEXSCREENER_POOLS[0];
    expect(p.address).toBe('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640');
    expect(p.chain).toBe('ethereum');
    expect(p.dexScreenerChain).toBe('ethereum');
    expect(p.dexId).toBe('uniswap');
});

it('every configured approval keeps licence booleans false and points at the opaque owner risk reference', () => {
    for (const a of [CHAINLINK_APPROVAL, COINPAPRIKA_APPROVAL, COINGECKO_APPROVAL, COINMARKETCAP_APPROVAL, DEXSCREENER_APPROVAL]) {
        expect(a.commercialUse).toBe(false);
        expect(a.redistribution).toBe(false);
        expect(new URL(a.termsUrl).protocol).toBe('https:');
        expect(Number.isFinite(Date.parse(a.checkedAt))).toBe(true);
        expect(a.ownerRiskAcceptance?.scope).toBe('testnet-hackathon');
        expect(a.ownerRiskAcceptance?.sourceReference).toBe(OWNER_REFERENCE);
        expect(Date.parse(a.ownerRiskAcceptance!.acceptedAt)).toBe(Date.parse('2026-11-23'));
    }
});

it('pinned legs reuse the keyless MAINNET_RPCS, so evidence URL equals RPC URL', () => {
    const legs = ethereumPinnedLegs();
    expect(legs.length).toBeGreaterThanOrEqual(2);
    for (const l of legs) {
        expect(l.evidenceUrl).toBe(l.rpcUrl);
        expect(new URL(l.rpcUrl).protocol).toBe('https:');
    }
});

it('keyed failover legs appear only with a non-blank key, order stays Chainlink, CoinPaprika, Gecko, CMC', () => {
    const bare = createWiredFinanceHandlers({} as NodeJS.ProcessEnv);
    expect(bare.priceSourceNames).toEqual(['Chainlink USD finalized proxy state', 'CoinPaprika USD ticker']);
    const blank = createWiredFinanceHandlers({ COINGECKO_API_KEY: '   ', COINMARKETCAP_API_KEY: '\t' } as NodeJS.ProcessEnv);
    expect(blank.priceSourceNames).toEqual(bare.priceSourceNames);
    const keyed = createWiredFinanceHandlers({ COINGECKO_API_KEY: 'k1', COINMARKETCAP_API_KEY: 'k2' } as NodeJS.ProcessEnv);
    expect(keyed.priceSourceNames).toEqual(['Chainlink USD finalized proxy state', 'CoinPaprika USD ticker', 'CoinGecko USD simple price', 'CoinMarketCap USD latest quote']);
    expect(keyed.liquiditySourceNames).toEqual(['DEX Screener named pool reserve liquidity','GeckoTerminal exact pool reserve liquidity']);
});

it('yield is wired to the Aave on-chain rate; unbound queries fail closed without network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
        const h = createWiredFinanceHandlers({} as NodeJS.ProcessEnv);
        expect(h.yieldSourceNames).toEqual(['Aave v3 on-chain reserve liquidity rate (safe-head, not finalized)']);
        await expect(h.yield({ project: 'compound', symbol: 'USDC', chain: 'ethereum' })).rejects.toMatchObject({ status: 502, code: 'APPROVED_SOURCES_UNAVAILABLE' });
        await expect(h.yield({ project: 'aave-v3', symbol: 'WBTC', chain: 'ethereum' })).rejects.toMatchObject({ status: 502, code: 'APPROVED_SOURCES_UNAVAILABLE' });
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(saveReceipt).not.toHaveBeenCalled();
    }
    finally {
        vi.unstubAllGlobals();
    }
});

it('route /v1/yield is wired and fails closed for unbound queries', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const app = buildServer();
    try {
        const r = await app.inject({ method: 'GET', url: '/v1/yield?project=compound&symbol=USDC&chain=ethereum' });
        expect(r.statusCode).toBe(502);
        expect(r.json().code).toBe('APPROVED_SOURCES_UNAVAILABLE');
        const missing = await app.inject({ method: 'GET', url: '/v1/yield?project=aave-v3&symbol=USDC' });
        expect(missing.statusCode).toBe(400);
        expect(fetchSpy).not.toHaveBeenCalled();
    }
    finally {
        await app.close();
        vi.unstubAllGlobals();
    }
});

it('unbound symbols and pools fail closed without touching the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
        const h = createWiredFinanceHandlers({ COINGECKO_API_KEY: 'k1', COINMARKETCAP_API_KEY: 'k2' } as NodeJS.ProcessEnv);
        await expect(h.price({ symbol: 'DOGE' })).rejects.toMatchObject({ status: 502, code: 'APPROVED_SOURCES_UNAVAILABLE' });
        expect(await h.liquidity({ pool: 'USDC/WETH 0.05%', chain: 'base' })).toMatchObject({liquidity_usd:null,data_status:'source_unavailable'});
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(saveReceipt).toHaveBeenCalledTimes(1);
    }
    finally {
        vi.unstubAllGlobals();
    }
});

it('routes /v1/price and /v1/liquidity are wired and fail closed for unbound queries', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const app = buildServer();
    try {
        const price = await app.inject({ method: 'GET', url: '/v1/price?symbol=DOGE' });
        expect(price.statusCode).toBe(502);
        expect(price.json().code).toBe('APPROVED_SOURCES_UNAVAILABLE');
        const liquidity = await app.inject({ method: 'GET', url: '/v1/liquidity?pool=NOPE&chain=ethereum' });
        expect(liquidity.statusCode).toBe(200);
        expect(liquidity.json()).toMatchObject({liquidity_usd:null,data_status:'source_unavailable'});
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    }
    finally {
        await app.close();
        vi.unstubAllGlobals();
    }
});

it('routes reject a missing required parameter with 400, not 502', async () => {
    const app = buildServer();
    try {
        const r = await app.inject({ method: 'GET', url: '/v1/price' });
        expect(r.statusCode).toBe(400);
    }
    finally {
        await app.close();
    }
});
