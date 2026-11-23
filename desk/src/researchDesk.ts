// Research Desk v1: pure, wallet-free policy, arithmetic and packet replay.
// Payment/network adapters are separate. Unknown evidence never becomes a fact.
import { createHash } from 'node:crypto';
import { canonicalPayloadJson } from './verify.js';

export const VERSION = 'research-desk-v1';
export const NETWORK = 'eip155:11155111';
export const hash = (v: unknown): string => createHash('sha256').update(canonicalPayloadJson(v)).digest('hex');
export type Params = Record<string, string>;
export interface FactSpec {
  id: string; intent: string; params: Params; field: string; unit: string;
  max_age_seconds: number;
}
export interface Assumption { id: string; value: string; unit: string; rationale: string }
export interface Calculation { id: string; op: 'multiply' | 'divide' | 'subtract'; left: string; right: string; unit: string }
export interface ThesisSpec {
  version: typeof VERSION; network: typeof NETWORK; template: 'onchain-valuation' | 'issuer-macro';
  question: string; frozen_at: string; facts: FactSpec[]; assumptions: Assumption[]; calculations: Calculation[];
  budget_uusdc: string; max_call_uusdc: '10000'; max_escalations: 1;
}
const CONTRACTS: Record<string, { field: string; unit: string; required: string[]; optional?: string[] }> = {
  CRYPTO_PRICE_USD: {field:'price_usd',unit:'USD/token',required:['symbol']},
  TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL: {field:'total_supply',unit:'token',required:['token']},
  TVL_LOOKUP_GENERAL: {field:'tvl_usd',unit:'USD',required:['protocol']},
  LIQUIDITY_DEPTH_VERIFY_GENERAL: {field:'liquidity_usd',unit:'USD',required:['pool','chain']},
  CRYPTO_YIELD_RATE_GENERAL: {field:'supply_apy',unit:'bps',required:['project','symbol','chain']},
  STOCK_PRICE_US_EQUITY: {field:'price_usd',unit:'USD/share',required:['ticker']},
  REGULATORY_FILING_MONITOR_GENERAL: {field:'filing_count',unit:'filings',required:['entity','period']},
  MACRO_ECONOMIC_INDICATOR_GENERAL: {field:'rate_pct',unit:'percent',required:['indicator','country'],optional:['year']},
};
function invariant(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const uint = (s: unknown): s is string => typeof s === 'string' && /^(0|[1-9]\d*)$/.test(s);
const timestamp = (s: string) => typeof s === 'string' && /^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(Date.parse(s));
const idOk = (s: string) => typeof s === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(s);

// Exact rational arithmetic: no IEEE-754 math, implicit rounding, or unit conversion.
export interface Rational { n: bigint; d: bigint }
function gcd(a: bigint,b: bigint): bigint { a=a<0n?-a:a; while(b){const t=b;b=a%b;a=t;}return a; }
function rat(n: bigint,d: bigint): Rational { invariant(d!==0n,'division by zero');if(d<0n){n=-n;d=-d;}const g=gcd(n,d);return {n:n/g,d:d/g}; }
export function decimal(s: string): Rational {
  invariant(typeof s==='string' && s.length<=120 && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(s),'invalid exact decimal');
  const [whole,frac='']=s.split('.');return rat(BigInt(whole+frac),10n**BigInt(frac.length));
}
const encoded = (r: Rational) => ({ numerator:r.n.toString(), denominator:r.d.toString() });
export function validateSpec(spec: ThesisSpec): void {
  invariant(spec.version===VERSION && spec.network===NETWORK,'version/network mismatch: testnet only');
  invariant(['onchain-valuation','issuer-macro'].includes(spec.template),'unknown template');
  invariant(typeof spec.question==='string' && spec.question.trim() && timestamp(spec.frozen_at),'missing question/frozen timestamp');
  invariant(uint(spec.budget_uusdc) && BigInt(spec.budget_uusdc)>0n,'invalid budget');
  invariant(spec.max_call_uusdc==='10000' && spec.max_escalations===1,'fixed call/escalation policy');
  invariant(Array.isArray(spec.facts) && spec.facts.length>0 && spec.facts.length<=16,'invalid fact count');
  invariant(Array.isArray(spec.assumptions) && Array.isArray(spec.calculations),'missing calculation inputs');
  const units=new Map<string,string>();
  const add=(id:string,unit:string)=>{invariant(idOk(id)&&!units.has(id),'duplicate/invalid input id');units.set(id,unit);};
  for(const f of spec.facts){
    const c=CONTRACTS[f.intent];invariant(c && c.field===f.field && c.unit===f.unit,'unsupported intent/field/unit');
    invariant(f.params && Object.values(f.params).every(v=>typeof v==='string' && v.trim()),'invalid exact params');
    invariant(c.required.every(k=>Object.hasOwn(f.params,k)) && Object.keys(f.params).every(k=>[...c.required,...(c.optional??[])].includes(k)),'required/unknown params');
    invariant(Number.isSafeInteger(f.max_age_seconds)&&f.max_age_seconds>0&&f.max_age_seconds<=366*86400,'invalid freshness');
    if(f.intent==='MACRO_ECONOMIC_INDICATOR_GENERAL'){
      invariant(f.params.indicator==='unemployment rate','macro is unemployment only');
      invariant(f.params.year===undefined || /^(19[6-9]\d|20\d\d|2100)$/.test(f.params.year),'invalid macro year');
    }
    if(f.intent==='TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL') invariant(/(?:ethereum|polygon|arbitrum|base|optimism|chain[:=])/i.test(f.params.token),'total supply needs explicit chain');
    add(f.id,f.unit);
  }
  const intents=spec.facts.map(f=>f.intent);
  const required=spec.template==='onchain-valuation'?['CRYPTO_PRICE_USD','TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL']:['STOCK_PRICE_US_EQUITY','REGULATORY_FILING_MONITOR_GENERAL','MACRO_ECONOMIC_INDICATOR_GENERAL'];
  invariant(required.every(i=>intents.includes(i)),'template missing required observations');
  for(const a of spec.assumptions){decimal(a.value);invariant(typeof a.rationale==='string'&&a.rationale.trim(),'assumption rationale required');add(a.id,a.unit);}
  for(const c of spec.calculations){
    const l=units.get(c.left),r=units.get(c.right);invariant(l&&r,'calculation references missing/forward input');
    let unit: string|undefined;
    if(c.op==='multiply' && ((l==='USD/token'&&r==='token')||(r==='USD/token'&&l==='token'))) {
      invariant(c.id==='implied_fdv','price times total supply must be named implied_fdv');unit='USD';
    } else if(c.op==='divide'&&l==='USD'&&r==='USD') unit='ratio';
    else if(c.op==='subtract'&&l===r && l!=='percent' && l!=='bps') unit=l;
    invariant(unit && unit===c.unit,'unsupported or dimensionally unsafe calculation');add(c.id,c.unit);
  }
}
export interface Layer { status:'passed'|'failed'|'unavailable'; checks: {name:string;ok:boolean;detail:string}[] }
export interface SourceEvidence {
  url: string; content_sha256: string; raw_text: string; observed_at: string; scope_hash: string; value: string;
  // Parser identity is bound to the independently verified source record.
  parser: string;
}
export interface Observation {
  fact_id: string; request_hash: string; value: string|null; unit: string; as_of: string;
  acquired_at: string; receipt_hash: string; signal_hash: string;
  serving_registration: string; supply:'own'|'external';
  acquisition_cost_uusdc: string;
  integrity_level:'L1_SIGNAL_ONLY'|'L2_RAW_BYTES';
  reuse: 'fresh-purchase'|'fresh-receipt-reuse';
  layers: {schema:Layer;receipt:Layer;semantics:Layer;primary:Layer};
  source: SourceEvidence|null;
}
export interface Expense {
  fact_id: string; attempt:0|1; nonce: string;
  reserved_uusdc: string; reported_charge_uusdc: string|null; settled_uusdc: string|null;
  status:'reserved-uncertain'|'receipted-unsettled'|'settled'; receipt_hash:string|null;
  useful: boolean;
}
export interface Claim { id:string; fact_refs:string[]; assumption_refs:string[]; calculation_ref?:string; predicate?:{left:string;op:'<'|'<='|'>'|'>='|'==';right:string} }
export interface RawValueDiagnostic {
  fact_id:string; label:'raw-value observation'; status:'REJECTED_SHAPED_MISMATCH';
  request_hash:string; provider_value:string; shaped_value:string; unit:string;
  signal_hash:string; receipt_hash:string; source:SourceEvidence;
  failed_check:{name:'engine value equals provider answer';ok:false;detail:string};
  usable_for_calculations:false;
}
export interface ResearchPacket {
  version: typeof VERSION; spec:ThesisSpec; spec_hash:string; completed_at:string;
  observations:Observation[]; expenses:Expense[]; claims:Claim[];
  rejected_raw_observations?:RawValueDiagnostic[];
  calculations:Record<string,{numerator:string;denominator:string;unit:string}>;
  claim_results:Record<string,'SUPPORTED'|'NOT_SUPPORTED'|'UNKNOWN'>;
  outcome:'READY'|'HOLD'; reasons:string[];
  accounting:ReturnType<typeof expenseSummary>;
  metrics:{completed_reproducible_notes:0|1;cost_per_useful_note_uusdc:string|null;per_fact_worst_case_uusdc:Record<string,string>;reused_acquisition_cost_uusdc:string};
  packet_hash:string;
}
export const factHash=(f:FactSpec)=>hash({intent:f.intent,params:f.params,field:f.field,unit:f.unit});
const digest = (s: string) => typeof s==='string'&&/^(?:0x)?[a-f0-9]{64}$/.test(s);
export function observationFailures(f:FactSpec,o:Observation,at:string):string[]{
  const failures:string[]=[];const check=(ok:unknown,msg:string)=>{if(!ok)failures.push(msg);};
  check(o.fact_id===f.id&&o.request_hash===factHash(f),'request binding');
  check(o.unit===f.unit,'units');check(digest(o.receipt_hash)&&digest(o.signal_hash),'receipt/signal hash');
  check(typeof o.serving_registration==='string'&&o.serving_registration.length>0,'serving registration');
  check(o.supply==='own'||o.supply==='external','supply label');
  check(uint(o.acquisition_cost_uusdc),'original acquisition cost');
  check(['L1_SIGNAL_ONLY','L2_RAW_BYTES'].includes(o.integrity_level),'integrity label');
  check(['fresh-purchase','fresh-receipt-reuse'].includes(o.reuse),'reuse label');
  for(const name of ['schema','receipt','semantics','primary'] as const){const l=o.layers?.[name];check(l?.status==='passed'&&l.checks.length>0&&l.checks.every(c=>c.ok),`${name} layer`);}
  check(timestamp(o.as_of)&&timestamp(o.acquired_at)&&Date.parse(o.as_of)<=Date.parse(o.acquired_at)&&Date.parse(o.acquired_at)<=Date.parse(at)&&Date.parse(at)-Date.parse(o.as_of)<=f.max_age_seconds*1000,'freshness');
  try { invariant(o.value!==null,'missing value');decimal(o.value); } catch { failures.push('numeric observation unavailable'); }
  const s=o.source;
  check(s&&/^https:\/\//.test(s.url)&&digest(s.content_sha256)&&typeof s.raw_text==='string'&&createHash('sha256').update(s.raw_text).digest('hex')===s.content_sha256&&s.scope_hash===factHash(f)&&s.value===o.value&&!!s.parser&&timestamp(s.observed_at)&&Date.parse(s.observed_at)<=Date.parse(at),'primary evidence binding');
  return failures;
}
export function expenseSummary(expenses:Expense[]){
  let reserved=0n,reported=0n,settled=0n,exposure=0n,wasted=0n,uncertain=0n;
  const nonces=new Set<string>();
  for(const e of expenses){
    invariant(typeof e.useful==='boolean'&&typeof e.fact_id==='string'&&idOk(e.fact_id),'invalid expense shape');
    invariant(typeof e.nonce==='string'&&e.nonce.length>0&&!nonces.has(e.nonce),'duplicate/empty expense nonce');nonces.add(e.nonce);
    invariant(uint(e.reserved_uusdc)&&BigInt(e.reserved_uusdc)>0n&&BigInt(e.reserved_uusdc)<=10000n,'invalid reservation');
    const r=BigInt(e.reserved_uusdc);reserved+=r;
    for(const x of [e.reported_charge_uusdc,e.settled_uusdc])invariant(x===null||(uint(x)&&BigInt(x)<=r),'invalid charge/settlement');
    invariant(e.attempt===0||e.attempt===1,'invalid escalation');
    if(e.status==='settled')invariant(e.settled_uusdc!==null,'settled row needs amount');
    else invariant(e.settled_uusdc===null,'unsettled row carries settlement');
    if(e.status==='reserved-uncertain')invariant(e.reported_charge_uusdc===null&&e.receipt_hash===null,'uncertain row claims receipt');
    else invariant(e.reported_charge_uusdc!==null&&digest(e.receipt_hash??''),'receipted row needs charge/hash');
    invariant(['reserved-uncertain','receipted-unsettled','settled'].includes(e.status),'invalid expense status');
    reported+=BigInt(e.reported_charge_uusdc??'0');settled+=BigInt(e.settled_uusdc??'0');
    const cost=e.settled_uusdc===null?r:BigInt(e.settled_uusdc);exposure+=cost;
    if(!e.useful)wasted+=cost;if(e.status==='reserved-uncertain')uncertain+=r;
  }
  return {reserved_uusdc:reserved.toString(),reported_charge_uusdc:reported.toString(),settled_uusdc:settled.toString(),worst_case_uusdc:exposure.toString(),wasted_uusdc:wasted.toString(),uncertain_uusdc:uncertain.toString(),useful_outcome_cost_uusdc:exposure.toString()};
}
export function buildPacket(spec:ThesisSpec,observations:Observation[],expenses:Expense[],claims:Claim[],completed_at:string,rejected_raw_observations:RawValueDiagnostic[]=[]):ResearchPacket {
  validateSpec(spec);invariant(timestamp(completed_at)&&Date.parse(completed_at)>=Date.parse(spec.frozen_at),'invalid completion time');
  const reasons:string[]=[];const values=new Map<string,Rational>();
  const ids=new Set(spec.facts.map(f=>f.id));
  invariant(observations.every(o=>ids.has(o.fact_id)),'unknown observation');
  for(const f of spec.facts){const found=observations.filter(o=>o.fact_id===f.id);if(found.length!==1){reasons.push(`${f.id}: exactly one final observation required`);continue;}const failures=observationFailures(f,found[0],completed_at);reasons.push(...failures.map(s=>`${f.id}: ${s}`));if(!failures.length)values.set(f.id,decimal(found[0].value!));}
  for(const a of spec.assumptions)values.set(a.id,decimal(a.value));
  const calculations:ResearchPacket['calculations']={};
  for(const c of spec.calculations){const l=values.get(c.left),r=values.get(c.right);if(!l||!r){reasons.push(`${c.id}: input unavailable`);continue;}try{const v=c.op==='multiply'?rat(l.n*r.n,l.d*r.d):c.op==='divide'?rat(l.n*r.d,l.d*r.n):rat(l.n*r.d-r.n*l.d,l.d*r.d);values.set(c.id,v);calculations[c.id]={...encoded(v),unit:c.unit};}catch{reasons.push(`${c.id}: undefined calculation`);}}
  const claimIds=new Set<string>();
  for(const c of claims){invariant(idOk(c.id)&&!claimIds.has(c.id),'invalid/duplicate claim');claimIds.add(c.id);invariant(c.fact_refs.length>0,'claim without numeric evidence');invariant(c.fact_refs.every(id=>ids.has(id)),'invented fact reference');invariant(c.assumption_refs.every(id=>spec.assumptions.some(a=>a.id===id)),'invented assumption');if(c.calculation_ref){const calc=spec.calculations.find(x=>x.id===c.calculation_ref);invariant(calc,'invented calculation');const dependencies=new Set<string>();const walk=(id:string)=>{const nested=spec.calculations.find(x=>x.id===id);if(nested){walk(nested.left);walk(nested.right);}else dependencies.add(id);};walk(calc.id);invariant([...dependencies].every(id=>ids.has(id)?c.fact_refs.includes(id):c.assumption_refs.includes(id)),'claim omits calculation dependencies');}}
  invariant(claims.length>0,'no supported claims');
  const accounting=expenseSummary(expenses);
  invariant(expenses.every(e=>ids.has(e.fact_id)),'expense for unknown fact');
  invariant(expenses.filter(e=>e.attempt===1).length<=1,'at most one escalation per note');
  for(const f of spec.facts){const paid=expenses.filter(e=>e.fact_id===f.id);invariant(paid.length<=2,'too many purchase attempts');invariant(paid.filter(e=>e.attempt===0).length<=1,'duplicate first purchase');if(paid.some(e=>e.attempt===1))invariant(paid.some(e=>e.attempt===0&&e.status!=='reserved-uncertain'&&!e.useful),'escalation needs known failed first attempt');}
  for(const o of observations){if(o.reuse==='fresh-purchase')invariant(expenses.some(e=>e.fact_id===o.fact_id&&e.receipt_hash===o.receipt_hash),'fresh purchase lacks expense');}
  if(BigInt(accounting.worst_case_uusdc)>BigInt(spec.budget_uusdc))reasons.push('note budget exceeded');
  for(const d of rejected_raw_observations){
    const fact=spec.facts.find(f=>f.id===d.fact_id);
    invariant(fact&&d.label==='raw-value observation'&&d.status==='REJECTED_SHAPED_MISMATCH'&&d.usable_for_calculations===false,'invalid raw diagnostic');
    invariant(d.request_hash===factHash(fact)&&d.unit===fact.unit&&digest(d.signal_hash)&&digest(d.receipt_hash),'raw diagnostic identity mismatch');
    invariant(d.failed_check.name==='engine value equals provider answer'&&d.failed_check.ok===false,'raw diagnostic must preserve failed shaped check');
    const raw=decimal(d.provider_value),shaped=decimal(d.shaped_value);
    invariant(raw.n*shaped.d!==shaped.n*raw.d,'raw diagnostic needs actual numeric mismatch');
    invariant(d.source.scope_hash===factHash(fact)&&d.source.value===d.provider_value&&createHash('sha256').update(d.source.raw_text).digest('hex')===d.source.content_sha256,'raw diagnostic source mismatch');
    invariant(expenses.some(e=>e.fact_id===d.fact_id&&e.receipt_hash===d.receipt_hash&&!e.useful),'raw diagnostic needs wasted purchase evidence');
    reasons.push(`${d.fact_id}: raw-value observation rejected because shaped check FAILED; diagnostic only`);
  }
  const claim_results:ResearchPacket['claim_results']={};
  for(const c of claims){
    if(!c.predicate){claim_results[c.id]=c.fact_refs.every(id=>values.has(id))&&c.assumption_refs.every(id=>values.has(id))&&(!c.calculation_ref||values.has(c.calculation_ref))?'SUPPORTED':'UNKNOWN';continue;}
    const p=c.predicate;
    invariant(['<','<=','>','>=','=='].includes(p.op),'invalid predicate operation');
    invariant([p.left,p.right].every(id=>c.fact_refs.includes(id)||c.assumption_refs.includes(id)||id===c.calculation_ref),'predicate uses undeclared input');
    const unitOf=(id:string)=>spec.facts.find(f=>f.id===id)?.unit??spec.assumptions.find(a=>a.id===id)?.unit??spec.calculations.find(x=>x.id===id)?.unit;
    invariant(unitOf(p.left)===unitOf(p.right),'predicate units mismatch');
    const l=values.get(p.left),r=values.get(p.right);
    if(!l||!r){claim_results[c.id]='UNKNOWN';continue;}
    const diff=l.n*r.d-r.n*l.d;
    const supported=p.op==='<'?diff<0n:p.op==='<='?diff<=0n:p.op==='>'?diff>0n:p.op==='>='?diff>=0n:diff===0n;
    claim_results[c.id]=supported?'SUPPORTED':'NOT_SUPPORTED';
  }
  const completed_reproducible_notes=reasons.length?0 as const:1 as const;
  const per_fact_worst_case_uusdc=Object.fromEntries(spec.facts.map(f=>[f.id,expenseSummary(expenses.filter(e=>e.fact_id===f.id)).worst_case_uusdc]));
  const metrics={completed_reproducible_notes,cost_per_useful_note_uusdc:completed_reproducible_notes?accounting.worst_case_uusdc:null,per_fact_worst_case_uusdc,reused_acquisition_cost_uusdc:observations.filter(o=>o.reuse==='fresh-receipt-reuse').reduce((n,o)=>n+BigInt(o.acquisition_cost_uusdc),0n).toString()};
  const body={version:VERSION as typeof VERSION,spec,spec_hash:hash(spec),completed_at,observations,expenses,claims,calculations,claim_results,outcome:reasons.length?'HOLD' as const:'READY' as const,reasons,accounting,metrics,...(rejected_raw_observations.length?{rejected_raw_observations}: {})};
  return {...body,packet_hash:hash(body)};
}
export function replayPacket(packet:ResearchPacket, expectedSpecHash?:string):{ok:boolean;reasons:string[]} {
  if(expectedSpecHash!==undefined&&packet.spec_hash!==expectedSpecHash)return {ok:false,reasons:['frozen spec hash mismatch']};
  try{const rebuilt=buildPacket(packet.spec,packet.observations,packet.expenses,packet.claims,packet.completed_at,packet.rejected_raw_observations??[]);return {ok:hash(rebuilt)===hash(packet)&&rebuilt.outcome==='READY',reasons:hash(rebuilt)===hash(packet)?rebuilt.reasons:['packet contents/hash mismatch']};}catch(e){return {ok:false,reasons:[e instanceof Error?e.message:String(e)]};}
}
