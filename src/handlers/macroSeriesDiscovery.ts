import {createHash} from 'node:crypto';
import {logMacroStage,macroFetchClass} from '../core/macroStageLog';
import {readMacroText} from './macroSourceCache';
import {upstreamUnavailable} from '../core/errors';

// A fixed vocabulary is diagnostic context, never verbatim request text.
const TERMS = new Set('unemployment employment jobless inflation cpi gdp growth population trade exports imports current account interest lending deposit policy rate youth female male national labor labour force participation debt government central general exchange reserves investment foreign direct fdi income gni savings consumption production manufacturing pmi retail sales money m1 m2 m3 broad narrow deflator expectations wages productivity poverty fiscal budget balance deficit surplus real nominal capita hour annual monthly quarterly percent percentage total services goods'.split(' '));
export function macroInputDiagnostic(input:string) {
  const words=input.toLowerCase().match(/[a-z]+/g)??[];
  return {indicator_terms:[...new Set(words.filter(word=>TERMS.has(word)))].sort().slice(0,12),
    indicator_sha256:createHash('sha256').update(input).digest('hex'),indicator_length:Math.min(input.length,10000)};
}
export function isMacroRequest(input:string):boolean {
  return input.length<=240 && !/[\u0000-\u001f\u007f]/.test(input) &&
    (macroInputDiagnostic(input).indicator_terms.length>0 || /^[A-Z][A-Z0-9]*(?:\.[A-Z0-9]+){2,7}$/i.test(input.trim()));
}
const URL='https://api.worldbank.org/v2/indicator?source=2&format=json&per_page=20000';
let cache:{raw:string;fetchedAt:string}|undefined;
export function resetMacroDiscoveryForTests(){cache=undefined;}
const key=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export async function discoverMacroSeries(input:string,deadline:number) {
  let raw:string,fetchedAt:string;
  if(cache && Date.now()-Date.parse(cache.fetchedAt)>=0 && Date.now()-Date.parse(cache.fetchedAt)<3600000){({raw,fetchedAt}=cache);}
  else {
    try{raw=await readMacroText(URL,deadline);}catch(fetchError){logMacroStage('discovery_fetch',macroFetchClass(fetchError));throw upstreamUnavailable('WORLD_BANK_UNAVAILABLE','World Bank indicator catalog is unreachable');}
    fetchedAt=new Date().toISOString();
  }
  let parsed:unknown;try{parsed=JSON.parse(raw);}catch{logMacroStage('discovery_parse','parse');throw upstreamUnavailable('WORLD_BANK_UNAVAILABLE','Invalid indicator catalog JSON');}
  if(!Array.isArray(parsed)||!parsed[0]||!Array.isArray(parsed[1])||Number(parsed[0].pages)!==1||Number(parsed[0].total)!==parsed[1].length||!parsed[1].length)
    {logMacroStage('discovery_parse','none');throw upstreamUnavailable('WORLD_BANK_UNAVAILABLE','Incomplete or malformed indicator catalog');}
  const rows=parsed[1] as Array<{id?:unknown;name?:unknown;unit?:unknown;source?:{id?:unknown}}>;
  if(rows.some(row=>typeof row?.id!=='string'||!/^[A-Z0-9][A-Z0-9_.]{0,100}$/i.test(row.id)||typeof row.name!=='string'||row.name.length>500||String(row.source?.id)!=='2'))
    {logMacroStage('discovery_parse','none');throw upstreamUnavailable('WORLD_BANK_UNAVAILABLE','Unbound WDI indicator metadata');}
  cache={raw,fetchedAt};
  const matches=rows.filter(row=>key(String(row.id))===key(input)||key(String(row.name))===key(input));
  const row=matches.length===1?matches[0]:undefined;
  // Labels contain authoritative units even where WB's separate unit is empty.
  const series=row?{id:String(row.id),name:String(row.name),unit:typeof row.unit==='string'&&row.unit?row.unit:String(row.name)}:undefined;
  return {series,raw,fetchedAt,url:URL};
}
