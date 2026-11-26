// /v1/liquidity answers 200 with a disclosed null for unknown pools/chains; the class log line must fire there too, fixed labels only.
import {afterAll,afterEach,expect,it,vi} from 'vitest';import {readFileSync,mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';
const dir=mkdtempSync('/tmp/liq-null-class-');process.env.SQLITE_PATH=join(dir,'v.sqlite');
import {resetLiquidityDiscoveryForTests} from '../src/handlers/liquidityDiscovery';import {buildServer} from '../src/server';
const sol=readFileSync(join(__dirname,'fixtures/liquidity-discovery/gecko-search-solana.json'),'utf8');
afterAll(()=>rmSync(dir,{recursive:true,force:true}));afterEach(()=>{resetLiquidityDiscoveryForTests();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function hit(url:string,fetchImpl:()=>Response){const lines:string[]=[];vi.spyOn(console,'info').mockImplementation((m:unknown)=>{lines.push(String(m));});vi.stubGlobal('fetch',async()=>fetchImpl());const app=buildServer();try{const r=await app.inject(url);return {r,cls:lines.map(l=>{try{return JSON.parse(l);}catch{return {};}}).filter(o=>o.event==='refusal_param_class'),all:lines.join('\n')};}finally{await app.close();}}
it('200 no_data null logs class labels and data_status, never the raw pool or chain',async()=>{
 const {r,cls,all}=await hit('/v1/liquidity?pool=Secret%20Pool%2031337&chain=solana',()=>new Response('{"data":[]}'));
 expect(r.statusCode).toBe(200);expect(r.json().liquidity_usd).toBeNull();
 expect(cls).toHaveLength(1);expect(cls[0]).toMatchObject({intent:'LIQUIDITY_DEPTH_VERIFY_GENERAL',error_code:'DISCLOSED_NULL',status:'200',pool_class:'name',chain_class:'solana',data_status:'no_data'});
 expect(all).not.toContain('Secret');expect(all).not.toContain('31337');
});
it('200 source_unavailable null is labelled source_unavailable',async()=>{
 const {r,cls}=await hit('/v1/liquidity?pool=SOL%2FUSDC&chain=solana',()=>new Response('',{status:503}));
 expect(r.statusCode).toBe(200);expect(r.json().liquidity_usd).toBeNull();expect(cls).toHaveLength(1);expect(cls[0]).toMatchObject({data_status:'source_unavailable',pool_class:'pair_alias'});
});
it('a priced 200 answer logs no class line',async()=>{
 const {r,cls}=await hit('/v1/liquidity?pool=SOL%2FUSDC&chain=solana',()=>new Response(sol));
 expect(r.statusCode).toBe(200);expect(typeof r.json().liquidity_usd).toBe('number');expect(cls).toHaveLength(0);
});
