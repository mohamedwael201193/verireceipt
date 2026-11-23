import {isIP} from 'node:net';
import {badRequest,upstreamUnavailable} from '../core/errors';
import {envelope,makeReceipt} from '../core/receipt';
import {saveReceipt} from '../core/storage';
import {extractSdnCryptoAddresses,RUBRIC} from './transactionRisk';
import {loadFeeds,matchIndicator} from './threatIntel';
const SDN='https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV';
export async function handleFraudDetection(query:Record<string,string|undefined>):Promise<Record<string,unknown>> {
 const subject=query.subject?.trim();
 if(!subject)throw badRequest('MISSING_PARAM','subject is required');
 if(subject.length>2000||/[\x00-\x1f]/.test(subject))throw badRequest('INVALID_SUBJECT','subject must be at most 2000 printable characters');
 let verdict='INCONCLUSIVE';let score:number|null=null;const signals:string[]=[];
 let source='Supplied subject only; no independent evidence';let evidence:Record<string,unknown>={};
 let fetchedAt=new Date().toISOString();
 if(/^0x[a-f0-9]{40}$/i.test(subject)) {
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),8000);
  try {
   const response=await fetch(SDN,{signal:controller.signal,headers:{accept:'text/csv','user-agent':'VeriReceipt/2.0 fraud-screen observer'}});
   if(!response.ok)throw new Error('SDN HTTP failure');
   const size=Number(response.headers.get('content-length')??0);if(size>12000000)throw new Error('SDN oversized');
   const reader=response.body?.getReader();if(!reader)throw new Error('SDN missing');
   const chunks:Uint8Array[]=[];let bytes=0;
   try {while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>12000000){await reader.cancel();throw new Error('SDN oversized');}chunks.push(part.value);}}finally{reader.releaseLock();}
   const raw=Buffer.concat(chunks).toString('utf8');const addresses=extractSdnCryptoAddresses(raw);
   if(addresses.length<50)throw new Error('SDN incomplete');
   const listed=addresses.includes(subject.toLowerCase());
   fetchedAt=new Date().toISOString();source=SDN;
   if(listed){verdict='SUSPICIOUS';score=1;signals.push('Exact OFAC SDN Digital Currency Address match. The existing transaction rubric assigns sanctions exposure weight 1; this is not a probability of fraud or proof of a fraudulent act.');}
   else signals.push('No exact address match in the fetched OFAC SDN crypto-address entries; other sanctions lists and fraud evidence are not checked.');
   evidence={mode:'address',raw_body:raw,source_url:SDN,addresses_seen:addresses.length,listed,rubric:RUBRIC};
  }catch {throw upstreamUnavailable('SANCTIONS_UNAVAILABLE','complete OFAC SDN address evidence could not be fetched');}
  finally{clearTimeout(timer);}
 } else if(isIP(subject)===4 || /^https?:\/\//i.test(subject) || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(subject)) {
  if(/^https?:\/\//i.test(subject)) {
   try {const u=new URL(subject);if(u.username||u.password)throw new Error();}
   catch {throw badRequest('INVALID_SUBJECT','subject URL must be valid and have no credentials');}
  }
  const states=await loadFeeds();const matched=matchIndicator(subject,states);
  if(matched.matches.length){verdict='SUSPICIOUS';signals.push(...matched.matches.map(m=>`${m.feed}: ${m.raw}`));}
  else signals.push('No match in the queried threat feeds; absence is not clearance and does not establish legitimate activity.');
  fetchedAt=states.map(s=>s.fetchedAt).sort()[0];source=states.map(s=>s.feed.url).join('; ');
  evidence={mode:'indicator',matches:matched.matches,feeds:states.map(s=>({name:s.feed.name,url:s.feed.url,sha256:s.sha256,fetched_at:s.fetchedAt,published:s.published})),score_notice:'No calibrated fraud probability is available; risk_score is null.'};
 } else {
  signals.push('Unsupported free-text subject: no independent fraud evidence or factual verification; no score assigned.');
  evidence={mode:'unsupported-description',notice:'No external lookup; free-text accusations or claimed sanctions status are not evidence.'};
 }
 const summary=`${subject}: ${verdict}. ${signals.join(' ')} Screening evidence only, not proof of fraud or legitimacy.`;
 const body=JSON.stringify({subject,verdict,risk_score:score,signals,...evidence,fetched_at:fetchedAt,notice:'Blocklist/sanctions membership is not fraud adjudication. Null score means unmeasured, never zero risk.'});
 const receipt=makeReceipt('FRAUD_DETECTION_GENERAL',source,body,'Evidence-bound screening; no fraud adjudication');receipt.fetched_at=fetchedAt;
 try{await saveReceipt(receipt,body);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');}
 return envelope('FRAUD_DETECTION_GENERAL',{subject,risk_score:score,signals,summary,assessment_status:'unverified'},receipt,{answer:summary,verdict,confidence:0,source});
}
