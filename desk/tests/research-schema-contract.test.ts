import {expect,it} from 'vitest';
import {validateLiveFact} from '../src/researchLiveAdapter.js';
import snapshot from '../policy/m13-intents.snapshot.json';
const fact={id:'sanctions',intent:'SANCTIONS_SCREENING_MATCH_GENERAL',params:{name:'Ares Capital Corporation'},field:'match_score',unit:'score',max_age_seconds:86400};
const frozen=snapshot.schemas.find(s=>s.intent_name===fact.intent)!;
const contract=()=>({intent_name:fact.intent,lifecycle:{state:'active'},request:structuredClone(frozen.request),response:structuredClone(frozen.response)});
it('accepts the declared numeric off-chain score while preserving the actual scored boolean contract',async()=>{
 const c=contract();expect(c.response.fields.find(f=>f.name==='matched')).toMatchObject({type:'bool',scored:true});expect(c.response.fields.find(f=>f.name==='match_score')).toMatchObject({type:'number',off_chain:true});
 const r=await validateLiveFact(fact,async()=>Response.json(c));expect(r.ok).toBe(true);
});
it.each(['type','scored','missing','range','off_chain'])('refuses changed sanctions contract %s before purchase',async change=>{
 const c:any=contract();const score=c.response.fields.find((f:any)=>f.name==='match_score');const scored=c.response.fields.find((f:any)=>f.name==='matched');
 if(change==='type')score.type='string';if(change==='scored')scored.scored=false;if(change==='missing')c.response.fields=c.response.fields.filter((f:any)=>f.name!=='matched');if(change==='range')score.range=[0,100];if(change==='off_chain')delete score.off_chain;
 expect((await validateLiveFact(fact,async()=>Response.json(c))).ok).toBe(false);
});
it('does not allow an ordinary scored numeric to silently become off-chain only',async()=>{
 const f={...fact,intent:'CRYPTO_PRICE_USD',params:{symbol:'UNI'},field:'price_usd'};
 const c:any=structuredClone(snapshot.schemas.find(s=>s.intent_name===f.intent)!);c.lifecycle={state:'active'};const field=c.response.fields.find((x:any)=>x.name===f.field);delete field.scored;field.off_chain=true;
 expect((await validateLiveFact(f,async()=>Response.json(c))).ok).toBe(false);
});
