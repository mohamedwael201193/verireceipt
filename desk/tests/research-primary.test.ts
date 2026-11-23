// Injected unit transports only, never live observations.
import {describe,it,expect} from 'vitest';
import {verifyResearchPrimary} from '../src/researchPrimary.js';
import snapshot from '../policy/m13-intents.snapshot.json';
import {validateLiveFact} from '../src/researchLiveAdapter.js';
import type {FactSpec} from '../src/researchDesk.js';
const now=()=>new Date('2026-11-23T01:00:00Z');
const macro:FactSpec={id:'macro',intent:'MACRO_ECONOMIC_INDICATOR_GENERAL',params:{indicator:'unemployment rate',country:'US',year:'2024'},field:'rate_pct',unit:'percent',max_age_seconds:300};
const macroRow={indicator:{id:'SL.UEM.TOTL.ZS'},country:{id:'US'},countryiso3code:'USA',date:'2024',value:4.12345678};
const transport=(j:any)=>async()=>Response.json(j);
describe('independent primary parsers',()=>{
 it('matches exact World Bank indicator/country/year and 6dp',async()=>{const r=await verifyResearchPrimary(macro,'4.123457',{f:transport([{},[macroRow]]),now});expect(r.ok).toBe(true);expect(r.source!.raw_text).toContain('4.12345678');});
 it.each([{...macroRow,date:'2023'},{...macroRow,country:{id:'EG'},countryiso3code:'EGY'},{...macroRow,indicator:{id:'CPI'}},{...macroRow,value:null}])('rejects macro scope mismatch or unavailable value',async(row)=>expect((await verifyResearchPrimary(macro,'4.123457',{f:transport([{},[row]]),now})).ok).toBe(false));
 it('macro refuses unsupported country or absent year without fetch',async()=>{let calls=0;const f=async()=>{calls++;return Response.json({});};const r=await verifyResearchPrimary({...macro,params:{indicator:'unemployment rate',country:'guess'}},'1',{f,now});expect(r.ok).toBe(false);expect(calls).toBe(0);});
 it('HTTP refusal is HOLD not zero',async()=>expect((await verifyResearchPrimary(macro,'0',{f:async()=>new Response('',{status:503}),now})).ok).toBe(false));
 const price:FactSpec={id:'price',intent:'CRYPTO_PRICE_USD',params:{symbol:'UNI'},field:'price_usd',unit:'USD/token',max_age_seconds:60};
 it('matches explicitly selected USD spot pair',async()=>expect((await verifyResearchPrimary(price,'12',{f:transport({error:[],result:{UNIUSD:{c:['12.01']}}}),now})).ok).toBe(true));
 it('rejects USDT quote substituting USD pair',async()=>expect((await verifyResearchPrimary(price,'12',{f:transport({error:[],result:{UNIUSDT:{c:['12']}}}),now})).ok).toBe(false));
 it('rejects price outside fixed relative tolerance',async()=>expect((await verifyResearchPrimary(price,'15',{f:transport({error:[],result:{UNIUSD:{c:['12']}}}),now})).ok).toBe(false));
 it('rejects wrapped/native symbol alias',async()=>expect((await verifyResearchPrimary({...price,params:{symbol:'WETH'}},'12',{f:transport({}),now})).ok).toBe(false));
 const yieldFact:FactSpec={id:'yield',intent:'CRYPTO_YIELD_RATE_GENERAL',params:{project:'unit',symbol:'USDC',chain:'ethereum'},field:'supply_apy',unit:'bps',max_age_seconds:60};
 it('converts percent APY to bps exactly',async()=>expect((await verifyResearchPrimary(yieldFact,'125',{f:transport({data:[{project:'unit',symbol:'USDC',chain:'Ethereum',apyBase:1.25}]}),now})).ok).toBe(true));
 it('does not pick from ambiguous yield pools',async()=>{const row={project:'unit',symbol:'USDC',chain:'Ethereum',apyBase:1.25};expect((await verifyResearchPrimary(yieldFact,'125',{f:transport({data:[row,row]}),now})).ok).toBe(false);});
 it('does not treat APY percent as bps',async()=>expect((await verifyResearchPrimary(yieldFact,'1.25',{f:transport({data:[{project:'unit',symbol:'USDC',chain:'Ethereum',apyBase:1.25}]}),now})).ok).toBe(false));
 it('rejects missing parser',async()=>expect((await verifyResearchPrimary({...price,intent:'INVENTED'},'1',{f:transport({}),now})).ok).toBe(false));
});
describe('live schema revalidation, unit transport',()=>{
 const snapshotMacro=snapshot.schemas.find(s=>s.intent_name===macro.intent)!;
 const schema={intent_name:macro.intent,lifecycle:{state:'active'},request:snapshotMacro.request,response:snapshotMacro.response};
 it('checks actual allowed/min/max schema keys',async()=>expect((await validateLiveFact(macro,transport(schema))).ok).toBe(true));
 it.each([{indicator:'inflation',country:'US',year:'2024'},{indicator:'unemployment rate',country:'US',year:'1900'},{indicator:'unemployment rate',country:'US',year:'2101'},{indicator:'unemployment rate',country:'US',year:'2024',guess:'yes'}])('rejects changed input contract',async params=>expect((await validateLiveFact({...macro,params:params as Record<string,string>},transport(schema))).ok).toBe(false));
 it('rejects null schema and inactive intent',async()=>{expect((await validateLiveFact(macro,transport({...schema,request:null}))).ok).toBe(false);expect((await validateLiveFact(macro,transport({...schema,lifecycle:{state:'paused'}}))).ok).toBe(false);});
});

describe('source-byte replay, injected unit transports',()=>{
 it('reparses source bytes with fixed parser and rejects changed byte',async()=>{const {replayPrimaryBytes}=await import('../src/researchPublicReplay.js');const r=await verifyResearchPrimary(macro,'4.123457',{f:transport([{},[macroRow]]),now});const o={source:r.source,value:'4.123457'} as any;expect(await replayPrimaryBytes(macro,o,now().toISOString())).toBe(true);o.source.raw_text+='x';expect(await replayPrimaryBytes(macro,o,now().toISOString())).toBe(false);});
 it('will not fetch a source URL chosen by a packet',async()=>{const {replayPrimaryBytes}=await import('../src/researchPublicReplay.js');const r=await verifyResearchPrimary(macro,'4.123457',{f:transport([{},[macroRow]]),now});const reads=JSON.parse(r.source!.raw_text);reads[0].url='https://example.invalid/attacker';r.source!.raw_text=JSON.stringify(reads);const {createHash}=await import('node:crypto');r.source!.content_sha256=createHash('sha256').update(r.source!.raw_text).digest('hex');expect(await replayPrimaryBytes(macro,{source:r.source,value:'4.123457'} as any,now().toISOString())).toBe(false);});
});

describe('chain-bound token supply primary, unit RPC transport only',()=>{
 const supply:FactSpec={id:'supply',intent:'TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL',params:{token:'UNI on ethereum'},field:'total_supply',unit:'token',max_age_seconds:1800};
 function rpc(mutant?:'chain'|'block'|'decimals'|'supply'){
  let calls=0;const f:typeof fetch=async(url,init)=>{calls++;const req=JSON.parse(String(init?.body));const second=String(url).includes('drpc');let result:unknown;
   if(req.method==='eth_chainId')result=mutant==='chain'&&second?'0x89':'0x1';
   else if(req.method==='eth_getBlockByNumber')result={number:'0x123',hash:'0x'+(mutant==='block'&&second?'b':'a').repeat(64),timestamp:'0x'+Math.floor(now().getTime()/1000-60).toString(16)};
   else if(req.method==='eth_call')result=req.params[0].data==='0x313ce567'?(mutant==='decimals'&&second?'0x7':'0x6'):(mutant==='supply'&&second?'0x5':'0x5f5e100');
   return Response.json({jsonrpc:'2.0',id:1,result});
  };return {f,get calls(){return calls;}};
 }
 it('requires two chain-bound matching finalized block/supply/decimal reads',async()=>{const t=rpc();const r=await verifyResearchPrimary(supply,'100',{f:t.f,now});expect(r.ok).toBe(true);expect(t.calls).toBe(9);expect(r.source!.raw_text).toContain('eth_chainId');expect(r.source!.raw_text).toContain('0x18160ddd');});
 it.each(['chain','block','decimals','supply'] as const)('rejects RPC %s mismatch',async mutant=>expect((await verifyResearchPrimary(supply,'100',{f:rpc(mutant).f,now})).ok).toBe(false));
 it('does not silently treat base units as whole tokens',async()=>expect((await verifyResearchPrimary(supply,'100000000',{f:rpc().f,now})).ok).toBe(false));
 it('source replay preserves method/body selectors for RPC calls',async()=>{const {replayPrimaryBytes}=await import('../src/researchPublicReplay.js');const r=await verifyResearchPrimary(supply,'100',{f:rpc().f,now});expect(await replayPrimaryBytes(supply,{source:r.source,value:'100'} as any,now().toISOString())).toBe(true);});
});
