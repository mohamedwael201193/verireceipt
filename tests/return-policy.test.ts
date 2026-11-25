import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {handleReturnPolicy,resetReturnPolicyBudgetForTests} from '../src/handlers/returnPolicy';
import {sha256Hex} from '../src/core/receipt';
const apple=readFileSync('tests/fixtures/return-policy/apple.html','utf8'),walmart=readFileSync('tests/fixtures/return-policy/walmart.html','utf8');
beforeEach(()=>{resetReturnPolicyBudgetForTests();vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-24T17:00:00Z'));});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();});
it.each([['Apple US',apple,14],['Walmart US',walmart,90]])('reviewed official %s section supplies a standard window and retained fixture bytes',async(retailer,raw,days)=>{
 vi.stubGlobal('fetch',async()=>new Response(raw));const out=await handleReturnPolicy({retailer});expect(out.return_window_days).toBe(days);expect(out.verified).toBe(true);expect(out.answer).toContain('standard return window');expect(out.scope).toContain('not a decision about a particular item');
 const [receipt,evidence]=vi.mocked(saveReceipt).mock.calls[0];expect(evidence).toBe(raw);expect(receipt.raw_response_sha256).toBe(sha256Hex(raw));
 expect(JSON.stringify(out.conditions)).toContain('Holiday exception');expect(out.sources).toHaveLength(1);
});
it('Apple holiday deadline and carrier exclusions are explicit, without replacing standard14',async()=>{
 vi.stubGlobal('fetch',async()=>new Response(apple));const out=await handleReturnPolicy({retailer:'Apple'});expect(out.return_window_days).toBe(14);expect(out.answer).toContain('January 8, 2027');expect(out.answer).toContain('November 6 through December 25, 2026');expect(out.answer).toContain('T-Mobile or Verizon');
});
it.each(['Apple UK','Walmart Canada','Apple for a phone','https://apple.com',''])('no retailer/country substitution for %s',async retailer=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);if(!retailer)await expect(handleReturnPolicy({retailer})).rejects.toMatchObject({status:400});else{const out=await handleReturnPolicy({retailer});expect(out.return_window_days).toBeNull();expect(out.verified).toBe(false);}expect(f).not.toHaveBeenCalled();
});
it.each(['window','holiday','exception','missing'])('refuses changed %s section, never returns a remembered window',async mode=>{
 const raw=mode==='window'?apple.replace('You have 14 calendar days','You have 30 calendar days'):mode==='holiday'?apple.replace(/January 8, 2027/g,'January 9, 2027'):mode==='exception'?apple.replace(/Opened software/g,'Different exclusion'):'<html>unavailable</html>';
 vi.stubGlobal('fetch',async()=>new Response(raw));await expect(handleReturnPolicy({retailer:'Apple US'})).rejects.toMatchObject({code:'POLICY_UNVERIFIED'});expect(saveReceipt).not.toHaveBeenCalled();
});
it('live read every call; transport403 never uses prior successful body',async()=>{
 const f=vi.fn().mockResolvedValueOnce(new Response(apple)).mockResolvedValueOnce(new Response('blocked',{status:403}));vi.stubGlobal('fetch',f);await handleReturnPolicy({retailer:'Apple US'});await expect(handleReturnPolicy({retailer:'Apple US'})).rejects.toMatchObject({code:'POLICY_UNVERIFIED'});expect(f).toHaveBeenCalledTimes(2);expect(saveReceipt).toHaveBeenCalledTimes(1);
});
it('expired reviewed interpretation refuses without fetch',async()=>{
 vi.setSystemTime(new Date('2026-12-02T00:00:00Z'));const f=vi.fn();vi.stubGlobal('fetch',f);await expect(handleReturnPolicy({retailer:'Apple'})).rejects.toMatchObject({code:'POLICY_REVIEW_EXPIRED'});expect(f).not.toHaveBeenCalled();
});
it('abort-ignoring network never holds caller or writes a late receipt',async()=>{
 let release:(r:Response)=>void=()=>{};vi.stubGlobal('fetch',async()=>new Promise<Response>(r=>{release=r;}));const pending=handleReturnPolicy({retailer:'Apple'}).catch(e=>e);await vi.advanceTimersByTimeAsync(3500);expect((await pending).code).toBe('POLICY_UNVERIFIED');release(new Response(apple));await vi.advanceTimersByTimeAsync(1);expect(saveReceipt).not.toHaveBeenCalled();
});
it('storage failure does not certify policy',async()=>{
 vi.stubGlobal('fetch',async()=>new Response(apple));vi.mocked(saveReceipt).mockRejectedValueOnce(Error('storage'));await expect(handleReturnPolicy({retailer:'Apple'})).rejects.toMatchObject({code:'RECEIPT_PERSIST_FAILED'});
});

it('start budget blocks21strequest without network',async()=>{
 const f=vi.fn(async()=>new Response(apple));vi.stubGlobal('fetch',f);for(let i=0;i<20;i++)await handleReturnPolicy({retailer:'Apple'});
 await expect(handleReturnPolicy({retailer:'Apple'})).rejects.toMatchObject({code:'POLICY_BUDGET'});expect(f).toHaveBeenCalledTimes(20);
});
it.each([403,429,500])('HTTP%s refusal is not retried or certified',async status=>{
 const f=vi.fn(async()=>new Response('unavailable',{status}));vi.stubGlobal('fetch',f);await expect(handleReturnPolicy({retailer:'Walmart US'})).rejects.toMatchObject({code:'POLICY_UNVERIFIED'});expect(f).toHaveBeenCalledTimes(1);expect(saveReceipt).not.toHaveBeenCalled();
});
