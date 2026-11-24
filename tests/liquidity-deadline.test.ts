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
it('price keeps its 900 ms per-source deadline and yield keeps its reviewed 5000 ms deadline', async () => {
    vi.useFakeTimers(); vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
    const h = createWiredFinanceHandlers({});
    const price = expect(h.price({symbol:'ETH'})).rejects.toMatchObject({code:'APPROVED_SOURCES_UNAVAILABLE'});
    let yieldSettled=false;
    const yieldPending=h.yield({project:'aave-v3',symbol:'USDC',chain:'ethereum'}).finally(()=>{yieldSettled=true;});
    const yieldResult=expect(yieldPending).rejects.toMatchObject({code:'APPROVED_SOURCES_UNAVAILABLE'});
    await vi.advanceTimersByTimeAsync(1800); await price;
    expect(saveReceipt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3199); expect(yieldSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await yieldResult;
    await vi.advanceTimersByTimeAsync(5000);
    expect(saveReceipt).not.toHaveBeenCalled();
});
it('fast primary failure leaves only the remainder of the shared 3000 ms budget for abort-ignoring fallback',async()=>{
 vi.useFakeTimers();
 const gecko=readFileSync(join(__dirname,'fixtures/gecko-pool-bound.json'),'utf8');
 const fetch=vi.fn((url:unknown)=>new Promise<Response>(resolve=>{
  setTimeout(()=>resolve(String(url).includes('api.dexscreener.com')?new Response('unavailable',{status:503}):new Response(gecko)),String(url).includes('api.dexscreener.com')?1000:2400);
 }));vi.stubGlobal('fetch',fetch);
 let settled=false;const p=createWiredFinanceHandlers({}).liquidity(query).finally(()=>{settled=true;});
 const checked=expect(p).rejects.toMatchObject({code:'APPROVED_SOURCES_UNAVAILABLE'});
 await vi.advanceTimersByTimeAsync(2999);expect(settled).toBe(false);
 await vi.advanceTimersByTimeAsync(1);await checked;expect(fetch).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(5000);expect(saveReceipt).not.toHaveBeenCalled();
});
it('fast primary failure still allows fallback success inside the shared budget',async()=>{
 vi.useFakeTimers();const gecko=readFileSync(join(__dirname,'fixtures/gecko-pool-bound.json'),'utf8');
 const fetch=vi.fn((url:unknown)=>new Promise<Response>(resolve=>setTimeout(()=>resolve(String(url).includes('api.dexscreener.com')?new Response('unavailable',{status:503}):new Response(gecko)),1000)));
 vi.stubGlobal('fetch',fetch);const p=createWiredFinanceHandlers({}).liquidity(query);
 await vi.advanceTimersByTimeAsync(2000);expect((await p).liquidity_usd).toBe(68820142.6838);expect(saveReceipt).toHaveBeenCalledTimes(1);
});
it('a stalled primary body read consumes its 2500 ms deadline without starting fallback',async()=>{
 vi.useFakeTimers();const fetch=vi.fn(async()=>new Response(new ReadableStream({start(){}})));vi.stubGlobal('fetch',fetch);
 const p=expect(createWiredFinanceHandlers({}).liquidity(query)).rejects.toMatchObject({code:'APPROVED_SOURCES_UNAVAILABLE'});
 await vi.advanceTimersByTimeAsync(3000);await p;expect(fetch).toHaveBeenCalledTimes(1);expect(saveReceipt).not.toHaveBeenCalled();
});
