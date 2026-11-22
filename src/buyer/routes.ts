// Additive API, inert unless BUYER_ENABLED=1. No paid work on startup/recovery/GET.
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {randomBytes} from 'node:crypto';
import {dirname,isAbsolute,join} from 'node:path';
import {existsSync,lstatSync,mkdirSync,realpathSync} from 'node:fs';
import {BUYER,buyerInput,digest} from './contracts';
import {BuyerStore,BuyerStoreError} from './store';
import type {BuyerRuntime,BuyerExecutionResult} from './runtimeTypes';
import {buyerResultSummary,validateBuyerResult} from './result';
const ORIGIN='https://verireceipt.vercel.app';
const token=(r:FastifyRequest)=>/(?:^|;\s*)__Host-vr_buyer=([a-f0-9]{64})(?:;|$)/.exec(r.headers.cookie??'')?.[1]??null;
function loadRuntime():BuyerRuntime{return (require(join(__dirname,'..','buyer-runtime.cjs')) as {runtime:BuyerRuntime}).runtime;}
function databasePath():string {
 const file=process.env.BUYER_DATABASE_PATH;
 if(!file||!isAbsolute(file)||file.startsWith('/tmp/')||file===':memory:')throw new Error('Explicit persistent absolute buyer database path required');
 const parent=dirname(file);mkdirSync(parent,{recursive:true,mode:0o700});const stat=lstatSync(parent);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||realpathSync(parent)!==parent||(existsSync(file)&&(!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink())))throw new Error('Buyer database path must be canonical and private');
 return file;
}
function fail(reply:FastifyReply,error:unknown){
 const code=error instanceof BuyerStoreError?error.code:'BUYER_UNAVAILABLE',status=code==='NOT_FOUND'?404:code==='EXPIRED'?410:code==='TERMS_MISMATCH'||code==='STATE_CHANGED'?409:code==='BUYER_UNAVAILABLE'?503:429;
 return reply.status(status).send({status:'HOLD',code,paid_retry:false});
}
export function registerBuyer(app:FastifyInstance,options:{enabled?:boolean;runtime?:BuyerRuntime;store?:BuyerStore}={}):void {
 if(!(options.enabled??process.env.BUYER_ENABLED==='1'))return;
 const runtime=options.runtime??loadRuntime(),config=runtime.assertConfiguration(),store=options.store??new BuyerStore(databasePath(),config.payer);
 if(store.payer!==config.payer)throw new Error('Runtime and durable payer mismatch');
 store.purge();runtime.cleanup(config.scratchRoot);
 const active=new Set<Promise<void>>(),controllers=new Set<AbortController>();let stopping=false;
 const cleanup=setInterval(()=>{try{store.purge();runtime.cleanup(config.scratchRoot);}catch{app.log.error('Buyer cleanup failed; operator review required');}},3600000);cleanup.unref();
 app.addHook('onClose',async()=>{stopping=true;clearInterval(cleanup);for(const c of controllers)c.abort();await Promise.allSettled([...active]);store.close();});
 const session=(r:FastifyRequest,reply:FastifyReply,mutation=false):string|null=>{
  reply.header('Cache-Control','no-store');
  if(mutation&&(r.headers.origin!==ORIGIN||(r.headers['sec-fetch-site']&&r.headers['sec-fetch-site']!=='same-origin'))){reply.status(403).send({status:'HOLD',code:'ORIGIN_REQUIRED'});return null;}
  const value=token(r);if(!value){reply.status(428).send({status:'HOLD',code:'SESSION_REQUIRED'});return null;}return digest(value);
 };
 app.get('/v1/buyer/session',async(request,reply)=>{
  reply.header('Cache-Control','no-store');if(!token(request))reply.header('Set-Cookie',`__Host-vr_buyer=${randomBytes(32).toString('hex')}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`);
  return {enabled:true,network:BUYER.network,call_uusdc:BUYER.callUusdc,daily_cap_uusdc:BUYER.dailyUusdc,sponsored:true,retention_hours:24,routing:'ranked-auto'};
 });
 app.post('/v1/buyer/plans',{bodyLimit:2048},async(request,reply)=>{
  const owner=session(request,reply,true);if(!owner)return;if(stopping)return fail(reply,new Error());
  let input;try{input=buyerInput(request.body);}catch{return reply.status(400).send({status:'HOLD',code:'UNSUPPORTED_QUESTION',paid_retry:false});}
  try{return {plan:store.create(runtime.makePlan(input),owner,digest(request.ip)),purchased:false};}catch(error){return fail(reply,error);}
 });
 app.post<{Params:{id:string}}>('/v1/buyer/plans/:id/buy',{bodyLimit:2048},async(request,reply)=>{
  const owner=session(request,reply,true);if(!owner)return;if(stopping)return fail(reply,new Error());
  const body=request.body as {plan_hash?:unknown};if(!body||Object.keys(body).join(',')!=='plan_hash'||typeof body.plan_hash!=='string'||! /^[a-f0-9]{64}$/.test(body.plan_hash))return reply.status(400).send({status:'HOLD',code:'INVALID_PREVIEW',paid_retry:false});
  try{
   const job=store.start(request.params.id,owner,body.plan_hash);
   if(!job.reused){
    const controller=new AbortController();controllers.add(controller);
    const work=(async()=>{try{
     const result=await runtime.execute(job.plan,{scratchRoot:config.scratchRoot,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(BUYER.executionMs)]),beforeSign:async checkpoint=>{store.beforeSign(job.id,checkpoint);},recordHeaders:async r=>{store.recordHeaders(job.id,r);},recordBody:async r=>{store.recordPaidBody(job.id,r);}});
     validateBuyerResult(job.plan,result,config.payer);
     if(result.charge.status==='uncertain')store.uncertain(job.id,result as unknown as {plan_hash:string;[key:string]:unknown});else store.complete(job.id,result as unknown as {plan_hash:string;[key:string]:unknown});
    }catch{try{store.uncertain(job.id);}catch{/* Existing durable reservation is never released here. */}}finally{controllers.delete(controller);}})();
    active.add(work);void work.finally(()=>active.delete(work));
   }
   return reply.status(202).send({job_id:job.id,reused:job.reused,paid_retry:false});
  }catch(error){return fail(reply,error);}
 });
 app.get<{Params:{id:string}}>('/v1/buyer/jobs/:id',async(request,reply)=>{
  const owner=session(request,reply);if(!owner)return;try{const job=store.read(request.params.id,owner);if(!job)return fail(reply,new BuyerStoreError('NOT_FOUND'));return {...job,result:buyerResultSummary(job.result),paid_retry:false,retention_hours:24};}catch(error){return fail(reply,error);}
 });
 app.get<{Params:{id:string}}>('/v1/buyer/jobs/:id/evidence',async(request,reply)=>{
  const owner=session(request,reply);if(!owner)return;try{const evidence=store.evidence(request.params.id,owner);if(!evidence)return fail(reply,new BuyerStoreError('NOT_FOUND'));return reply.header('Content-Type','application/json').header('Content-Disposition',`attachment; filename="buyer-${request.params.id}.json"`).send(evidence);}catch(error){return fail(reply,error);}
 });
 app.post<{Params:{id:string}}>('/v1/buyer/jobs/:id/delivery',{bodyLimit:64},async(request,reply)=>{
  const owner=session(request,reply,true);if(!owner)return;if(stopping)return fail(reply,new Error());if(request.body&&Object.keys(request.body).length)return reply.status(400).send({status:'HOLD',code:'NO_DELIVERY_PARAMETERS'});
  let claim:number;try{
   const job=store.read(request.params.id,owner);if(!job||job.state!=='complete'||!job.result||(job.result as BuyerExecutionResult).charge.status!=='receipt')return fail(reply,new BuyerStoreError('NOT_FOUND'));
   claim=store.addFollowup(job.id,owner,{status:'checking',paid_retry:false});
   const controller=new AbortController();controllers.add(controller);
   try{const data=await runtime.followup(job.plan,job.result as BuyerExecutionResult,AbortSignal.any([controller.signal,AbortSignal.timeout(20000)]));store.finishFollowup(job.id,owner,claim,data);return {followup:data,paid_retry:false};}
   catch{store.finishFollowup(job.id,owner,claim,{status:'error',paid_retry:false,settlement_finality:false});return fail(reply,new Error());}
   finally{controllers.delete(controller);}
  }catch(error){return fail(reply,error);}
 });
}
