// SEC company-search resolution. Atom is identity discovery, never a filing count.
import {upstreamUnavailable,unprocessable} from '../core/errors';
export function legalCompanyKey(name:string):string{
 const words=name.normalize('NFC').toLowerCase().replace(/[.,]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/);
 if(words[0]==='the')words.shift();
 const suffixes=new Set(['inc','incorporated','corp','corporation','co','company','ltd','limited','llc','llp','lp','plc','holdings']);
 while(words.length>1&&suffixes.has(words.at(-1)!))words.pop();
 return words.join(' ');
}
export interface SecSearchCompany{cik:number;name:string}
function text(value:string):string{
 if(/&(?!#x[0-9a-f]+;|#\d+;|amp;|lt;|gt;|quot;|apos;)/i.test(value))throw Error('unknown XML entity');
 if(/<[^>]*>/.test(value))throw Error('nested identity text');
 return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,v:string)=>{
  if(v[0]==='#'){const n=v[1].toLowerCase()==='x'?parseInt(v.slice(2),16):parseInt(v.slice(1),10);if(n<=0||n>0x10ffff||(n>=0xd800&&n<=0xdfff))throw Error('invalid XML character');return String.fromCodePoint(n);}
  return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"} as Record<string,string>)[v.toLowerCase()];
 }).trim();
}
// Validate complete nesting before extracting the small, fixed SEC identity schema.
function assertXmlNesting(body:string):void{
 const stack:string[]=[];let cursor=0;
 const tags=/<(?:\?[^?]*\?|!--[\s\S]*?--|\/?[A-Za-z_][\w:.-]*(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\/?)>/g;
 for(const m of body.matchAll(tags)){
  if(body.slice(cursor,m.index).includes('<'))throw Error('invalid XML token');cursor=m.index!+m[0].length;
  const tag=m[0];if(tag.startsWith('<?')||tag.startsWith('<!--'))continue;
  const name=/^<\/?([\w:.-]+)/.exec(tag)![1];
  if(tag.startsWith('</')){if(stack.pop()!==name)throw Error('unbalanced XML');}else if(!tag.endsWith('/>'))stack.push(name);
 }
 if(stack.length||body.slice(cursor).trim())throw Error('incomplete XML');
}
export function parseSecCompanyAtom(body:string):SecSearchCompany[]{
 try{
  assertXmlNesting(body);
  if(body.length>2_000_000||/<!DOCTYPE|<!ENTITY/i.test(body)||!/^\s*(?:<\?xml[^?]*\?>\s*)?<feed\b[^>]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["'][^>]*>[\s\S]*<\/feed>\s*$/.test(body))throw Error('not a company Atom feed');
  const rootIdentity=body.slice(0,body.indexOf('<entry')<0?body.length:body.indexOf('<entry'));
  const single=/<company-info\b[^>]*>([\s\S]*?)<\/company-info>/.exec(rootIdentity);
  const entries=[...body.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)];
  if(entries.length!==(body.match(/<entry\b/g)||[]).length)throw Error('broken entries');
  const out:SecSearchCompany[]=[];
  const identityEntries=single?[[single[0],single[0]]]:entries;
  for(const entry of identityEntries){
   const infos=[...entry[1].matchAll(/<company-info\b[^>]*>([\s\S]*?)<\/company-info>/g)];if(infos.length!==1)throw Error('missing company identity');
   const ciks=[...infos[0][1].matchAll(/<cik>([^<]*)<\/cik>/g)],names=[...infos[0][1].matchAll(single?/<conformed-name>([^<]*)<\/conformed-name>/g:/<name>([^<]*)<\/name>/g)];
   if(ciks.length!==1||names.length!==1||!/^\d{1,10}$/.test(ciks[0][1])||Number(ciks[0][1])<=0)throw Error('bad company identity');
   const name=text(names[0][1]);if(!name||name.length>512||!legalCompanyKey(name))throw Error('empty company name');
   out.push({cik:Number(ciks[0][1]),name});
  }
  // An empty response must still identify itself as the company-search feed.
  if(!single&&!entries.length&&!/<title>Company Search Feed<\/title>/.test(body))throw Error('not a healthy empty search');
  return out;
 }catch{throw upstreamUnavailable('SEC_UNAVAILABLE','SEC company search returned malformed Atom identity data');}
}
export function matchSecCompany(companies:SecSearchCompany[],query:string):SecSearchCompany|null{
 const key=legalCompanyKey(query);if(!key||key.length<3)return null;
 const matches=companies.filter(c=>legalCompanyKey(c.name)===key),unique=new Map(matches.map(c=>[c.cik,c]));
 if(unique.size>1)throw unprocessable('AMBIGUOUS_ENTITY','multiple SEC legal names match; use the exact CIK');
 return [...unique.values()][0]??null;
}
/** Atom relation is a whitespace-separated token set; XML attribute spacing is insignificant. */
export function hasNextSecCompanyPage(body:string):boolean{
 for(const link of body.matchAll(/<(?:[A-Za-z_][\w.-]*:)?link\b([^<>]*)\/?>/g)){
  const attrs=new Map<string,string>();
  for(const attr of link[1].matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)){
   if(attrs.has(attr[1]))throw upstreamUnavailable('SEC_UNAVAILABLE','duplicate Atom link attribute');
   attrs.set(attr[1],text(attr[2]??attr[3]));
  }
  if((attrs.get('rel')??'').split(/\s+/).includes('next'))return true;
 }
 return false;
}
