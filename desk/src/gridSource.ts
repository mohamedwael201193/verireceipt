// Official-source grid verification. No cached default prices, benchmark
// answers, provider allowlists, or silent market selection.
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { finishSource, sourceCheck, sourceResult, type SourceOptions, type SourceVerification } from './sourceTypes.js';

export interface GridContract { operator:'NYISO'|'CAISO'; market:'RTM'|'DAM'; node:string; startMs:number; interval:string }
const NY_NAMES = ['WEST','GENESE','CENTRL','NORTH','MHK VL','CAPITL','HUD VL','MILLWD','DUNWOD','N.Y.C.','LONGIL'];
const CA_NODES = new Set(['TH_NP15_GEN-APND','TH_SP15_GEN-APND','TH_ZP26_GEN-APND']);
function nyNode(value:string):string|undefined {
 const normalized=value.trim().toUpperCase();
 const zone=/^ZONE_([A-K])$/.exec(normalized);
 return zone?NY_NAMES[zone[1].charCodeAt(0)-65]:NY_NAMES.includes(normalized)?normalized:undefined;
}
function timestamp(value:unknown):number {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|-00:00|\+00:00)$/.test(value))throw new Error('interval must be exact UTC ISO time');
 const canonical=value.replace(/(?:-00:00|\+00:00)$/,'Z').replace(/\.000Z$/,'Z');
 const ms=Date.parse(value);
 if(!Number.isFinite(ms)||new Date(ms).toISOString().replace(/\.000Z$/,'Z')!==canonical)throw new Error('invalid interval date');
 return ms;
}
function market(value:unknown):string {
 if(typeof value!=='string')return '';
 const m=value.trim().toUpperCase();
 if(['DAM','CAISO DAM','DAY-AHEAD'].includes(m))return 'DAM';
 if(['RTM','NYISO RTM','NYISO REALTIME LBMP','REAL-TIME'].includes(m))return 'RTM';
 return '';
}
export function gridContract(params:Record<string,string>):GridContract {
 if(!params.market)throw new Error('explicit grid market is required; no market default');
 const startMs=timestamp(params.interval_start);
 const node=(params.node_or_zone??'').trim().toUpperCase();
 const ny=nyNode(node);
 if(ny){
  if(market(params.market)!=='RTM')throw new Error('NYISO source supports only explicit RTM market');
  if(startMs%300000!==0)throw new Error('NYISO interval is not aligned to five minutes');
  return {operator:'NYISO',market:'RTM',node:ny,startMs,interval:new Date(startMs).toISOString()};
 }
 if(CA_NODES.has(node)){
  if(market(params.market)!=='DAM')throw new Error('CAISO source supports only explicit DAM market');
  if(startMs%3600000!==0)throw new Error('CAISO interval is not aligned to an hour');
  return {operator:'CAISO',market:'DAM',node,startMs,interval:new Date(startMs).toISOString()};
 }
 throw new Error('unsupported grid source node');
}
function csv(text:string):string[][] {
 const rows:string[][]=[];let row:string[]=[];let field='';let state:'start'|'plain'|'quoted'|'closed'='start';
 const pushField=()=>{row.push(field.trim());field='';state='start';};
 const pushRow=()=>{pushField();if(row.some(x=>x))rows.push(row);row=[];};
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(state==='quoted'){
   if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else state='closed';}else field+=c;
  }else if(c===',')pushField();
  else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;pushRow();}
  else if(c==='"'){if(state!=='start')throw new Error('quote inside unquoted CSV field');state='quoted';}
  else {if(state==='closed')throw new Error('data after closing CSV quote');field+=c;state='plain';}
 }
 if(state==='quoted')throw new Error('unterminated quoted CSV field');
 pushRow();
 const header=rows[0];if(!header)throw new Error('missing CSV header');header[0]=header[0].replace(/^\uFEFF/,'');
 if(new Set(header).size!==header.length||rows.some(row=>row.length!==header.length))throw new Error('duplicate CSV columns or inconsistent row width');
 return rows;
}
function decimal(value:string|undefined):number {
 if(!value||!/^[-+]?\d+(?:\.\d+)?$/.test(value))throw new Error('missing or invalid official price');
 const n=Number(value);if(!Number.isFinite(n))throw new Error('non-finite official price');return n;
}
function one(values:number[]):number {if(values.length!==1)throw new Error('exactly one matching official row is required');return values[0];}
export function parseCaisoRows(text:string,c:GridContract):number {
 if(c.operator!=='CAISO'||c.market!=='DAM')throw new Error('wrong official grid market');
 const [header,...rows]=csv(text);if(!header)throw new Error('missing CSV header');
 const indexes=['INTERVALSTARTTIME_GMT','NODE','XML_DATA_ITEM','MW','MARKET_RUN_ID','INTERVALENDTIME_GMT'].map(key=>header.indexOf(key));
 if(indexes.some(i=>i<0))throw new Error('incomplete CAISO CSV schema');
 const [time,node,item,mw,run,end]=indexes;const values:number[]=[];
 for(const row of rows){
  if(row[node]!==c.node||row[item]!=='LMP_PRC'||row[run]!=='DAM')continue;
  if(timestamp(row[time])===c.startMs){
   if(timestamp(row[end])!==c.startMs+3600000)throw new Error('CAISO row is not the exact hourly interval');
   values.push(decimal(row[mw]));
  }
 }
 return one(values);
}
const nyFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function nyParts(ms:number):string {
 const p=Object.fromEntries(nyFormatter.formatToParts(ms).map(x=>[x.type,x.value]));
 return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
function wallCandidates(wall:string):number[]{
 const m=/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(wall);
 if(!m)throw new Error('invalid NYISO wall timestamp');
 const canonical=`${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:${m[6]}`;
 const base=timestamp(canonical+'Z');
 const candidates=[base+4*3600000,base+5*3600000].filter(ms=>nyParts(ms)===canonical);
 if(!candidates.length)throw new Error('nonexistent NYISO local time');
 return candidates;
}
function fallbackChronology(wall:string,zoneRows:string[][],time:number):void {
 const m=/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):/.exec(wall)!;
 const base=Date.parse(`${m[3]}-${m[1]}-${m[2]}T${m[4]}:00:00Z`);
 const format=(offset:number)=>{const d=new Date(base+offset*60000).toISOString();return `${d.slice(5,7)}/${d.slice(8,10)}/${d.slice(0,4)} ${d.slice(11,19)}`;};
 const expected=[format(-5),...Array.from({length:12},(_,i)=>format(i*5)),...Array.from({length:12},(_,i)=>format(i*5)),format(60)];
 const first=zoneRows.findIndex(row=>row[time]===format(0));
 const actual=zoneRows.slice(first-1,first+25).map(row=>row[time]);
 if(first<1||JSON.stringify(actual)!==JSON.stringify(expected)||zoneRows.filter(row=>row[time].startsWith(wall.slice(0,14))).length!==24)throw new Error('fallback hour lacks complete ordered blocks and chronological neighbours');
}
export function parseNyisoRows(text:string,c:GridContract):number {
 if(c.operator!=='NYISO'||c.market!=='RTM')throw new Error('wrong official grid market');
 const [header,...rows]=csv(text);if(!header)throw new Error('missing CSV header');
 const time=header.indexOf('Time Stamp'),name=header.indexOf('Name'),price=header.indexOf('LBMP ($/MWHr)');
 if([time,name,price].some(i=>i<0)||header.filter(x=>x.startsWith('LBMP')).length!==1)throw new Error('incomplete or contradictory NYISO USD CSV schema');
 const zoneRows=rows.filter(row=>nyNode(row[name]??'')===c.node);
 const groups=new Map<string,string[]>();
 for(const row of zoneRows){const values=groups.get(row[time])??[];values.push(row[price]);groups.set(row[time],values);}
 const matches:number[]=[];
 for(const [wall,prices] of groups){
  const candidates=wallCandidates(wall);
  if(candidates.length!==prices.length)throw new Error('ambiguous or duplicate NYISO interval rows');
  if(candidates.length===2)fallbackChronology(wall,zoneRows,time);
  for(let i=0;i<candidates.length;i++)if(candidates[i]===c.startMs)matches.push(decimal(prices[i]));
 }
 return one(matches);
}
function crc32(bytes:Buffer):number {
 let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;
}
/** Bounded ZIP reader. Select one CSV, verify size/CRC, never write archive paths. */
export function officialCsvFromZip(bytes:Buffer,wantedName?:string):string {
 let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
 if(end<0||bytes.readUInt16LE(end+4)!==0||bytes.readUInt16LE(end+6)!==0)throw new Error('invalid or multi-disk official ZIP');
 const count=bytes.readUInt16LE(end+10),offset=bytes.readUInt32LE(end+16),size=bytes.readUInt32LE(end+12);
 if(count<1||count>64||offset+size!==end||bytes.readUInt16LE(end+8)!==count)throw new Error('unbounded or inconsistent official ZIP directory');
 let at=offset;const selected:Array<{method:number;size:number;compressed:number;crc:number;local:number}>=[];
 for(let i=0;i<count;i++){
  if(at+46>end||bytes.readUInt32LE(at)!==0x02014b50)throw new Error('invalid ZIP central entry');
  const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),compressed=bytes.readUInt32LE(at+20),uncompressed=bytes.readUInt32LE(at+24);
  const nameLength=bytes.readUInt16LE(at+28),extra=bytes.readUInt16LE(at+30),comment=bytes.readUInt16LE(at+32);
  if(at+46+nameLength+extra+comment>end||flags&1)throw new Error('invalid or encrypted official ZIP');
  const name=bytes.subarray(at+46,at+46+nameLength).toString('utf8');
  if((wantedName?name===wantedName:/^[^/\\]+\.csv$/i.test(name))){
   if(![0,8].includes(method)||uncompressed>16_000_000||compressed>8_000_000)throw new Error('unsupported or oversized official ZIP member');
   selected.push({method,size:uncompressed,compressed,crc:bytes.readUInt32LE(at+16),local:bytes.readUInt32LE(at+42)});
  }
  at+=46+nameLength+extra+comment;
 }
 if(at!==end||selected.length!==1)throw new Error('exactly one requested official CSV is required');
 const entry=selected[0],local=entry.local;
 if(local+30>offset||bytes.readUInt32LE(local)!==0x04034b50)throw new Error('invalid ZIP local entry');
 const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
 if(start+entry.compressed>offset)throw new Error('invalid ZIP data bounds');
 const compressed=bytes.subarray(start,start+entry.compressed);
 const output=entry.method===0?compressed:inflateRawSync(compressed,{maxOutputLength:16_000_000});
 if(output.length!==entry.size||crc32(output)!==entry.crc)throw new Error('official ZIP size or CRC mismatch');
 return output.toString('utf8');
}
async function readFeed(url:string,r:SourceVerification,options:SourceOptions):Promise<{status:number;bytes:Buffer}> {
 const response=await(options.f??fetch)(url,{redirect:'error',signal:AbortSignal.timeout(120000)});
 if(response.status===404)return {status:404,bytes:Buffer.alloc(0)};
 if(!response.ok)throw new Error(`official grid HTTP ${response.status}`);
 const bytes=Buffer.from(await response.arrayBuffer());
 if(bytes.length>8_000_000)throw new Error('official grid response exceeds bound');
 const zip=bytes.length>=4&&bytes.readUInt32LE(0)===0x04034b50;
 r.sources.push({url:response.url||url,sha256:createHash('sha256').update(bytes).digest('hex'),retrieved_at:new Date().toISOString(),raw_text:zip?bytes.toString('base64'):bytes.toString('utf8'),encoding:zip?'base64':'utf8'});
 return {status:200,bytes};
}
function caisoTime(ms:number):string {return new Date(ms).toISOString().slice(0,16).replace(/-/g,'')+'-0000';}
function caisoWindowTime(value:string|null):number {
 if(value===null)throw new Error('missing OASIS window');
 const m=/^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2})-0000$/.exec(value);
 if(!m)throw new Error('invalid OASIS window timestamp');
 return timestamp(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
}
function productUrl(value:unknown,c:GridContract):boolean {
 if(typeof value!=='string')return false;
 try{
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)return false;
  if(c.operator==='NYISO'){
   const date=nyParts(c.startMs).slice(0,10).replace(/-/g,'');
   return u.hostname==='mis.nyiso.com'&&!u.search&&[`${date}realtime_zone.csv`,`${date.slice(0,6)}01realtime_zone_csv.zip`].some(name=>u.pathname==='/public/csv/realtime/'+name);
  }
  if(u.hostname!=='oasis.caiso.com'||u.pathname!=='/oasisapi/SingleZip')return false;
  const q=u.searchParams;if([...q.keys()].some(key=>q.getAll(key).length!==1))return false;
  const start=caisoWindowTime(q.get('startdatetime')),end=caisoWindowTime(q.get('enddatetime'));
  return q.get('queryname')==='PRC_LMP'&&q.get('market_run_id')==='DAM'&&q.get('node')===c.node&&start<=c.startMs&&end>=c.startMs+3600000&&end>start&&end-start<=26*3600000;
 }catch{return false;}
}
function returnedProduct(result:Record<string,unknown>,provider:Record<string,unknown>|undefined,c:GridContract):boolean {
 let productEvidence=false;
 for(const claims of provider?[result,provider]:[result]){
  if(claims.market!==undefined&&claims.market!==null){if(market(claims.market)===c.market)productEvidence=true;else if(claims.market!==c.operator)return false;}
  for(const key of ['product','market_run_id'])if(claims[key]!==undefined){if(market(claims[key])!==c.market)return false;productEvidence=true;}
  if(claims.receipt!==undefined){
   if(!claims.receipt||typeof claims.receipt!=='object'||Array.isArray(claims.receipt))return false;
   const url=(claims.receipt as Record<string,unknown>).upstream_url;
   if(url!==undefined){if(!productUrl(url,c))return false;productEvidence=true;}
  }
 }
 return (result.market!=null||provider?.market!=null)&&productEvidence;
}
export async function verifyGridSource(input:{params:Record<string,string>;result:Record<string,unknown>;providerResult?:Record<string,unknown>},options:SourceOptions={}):Promise<SourceVerification>{
 const r=sourceResult();
 try{
  const c=gridContract(input.params);
  r.details={contract_version:'grid-source-contract-v2',...c};
  const identityMatches=(p:Record<string,unknown>)=>(c.operator==='NYISO'?nyNode(String(p.node_or_zone??'')):p.node_or_zone)===c.node && p.currency==='USD' && timestamp(p.interval_start)===c.startMs;
  const identitiesMatch=identityMatches(input.result)&&(!input.providerResult||identityMatches(input.providerResult));
  sourceCheck(r,'grid response identity',returnedProduct(input.result,input.providerResult,c) && identitiesMatch,'returned ISO/product claims need explicit product metadata or exact official product URL; node, UTC interval and currency must match the query');
  if(!r.checks.every(x=>x.ok))return finishSource(r);
  let price:number;
  if(c.operator==='NYISO'){
   const date=nyParts(c.startMs).slice(0,10).replace(/-/g,'');
   let feed=await readFeed(`https://mis.nyiso.com/public/csv/realtime/${date}realtime_zone.csv`,r,options);
   let text:string;
   if(feed.status===404){
    feed=await readFeed(`https://mis.nyiso.com/public/csv/realtime/${date.slice(0,6)}01realtime_zone_csv.zip`,r,options);
    if(feed.status!==200)throw new Error('official NYISO history unavailable');
    text=officialCsvFromZip(feed.bytes,`${date}realtime_zone.csv`);
   }else text=feed.bytes.toString('utf8');
   price=parseNyisoRows(text,c);
  }else{
   const url='https://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_LMP&startdatetime='+caisoTime(c.startMs)+'&enddatetime='+caisoTime(c.startMs+3600000)+'&version=1&market_run_id=DAM&node='+encodeURIComponent(c.node)+'&resultformat=6';
   const feed=await readFeed(url,r,options);if(feed.status!==200)throw new Error('official CAISO source unavailable');
   price=parseCaisoRows(officialCsvFromZip(feed.bytes),c);
  }
  r.details.primary_value=price;
  sourceCheck(r,'grid value',(!input.providerResult||input.providerResult.lmp_usd_per_mwh===input.result.lmp_usd_per_mwh)&&typeof input.result.lmp_usd_per_mwh==='number'&&Number.isFinite(input.result.lmp_usd_per_mwh)&&input.result.lmp_usd_per_mwh===price,`provider ${String(input.result.lmp_usd_per_mwh)}; exact official row ${price}`);
 }catch(error){sourceCheck(r,'grid evidence available',false,error instanceof Error?error.message:'grid source verification failed');}
 return finishSource(r);
}
