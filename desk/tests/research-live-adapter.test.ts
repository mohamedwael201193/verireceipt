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
function setup(options:{primaryPrice?:string;paidRejects?:boolean;inactive?:boolean;payloadValue?:number|string;io?:SyncIO}={}){
 const dir=mkdtempSync(join(tmpdir(),'research-adapter-unit-'));dirs.push(dir);const run_ledger=join(dir,'runs.jsonl');
 const spend=spendLedgerFromFiles({reservationsFile:join(dir,'reservations.jsonl'),lockFile:join(dir,'spend.lock'),runLedgerFiles:[run_ledger]});
 const network=node({intent:fact.intent,requestParams:fact.params,valueField:fact.field,value:12,payloadValue:options.payloadValue,miner:'9999',minerSlug:'unit-external-provider',paidRejects:options.paidRejects}).f;
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

it('all committed templates validate before any live purchase',async()=>{const {researchTemplate}=await import('../src/researchTemplates.js');const {validateSpec,buildPacket}=await import('../src/researchDesk.js');for(const id of ['A','B','C','D','E','F','G'] as const){const {spec,claims}=researchTemplate(id,new Date().toISOString(),id==='G'?'26489252':undefined);expect(()=>validateSpec(spec)).not.toThrow();expect(buildPacket(spec,[],[],claims,spec.frozen_at).outcome).toBe('HOLD');}});
it('template G refuses to build without an explicit pinned block',async()=>{const {researchTemplate}=await import('../src/researchTemplates.js');expect(()=>researchTemplate('G',new Date().toISOString())).toThrow('pinned finalized block');expect(()=>researchTemplate('G',new Date().toISOString(),'0')).toThrow('pinned finalized block');});


describe('crash-durable spend ordering',()=>{
 it('shared reservation fsync failure refuses signature',async()=>{let fail=false;const io:SyncIO={sync:fd=>{if(fail)throw new Error('UNIT fsync fault');fsyncSync(fd);},write:(fd,data)=>{writeSync(fd,data);fail=true;}};const {adapter,payer,dir}=setup({io});await expect(adapter.buy(fact,{spec_hash:'a'.repeat(64),remaining_uusdc:'20000',escalation:false})).rejects.toThrow();expect(payer.signMessage).not.toHaveBeenCalled();expect(readFileSync(join(dir,'reservations.jsonl'),'utf8')).toContain('10000');});
 it('per-note reservation fsync failure refuses signature',async()=>{let writes=0,fail=false;const io:SyncIO={sync:fd=>{if(fail)throw new Error('UNIT note fsync fault');fsyncSync(fd);},write:(fd,data)=>{writes++;writeSync(fd,data);if(writes===2)fail=true;}};const {adapter,payer,dir}=setup({io});await expect(adapter.buy(fact,{spec_hash:'a'.repeat(64),remaining_uusdc:'20000',escalation:false})).rejects.toThrow();expect(payer.signMessage).not.toHaveBeenCalled();expect(readFileSync(join(dir,'reservations.jsonl'),'utf8')).toContain('10000');});
 it('post-signing raw sync failure preserves reservation and does not retry',async()=>{let writes=0,fail=false;const io:SyncIO={sync:fd=>{if(fail)throw new Error('UNIT raw fsync fault');fsyncSync(fd);},write:(fd,data)=>{writes++;writeSync(fd,data);if(writes===3)fail=true;}};const {adapter,payer,dir}=setup({io});await expect(adapter.buy(fact,{spec_hash:'a'.repeat(64),remaining_uusdc:'20000',escalation:false})).rejects.toThrow();expect(payer.signMessage).toHaveBeenCalledTimes(1);expect(readFileSync(join(dir,'reservations.jsonl'),'utf8')).toContain('10000');expect(readFileSync(join(dir,'price-reservation.json'),'utf8')).toContain('10000');});
});

it('the normalization policy still rejects the real TVL rounding mismatch',async()=>{const {exactNumericEqual}=await import('../src/exactNumeric.js');expect(exactNumericEqual(3110285426.77,3110285426.7703633)).toBe(false);expect(exactNumericEqual(1000000000,'1000000000')).toBe(true);});


it('credits exact numeric transport strings through the real adapter seam, not raw fallback',async()=>{const {adapter}=setup({payloadValue:'12.000'});const a=await adapter.buy(fact,{spec_hash:'a'.repeat(64),remaining_uusdc:'20000',escalation:false});expect(a.failure).toBeNull();expect(a.observation?.value).toBe('12');});
it('still refuses mismatching numeric transport values through adapter seam',async()=>{const {adapter}=setup({payloadValue:'12.001'});const a=await adapter.buy(fact,{spec_hash:'a'.repeat(64),remaining_uusdc:'20000',escalation:false});expect(a.observation).toBeNull();expect(a.expense.useful).toBe(false);});


it('keeps a source-matched raw mismatch diagnostic separate from usable facts',async()=>{const {adapter}=setup({payloadValue:'12.001'});const a=await adapter.buy(fact,{spec_hash:'a'.repeat(64),remaining_uusdc:'20000',escalation:false});expect(a.observation).toBeNull();expect(a.expense.useful).toBe(false);expect(a.raw_diagnostic?.label).toBe('raw-value observation');expect(a.raw_diagnostic?.failed_check.ok).toBe(false);expect(a.raw_diagnostic?.provider_value).toBe('12.001');expect(a.raw_diagnostic?.shaped_value).toBe('12');expect(a.raw_diagnostic?.usable_for_calculations).toBe(false);});
it('does not preserve an independently wrong raw candidate',async()=>{const {adapter}=setup({payloadValue:'20'});const a=await adapter.buy(fact,{spec_hash:'a'.repeat(64),remaining_uusdc:'20000',escalation:false});expect(a.raw_diagnostic).toBeUndefined();expect(a.observation).toBeNull();});
