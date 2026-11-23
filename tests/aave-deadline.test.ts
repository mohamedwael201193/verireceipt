import {afterEach,it,expect,vi} from 'vitest';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {createFinanceObservationHandlers} from '../src/handlers/financeObservations';
import type {ObservationSource} from '../src/core/observedSources';
import type {YieldQuery,YieldValue} from '../src/handlers/financeObservations';
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
it('yield permits a bounded 1200ms primary read rather than a 900ms timeout',async()=>{
 vi.useFakeTimers();const now=new Date().toISOString();
 const source:ObservationSource<YieldQuery,YieldValue>={name:'synthetic timing control, not live evidence',approval:{commercialUse:true,redistribution:true,termsUrl:'https://example.org',checkedAt:now},read:async()=>{await new Promise(r=>setTimeout(r,1200));return {identity:JSON.stringify(['aave-v3','usdc','ethereum']),sourceUrl:'https://example.org',rawBody:'timing control',observedAt:now,fetchedAt:now,value:{project:'aave-v3',symbol:'USDC',chain:'ethereum',supplyApyBps:250,components:'supply only'}};}};
 const pending=createFinanceObservationHandlers({price:[],liquidity:[],yield:[source]}).yield({project:'aave-v3',symbol:'USDC',chain:'ethereum'});
 await vi.advanceTimersByTimeAsync(1300);expect((await pending).supply_apy).toBe(250);
});
it('yield deadline aborts an over-budget source and refuses late output',async()=>{
 vi.useFakeTimers();let signal:AbortSignal|undefined;const now=new Date().toISOString();
 const source:ObservationSource<YieldQuery,YieldValue>={name:'synthetic hung source',approval:{commercialUse:true,redistribution:true,termsUrl:'https://example.org',checkedAt:now},read:async(_q,s)=>{signal=s;return new Promise(()=>{});}};
 const pending=createFinanceObservationHandlers({price:[],liquidity:[],yield:[source]}).yield({project:'aave-v3',symbol:'USDC',chain:'ethereum'});
 const refused=expect(pending).rejects.toMatchObject({code:'APPROVED_SOURCES_UNAVAILABLE'});
 await vi.advanceTimersByTimeAsync(5001);await refused;expect(signal?.aborted).toBe(true);
});
