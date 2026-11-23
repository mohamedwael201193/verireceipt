// Explicit synthetic transports, no live requests or persistent keys.
import {describe,it,expect,afterEach} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,fsyncSync,writeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {liveResearchAdapter} from '../src/researchLiveAdapter.js';
import {spendLedgerFromFiles} from '../src/gate.js';
import {node,makePayer} from './gateNodeFixture.js';
import snapshot from '../policy/m13-intents.snapshot.json';
import type {SyncIO} from '../src/privateEvidence.js';
import type {FactSpec} from '../src/researchDesk.js';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const fact:FactSpec={id:'price',intent:'CRYPTO_PRICE_USD',params:{symbol:'UNI'},field:'price_usd',unit:'USD/token',max_age_seconds:300};
function setup(options:{primaryPrice?:string;paidRejects?:boolean;inactive?:boolean;io?:SyncIO}={}){
 const dir=mkdtempSync(join(tmpdir(),'research-adapter-unit-'));dirs.push(dir);const run_ledger=join(dir,'runs.jsonl');
 const spend=spendLedgerFromFiles({reservationsFile:join(dir,'reservations.jsonl'),lockFile:join(dir,'spend.lock'),runLedgerFiles:[run_ledger]});
 const network=node({intent:fact.intent,requestParams:fact.params,valueField:fact.field,value:12,miner:'9999',minerSlug:'unit-external-provider',paidRejects:options.paidRejects}).f;
 const contract=snapshot.schemas.find(s=>s.intent_name===fact.intent)!;
 const f:typeof fetch=async(input,init)=>{const url=String(input);
  if(url.endsWith('/engine/v1/intents/'+fact.intent))return Response.json({intent_name:fact.intent,lifecycle:{state:options.inactive?'paused':'active'},request:contract.request,response:contract.response});
  if(url.startsWith('https://api.kraken.com/'))return Response.json({error:[],result:{UNIUSD:{c:[options.primaryPrice??'12']}}});
  return network(input,init);
 };
 const payer=makePayer();return {adapter:liveResearchAdapter({payer,spend,evidence_dir:dir,run_ledger,f,io:options.io}),payer,dir};
}
describe('live adapter through existing paid gate, injected unit transport only',()=>{
 it('records external supply honestly and leaves settlement unclaimed',async()=>{const {adapter,dir}=setup();const a=await adapter.buy(fact,{spec_hash:'a'.repeat(64),remaining_uusdc:'20000',escalation:false});expect(a.failure).toBeNull();expect(a.observation?.supply).toBe('external');expect(a.observation?.integrity_level).toBe('L1_SIGNAL_ONLY');expect(a.expense.status).toBe('receipted-unsettled');expect(a.expense.settled_uusdc).toBeNull();expect(JSON.parse(readFileSync(join(dir,'price-reservation.json'),'utf8')).amount_uusdc).toBe('10000');});
 it('does not credit wrong but well-receipted price',async()=>{const {adapter}=setup({primaryPrice:'20'});const a=await adapter.buy(fact,{spec_hash:'a'.repeat(64),remaining_uusdc:'20000',escalation:false});expect(a.observation).toBeNull();expect(a.expense.useful).toBe(false);expect(a.expense.reported_charge_uusdc).toBe('10000');});
 it('keeps unknown signature exposure at full reservation',async()=>{const {adapter}=setup({paidRejects:true});const a=await adapter.buy(fact,{spec_hash:'a'.repeat(64),remaining_uusdc:'20000',escalation:false});expect(a.observation).toBeNull();expect(a.expense.status).toBe('reserved-uncertain');expect(a.expense.reserved_uusdc).toBe('10000');expect(a.expense.reported_charge_uusdc).toBeNull();});
 it('rejects inactive schema before sign',async()=>{const {adapter,payer}=setup({inactive:true});await expect(adapter.buy(fact,{spec_hash:'a'.repeat(64),remaining_uusdc:'20000',escalation:false})).rejects.toThrow('schema');expect(payer.signMessage).not.toHaveBeenCalled();});
 it('rejects per-note authority before sign',async()=>{const {adapter,payer}=setup();await expect(adapter.buy(fact,{spec_hash:'a'.repeat(64),remaining_uusdc:'9999',escalation:false})).rejects.toThrow();expect(payer.signMessage).not.toHaveBeenCalled();});
 it('never endorses un-replayed cached checks',async()=>{const {adapter}=setup();expect(await adapter.revalidate({} as any,fact,new Date().toISOString())).toBeNull();});
 it('fails closed before signing an unsupported second-provider retry',async()=>{const {adapter,payer}=setup();await expect(adapter.buy(fact,{spec_hash:'a'.repeat(64),remaining_uusdc:'20000',escalation:true})).rejects.toThrow('escalation');expect(payer.signMessage).not.toHaveBeenCalled();});
});

it('both committed templates validate before any live purchase',async()=>{const {researchTemplate}=await import('../src/researchTemplates.js');const {validateSpec,buildPacket}=await import('../src/researchDesk.js');for(const id of ['A','B'] as const){const {spec,claims}=researchTemplate(id,new Date().toISOString());expect(()=>validateSpec(spec)).not.toThrow();expect(buildPacket(spec,[],[],claims,spec.frozen_at).outcome).toBe('HOLD');}});


describe('crash-durable spend ordering',()=>{
 it('shared reservation fsync failure refuses signature',async()=>{let fail=false;const io:SyncIO={sync:fd=>{if(fail)throw new Error('UNIT fsync fault');fsyncSync(fd);},write:(fd,data)=>{writeSync(fd,data);fail=true;}};const {adapter,payer,dir}=setup({io});await expect(adapter.buy(fact,{spec_hash:'a'.repeat(64),remaining_uusdc:'20000',escalation:false})).rejects.toThrow();expect(payer.signMessage).not.toHaveBeenCalled();expect(readFileSync(join(dir,'reservations.jsonl'),'utf8')).toContain('10000');});
 it('per-note reservation fsync failure refuses signature',async()=>{let writes=0,fail=false;const io:SyncIO={sync:fd=>{if(fail)throw new Error('UNIT note fsync fault');fsyncSync(fd);},write:(fd,data)=>{writes++;writeSync(fd,data);if(writes===2)fail=true;}};const {adapter,payer,dir}=setup({io});await expect(adapter.buy(fact,{spec_hash:'a'.repeat(64),remaining_uusdc:'20000',escalation:false})).rejects.toThrow();expect(payer.signMessage).not.toHaveBeenCalled();expect(readFileSync(join(dir,'reservations.jsonl'),'utf8')).toContain('10000');});
 it('post-signing raw sync failure preserves reservation and does not retry',async()=>{let writes=0,fail=false;const io:SyncIO={sync:fd=>{if(fail)throw new Error('UNIT raw fsync fault');fsyncSync(fd);},write:(fd,data)=>{writes++;writeSync(fd,data);if(writes===3)fail=true;}};const {adapter,payer,dir}=setup({io});await expect(adapter.buy(fact,{spec_hash:'a'.repeat(64),remaining_uusdc:'20000',escalation:false})).rejects.toThrow();expect(payer.signMessage).toHaveBeenCalledTimes(1);expect(readFileSync(join(dir,'reservations.jsonl'),'utf8')).toContain('10000');expect(readFileSync(join(dir,'price-reservation.json'),'utf8')).toContain('10000');});
});
