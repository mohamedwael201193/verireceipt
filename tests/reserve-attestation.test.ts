import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/reserve-attestation-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
import { handleReserveAttestation, parseRoundData } from "../src/handlers/reserveAttestation";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real eth_call bodies for the WBTC PoR proxy, retrieved 2026-11-23 from
// two independent legs; they agree exactly (answer 116144.74510048 WBTC,
// updatedAt 1795338491, decimals 8).
const roundBlast = readFileSync(join(__dirname, "fixtures/reserve-attestation/wbtc-round-blastapi.json"), "utf8");
const roundDrpc = readFileSync(join(__dirname, "fixtures/reserve-attestation/wbtc-round-drpc.json"), "utf8");
const decBody = readFileSync(join(__dirname, "fixtures/reserve-attestation/wbtc-decimals-blastapi.json"), "utf8");
function stub(opts: { round?: string; dec?: string; down?: boolean; emptyRound?: boolean; supplyDown?: boolean; supplyDecimals?: string } = {}): void {
  vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
    if (opts.down) throw new Error("rpc outage");
    const call = JSON.parse(String(init?.body ?? "{}")).params?.[0];
    const data = call?.data;
    if (call?.to?.toLowerCase() === "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599") {
      if (opts.supplyDown) throw new Error("sensitive upstream token error");
      return new Response(data === "0x18160ddd"
        ? readFileSync(join(__dirname, "fixtures/reserve-attestation/wbtc-supply-blast.json"), "utf8")
        : opts.supplyDecimals ?? decBody);
    }
    if (data === "0x313ce567") return new Response(opts.dec ?? decBody, { status: 200 });
    if (opts.emptyRound) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), { status: 200 });
    return new Response(opts.round ?? roundBlast, { status: 200 });
  });
}
describe("ASSET_RESERVE_ATTESTATION_GENERAL", () => {
  it("requires an asset and discloses coverage-only unknown responses", async () => {
    await expect(handleReserveAttestation({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    stub();
    expect(await handleReserveAttestation({ asset: "ION" })).toMatchObject({ attested_reserve: null, verdict: "unavailable" });
    expect(await handleReserveAttestation({ asset: "DOGE" })).toMatchObject({ attested_reserve: null, verdict: "unavailable" });
  });
  it("parses the real round body", () => {
    const d = parseRoundData(JSON.parse(roundBlast).result);
    expect(d.answer).toBe(11614474510048n);
    expect(d.updatedAt).toBe(1795338491);
  });
  it("serves the WBTC attestation in micro-units with age and source named", async () => {
    stub();
    const result = await handleReserveAttestation({ asset: "wbtc" });
    expect(result.attested_reserve).toBe(116144745100); // answer / 100 (8 decimals -> micro)
    const ans = String(result.answer);
    expect(ans).toContain("Chainlink WBTC Proof of Reserves");
    expect(ans).toContain("not an independent audit");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("ASSET_RESERVE_ATTESTATION_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    expect(String(stored.evidence)).toContain("micro_remainder");
  });
  it("an RPC outage and an empty feed answer both fail closed", async () => {
    stub({ down: true });
    await expect(handleReserveAttestation({ asset: "WBTC" })).rejects.toMatchObject({ status: 502, code: "RPC_QUORUM_UNREACHABLE" });
    vi.unstubAllGlobals();
    stub({ emptyRound: true });
    await expect(handleReserveAttestation({ asset: "WBTC" })).rejects.toMatchObject({ status: 502, code: "FEED_UNREADABLE" });
  });
  it("GET /v1/reserve-attestation is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/reserve-attestation" })).toBe(true);
    await app.close();
  });
});


describe("reserve supply scope from actual RPC bodies", () => {
  it("leads with human reserve and compares only to Ethereum supply without a global ratio", async () => {
    stub();
    const out = await handleReserveAttestation({ asset: "WBTC" });
    expect(out.ethereum_total_supply).toBe(116381.88357262);
    expect(out.reserve_vs_ethereum_supply_pct).toBeCloseTo(116144.74510048 / 116381.88357262 * 100, 8);
    expect(out.collateral_ratio_pct).toBeNull();
    expect(out.answer).toContain("not a global collateral ratio");
    expect(out.answer).toContain("other native chains are excluded");
    expect(String(out.answer).indexOf("116,144.74510048")).toBeLessThan(String(out.answer).indexOf("micro-units"));
    expect(out.updated_at).toBe(new Date(1795338491 * 1000).toISOString());
    expect(out.heartbeat_seconds).toBe(86400);
    const receipt = out.receipt as { receipt_id: string; raw_response_sha256: string };
    const stored = await getReceiptEvidence(receipt.receipt_id);
    expect(sha256Hex(stored.evidence!)).toBe(receipt.raw_response_sha256);
    expect(String(stored.evidence)).toContain("raw_supply");
  });
  it("keeps the reserve but does not invent supply or ratio on supply quorum failure", async () => {
    stub({ supplyDown: true }); const out = await handleReserveAttestation({ asset: "WBTC" });
    expect(out.attested_reserve).toBe(116144745100); expect(out.ethereum_total_supply).toBeNull();
    expect(out.reserve_vs_ethereum_supply_pct).toBeNull(); expect(out.answer).toContain("supply unavailable");
    expect(JSON.stringify(out)).not.toContain("sensitive upstream");
  });
  it("rejects wrong token decimals as unavailable rather than scaling a false supply", async () => {
    stub({ supplyDecimals: JSON.stringify({ result: "0x" + "12".padStart(64, "0") }) });
    expect((await handleReserveAttestation({ asset: "WBTC" })).ethereum_total_supply).toBeNull();
  });
  it("unknown inherited property names never select a feed", async () => {
    expect((await handleReserveAttestation({ asset: "constructor" })).attested_reserve).toBeNull();
  });
});


describe("all enabled token bindings from two live RPC captures", () => {
  it.each([
    ["WBTC", "wbtc", "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", 8],
    ["cbBTC", "cbbtc", "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", 8],
    ["TUSD", "tusd", "0x0000000000085d4780b73119b644ae5ecd22b376", 18],
  ] as const)("binds %s supply to the verified token and decimals", async (asset, file, token, decimals) => {
    const raw = (name: string, leg: string) => readFileSync(join(__dirname, `fixtures/reserve-attestation/${file}-${name}-${leg}.json`), "utf8");
    expect(JSON.parse(raw("supply", "blast")).result).toBe(JSON.parse(raw("supply", "drpc")).result);
    vi.stubGlobal("fetch", async (url: unknown, init?: { body?: string }) => {
      const leg = String(url).includes("drpc") ? "drpc" : "blast";
      const call = JSON.parse(String(init?.body)).params[0];
      if (call.to.toLowerCase() === token) return new Response(raw(call.data === "0x18160ddd" ? "supply" : "token-decimals", leg));
      if (call.data === "0xfeaf968c") return new Response(raw("round", leg + "-supply-slice"));
      return new Response(readFileSync(join(__dirname, `fixtures/reserve-attestation/${file}-feed-decimals-supply-slice.json`), "utf8"));
    });
    const out = await handleReserveAttestation({ asset });
    const expected = Number(BigInt(JSON.parse(raw("supply", "blast")).result)) / 10 ** decimals;
    expect(out.ethereum_total_supply).toBe(expected);
    expect(out.reserve_vs_ethereum_supply_pct).toBeCloseTo(Number(out.reserve_units) / expected * 100, 8);
    expect(out.collateral_ratio_pct).toBeNull();
  });
});
describe('existing-feed exact address and case aliases',()=>{
 const assets=[['WBTC','0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'],['cbBTC','0xcBb7C0000aB88B473b1f5afd9ef808440eed33bf'],['TUSD','0x0000000000085d4780B73119b644AE5ecd22b376']];
 it.each(assets)('%s exact Ethereum token address resolves to the existing feed without changing the numeric result',async(asset,address)=>{stub();const symbol=await handleReserveAttestation({asset});const byAddress=await handleReserveAttestation({asset:address});expect(byAddress.asset).toBe(asset);expect(byAddress.attested_reserve).toBe(symbol.attested_reserve);expect(String(byAddress.source_feed).split("; fetched")[0]).toBe(String(symbol.source_feed).split("; fetched")[0]);});
 it.each(['wBtC','cBbTc','tUsD'])('%s mixed symbol case resolves',async asset=>{stub();expect((await handleReserveAttestation({asset})).attested_reserve).not.toBeNull();});
 it.each(['0x2260fac5','0x2260fac5e5542a773aa44fbcfedf7c193bc2c590','ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599','0x0000000000000000000000000000000000000000'])('unsupported/prefix address never aliases %s',async asset=>{const fn=vi.fn(()=>{throw new Error('must not fetch');});vi.stubGlobal('fetch',fn);expect((await handleReserveAttestation({asset})).attested_reserve).toBeNull();if(/^0x[0-9a-fA-F]{40}$/.test(asset))expect(fn.mock.calls.length).toBeGreaterThan(0);else expect(fn).not.toHaveBeenCalled();});
});

describe('bounded optional supply enrichment',()=>{
 it.each(['fetch','body'])('%s ignores abort: validated reserve still returns within900ms and late output never updates receipt',async mode=>{
  const {resetReserveSupplyReadsForTests}=await import('../src/handlers/reserveAttestation');resetReserveSupplyReadsForTests();vi.useFakeTimers();
  const releases:(()=>void)[]=[];let optionalCalls=0;
  vi.stubGlobal('fetch',async(_u:any,o:any)=>{const c=JSON.parse(o.body).params[0];if(c.to.toLowerCase()==='0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'){optionalCalls++;if(mode==='fetch')return new Promise<Response>(r=>releases.push(()=>r(new Response(decBody))));return new Response(new ReadableStream({start(c){releases.push(()=>{c.enqueue(new TextEncoder().encode(decBody));c.close();});}}));}return new Response(c.data==='0x313ce567'?decBody:roundBlast);});
  try{const promise=handleReserveAttestation({asset:'WBTC'});await vi.advanceTimersByTimeAsync(900);const out=await promise;expect(out.attested_reserve).toBe(116144745100);expect(out.ethereum_total_supply).toBeNull();expect(out.reserve_vs_ethereum_supply_pct).toBeNull();expect(optionalCalls).toBe(6);const receipt=out.receipt as any;const before=await getReceiptEvidence(receipt.receipt_id);expect(Buffer.from(before.evidence!).toString()).toContain('token_supply_quorum_unavailable');
  const repeat=await handleReserveAttestation({asset:'WBTC'});expect(repeat.ethereum_total_supply).toBeNull();expect(optionalCalls).toBe(6);
  for(const r of releases)r();await vi.advanceTimersByTimeAsync(1);expect((await getReceiptEvidence(receipt.receipt_id)).evidence).toEqual(before.evidence);expect(out.ethereum_total_supply).toBeNull();
  }finally{resetReserveSupplyReadsForTests();vi.useRealTimers();}
 });
 it('oversized optional body falls open without losing the validated reserve',async()=>{vi.stubGlobal('fetch',async(_u:any,o:any)=>{const c=JSON.parse(o.body).params[0];return new Response(c.to.toLowerCase()==='0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'?' '.repeat(10001)+(c.data==='0x313ce567'?decBody:JSON.stringify({result:'0x'+'1'.padStart(64,'0')})):c.data==='0x313ce567'?decBody:roundBlast);});const out=await handleReserveAttestation({asset:'WBTC'});expect(out.attested_reserve).toBe(116144745100);expect(out.ethereum_total_supply).toBeNull();});
});
it('mixed assets saturate16 underlying optional keys, retain cap after timeout, and reuse only a truly freed slot',async()=>{const {resetReserveSupplyReadsForTests,POR_FEEDS}=await import('../src/handlers/reserveAttestation');resetReserveSupplyReadsForTests();vi.useFakeTimers();const releases:(()=>void)[]=[];let calls=0;vi.stubGlobal('fetch',async(_u:any,o:any)=>{const c=JSON.parse(o.body).params[0];if(!Object.values(POR_FEEDS).some(f=>f.proxy.toLowerCase()===c.to.toLowerCase())){calls++;return new Promise<Response>(r=>releases.push(()=>r(new Response(decBody))));}return new Response(c.data==='0x313ce567'?decBody:roundBlast);});try{const all=Promise.all(['WBTC','cbBTC','TUSD'].map(asset=>handleReserveAttestation({asset})));await vi.advanceTimersByTimeAsync(899);expect(calls).toBe(16);await vi.advanceTimersByTimeAsync(1);await all;expect(calls).toBe(16);for(const asset of ['WBTC','cbBTC','TUSD'])await handleReserveAttestation({asset});expect(calls).toBe(16);releases[0]();await vi.advanceTimersByTimeAsync(1);const again=Promise.all(['WBTC','cbBTC','TUSD'].map(asset=>handleReserveAttestation({asset})));await vi.advanceTimersByTimeAsync(899);expect(calls).toBe(17);await vi.advanceTimersByTimeAsync(1);await again;for(const r of releases)r();await vi.advanceTimersByTimeAsync(1);}finally{resetReserveSupplyReadsForTests();vi.useRealTimers();}});

describe('required feed real transport budget',()=>{
 it.each(['fetch','body'])('%s ignores abort: fails closed at9s, retains all9feed keys across repeated requests, late bytes create no answer',async mode=>{
  const {resetReserveFeedReadsForTests}=await import('../src/handlers/reserveAttestation');resetReserveFeedReadsForTests();vi.useFakeTimers();let calls=0;const releases:(()=>void)[]=[];
  vi.stubGlobal('fetch',async()=>{calls++;if(mode==='fetch')return new Promise<Response>(r=>releases.push(()=>r(new Response(decBody))));return new Response(new ReadableStream({start(c){releases.push(()=>{c.enqueue(new TextEncoder().encode(decBody));c.close();});}}));});
  try{let settled=false;const promise=Promise.all(['WBTC','cbBTC','TUSD'].map(asset=>handleReserveAttestation({asset}).catch(e=>e))).then(x=>{settled=true;return x;});await vi.advanceTimersByTimeAsync(8999);expect(settled).toBe(false);expect(calls).toBe(9);await vi.advanceTimersByTimeAsync(1);const errors=await promise;for(const e of errors)expect(e).toMatchObject({status:502,code:'RPC_QUORUM_UNREACHABLE'});for(const asset of ['WBTC','cbBTC','TUSD'])await expect(handleReserveAttestation({asset})).rejects.toMatchObject({status:502});expect(calls).toBe(9);releases.shift()!();await vi.advanceTimersByTimeAsync(1);const again=handleReserveAttestation({asset:'WBTC'}).catch(e=>e);await vi.advanceTimersByTimeAsync(1);expect(calls).toBe(10);await vi.advanceTimersByTimeAsync(9000);expect(await again).toMatchObject({status:502});for(const r of releases)r();await vi.advanceTimersByTimeAsync(1);}finally{resetReserveFeedReadsForTests();vi.useRealTimers();}
 });
 it('successful decimals consume shared budget; stalled round refuses exactly at9s not17s',async()=>{const {resetReserveFeedReadsForTests}=await import('../src/handlers/reserveAttestation');resetReserveFeedReadsForTests();vi.useFakeTimers();const releases:(()=>void)[]=[];vi.stubGlobal('fetch',async(_u:any,o:any)=>{const c=JSON.parse(o.body).params[0];if(c.data==='0x313ce567'){await new Promise(r=>setTimeout(r,8000));return new Response(decBody);}return new Promise<Response>(r=>releases.push(()=>r(new Response(roundBlast))));});try{let settled=false;const pending=handleReserveAttestation({asset:'WBTC'}).catch(e=>{settled=true;return e;});await vi.advanceTimersByTimeAsync(8999);expect(settled).toBe(false);await vi.advanceTimersByTimeAsync(1);expect(settled).toBe(true);expect(await pending).toMatchObject({status:502});for(const r of releases)r();await vi.advanceTimersByTimeAsync(1000);expect(settled).toBe(true);}finally{resetReserveFeedReadsForTests();vi.useRealTimers();}});
 it('oversized but parseable required body refuses instead of reading an unbounded payload',async()=>{vi.stubGlobal('fetch',async()=>new Response(' '.repeat(10001)+decBody));await expect(handleReserveAttestation({asset:'WBTC'})).rejects.toMatchObject({status:502,code:'RPC_QUORUM_UNREACHABLE'});});
 it('required redirects and RPC errors are refused without changing valid quorum rules',async()=>{vi.stubGlobal('fetch',async(_u:any,o:any)=>{expect(o.redirect).toBe('error');const c=JSON.parse(o.body).params[0];return new Response(c.data==='0xfeaf968c'?roundBlast:JSON.stringify({error:{code:-1},result:JSON.parse(decBody).result}));});await expect(handleReserveAttestation({asset:'WBTC'})).rejects.toMatchObject({status:502});});
});

describe('verified additional reserve feeds',()=>{
 const fixture=JSON.parse(readFileSync(join(__dirname,'fixtures/reserve-attestation/expansion-20261125.json'),'utf8'));
 it.each(fixture.feeds)('$asset exact feed identity, micro value, units, heartbeat and evidence from captured3-leg bodies',async(f:any)=>{
  const seen:any[]=[];vi.stubGlobal('fetch',async(url:any,o:any)=>{const c=JSON.parse(o.body).params[0];seen.push(c);expect(c.to).toBe(f.proxy);expect(['0x313ce567','0xfeaf968c']).toContain(c.data);const leg=f.legs.find((l:any)=>l.url===String(url));expect(leg).toBeDefined();return new Response(c.data==='0x313ce567'?leg.decimals.raw:leg.round.raw);});
  const decimals=Number(BigInt(JSON.parse(f.legs[0].decimals.raw).result));const rd=parseRoundData(JSON.parse(f.legs[0].round.raw).result);const micro=decimals<=6?rd.answer*10n**BigInt(6-decimals):rd.answer/10n**BigInt(decimals-6);
  const out=await handleReserveAttestation({asset:f.asset.toLowerCase()});expect(out).toMatchObject({asset:f.asset,attested_reserve:Number(micro),reserve_unit:f.reserve_unit,heartbeat_seconds:f.heartbeat,ethereum_total_supply:null,reserve_vs_ethereum_supply_pct:null,collateral_ratio_pct:null});expect(out.source_feed).toContain(f.proxy);expect(out.answer).toContain(f.reserve_unit);expect(seen).toHaveLength(6);
  const stored=await getReceiptEvidence((out.receipt as any).receipt_id);const evidence=JSON.parse(Buffer.from(stored.evidence!).toString());expect(evidence).toMatchObject({proxy:f.proxy,heartbeat_seconds:f.heartbeat,reserve_unit:f.reserve_unit,answer_raw:rd.answer.toString()});expect(sha256Hex(stored.evidence!)).toBe((out.receipt as any).raw_response_sha256);
 });
 it('USDW uses12h, not default24h staleness and discloses it',async()=>{vi.useFakeTimers();const f=fixture.feeds.find((f:any)=>f.asset==='USDW');const rd=parseRoundData(JSON.parse(f.legs[0].round.raw).result);vi.setSystemTime((rd.updatedAt+43201)*1000);vi.stubGlobal('fetch',async(_u:any,o:any)=>new Response(JSON.parse(o.body).params[0].data==='0x313ce567'?f.legs[0].decimals.raw:f.legs[0].round.raw));try{const out=await handleReserveAttestation({asset:'USDW'});expect(out.answer).toContain('OLDER than the 12h heartbeat');const st=await getReceiptEvidence((out.receipt as any).receipt_id);expect(JSON.parse(Buffer.from(st.evidence!).toString()).stale).toBe(true);}finally{vi.useRealTimers();}});
 it.each(['FBTCsuffix','LB','ethereum:LBTC','0x75A0d3264a949C2C920d7F25Df174af1FaF73399'])('no partial names or feed proxy-as-token aliases %s',async asset=>{const f=vi.fn();vi.stubGlobal('fetch',f);expect((await handleReserveAttestation({asset})).attested_reserve).toBeNull();if(/^0x[0-9a-fA-F]{40}$/.test(asset))expect(f.mock.calls.every(([,o]:any)=>!String(o.body).includes('0xfeaf968c'))).toBe(true);else expect(f).not.toHaveBeenCalled();});

  // 2026-11-26 expansion: stETH, eETH, BGBTC, HBTC, swETH, rswETH, C1USD from captured 3-leg bodies.
  const fx26 = JSON.parse(readFileSync(join(__dirname, "fixtures/reserve-attestation/expansion-20261126.json"), "utf8"));
  const legStub = (f: any, round?: (leg: any) => string) => vi.stubGlobal("fetch", async (url: any, o: any) => {
    const c = JSON.parse(o.body).params[0]; expect(c.to).toBe(f.proxy);
    const leg = f.legs.find((l: any) => l.url === String(url)); expect(leg).toBeDefined();
    return new Response(c.data === "0x313ce567" ? leg.decimals.raw : round ? round(leg) : leg.round.raw);
  });
  const roundOf = (f: any) => parseRoundData(JSON.parse(f.legs[0].round.raw).result);
  it("fixture covers exactly the seven new feeds", () => {
    expect(fx26.feeds.map((f: any) => f.asset)).toEqual(["stETH", "eETH", "BGBTC", "HBTC", "swETH", "rswETH", "C1USD"]);
  });
  it.each(fx26.feeds)("$asset serves the exact feed, micro value inside [1,1e18], with the directory heartbeat", async (f: any) => {
    vi.useFakeTimers();
    try {
      const rd = roundOf(f); vi.setSystemTime((rd.updatedAt + 3600) * 1000); legStub(f);
      const dec = Number(BigInt(JSON.parse(f.legs[0].decimals.raw).result));
      const micro = dec <= 6 ? rd.answer * 10n ** BigInt(6 - dec) : rd.answer / 10n ** BigInt(dec - 6);
      expect(micro >= 1n && micro <= 10n ** 18n).toBe(true);
      const out = await handleReserveAttestation({ asset: f.asset.toLowerCase() });
      expect(out).toMatchObject({ asset: f.asset, attested_reserve: Number(micro), reserve_unit: f.reserve_unit, heartbeat_seconds: f.heartbeat, ethereum_total_supply: null, collateral_ratio_pct: null });
      expect(out.source_feed).toContain(f.proxy);
      const st = await getReceiptEvidence((out.receipt as any).receipt_id);
      const ev = JSON.parse(Buffer.from(st.evidence!).toString());
      expect(ev).toMatchObject({ proxy: f.proxy, stale: false, answer_raw: rd.answer.toString() });
    } finally { vi.useRealTimers(); }
  });
  it("stETH is about 9.70e12 micro-ETH, inside the contract range", async () => {
    const f = fx26.feeds[0]; vi.useFakeTimers();
    try { vi.setSystemTime((roundOf(f).updatedAt + 60) * 1000); legStub(f); const out = await handleReserveAttestation({ asset: "stETH" }); expect(out.attested_reserve).toBe(9702767101123); expect(out.attested_reserve as number).toBeLessThanOrEqual(1e18); }
    finally { vi.useRealTimers(); }
  });
  it.each(fx26.feeds)("$asset one second past its heartbeat refuses, exactly at it still serves", async (f: any) => {
    vi.useFakeTimers();
    try {
      const rd = roundOf(f); legStub(f);
      vi.setSystemTime((rd.updatedAt + f.heartbeat) * 1000);
      expect(await handleReserveAttestation({ asset: f.asset })).toMatchObject({ asset: f.asset });
      vi.setSystemTime((rd.updatedAt + f.heartbeat + 1) * 1000);
      await expect(handleReserveAttestation({ asset: f.asset })).rejects.toMatchObject({ status: 502, code: "STALE_ATTESTATION" });
    } finally { vi.useRealTimers(); }
  });
  it("a stale refusal stores no answer and names no figure", async () => {
    const f = fx26.feeds[3]; vi.useFakeTimers();
    try {
      const rd = roundOf(f); vi.setSystemTime((rd.updatedAt + f.heartbeat + 5) * 1000); legStub(f);
      const err: any = await handleReserveAttestation({ asset: "HBTC" }).catch((e) => e);
      expect(err.code).toBe("STALE_ATTESTATION"); expect(String(err.message)).not.toContain(rd.answer.toString());
    } finally { vi.useRealTimers(); }
  });
  it("a new feed needs quorum: one dissenting leg is outvoted, three different answers refuse", async () => {
    const f = fx26.feeds[2]; vi.useFakeTimers();
    const bump = (raw: string, d: string) => raw.replace(/(0x[0-9a-f]{64})([0-9a-f]{63})([0-9a-f])/, (_m: string, a: string, b: string, c: string) => a + b + d);
    try {
      const rd = roundOf(f); vi.setSystemTime((rd.updatedAt + 60) * 1000);
      legStub(f, (leg) => (leg.url.includes("drpc") ? bump(leg.round.raw, "1") : leg.round.raw));
      expect(await handleReserveAttestation({ asset: "BGBTC" })).toMatchObject({ attested_reserve: 1419999837 });
      legStub(f, (leg) => (leg.url.includes("drpc") ? bump(leg.round.raw, "1") : leg.url.includes("mevblocker") ? bump(leg.round.raw, "2") : leg.round.raw));
      await expect(handleReserveAttestation({ asset: "BGBTC" })).rejects.toMatchObject({ status: 502 });
    } finally { vi.useRealTimers(); }
  });
  it("old feeds keep serving stale data with staleness stated (no behaviour change)", async () => {
    const fb = fixture.feeds.find((x: any) => x.asset === "FBTC"); vi.useFakeTimers();
    try {
      const rd = parseRoundData(JSON.parse(fb.legs[0].round.raw).result); vi.setSystemTime((rd.updatedAt + fb.heartbeat + 100) * 1000);
      vi.stubGlobal("fetch", async (_u: any, o: any) => new Response(JSON.parse(o.body).params[0].data === "0x313ce567" ? fb.legs[0].decimals.raw : fb.legs[0].round.raw));
      expect(await handleReserveAttestation({ asset: "FBTC" })).toMatchObject({ asset: "FBTC" });
    } finally { vi.useRealTimers(); }
  });
  it.each(["0xAd410E655C0fE4741F573152592eeb766e686CE7", "stETHx", "steth proof"])("no proxy-address or partial alias for %s", async (asset) => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    expect((await handleReserveAttestation({ asset })).attested_reserve).toBeNull();
  });
});
