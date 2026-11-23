import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseVelora, aggregatorSummary, observeVelora, veloraUrl } from "../src/handlers/routeAggregator";
const body = readFileSync(join(__dirname, "fixtures/route-aggregator/velora-eth-usdc.json"), "utf8");
const pin = JSON.parse(body).priceRoute.blockNumber;
afterEach(() => vi.unstubAllGlobals());
describe("Velora provider-block quote", () => {
 it("reads the recorded identity, amount and block without changing units", () => {
  expect(parseVelora(body, pin)).toEqual({amount:1718535585n, block:pin});
 });
 it("rejects old/future blocks and mismatched identities", () => {
  expect(() => parseVelora(body, pin+1)).toThrow();
  expect(() => parseVelora(body, pin-3)).toThrow();
  const d=JSON.parse(body); d.priceRoute.network=10;
  expect(() => parseVelora(JSON.stringify(d),pin)).toThrow();
 });
 it("reports lower median separately from best before gas", () => {
  const o={source:"Velora",url:"recorded",body,fetched_at:"recorded",amount_out:"1718535585"};
  expect(aggregatorSummary(1718000000n,o)).toEqual({median:1718000000n,best:1718535585n,bestSource:"Velora/ParaSwap"});
 });
 it("excludes implausible disagreement without changing the baseline", () => {
  const o={source:"Velora",url:"recorded",body,fetched_at:"recorded",amount_out:"3000000000",excluded:undefined as string|undefined};
  expect(aggregatorSummary(1718000000n,o).median).toBe(1718000000n);
  expect(o.excluded).toContain("agreement band");
 });
 it("retains exact body on valid observation and error response", async () => {
  vi.stubGlobal("fetch",async()=>new Response(body));
  expect((await observeVelora(pin)).body).toBe(body);
  vi.stubGlobal("fetch",async()=>new Response("unavailable",{status:503}));
  const failed=await observeVelora(pin);
  expect(failed.body).toBe("unavailable"); expect(failed.excluded).toContain("503");
 });
 it("propagates parent cancellation to the fetch", async () => {
  vi.stubGlobal("fetch",async(_u:unknown,opts:RequestInit)=>{
   if(opts.signal?.aborted) throw new Error("aborted");
   return new Promise((_resolve,reject)=>opts.signal?.addEventListener("abort",()=>reject(new Error("aborted"))));
  });
  const c=new AbortController(); const pending=observeVelora(pin,c.signal); c.abort();
  expect((await pending).excluded).toContain("aborted");
 });
});


describe("generic aggregator identity from actual quotes", () => {
 it.each(["link-usdc", "usdc-weth"])("preserves %s direction and output decimals", async (name) => {
  const raw = readFileSync(join(__dirname, `fixtures/route-aggregator/velora-${name}.json`), "utf8");
  const p = JSON.parse(raw).priceRoute;
  const identity = { sellToken: p.srcToken, buyToken: p.destToken, amountIn: BigInt(p.srcAmount), sellDecimals: p.srcDecimals, buyDecimals: p.destDecimals };
  expect(parseVelora(raw, p.blockNumber, identity).amount.toString()).toBe(p.destAmount);
  expect(() => parseVelora(raw, p.blockNumber, { ...identity, sellToken: p.destToken, buyToken: p.srcToken })).toThrow();
  expect(() => parseVelora(raw, p.blockNumber, { ...identity, buyDecimals: p.destDecimals + 1 })).toThrow();
  const u = new URL(veloraUrl(identity)); expect(u.searchParams.get("srcToken")).toBe(p.srcToken);
  expect(u.searchParams.get("destToken")).toBe(p.destToken); expect(u.searchParams.get("amount")).toBe(p.srcAmount);
  vi.stubGlobal("fetch", async () => new Response(raw));
  const observed = await observeVelora(p.blockNumber, undefined, identity);
  expect(observed.amount_out).toBe(p.destAmount); expect(observed.body).toBe(raw);
 });
});
