// Receipt wrapper only. Route and declaration are separate reviewed changes.
import {extractSuppliedContent} from './contentExtraction';
import {envelope,makeReceipt} from '../core/receipt';
import {saveReceipt} from '../core/storage';
import {upstreamUnavailable} from '../core/errors';
export const INTENT='CONTENT_EXTRACTION_GENERAL';
export async function handleContentExtraction(query:Record<string,string|undefined>):Promise<Record<string,unknown>> {
 const extracted=extractSuppliedContent(query);
 const acquiredAt=new Date().toISOString();
 const evidence=JSON.stringify({intent:INTENT,source_kind:'caller-supplied-content',
  supplied_content:query.content,requested_fields:query.fields,extracted,
  acquired_at:acquiredAt,independently_verified:false,
  scope:'Exact supplied scalar or labelled-text extraction only. No URL retrieval, OCR, document title identification or authenticity verification. Receipt proves retained input/output bytes, not truth or authorship.'});
 const receipt=makeReceipt(INTENT,'supplied:inline',evidence,'caller-supplied bytes; no external source verification');
 receipt.fetched_at=acquiredAt;
 try {await saveReceipt(receipt,evidence);} catch {
  throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');
 }
 return envelope(INTENT,{...extracted,title:'',acquired_at:acquiredAt,
  source_kind:'caller-supplied-content',title_identified:false},receipt,{
  answer:`${extracted.brief}. Exact values from caller-supplied content only; not independently verified. No URL was fetched and no document title or authenticity was established.`,
  verdict:'extracted',confidence:1,
  source:'Caller-supplied inline content; receipt retains exact supplied content and requested fields. Receipt is not independent verification.',
 });
}
