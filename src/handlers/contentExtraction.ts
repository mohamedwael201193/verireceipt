// Exact supplied JSON or explicitly labelled text/HTML extraction. No URL fetch or factual verification.
// Intentionally not registered until request-distribution fit is established.
import {badRequest,unprocessable} from '../core/errors';
export interface ExtractedContent {
 title:string; content:string; url:string; entities:string[]; brief:string;
 scope:'supplied-content-only'; independently_verified:false;
}
export function extractSuppliedContent(query:Record<string,string|undefined>):ExtractedContent {
 const content=query.content;const fields=query.fields;
 if(!content||!fields?.trim())throw badRequest('MISSING_PARAM','content and fields are required');
 if(Buffer.byteLength(content,'utf8')>16384)throw badRequest('CONTENT_TOO_LARGE','supplied content must be at most 16384 UTF-8 bytes');
 if(fields.length>256)throw badRequest('FIELDS_TOO_LONG','fields must be at most 256 characters');
 const names=fields.split(',').map(s=>s.trim());
 if(names.length>8||names.some(n=>! /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(n)||['constructor','prototype','__proto__'].includes(n))||new Set(names).size!==names.length)
  throw badRequest('INVALID_FIELDS','fields must be1to8distinct simple top-level keys, comma separated');
 let data:unknown;
 if(content.trimStart().startsWith('{'))validateJsonLexemes(content);
 try{data=JSON.parse(content);}catch{
  if(/^https?:\/\/\S+$/i.test(content.trim()))throw unprocessable('UNSUPPORTED_CONTENT','URLs are not fetched; supply the document text or HTML');
  data=labelledValues(content,names);
 }
 if(!data||typeof data!=='object'||Array.isArray(data))throw unprocessable('UNSUPPORTED_CONTENT','content must be a supplied JSON object');
 const values=names.map(name=>{
  if(!Object.hasOwn(data as object,name))throw unprocessable('EXTRACTION_FIELD_MISSING','a requested exact field is absent');
  const value=(data as Record<string,unknown>)[name];
  if(typeof value!=='string'&&typeof value!=='boolean'&&typeof value!=='number')throw unprocessable('UNSUPPORTED_FIELD_VALUE','requested values must be strings, booleans or finite numbers');
  if(typeof value==='number'&&(!Number.isFinite(value)||!Number.isSafeInteger(value)))throw unprocessable('UNSUPPORTED_FIELD_VALUE','numeric values must be safe integers; supply decimal quantities as exact strings');
  // Quote strings so values cannot impersonate other fields or hide delimiters.
  return name+': '+JSON.stringify(value);
 });
 const brief=values.join('; ');
 if(Array.from(brief).length>80||Buffer.byteLength(brief,'utf8')>256)throw unprocessable('EXTRACTION_BRIEF_TOO_LONG','complete exact extracted pairs exceed80characters; values are never truncated');
 return {title:'Supplied content field extraction',content:values.join('\n'),url:'',entities:values,brief,scope:'supplied-content-only',independently_verified:false};
}

const aliases:Record<string,string[]>={merchant:['merchant','merchant name','vendor','seller'],date:['date','invoice date','created','issued'],total:['total','total due','grand total','amount due'],invoice_number:['invoice number','invoice #','invoice no'],currency:['currency']};
/** Markup is data, never executable. Extraction is textual, not a rendered-visibility claim. */
function documentLines(content:string):string[]{
 const cleaned=content.replace(/<!--[^]*?-->/g,' ').replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi,' ');
 if(/<(script|style)\b|<!--/i.test(cleaned))throw unprocessable('UNSUPPORTED_CONTENT','unterminated non-content markup');
 const raw=cleaned.replace(/<(br|\/p|\/div|\/tr|\/td|\/th|\/h[1-6]|\/li)\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,' ');
 return raw.replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").split(/\r?\n/).map(x=>x.replace(/[ \t]+/g,' ').trim()).filter(Boolean);
}
function labelledValues(content:string,names:string[]):Record<string,string>{
 const lines=documentLines(content);const result:Record<string,string>=Object.create(null);
 for(const name of names){
  const labels=Object.hasOwn(aliases,name.toLowerCase())?aliases[name.toLowerCase()]:[name.replace(/_/g,' ')];const found:string[]=[];
  for(let i=0;i<lines.length;i++)for(const label of labels){
   const escaped=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   const m=new RegExp('^'+escaped+'\\s*:\\s*(.+)$','i').exec(lines[i]);
   if(m){found.push(m[1]);continue;}
   // Receipt totals may be explicitly labelled on the same line without a
   // colon. Numeric-only values avoid confusing TOTAL ITEMS or TOTAL DISC
   // with an amount; no currency, decimal or thousands conversion occurs.
   if(name.toLowerCase()==='total'){
    const amount=new RegExp('^'+escaped+'\\s+([+-]?[0-9]+(?:[.,][0-9]+)*)$','i').exec(lines[i]);
    if(amount){found.push(amount[1]);continue;}
   }
   if(lines[i].toLowerCase()===label.toLowerCase()&&lines[i+1]&&!/:/.test(lines[i+1]))found.push(lines[i+1]);
  }
  const unique=[...new Set(found)];if(unique.length!==1)throw unprocessable('EXTRACTION_FIELD_AMBIGUOUS','requested field must have one unique explicit label/value; missing or conflicting fields are not inferred');
  result[name]=unique[0];
 }
 return result;
}

function validateJsonLexemes(content:string):void {
 // Scan before JSON.parse converts numbers. JSON.parse then validates grammar.
 // Reject ambiguous
 // top-level keys instead of silently using the last duplicate value.
 const tokens=content.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)??[];
 let depth=0;const seen=new Set<string>();
 for(let i=0;i<tokens.length;i++){
  const token=tokens[i];
  if(/^-?\d/.test(token)){
   if(!/^-?(0|[1-9]\d*)$/.test(token)||token==='-0')throw unprocessable('UNSUPPORTED_FIELD_VALUE','numeric tokens must use exact integer syntax; supply decimals as strings');
   const integer=BigInt(token);
   if(integer>BigInt(Number.MAX_SAFE_INTEGER)||integer<BigInt(Number.MIN_SAFE_INTEGER))throw unprocessable('UNSUPPORTED_FIELD_VALUE','integer token outside safe range');
  }
  if(token==='{'||token==='['){depth++;continue;}
  if(token==='}'||token===']'){depth--;continue;}
  if(depth===1&&token.startsWith('"')&&tokens[i+1]===':'){
   const key=JSON.parse(token) as string;
   if(seen.has(key))throw unprocessable('EXTRACTION_FIELD_AMBIGUOUS','duplicate JSON keys are not accepted');seen.add(key);
  }
 }
}
