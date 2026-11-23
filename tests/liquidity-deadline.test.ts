import {afterEach, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
vi.mock('../src/core/storage', () => ({saveReceipt: vi.fn(async () => {})}));
import {saveReceipt} from '../src/core/storage';
import {createWiredFinanceHandlers, DEXSCREENER_POOLS} from '../src/handlers/financeWired';
const raw = readFileSync(join(__dirname, 'fixtures/liquidity-deadline/ethereum-usdc-weth.json'), 'utf8');
const pool = DEXSCREENER_POOLS[0];
const query = {chain: pool.chain, pool: pool.address};
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();});
function delayedFetch(delay: number, respectAbort = true) {
    return vi.fn((_url: unknown, options: RequestInit) => new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(raw)), delay);
        if (respectAbort) options.signal?.addEventListener('abort', () => {clearTimeout(timer); reject(new Error('aborted'));}, {once: true});
    }));
}
it('receipts a 2400 ms captured-body response through the wired handler, keeping exact bytes and digest', async () => {
    vi.useFakeTimers();
    const fetch = delayedFetch(2400); vi.stubGlobal('fetch', fetch);
    const pending = createWiredFinanceHandlers({}).liquidity(query);
    await vi.advanceTimersByTimeAsync(2400);
    const out = await pending;
    expect(out.liquidity_usd).toBe(JSON.parse(raw).pairs[0].liquidity.usd);
    expect(saveReceipt).toHaveBeenCalledTimes(1);
    const [receipt, evidence] = vi.mocked(saveReceipt).mock.calls[0];
    const parsed = JSON.parse(evidence);
    expect(JSON.parse(parsed.raw_body).source_raw_body).toBe(raw);
    expect(parsed.observed_at).toBe(parsed.fetched_at);
    expect(receipt.fetched_at).toBe(parsed.fetched_at);
    expect(receipt.raw_response_sha256).toBe(createHash('sha256').update(evidence).digest('hex'));
    expect(fetch).toHaveBeenCalledTimes(1);
});
it('aborts a slow upstream at 2500 ms and never saves a receipt', async () => {
    vi.useFakeTimers();
    const fetch = delayedFetch(2700); vi.stubGlobal('fetch', fetch);
    const pending = expect(createWiredFinanceHandlers({}).liquidity(query)).rejects.toMatchObject({code: 'APPROVED_SOURCES_UNAVAILABLE'});
    await vi.advanceTimersByTimeAsync(2500); await pending;
    expect((fetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveReceipt).not.toHaveBeenCalled();
});
it('runner rejects at 3000 ms even when fetch ignores abort, without a late receipt', async () => {
    vi.useFakeTimers(); vi.stubGlobal('fetch', delayedFetch(4000, false));
    const pending = expect(createWiredFinanceHandlers({}).liquidity(query)).rejects.toMatchObject({code: 'APPROVED_SOURCES_UNAVAILABLE'});
    await vi.advanceTimersByTimeAsync(3000); await pending;
    await vi.advanceTimersByTimeAsync(1500);
    expect(saveReceipt).not.toHaveBeenCalled();
});
it('price and yield keep their 900 ms runner deadlines', async () => {
    vi.useFakeTimers(); vi.stubGlobal('fetch', delayedFetch(4000, false));
    const h = createWiredFinanceHandlers({});
    const price = expect(h.price({symbol:'ETH'})).rejects.toMatchObject({code:'APPROVED_SOURCES_UNAVAILABLE'});
    const yieldResult = expect(h.yield({project:'aave-v3',symbol:'USDC',chain:'ethereum'})).rejects.toMatchObject({code:'APPROVED_SOURCES_UNAVAILABLE'});
    await vi.advanceTimersByTimeAsync(1800); await price; await yieldResult;
    expect(saveReceipt).not.toHaveBeenCalled();
});
