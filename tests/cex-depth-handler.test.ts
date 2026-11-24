import{it,expect,vi,afterEach}from'vitest';import{readFileSync}from'node:fs';import{join}from'node:path';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import{saveReceipt}from'../src/core/storage';import{handleCexDepth}from'../src/handlers/cexDepth';import{createWiredFinanceHandlers}from'../src/handlers/financeWired';
const raw=readFileSync(join(__dirname,'fixtures/cex-depth/bitstamp-btcusd.json'),'utf8');
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()});
it('only explicit CEX selector uses pair book, writes exact bytes and honest scope',async()=>{
 vi.spyOn(Date,'now').mockReturnValue(Number(JSON.parse(raw).timestamp)*1000);const f=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',f);
 const out=await createWiredFinanceHandlers({}).liquidity({pool:'BTC/USD',chain:'bitstamp'});
 expect(out.chain).toBe('bitstamp');expect(out.band_pct).toBe(2);expect(out.answer).toContain('not DEX pool liquidity');
 const args=vi.mocked(saveReceipt).mock.calls;expect(String(args.at(-1)![1])).toContain(JSON.stringify(raw).slice(1,-1));
 expect(String(f.mock.calls[0][0])).toContain('/btcusd/');
 await expect(handleCexDepth({pool:'BTC/USD',chain:'ethereum'})).rejects.toMatchObject({status:400});
 await expect(handleCexDepth({pool:'BTC/USDT',chain:'bitstamp'})).rejects.toMatchObject({status:400});expect(f).toHaveBeenCalledTimes(1);
});
it('source failures and failed receipt persistence fail closed',async()=>{
 vi.stubGlobal('fetch',async()=>new Response('blocked',{status:403}));await expect(handleCexDepth({pool:'BTC/USD',chain:'bitstamp'})).rejects.toMatchObject({status:502});
 vi.spyOn(Date,'now').mockReturnValue(Number(JSON.parse(raw).timestamp)*1000);vi.stubGlobal('fetch',async()=>new Response(raw));vi.mocked(saveReceipt).mockRejectedValueOnce(new Error('storage fault'));
 await expect(handleCexDepth({pool:'BTC/USD',chain:'bitstamp'})).rejects.toMatchObject({status:502,code:'RECEIPT_PERSIST_FAILED'});
});
