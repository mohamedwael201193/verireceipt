import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedHolderBody, resetHolderCacheForTests } from "../src/handlers/holderSourceCache";
beforeEach(() => { resetHolderCacheForTests(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T13:00:00Z")); });
afterEach(() => vi.useRealTimers());
const accept = (_body: string) => {};
async function settle<T>(p: Promise<T>): Promise<T> { await vi.runAllTimersAsync(); return p; }
describe("holder source bounded cache and pacing", () => {
 it("deduplicates a same-token burst and preserves the exact original body", async () => {
  const load=vi.fn(async()=>'{"original":"body"}');
  const pending=Array.from({length:10},()=>cachedHolderBody("same",load,accept));
  expect(await settle(Promise.all(pending))).toEqual(Array(10).fill({body:'{"original":"body"}',fetchedAt:new Date().toISOString()}));
  expect(load).toHaveBeenCalledTimes(1);
  const fetchedAt = (await cachedHolderBody("same",load,accept)).fetchedAt;
  await vi.advanceTimersByTimeAsync(1000);
  expect((await cachedHolderBody("same",load,accept)).body).toBe('{"original":"body"}');
  expect(load).toHaveBeenCalledTimes(1);
  expect((await cachedHolderBody("same",load,accept)).fetchedAt).toBe(fetchedAt);
 });
 it("expires after five minutes and refetches",async()=>{
  const load=vi.fn(async()=>"raw");
  await settle(cachedHolderBody("same",load,accept));
  await vi.advanceTimersByTimeAsync(300001);
  await settle(cachedHolderBody("same",load,accept));expect(load).toHaveBeenCalledTimes(2);
 });
 it("serializes different-chain calls at least 2100ms apart",async()=>{
  const starts:number[]=[];let active=0,maxActive=0;
  const load=async()=>{starts.push(Date.now());active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,50));active--;return "raw";};
  await settle(Promise.all(["base","bsc"].map(k=>cachedHolderBody(k,load,accept))));
  expect(maxActive).toBe(1);expect(starts).toHaveLength(2);
  for(let i=1;i<starts.length;i++)expect(starts[i]-starts[i-1]).toBeGreaterThanOrEqual(2100);
 });
 it("makes only one attempt on HTTP429 even when retry fits the budget",async()=>{
  const load=vi.fn(async()=>{throw Object.assign(new Error("limited"),{status:429});});
  const failed=expect(cachedHolderBody("base",load,accept)).rejects.toThrow("limited");await settle(failed);
  expect(load).toHaveBeenCalledTimes(1);
 });
 it("respects a long Retry-After without an early second request",async()=>{
  const load=vi.fn(async()=>{throw Object.assign(new Error("limited"),{status:429,retryAfterMs:60000});});
  const failed=expect(cachedHolderBody("a",load,accept)).rejects.toThrow("limited");await settle(failed);
  expect(load).toHaveBeenCalledTimes(1);
  const starts:number[]=[];
  const blocked=expect(cachedHolderBody("b",async()=>{starts.push(Date.now());return "raw";},accept)).rejects.toThrow("429 cooldown");
  await settle(blocked);expect(starts).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(60000);
  await settle(cachedHolderBody("b",async()=>{starts.push(Date.now());return "raw";},accept));
  expect(starts[0]).toBeGreaterThanOrEqual(Date.parse("2026-11-23T13:01:00Z"));
 });
 it("revalidates staleness on cache hits, and never caches invalid replacements",async()=>{
  const updated=Date.now()-86400000+500;
  const validate=()=>{if(Date.now()-updated>86400000)throw new Error("stale");};
  const load=vi.fn(async()=>"raw");await settle(cachedHolderBody("base",load,validate));
  await vi.advanceTimersByTimeAsync(1000);
  const rejected=expect(cachedHolderBody("base",load,validate)).rejects.toThrow("stale");await settle(rejected);
  expect(load).toHaveBeenCalledTimes(2);
 });
});

it("bounds queued wait to 3s while the leading request is still in flight",async()=>{
 let release!:(s:string)=>void;
 const lead=cachedHolderBody("lead",()=>new Promise<string>(r=>{release=r;}),accept);
 await vi.advanceTimersByTimeAsync(0);
 const queued=cachedHolderBody("queued",async()=>"raw",accept);
 const checked=expect(queued).rejects.toThrow("3s wait budget");
 await vi.advanceTimersByTimeAsync(3001);await checked;
 release("raw");await settle(lead);
});
it("passes the reduced remaining HTTP budget after a paced start",async()=>{
 const budgets:number[]=[];
 await settle(cachedHolderBody("a",async()=>"raw",accept));
 await settle(cachedHolderBody("b",async remaining=>{budgets.push(remaining);return "raw";},accept,Date.now()+3000));
 expect(budgets[0]).toBeLessThanOrEqual(800);expect(budgets[0]).toBeGreaterThan(0);
});
it("caps eight pending distinct tokens before loading a ninth",async()=>{
 let release!:(s:string)=>void;
 const first=cachedHolderBody("0",()=>new Promise<string>(r=>{release=r;}),accept);
 await vi.advanceTimersByTimeAsync(0);
 const pending=Array.from({length:7},(_,i)=>cachedHolderBody(String(i+1),async()=>"raw",accept).catch(e=>String(e)));
 await expect(cachedHolderBody("ninth",async()=>"raw",accept)).rejects.toThrow("queue full");
 release("raw");await settle(Promise.all([first,...pending]));
});


it("429 fallback returns only the last validated body and original acquisition time",async()=>{
 const validate=vi.fn();let limited=false;
 const load=vi.fn(async()=>{if(limited)throw Object.assign(new Error("429"),{status:429});return "real-body";});
 const original=await settle(cachedHolderBody("x",load,validate));
 await vi.advanceTimersByTimeAsync(300001);limited=true;
 const stale=await settle(cachedHolderBody("x",load,validate));
 expect(stale.body).toBe(original.body);expect(stale.fetchedAt).toBe(original.fetchedAt);
 expect(stale.staleReason).toContain("429");
 const calls=load.mock.calls.length;
 expect((await cachedHolderBody("x",load,validate)).staleReason).toContain("429");expect(load.mock.calls.length).toBe(calls);
});
it("discloses a retained observation for non-429 failures within the short window",async()=>{
 let fail=false;const load=async()=>{if(fail)throw new Error("503");return "real-body";};
 await settle(cachedHolderBody("x",load,accept));await vi.advanceTimersByTimeAsync(300001);fail=true;
 const stale=await settle(cachedHolderBody("x",load,accept));expect(stale.body).toBe("real-body");expect(stale.staleReason).toContain("request failed");
});
it("rejects a retained observation crossing the 24h source bound during 429",async()=>{
 const source=Date.now();let fail=false;
 const load=async()=>{if(fail)throw Object.assign(new Error("429"),{status:429,retryAfterMs:60000});return "real-body";};
 const validate=()=>{if(Date.now()-source>86400000)throw new Error("stale source");};
 await settle(cachedHolderBody("x",load,validate));await vi.advanceTimersByTimeAsync(86400001);fail=true;
 const checked=expect(cachedHolderBody("x",load,validate)).rejects.toThrow("429");await settle(checked);
});

it.each([600000,600001,86400001])("refuses retained data at acquisition age %ims",async age=>{
 let fail=false;const load=vi.fn(async()=>{if(fail)throw new Error("503");return "exact-original";});
 await settle(cachedHolderBody("bound",load,accept));await vi.advanceTimersByTimeAsync(age);fail=true;
 const checked=expect(cachedHolderBody("bound",load,accept)).rejects.toThrow("503");await settle(checked);expect(load).toHaveBeenCalledTimes(2);
});
it("keeps stale fallback below ten minutes and never refreshes its acquisition timestamp",async()=>{
 let fail=false;const load=vi.fn(async()=>{if(fail)throw new Error("503");return "exact-original";});
 const first=await settle(cachedHolderBody("bound",load,accept));await vi.advanceTimersByTimeAsync(599999);fail=true;
 const stale=await settle(cachedHolderBody("bound",load,accept));expect(stale.body).toBe(first.body);expect(stale.fetchedAt).toBe(first.fetchedAt);expect(stale.staleReason).toBeTruthy();
 await vi.advanceTimersByTimeAsync(1);const checked=expect(cachedHolderBody("bound",load,accept)).rejects.toThrow("503");await settle(checked);
});
it("never serves a stale value belonging to another token",async()=>{
 await settle(cachedHolderBody("one",async()=>"real",accept));await vi.advanceTimersByTimeAsync(300001);
 const checked=expect(cachedHolderBody("two",async()=>{throw new Error("503");},accept)).rejects.toThrow("503");await settle(checked);
});
it("invalid replacement falls back only to the original validated observation",async()=>{
 let invalid=false;const load=async()=>invalid?"invalid":"original";const validate=(s:string)=>{if(s!=="original")throw new Error("invalid response");};
 const first=await settle(cachedHolderBody("x",load,validate));await vi.advanceTimersByTimeAsync(300001);invalid=true;
 const stale=await settle(cachedHolderBody("x",load,validate));expect(stale.body).toBe(first.body);expect(stale.fetchedAt).toBe(first.fetchedAt);expect(stale.staleReason).toContain("invalid response");
});
it("revalidates provider age during fallback even with a six-minute acquisition age",async()=>{
 const sourceUpdated=Date.now()-86400000+350000;
 let fail=false;const load=vi.fn(async()=>{if(fail)throw new Error("503");return "original";});
 const validate=vi.fn(()=>{if(Date.now()-sourceUpdated>86400000)throw new Error("provider exceeds 24h");});
 await settle(cachedHolderBody("provider-age",load,validate));
 await vi.advanceTimersByTimeAsync(360000);fail=true;
 const checked=expect(cachedHolderBody("provider-age",load,validate)).rejects.toThrow("503");await settle(checked);
 expect(load).toHaveBeenCalledTimes(2);expect(validate).toHaveBeenCalledTimes(2);
});
