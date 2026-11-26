// Calendar-month uptime from a statuspage host's public history JSON (https://HOST/history.json?page=N).
// Page N holds three calendar months, newest first; page 1 ends with the current month. Only the vendor's
// own listed incidents are read. Anything partial, unparseable or ambiguous returns a refusal reason,
// never a number.
const MONTHS=['january','february','march','april','may','june','july','august','september','october','november','december'];
const ABBR=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
export interface CalendarMonth{year:number;month:number} // month 0-11
export function parseCalendarMonth(raw:string|undefined):CalendarMonth|null{
 const t=raw?.trim().toLowerCase().replace(/\s+/g,' ')??'';
 let m=/^([a-z]+) (\d{4})$/.exec(t);
 if(m){const i=MONTHS.indexOf(m[1]);if(i>=0)return valid({year:Number(m[2]),month:i});}
 m=/^(\d{4})-(\d{2})$/.exec(t);
 if(m){const i=Number(m[2])-1;if(i>=0&&i<12)return valid({year:Number(m[1]),month:i});}
 return null;
}
const valid=(c:CalendarMonth):CalendarMonth|null=>c.year>=2000&&c.year<=9999?c:null;
export const monthStartMs=(c:CalendarMonth)=>Date.UTC(c.year,c.month,1);
export const monthEndMs=(c:CalendarMonth)=>Date.UTC(c.year,c.month+1,1);
export const monthIndex=(c:CalendarMonth)=>c.year*12+c.month;
/** Page number whose three-month block holds the month, counted back from the current month. */
export function historyPageFor(target:CalendarMonth,now:number):number{
 const n=new Date(now),cur={year:n.getUTCFullYear(),month:n.getUTCMonth()};
 return Math.floor((monthIndex(cur)-monthIndex(target))/3)+1;
}
export interface HistIncident{name:string;impact:string;start:number;end:number}
type Group={name:string;year:number;incidents:{name?:unknown;impact?:unknown;timestamp?:unknown}[]};
/** "Nov 28, 06:27 - 07:01 UTC" or "Nov 28, 23:10 - Nov 29, 01:00 UTC", year from the listing month. */
export function parseHistoryTimestamp(ts:unknown,year:number):[number,number]|null{
 if(typeof ts!=='string')return null;
 const t=ts.replace(/<var data-var='(?:date|time)'>([^<]*)<\/var>/g,'$1').trim();
 const m=/^([A-Z][a-z]{2}) (\d{1,2}), (\d{2}):(\d{2}) - (?:([A-Z][a-z]{2}) (\d{1,2}), )?(\d{2}):(\d{2}) UTC$/.exec(t);
 if(!m)return null;
 const sm=ABBR.indexOf(m[1].toLowerCase()),em=m[5]?ABBR.indexOf(m[5].toLowerCase()):sm;
 if(sm<0||em<0)return null;
 const sd=Number(m[2]),ed=m[6]?Number(m[6]):sd;
 const sh=Number(m[3]),smin=Number(m[4]),eh=Number(m[7]),emin=Number(m[8]);
 if(sh>23||eh>23||smin>59||emin>59)return null;
 const mk=(y:number,mo:number,d:number,h:number,mi:number)=>{const x=new Date(Date.UTC(y,mo,d,h,mi));return x.getUTCMonth()===mo&&x.getUTCDate()===d?x.getTime():NaN;};
 const start=mk(year,sm,sd,sh,smin);
 const end=mk(em<sm?year+1:year,em,ed,eh,emin);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)return null;
 return [start,end];
}
export type PageResult={ok:true;groups:Group[]}|{ok:false;reason:string};
export function readHistoryPage(body:string,page:number,need:CalendarMonth[]):PageResult{
 let d:any;try{d=JSON.parse(body);}catch{return {ok:false,reason:'history page is not JSON'};}
 // Identity is the bound host the page was fetched from; page_status.page.url names the vendor site, not the status host.
 if(!Array.isArray(d?.months))return {ok:false,reason:'history page has no months list'};
 const groups:Group[]=[];
 for(const m of d.months){
  if(typeof m?.name!=='string'||!Number.isInteger(m?.year)||!Array.isArray(m?.incidents))return {ok:false,reason:'history month entry is malformed'};
  groups.push({name:m.name,year:m.year,incidents:m.incidents});
 }
 for(const c of need){
  const g=groups.find(x=>MONTHS.indexOf(x.name.toLowerCase())===c.month&&x.year===c.year);
  if(!g)return {ok:false,reason:`history page ${page} does not list ${MONTHS[c.month]} ${c.year}`};
 }
 const st=Date.parse(d.start_time),en=Date.parse(d.end_time);
 if(!Number.isFinite(st)||!Number.isFinite(en))return {ok:false,reason:'history page has no start_time/end_time'};
 for(const c of need)if(monthStartMs(c)<st||monthEndMs(c)-1000>en)return {ok:false,reason:'history page range does not cover the requested month'};
 return {ok:true,groups};
}
/** Major/critical incidents listed under the groups, as intervals. Refuses on any counted incident whose time cannot be parsed. */
export function countedIncidents(groups:Group[],months:CalendarMonth[]):{ok:true;incidents:HistIncident[];excluded:number}|{ok:false;reason:string}{
 const out:HistIncident[]=[];let excluded=0;
 for(const c of months){
  const g=groups.find(x=>MONTHS.indexOf(x.name.toLowerCase())===c.month&&x.year===c.year);
  if(!g)return {ok:false,reason:`${MONTHS[c.month]} ${c.year} is not listed`};
  for(const i of g.incidents){
   if(typeof i.impact!=='string')return {ok:false,reason:'an incident has no impact value'};
   if(i.impact!=='major'&&i.impact!=='critical'){excluded++;continue;}
   const iv=parseHistoryTimestamp(i.timestamp,c.year);
   if(!iv)return {ok:false,reason:'a major/critical incident has a time that cannot be parsed; no uptime computed'};
   out.push({name:String(i.name??''),impact:i.impact,start:iv[0],end:iv[1]});
  }
 }
 return {ok:true,incidents:out,excluded};
}
