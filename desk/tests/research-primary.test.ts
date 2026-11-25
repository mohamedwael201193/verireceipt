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
 it('reparses source bytes with fixed parser and rejects changed byte',async()=>{const {replayPrimaryBytes}=await import('../src/researchPublicReplay.js');const r=await verifyResearchPrimary(macro,'4.123457',{f:transport([{},[macroRow]]),now});const o={source:r.source,value:'4.123457',as_of:r.as_of} as any;expect(await replayPrimaryBytes(macro,o,now().toISOString())).toBe(true);o.source.raw_text+='x';expect(await replayPrimaryBytes(macro,o,now().toISOString())).toBe(false);});
 it('will not fetch a source URL chosen by a packet',async()=>{const {replayPrimaryBytes}=await import('../src/researchPublicReplay.js');const r=await verifyResearchPrimary(macro,'4.123457',{f:transport([{},[macroRow]]),now});const reads=JSON.parse(r.source!.raw_text);reads[0].url='https://example.invalid/attacker';r.source!.raw_text=JSON.stringify(reads);const {createHash}=await import('node:crypto');r.source!.content_sha256=createHash('sha256').update(r.source!.raw_text).digest('hex');expect(await replayPrimaryBytes(macro,{source:r.source,value:'4.123457',as_of:r.as_of} as any,now().toISOString())).toBe(false);});
});

describe('sanctions full-list recompute primary, unit transport only',()=>{
 const fact:FactSpec={id:'sanctions',intent:'SANCTIONS_SCREENING_MATCH_GENERAL',params:{name:'Ares Capital Corporation'},field:'match_score',unit:'score',max_age_seconds:86400};
 const SDN='https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV';
 const ALT='https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV';
 const UN='https://scsanctions.un.org/resources/xml/en/consolidated.xml';
 const sdnBody=(extra='')=>Array.from({length:1000},(_,i)=>`${i+1},"GENERIC ENTRY ${i+1}",-0- `).join('\n')+(extra?'\n'+extra:'');
 const altBody='999999,1,"aka","ARES CAPITAL CORP"';
 const unBody='<CONSOLIDATED_LIST dateGenerated="2026-11-24T00:00:00.000Z">'+Array.from({length:100},(_,i)=>`<INDIVIDUAL><FIRST_NAME>Person${i}</FIRST_NAME></INDIVIDUAL>`).join('')+'</CONSOLIDATED_LIST>';
 const OFAC_HOST='wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com';
 const lists=(sdn:string,alt=altBody,un=unBody,mutant?:'other-redirect'|'pinned-redirect')=>{const calls:Record<string,number>={};const f:typeof fetch=async(input)=>{const url=String(input);calls[url]=(calls[url]??0)+1;
   if(url===SDN&&mutant==='other-redirect')return new Response(null,{status:302,headers:{location:'https://lists.invalid/SDN.CSV'}});
   if(url===SDN&&mutant==='pinned-redirect'&&calls[url]===1)return new Response(null,{status:302,headers:{location:`https://${OFAC_HOST}/Published/x/SDN.CSV?sig=unit`}});
   if(url.startsWith(`https://${OFAC_HOST}/`))return new Response(sdn,{status:200});
   return new Response(url===SDN?sdn:url===ALT?alt:un,{status:200});
  };return {f,calls};};
 it('recomputes the exact best score from full list bytes',async()=>{const {f}=lists(sdnBody('999999,"ARES CAPITAL CORPORATION",-0- '));const r=await verifyResearchPrimary(fact,'1',{f,now});expect(r.ok).toBe(true);expect(r.source!.parser).toBe('ofac-sdn-alt-un-full-list-recompute-v1');expect(r.source!.raw_text).toContain('ARES CAPITAL CORPORATION');});
 it('rejects a claimed score that differs from the recompute',async()=>{const {f}=lists(sdnBody('999999,"ARES CAPITAL CORPORATION",-0- '));expect((await verifyResearchPrimary(fact,'0.666667',{f,now})).ok).toBe(false);});
 it('accepts a zero score when no candidate reaches the floor',async()=>{const {f}=lists(sdnBody());const r=await verifyResearchPrimary({...fact,params:{name:'Zqwx Vbnm'}},'0',{f,now});expect(r.ok).toBe(true);});
 it('screens SDN aliases whose parent exists',async()=>{const {f}=lists(sdnBody('999999,"ARES CAPITAL CORPORATION",-0- '));const r=await verifyResearchPrimary({...fact,params:{name:'Ares Capital Corp'}},'1',{f,now});expect(r.ok).toBe(true);});
 it('fails closed on a truncated SDN list',async()=>{const {f}=lists(Array.from({length:999},(_,i)=>`${i+1},"GENERIC ENTRY ${i+1}",-0- `).join('\n'));expect((await verifyResearchPrimary(fact,'0',{f,now})).ok).toBe(false);});
 it('fails closed on HTTP refusal, no retry',async()=>{let calls=0;const f:typeof fetch=async()=>{calls++;return new Response('',{status:429});};expect((await verifyResearchPrimary(fact,'0',{f,now})).ok).toBe(false);expect(calls).toBe(1);});
 it('rejects a redirect to any unpinned host',async()=>{const {f,calls}=lists(sdnBody(),undefined,undefined,'other-redirect');expect((await verifyResearchPrimary(fact,'0',{f,now})).ok).toBe(false);expect(calls[SDN]).toBe(1);});
 it('follows the pinned publication-host redirect',async()=>{const {f,calls}=lists(sdnBody('999999,"ARES CAPITAL CORPORATION",-0- '),undefined,undefined,'pinned-redirect');expect((await verifyResearchPrimary(fact,'1',{f,now})).ok).toBe(true);expect(calls[SDN]).toBe(1);});
 it('stored list bytes replay exactly',async()=>{const {replayPrimaryBytes}=await import('../src/researchPublicReplay.js');const {f}=lists(sdnBody('999999,"ARES CAPITAL CORPORATION",-0- '));const r=await verifyResearchPrimary(fact,'1',{f,now});expect(await replayPrimaryBytes(fact,{source:r.source,value:'1',as_of:r.as_of} as any,now().toISOString())).toBe(true);});
});

describe('blockscout token holders primary, unit transport only',()=>{
 const UNI='0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
 const holders:FactSpec={id:'holders',intent:'TOKEN_HOLDER_COUNT_GENERAL',params:{token:'UNI',chain:'ethereum'},field:'holders_count',unit:'addresses',max_age_seconds:86400};
 it('matches holder count within the declared 100bps tolerance',async()=>{const r=await verifyResearchPrimary(holders,'432000',{f:transport({address_hash:UNI,holders_count:'432070'}),now});expect(r.ok).toBe(true);expect(r.source!.parser).toBe('blockscout-ethereum-token-holders-v1-100bps');});
 it('rejects contract identity mismatch',async()=>expect((await verifyResearchPrimary(holders,'432000',{f:transport({address_hash:'0x0000000000000000000000000000000000000000',holders_count:'432000'}),now})).ok).toBe(false));
 it('rejects drift beyond the declared tolerance',async()=>expect((await verifyResearchPrimary(holders,'500000',{f:transport({address_hash:UNI,holders_count:'432070'}),now})).ok).toBe(false));
 it('rejects malformed holder count',async()=>expect((await verifyResearchPrimary(holders,'432000',{f:transport({address_hash:UNI,holders_count:'many'}),now})).ok).toBe(false));
 it('refuses non-ethereum chains without fetching',async()=>{let calls=0;const f=async()=>{calls++;return Response.json({});};expect((await verifyResearchPrimary({...holders,params:{token:'UNI',chain:'base'}},'1',{f,now})).ok).toBe(false);expect(calls).toBe(0);});
 it('refuses a symbol outside the verified contract registry without fetching',async()=>{let calls=0;const f=async()=>{calls++;return Response.json({});};expect((await verifyResearchPrimary({...holders,params:{token:'NOTAREALTOKEN',chain:'ethereum'}},'1',{f,now})).ok).toBe(false);expect(calls).toBe(0);});
 it('source bytes replay exactly',async()=>{const {replayPrimaryBytes}=await import('../src/researchPublicReplay.js');const r=await verifyResearchPrimary(holders,'432000',{f:transport({address_hash:UNI,holders_count:'432070'}),now});expect(await replayPrimaryBytes(holders,{source:r.source,value:'432000',as_of:r.as_of} as any,now().toISOString())).toBe(true);});
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
 it('source replay preserves method/body selectors for RPC calls',async()=>{const {replayPrimaryBytes}=await import('../src/researchPublicReplay.js');const r=await verifyResearchPrimary(supply,'100',{f:rpc().f,now});expect(await replayPrimaryBytes(supply,{source:r.source,value:'100',as_of:r.as_of} as any,now().toISOString())).toBe(true);});
});

describe('reserve attestation primary, unit transport only',()=>{
 const reserve:FactSpec={id:'reserve',intent:'ASSET_RESERVE_ATTESTATION_GENERAL',params:{asset:'TUSD'},field:'attested_reserve',unit:'micro-units of the underlying asset',max_age_seconds:86400};
 const ANSWER=123456789012345678n; // feed units at 8 decimals
 const MICRO=ANSWER/100n;          // handler conversion: floor(answer x 10^(6-8))
 const w=(x:bigint)=>x.toString(16).padStart(64,'0');
 const blockSecs=BigInt(Math.floor(now().getTime()/1000)-60);
 function rpcReserve(mutant?:'chain'|'block'|'decimals'|'round'|'zero'){
  let calls=0;const f:typeof fetch=async(url,init)=>{calls++;const req=JSON.parse(String(init?.body));const second=String(url).includes('drpc');let result:unknown;
   if(req.method==='eth_chainId')result=mutant==='chain'&&second?'0x89':'0x1';
   else if(req.method==='eth_getBlockByNumber')result={number:'0x123',hash:'0x'+(mutant==='block'&&second?'b':'a').repeat(64),timestamp:'0x'+blockSecs.toString(16)};
   else if(req.method==='eth_call'&&req.params[0].data==='0x313ce567')result=mutant==='decimals'&&second?'0x7':'0x8';
   else if(req.method==='eth_call'&&req.params[0].data==='0xfeaf968c'){const answer=mutant==='zero'?0n:mutant==='round'&&second?ANSWER+1n:ANSWER;result='0x'+w(9n)+w(answer)+w(blockSecs)+w(blockSecs)+w(9n);}
   else throw new Error('unexpected RPC method '+req.method);
   return Response.json({jsonrpc:'2.0',id:1,result});
  };return {f,get calls(){return calls;}};
 }
 it('recomputes micro-units from the pinned feed round at a finalized block',async()=>{const t=rpcReserve();const r=await verifyResearchPrimary(reserve,MICRO.toString(),{f:t.f,now});expect(r.ok).toBe(true);expect(r.source!.parser).toBe('evm-two-rpc-finalized-chainlink-por-micro-v1');expect(r.source!.raw_text).toContain('0xfeaf968c');});
 it.each(['chain','block','decimals','round'] as const)('rejects RPC %s mismatch',async mutant=>expect((await verifyResearchPrimary(reserve,MICRO.toString(),{f:rpcReserve(mutant).f,now})).ok).toBe(false));
 it('rejects a paid value that differs by one micro-unit',async()=>expect((await verifyResearchPrimary(reserve,(MICRO+1n).toString(),{f:rpcReserve().f,now})).ok).toBe(false));
 it('refuses a non-positive attestation',async()=>expect((await verifyResearchPrimary(reserve,'0',{f:rpcReserve('zero').f,now})).ok).toBe(false));
 it('refuses an unlisted asset without fetching',async()=>{let calls=0;const f=async()=>{calls++;return Response.json({});};const r=await verifyResearchPrimary({...reserve,params:{asset:'USDC'}},'1',{f,now});expect(r.ok).toBe(false);expect(calls).toBe(0);});
 it('floors the sub-micro remainder exactly as the handler does',async()=>{const odd=ANSWER+99n;const t=rpcReserve();t.f=async(url,init)=>{const req=JSON.parse(String(init?.body));if(req.method==='eth_call'&&req.params[0].data==='0xfeaf968c')return Response.json({jsonrpc:'2.0',id:1,result:'0x'+w(9n)+w(odd)+w(blockSecs)+w(blockSecs)+w(9n)});return rpcReserve().f(url,init);};const r=await verifyResearchPrimary(reserve,(odd/100n).toString(),{f:t.f,now});expect(r.ok).toBe(true);});
 it('source replay re-runs the same RPC sequence from stored bytes',async()=>{const {replayPrimaryBytes}=await import('../src/researchPublicReplay.js');const r=await verifyResearchPrimary(reserve,MICRO.toString(),{f:rpcReserve().f,now});expect(await replayPrimaryBytes(reserve,{source:r.source,value:MICRO.toString(),as_of:r.as_of} as any,now().toISOString())).toBe(true);});
});

describe('pinned-block native balance primary, unit RPC transport only',()=>{
 const POOL='0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801';
 const balance:FactSpec={id:'contract_balance',intent:'ONCHAIN_METRIC_VERIFY_GENERAL',params:{address:POOL,block:'291',chain:'ethereum',metric:'balance'},field:'balance_gwei',unit:'gwei',max_age_seconds:1800};
 const blockSecs=BigInt(Math.floor(now().getTime()/1000)-60);
 function rpcBalance(mutant?:'chain'|'block'|'balance'){
  let calls=0;const f:typeof fetch=async(url,init)=>{calls++;const req=JSON.parse(String(init?.body));const second=String(url).includes('drpc');let result:unknown;
   if(req.method==='eth_chainId')result=mutant==='chain'&&second?'0x89':'0x1';
   else if(req.method==='eth_getBlockByNumber'){expect(req.params[0]).toBe('0x123');result={number:'0x123',hash:'0x'+(mutant==='block'&&second?'b':'a').repeat(64),timestamp:'0x'+blockSecs.toString(16)};}
   else if(req.method==='eth_getBalance'){expect(req.params).toEqual([POOL,'0x123']);result=mutant==='balance'&&second?'0x5f5e101':'0x5f5e100';}
   else throw new Error('unexpected RPC method '+req.method);
   return Response.json({jsonrpc:'2.0',id:1,result});
  };return {f,get calls(){return calls;}};
 }
 // 0x5f5e100 wei = 100000000 wei = 0.1 gwei exactly.
 it('recomputes the exact gwei balance at the pinned block over two chain-bound RPCs',async()=>{const t=rpcBalance();const r=await verifyResearchPrimary(balance,'0.1',{f:t.f,now});expect(r.ok).toBe(true);expect(t.calls).toBe(6);expect(r.source!.parser).toBe('evm-two-rpc-pinned-block-balance-gwei-v1');expect(r.source!.raw_text).toContain('eth_getBalance');});
 it('accepts the zero balance of a WETH pool contract',async()=>{const t=rpcBalance();const zero:typeof fetch=async(url,init)=>{const req=JSON.parse(String(init?.body));if(req.method==='eth_getBalance')return Response.json({jsonrpc:'2.0',id:1,result:'0x0'});return t.f(url,init);};const r=await verifyResearchPrimary(balance,'0',{f:zero,now});expect(r.ok).toBe(true);});
 it.each(['chain','block','balance'] as const)('rejects RPC %s mismatch',async mutant=>expect((await verifyResearchPrimary(balance,'0.1',{f:rpcBalance(mutant).f,now})).ok).toBe(false));
 it('rejects a paid value that differs at wei precision',async()=>expect((await verifyResearchPrimary(balance,'0.100000001',{f:rpcBalance().f,now})).ok).toBe(false));
 it('refuses a non-0x address or a missing block without fetching',async()=>{let calls=0;const f=async()=>{calls++;return Response.json({});};expect((await verifyResearchPrimary({...balance,params:{...balance.params,address:'not-an-address'}},'0',{f,now})).ok).toBe(false);expect((await verifyResearchPrimary({...balance,params:{...balance.params,block:''}},'0',{f,now})).ok).toBe(false);expect(calls).toBe(0);});
 it('refuses the unscored tx_count metric without fetching',async()=>{let calls=0;const f=async()=>{calls++;return Response.json({});};expect((await verifyResearchPrimary({...balance,params:{...balance.params,metric:'tx_count'}},'1',{f,now})).ok).toBe(false);expect(calls).toBe(0);});
 it('refuses a chain outside the live enum without fetching',async()=>{let calls=0;const f=async()=>{calls++;return Response.json({});};expect((await verifyResearchPrimary({...balance,params:{...balance.params,chain:'base'}},'0',{f,now})).ok).toBe(false);expect(calls).toBe(0);});
 it('source replay re-runs the same RPC sequence from stored bytes',async()=>{const {replayPrimaryBytes}=await import('../src/researchPublicReplay.js');const r=await verifyResearchPrimary(balance,'0.1',{f:rpcBalance().f,now});expect(await replayPrimaryBytes(balance,{source:r.source,value:'0.1',as_of:r.as_of} as any,now().toISOString())).toBe(true);});
});


describe('mining hashprice primary, unit transport only',()=>{
 const hp:FactSpec={id:'hashprice',intent:'MINING_HASHPRICE_VERIFY_GENERAL',params:{block_height:'977460'},field:'hashprice_sats_per_ph_day',unit:'sats/PH/day',max_age_seconds:3600};
 const TIP=977460,HASH='a'.repeat(64);
 // Weekly basis at the tip: subsidy era 4 (312500000 sats) + mean fees over
 // mean hashrate. Three DISTINCT series entries so a mean-vs-first mutant
 // dies: first-entry recompute gives 45144 (a +19.7% shift), far outside
 // the declared 500 bps tolerance.
 const weekly=()=>{let calls=0;const f:typeof fetch=async(url)=>{calls++;const u=String(url);
  if(u.endsWith('/api/blocks/tip/height'))return new Response(String(TIP));
  if(u.endsWith('/api/v1/mining/hashrate/1w'))return Response.json({hashrates:[{timestamp:1,avgHashrate:1.0e21},{timestamp:2,avgHashrate:1.2e21},{timestamp:3,avgHashrate:1.4e21}]});
  if(u.endsWith('/api/v1/mining/blocks/fees/1w'))return Response.json([{avgFees:1000000,avgHeight:1},{avgFees:2000000,avgHeight:2},{avgFees:3000000,avgHeight:3}]);
  throw new Error('unexpected URL '+u);};return {f,get calls(){return calls;}};};
 // mean fees 2000000, mean hashrate 1.2e21:
 // (312500000 + 2000000) * 144 * 1e15 / 1.2e21 = 37740 exactly.
 it('recomputes the weekly-series basis at the pinned tip',async()=>{const t=weekly();const r=await verifyResearchPrimary(hp,'37740',{f:t.f,now});expect(r.ok).toBe(true);expect(t.calls).toBe(3);expect(r.source!.parser).toBe('mempool-1w-series-hashprice-recompute-v1-500bps');expect(r.source!.url).toBe('https://mempool.space/api/blocks/tip/height');});
 // Boundary symmetry around the declared 500 bps drift tolerance,
 // relative to the 37740 recompute: 4.9% either way accepts, 5.1% rejects.
 it.each(['39589.26','35890.74'])('accepts a paid value 4.9%% from the recompute (%s)',async v=>expect((await verifyResearchPrimary(hp,v,{f:weekly().f,now})).ok).toBe(true));
 it.each(['39664.74','35815.26'])('rejects a paid value 5.1%% from the recompute (%s)',async v=>expect((await verifyResearchPrimary(hp,v,{f:weekly().f,now})).ok).toBe(false));
 it('fails closed on an empty measured series',async()=>{const f:typeof fetch=async(url)=>{const u=String(url);if(u.endsWith('/api/blocks/tip/height'))return new Response(String(TIP));if(u.endsWith('/api/v1/mining/hashrate/1w'))return Response.json({hashrates:[]});return Response.json([]);};expect((await verifyResearchPrimary(hp,'37740',{f,now})).ok).toBe(false);});
 it('refuses a subsidy era outside the pinned era table',async()=>{const f:typeof fetch=async(url)=>{const u=String(url);if(u.endsWith('/api/blocks/tip/height'))return new Response(String(210000*6));throw new Error('unexpected URL '+u);};expect((await verifyResearchPrimary({...hp,params:{block_height:String(210000*6)}},'1',{f,now})).ok).toBe(false);});
 it('refuses a pinned height above the observed tip after one read',async()=>{let calls=0;const f:typeof fetch=async()=>{calls++;return new Response(String(TIP));};expect((await verifyResearchPrimary({...hp,params:{block_height:String(TIP+1)}},'1',{f,now})).ok).toBe(false);expect(calls).toBe(1);});
 it('refuses a missing or out-of-range pinned height without fetching',async()=>{let calls=0;const f:typeof fetch=async()=>{calls++;return new Response('1');};for(const block_height of ['','0','100000001','abc'])expect((await verifyResearchPrimary({...hp,params:{block_height}},'1',{f,now})).ok).toBe(false);expect(calls).toBe(0);});
 const single=(mutant?:'id'|'height'|'reward'|'difficulty')=>{const f:typeof fetch=async(url)=>{const u=String(url);
  if(u.endsWith('/api/blocks/tip/height'))return new Response(String(TIP));
  if(u.endsWith(`/api/block-height/${TIP-1}`))return new Response(HASH);
  if(u.endsWith(`/api/v1/block/${HASH}`))return Response.json({id:mutant==='id'?'b'.repeat(64):HASH,height:mutant==='height'?TIP-2:TIP-1,extras:{reward:mutant==='reward'?312400000:312500000},difficulty:mutant==='difficulty'?1.09e14*1.001:1.09e14,timestamp:1764000000});
  throw new Error('unexpected URL '+u);};return f;};
 const belowTip={...hp,params:{block_height:String(TIP-1)}};
 // reward 312500000, difficulty 1.09e14:
 // 312500000 * 144 * 1e15 * 600 / (1.09e14 * 2^32) = 57673.6456... -> 2dp 57673.65.
 const singleSats=String(Math.round(312500000*144*1e15/(1.09e14*Math.pow(2,32)/600)*100)/100);
 it('recomputes the single-block basis below the tip exactly within the disclosed 2dp rounding',async()=>{expect(singleSats).toBe('57673.65');const r=await verifyResearchPrimary(belowTip,singleSats,{f:single(),now});expect(r.ok).toBe(true);expect(r.source!.parser).toBe('mempool-single-block-hashprice-recompute-v1');});
 // 2dp quantum boundary: the exact value is 57673.6456..., so one unit of
 // the last decimal either way lands outside the disclosed 0.005 rounding.
 it.each(['57673.66','57673.64'])('rejects a paid value one 2dp unit from the single-block recompute (%s)',async v=>expect((await verifyResearchPrimary(belowTip,v,{f:single(),now})).ok).toBe(false));
 it.each(['id','height','reward','difficulty'] as const)('rejects pinned block %s mismatch',async mutant=>expect((await verifyResearchPrimary(belowTip,singleSats,{f:single(mutant),now})).ok).toBe(false));
 it('rejects a single-block value beyond the disclosed 2dp rounding',async()=>expect((await verifyResearchPrimary(belowTip,'1',{f:single(),now})).ok).toBe(false));
 it('source replay re-runs the same read sequence from stored bytes',async()=>{const {replayPrimaryBytes}=await import('../src/researchPublicReplay.js');const r=await verifyResearchPrimary(hp,'37740',{f:weekly().f,now});expect(await replayPrimaryBytes(hp,{source:r.source,value:'37740',as_of:r.as_of} as any,now().toISOString())).toBe(true);});
 it('single-block replay re-runs the same read sequence from stored bytes',async()=>{const {replayPrimaryBytes}=await import('../src/researchPublicReplay.js');const r=await verifyResearchPrimary(belowTip,singleSats,{f:single(),now});expect(await replayPrimaryBytes(belowTip,{source:r.source,value:singleSats,as_of:r.as_of} as any,now().toISOString())).toBe(true);});
 // One-unit reward/difficulty mutants in the stored bytes: the value shift
 // is below the 2dp rounding, so the byte digest binding is what kills them.
 it.each([['\\"reward\\":312500000','\\"reward\\":312500001'],['\\"difficulty\\":109000000000000','\\"difficulty\\":109000000000001']])('one-unit byte mutant %s invalidates single-block replay',async(orig,mutated)=>{const {replayPrimaryBytes}=await import('../src/researchPublicReplay.js');const r=await verifyResearchPrimary(belowTip,singleSats,{f:single(),now});const source=structuredClone(r.source)!;expect(source.raw_text).toContain(orig);source.raw_text=source.raw_text.replace(orig,mutated);expect(await replayPrimaryBytes(belowTip,{source,value:singleSats,as_of:r.as_of} as any,now().toISOString())).toBe(false);});
});

it('replay binds derived timestamp, source URL, parser, scope and observation metadata',async()=>{
 const {replayPrimaryBytes}=await import('../src/researchPublicReplay.js');const r=await verifyResearchPrimary(macro,'4.123457',{f:transport([{},[macroRow]]),now});
 for(const change of ['as_of','url','parser','scope_hash','observed_at'] as const){const o={source:structuredClone(r.source),value:'4.123457',as_of:r.as_of} as any;if(change==='as_of')o.as_of='2026-11-23T00:00:00Z';else o.source[change]=change==='observed_at'?'2020-01-01T00:00:00Z':'changed';expect(await replayPrimaryBytes(macro,o,now().toISOString())).toBe(false);}
 expect(await replayPrimaryBytes(macro,{source:r.source,value:'4.123457',as_of:r.as_of} as any,'2026-11-23T02:00:00Z')).toBe(false);
});
