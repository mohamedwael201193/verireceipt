import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {parseBostonBuoySensor as parse,NDBC_STATION_CACHE_MS,NDBC_MAX_OBSERVATION_AGE_MS} from '../src/handlers/buoySensor';
const raw=readFileSync(new URL('./fixtures/ndbc/44013-20261125.txt',import.meta.url),'utf8');
const metadataHtml=readFileSync(new URL('./fixtures/ndbc/44013-metadata.html',import.meta.url),'utf8');
const base={sensor:'NDBC:44013',metric:'water_temperature',sourceUrl:'https://www.ndbc.noaa.gov/data/realtime2/44013.txt',metadataUrl:'https://www.ndbc.noaa.gov/station_page.php?station=44013',raw,metadataHtml,nowMs:Date.parse('2026-11-25T01:55:00Z')};
function row(index:number,value:string){const lines=raw.trim().split('\n');const cells=lines[2].trim().split(/\s+/);cells[index]=value;lines[2]=cells.join(' ');return lines.join('\n');}
it('real captured Boston temperature is timestamp-bound, metric/units/QC disclosed',()=>{
 const r=parse(base);expect(r).toMatchObject({sensor:'NDBC:44013',metric:'water_temperature',value:11.4,unit:'degC',observed_at:'2026-11-25T01:00:00.000Z'});expect(r.quality).toContain('automated gross-error checks only');expect(r.scope).toContain('not arbitrary sensor telemetry');expect(parse({...base,metric:'air_temperature'}).value).toBe(5.5);
});
it('numeric extraction control is synthetic, not hardcoded source data',()=>{expect(parse({...base,raw:row(14,'12.7')}).value).toBe(12.7);expect(parse({...base,raw:row(14,'0')}).value).toBe(0);});
for(const[field,value]of [['sensor','44013'],['sensor','NDBC:44014'],['metric','temperature'],['metric','wind_speed'],['sourceUrl','https://www.ndbc.noaa.gov/data/realtime2/44014.txt'],['metadataUrl','https://www.ndbc.noaa.gov/station_page.php?station=44014']]as const)it('refuses unsupported '+field+' '+value,()=>expect(()=>parse({...base,[field]:value})).toThrow());
for(const phrase of ['<title>NDBC - Station 44013 Recent Data</title>','<link rel="canonical" href="https://www.ndbc.noaa.gov/station_page.php?station=44013">','BOSTON 16 NM East of Boston, MA','42.346 N 70.651 W','Owned and maintained by National Data Buoy Center'])it('refuses isolated metadata binding drift '+phrase.slice(0,20),()=>expect(()=>parse({...base,metadataHtml:metadataHtml.replaceAll(phrase,'changed')})).toThrow());
for(const value of ['MM','NaN','Infinity','11.4junk','61','-51'])it('refuses latest-row water temperature '+value+' without older-row substitution',()=>expect(()=>parse({...base,raw:row(14,value)})).toThrow());
it('missing air temperature refuses independently of present water value',()=>expect(()=>parse({...base,metric:'air_temperature',raw:row(13,'MM')})).toThrow());
it('units/header drift refuses',()=>{expect(()=>parse({...base,raw:raw.replace('degC','degF')})).toThrow();expect(()=>parse({...base,raw:raw.replace('WTMP','OTMP')})).toThrow();});
it('newest MM refuses even while next row has valid temperature',()=>{expect(()=>parse({...base,raw:row(14,'MM')})).toThrow();});
it('timestamps are descending with no duplicate newest report',()=>{const l=raw.trim().split('\n');l.splice(3,0,l[2]);expect(()=>parse({...base,raw:l.join('\n')})).toThrow();const a=raw.trim().split('\n');[a[2],a[3]]=[a[3],a[2]];expect(()=>parse({...base,raw:a.join('\n')})).toThrow();});
it('invalid calendar time is refused independently of freshness',()=>{let r=row(2,'31').split('\n').slice(0,3).join('\n');expect(()=>parse({...base,raw:r,nowMs:Date.parse('2026-12-01T01:05:00Z')})).toThrow();});
it('future or stale observation refuses, exact90min bound passes',()=>{const t=Date.parse('2026-11-25T01:00:00Z');expect(()=>parse({...base,nowMs:t-1})).toThrow();expect(()=>parse({...base,nowMs:t+5400000})).not.toThrow();expect(()=>parse({...base,nowMs:t+5400001})).toThrow();});
it('malformed and oversized otherwise-valid payloads refuse',()=>{expect(()=>parse({...base,raw:raw+' '.repeat(1000001)})).toThrow();expect(()=>parse({...base,metadataHtml:metadataHtml+' '.repeat(250001)})).toThrow();expect(()=>parse({...base,raw:raw.replace('2026 11 25 01 00','2026 11 25 01')})).toThrow();});
it('scope constants require hourly future source caching and90minute observation age',()=>{expect(NDBC_STATION_CACHE_MS).toBe(3600000);expect(NDBC_MAX_OBSERVATION_AGE_MS).toBe(5400000);});

it('row width guard refuses extra irrelevant cell with every binding still valid',()=>{const lines=raw.trim().split('\n');lines[2]+=' extra';expect(()=>parse({...base,raw:lines.join('\n')})).toThrow();});

it('NaN and infinite clocks refuse independently of observation freshness',()=>{for(const nowMs of [NaN,Infinity,-Infinity])expect(()=>parse({...base,nowMs})).toThrow();});
it('otherwise-valid strictly descending rows above count limit refuse',()=>{
 const h=raw.trim().split('\n').slice(0,2),template=raw.trim().split('\n')[2].trim().split(/\s+/);const rows=Array.from({length:12001},(_,i)=>{const d=new Date(Date.parse('2026-11-25T01:00:00Z')-i*60000);return [...d.toISOString().slice(0,16).replace(/[-T:]/g,' ').split(' '),...Array.from({length:14},()=> '0')].join(' ');});
 const oversized=[...h,...rows].join('\n');expect(Buffer.byteLength(oversized)).toBeLessThan(1000000);expect(()=>parse({...base,raw:oversized})).toThrow();
});
