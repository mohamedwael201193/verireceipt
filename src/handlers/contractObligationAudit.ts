// Literal supplied-text index, not a legal opinion or verification of performance.
// No network, execution, URL loading or persisted source text.
import { badRequest, upstreamUnavailable } from '../core/errors';
import { envelope, makeReceipt, sha256Hex } from '../core/receipt';
import { saveReceipt } from '../core/storage';
export const INTENT='CONTRACT_OBLIGATION_AUDIT_GENERAL';
const POLICY='Literal modal-clause index v1; no legal interpretation, applicability or actual performance verified. No dates inferred, no instructions executed. Source text is not retained in public receipt evidence.';
export interface LiteralClause {text:string;start:number;end:number}
export function indexObligations(text:string): {obligations:Record<string,unknown>[];clauses:LiteralClause[]} {
 const clauses:LiteralClause[]=[],obligations:Record<string,unknown>[]=[];
 // Every output span is a direct UTF-16 substring of the original, not normalized text.
 const parts=/[^;.!?]+(?:[;.!?]|$)/g;
 for(const part of text.matchAll(parts)){
  const segment=part[0],leading=segment.length-segment.trimStart().length;
  const clean=segment.trim();if(!clean)continue;
  const modal=/\b(shall(?:\s+not)?|must(?:\s+not)?|agrees?\s+to|is\s+required\s+to|are\s+required\s+to)\b/i.exec(clean);
  if(!modal)continue;
  const start=part.index!+leading,end=start+clean.length;
  const clause={text:text.slice(start,end),start,end};
  const subject=clean.slice(0,modal.index).trim();
  const action=clean.slice(modal.index+modal[0].length).trim();
  const time=/\b(?:within\s+\d+\s+(?:(?:business|calendar)\s+)?(?:days?|months?|years?|hours?)|(?:on|by|before|after)\s+\d{4}-\d{2}-\d{2})\b/i.exec(action)?.[0]??null;
  clauses.push(clause);obligations.push({clause_index:clauses.length-1,subject_text:subject||null,modal_text:modal[0],action_text:action||null,time_text:time,
   performance_status:'unverified',interpretation:'Literal candidate only; subject, scope, conditions, exceptions, defined terms and actual performance require human review.'});
 }
 return{obligations,clauses};
}
export async function handleContractObligationAudit(query:Record<string,string|undefined>):Promise<Record<string,unknown>>{
 if(Object.keys(query).some(k=>k!=='contract'))throw badRequest('UNKNOWN_PARAM','only contract is supported');
 const contract=query.contract;
 if(typeof contract!=='string'||!contract.trim())throw badRequest('MISSING_PARAM','contract is required');
 const bytes=Buffer.byteLength(contract,'utf8');
 const urlOnly=/^\s*(?:https?:\/\/|www\.)\S+\s*$/i.test(contract);
 const inputKind=bytes>256?'over_chain_limit':urlOnly?'url_not_loaded':'literal_text';
 const {obligations,clauses}=inputKind==='literal_text'?indexObligations(contract):{obligations:[],clauses:[]};
 const summary=inputKind==='url_not_loaded'?'Unclear: the supplied link was not retrieved; no contract wording or performance evidence was inspected. Supply literal clause text (up to256 UTF-8 bytes).':inputKind==='over_chain_limit'?'Unclear: input exceeds the256 UTF-8 byte chain limit; no clauses were indexed. Supply a shorter literal clause.':
  `Unclear: ${obligations.length} literal obligation candidate(s) indexed. Duties alone do not establish compliance or breach; external performance, applicability, definitions and exceptions were not verified.`;
 const evidence=JSON.stringify({input_sha256:sha256Hex(contract),input_bytes:bytes,input_kind:inputKind,offset_unit:'UTF-16 code units',clause_spans:clauses.map(({start,end})=>({start,end})),obligation_count:obligations.length,verdict:'Unclear',methodology:POLICY});
 const receipt=makeReceipt(INTENT,'local:supplied-contract-sha256',evidence,'Literal text index only; no compliance attestation; source text not persisted');
 try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');}
 return envelope(INTENT,{obligations,clauses,summary,input_kind:inputKind,source_text_retained:false,methodology:POLICY},receipt,{answer:summary+' '+POLICY,verdict:'Unclear',confidence:0.3,source:'Supplied text only, not independently authenticated; receipt retains hash and offsets, not source text'});
}
