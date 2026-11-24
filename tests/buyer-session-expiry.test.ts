import {createHash} from 'node:crypto';import Fastify from 'fastify';import {test,expect,vi} from 'vitest';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {registerBuyer} from '../src/buyer/routes';import {BuyerStore} from '../src/buyer/store';import {makeBuyerPlan} from '../desk/src/buyerPolicy';
test('a late-session buy must retain its owner cookie for the full reserved-payload access window',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-22T00:00:00Z'));
 const dir=mkdtempSync(join(tmpdir(),'owner-expiry-')),payer='0x'+'22'.repeat(20),app=Fastify(),store=new BuyerStore(join(dir,'store.sqlite'),payer);
 const runtime:any={assertConfiguration:()=>({payer,scratchRoot:dir}),cleanup:()=>{},makePlan:makeBuyerPlan,execute:async(p:any)=>({version:'hosted-ranked-filing-result-v1',plan_id:p.id,plan_hash:p.plan_hash,policy_hash:p.policy_hash,task_hash:p.task_hash,payer,charge:{status:'not_signed',amount_uusdc:null,maximum_uusdc:'10000'},receipt:null,limits:[],record:{gate_id:'hosted-exact-10q-minimum-three',intent:'REGULATORY_FILING_MONITOR_GENERAL',outcome:'HOLD',policy_hash:p.policy_hash,task_hash:p.task_hash,payer,params:p.params,rule:p.rule,purchase:{paid_uusdc:null}}}),followup:async()=>({})};registerBuyer(app,{enabled:true,runtime,store,operatorAccess:{hash:createHash('sha256').update('d'.repeat(64)).digest('hex'),expiresAt:Date.now()+3600000}});
 try{
 const bootstrap=await app.inject({method:'POST',url:'/v1/buyer/session',headers:{origin:'https://verireceipt.vercel.app'},payload:{access:'d'.repeat(64)}}),set=String(bootstrap.headers['set-cookie']),cookie=set.split(';')[0];expect(set).toContain('Max-Age=86400');
 vi.setSystemTime(new Date('2026-11-22T00:50:00Z'));const headers={cookie,origin:'https://verireceipt.vercel.app'};const preview=await app.inject({method:'POST',url:'/v1/buyer/plans',headers,payload:{cik:'320193',year:2025}}),p=preview.json().plan;
 store.armOneShot(p.id,p.plan_hash,Date.parse(p.expires_at),'10000');
 const buy=await app.inject({method:'POST',url:`/v1/buyer/plans/${p.id}/buy`,headers,payload:{plan_hash:p.plan_hash}});expect(buy.statusCode).toBe(202);
 await vi.waitFor(async()=>expect((await app.inject({url:`/v1/buyer/jobs/${p.id}`,headers:{cookie}})).json().state).toBe('complete'));
 // The cookie and server-side operator session must both cover this later reservation.
 vi.setSystemTime(new Date('2026-11-23T00:49:00Z'));expect((await app.inject({url:`/v1/buyer/jobs/${p.id}`,headers:{cookie}})).statusCode).toBe(200);
 expect(String(buy.headers['set-cookie'])).toContain(cookie);expect(String(buy.headers['set-cookie'])).toContain('Max-Age=86400');
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});vi.useRealTimers();}
});
