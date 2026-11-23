import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedHolderBody, holderBodyFetchedAt, resetHolderCacheForTests } from "../src/handlers/holderSourceCache";
beforeEach(() => { resetHolderCacheForTests(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T13:00:00Z")); });
afterEach(() => vi.useRealTimers());
const accept = (_body: string) => {};
async function settle<T>(p: Promise<T>): Promise<T> { await vi.runAllTimersAsync(); return p; }
describe("holder source bounded cache and pacing", () => {
 it("deduplicates a same-token burst and preserves the exact original body", async () => {
  const load=vi.fn(async()=>'{"original":"body"}');
  const pending=Array.from({length:10},()=>cachedHolderBody("same",load,accept));
  expect(await settle(Promise.all(pending))).toEqual(Array(10).fill('{"original":"body"}'));
  expect(load).toHaveBeenCalledTimes(1);
  const fetchedAt = holderBodyFetchedAt("same");
  await vi.advanceTimersByTimeAsync(1000);
  expect(await cachedHolderBody("same",load,accept)).toBe('{"original":"body"}');
  expect(load).toHaveBeenCalledTimes(1);
  expect(holderBodyFetchedAt("same")).toBe(fetchedAt);
 });
 it("expires after 30s and refetches",async()=>{
  const load=vi.fn(async()=>"raw");
  await settle(cachedHolderBody("same",load,accept));
  await vi.advanceTimersByTimeAsync(30001);
  await settle(cachedHolderBody("same",load,accept));expect(load).toHaveBeenCalledTimes(2);
 });
 it("serializes different-chain calls at least 2100ms apart",async()=>{
  const starts:number[]=[];let active=0,maxActive=0;
  const load=async()=>{starts.push(Date.now());active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,50));active--;return "raw";};
  await settle(Promise.all(["base","bsc","polygon","arbitrum"].map(k=>cachedHolderBody(k,load,accept))));
  expect(maxActive).toBe(1);expect(starts).toHaveLength(4);
  for(let i=1;i<starts.length;i++)expect(starts[i]-starts[i-1]).toBeGreaterThanOrEqual(2100);
 });
 it("retries one 429 after backoff and does not cache the failure",async()=>{
  const starts:number[]=[];
  const load=vi.fn(async()=>{starts.push(Date.now());if(starts.length===1)throw Object.assign(new Error("limited"),{status:429});return "raw";});
  expect(await settle(cachedHolderBody("base",load,accept))).toBe("raw");
  expect(starts[1]-starts[0]).toBeGreaterThanOrEqual(5000);
 });
 it("respects a long Retry-After without an early second request",async()=>{
  const load=vi.fn(async()=>{throw Object.assign(new Error("limited"),{status:429,retryAfterMs:60000});});
  const failed=expect(cachedHolderBody("a",load,accept)).rejects.toThrow("limited");await settle(failed);
  expect(load).toHaveBeenCalledTimes(1);
  const starts:number[]=[];
  const blocked=expect(cachedHolderBody("b",async()=>{starts.push(Date.now());return "raw";},accept)).rejects.toThrow("12s budget");
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
