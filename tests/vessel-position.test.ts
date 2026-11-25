import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {parseBarentswatchPosition as parse} from '../src/handlers/vesselPosition';
const raw=readFileSync(new URL('./fixtures/vessel-ais/barentswatch-position-20261125.json',import.meta.url),'utf8');
const vessel='257635500',now=Date.parse('2026-11-25T01:45:00Z');
function changed(fn:(e:any)=>void){const e=JSON.parse(raw);fn(e);return JSON.stringify(e);}
describe('bounded AIS position event parser, controls are not live data',()=>{
 it('replays real source event, including a real zero speed and synthesized disclosure',()=>{
  const r=parse(raw,vessel,now);expect(r).toMatchObject({vessel,speed_knots:0,latitude:59.590720000000005,longitude:5.154825,course_deg:203.8,observed_at:'2026-11-25T01:44:57.8644366Z',source:'barentswatch',license:'NLOD-2.0',synthesized:true});
  expect(r.attribution).toContain('Data delivered by BarentsWatch.');expect(r.scope).toContain('not independently authenticated');
 });
 it('extracts changed supported numeric values instead of hardcoding',()=>{
  const r=parse(changed(e=>{e.message.Sog=7.4;e.message.Cog=90;e.message.Latitude=e.lat=59.5;e.message.Longitude=e.lon=5.1;}),vessel,now);
  expect([r.speed_knots,r.course_deg,r.latitude,r.longitude]).toEqual([7.4,90,59.5,5.1]);
 });
 for(const value of ['ROSE EKSPRESS','9710414','IMO9710414','257635500?x=1',' 257635500','002573104','992576072'])it('refuses unsupported identity '+value,()=>{expect(()=>parse(raw,value,now)).toThrow();});
 const controls:[string,(e:any)=>void][]=[
  ['envelope identity',e=>e.mmsi=257635501],['decoded identity',e=>e.message.UserID=257635501],
  ['static message',e=>e.msg_type='StaticDataReport'],['decoded message type',e=>e.message.MessageID=24],
  ['invalid decoded packet',e=>e.message.Valid=false],['source identity',e=>e.source='udp:other'],
  ['cached coordinates dissent',e=>e.lat=59],['missing latitude',e=>delete e.message.Latitude],
  ['missing speed never zero',e=>delete e.message.Sog],['string speed',e=>e.message.Sog='0'],
  ['speed sentinel',e=>e.message.Sog=102.3],['negative speed',e=>e.message.Sog=-1],
  ['negative course',e=>e.message.Cog=-0.1],['course sentinel',e=>e.message.Cog=360],['latitude sentinel',e=>e.message.Latitude=e.lat=91],
  ['longitude sentinel',e=>e.message.Longitude=e.lon=181],['default null island',e=>{e.message.Latitude=e.lat=0;e.message.Longitude=e.lon=0;}],
  ['missing time',e=>delete e.time],['malformed time',e=>e.time='2026-11-25'],
  ['invalid calendar date',e=>e.time='2026-11-31T01:44:57Z'],['future event',e=>e.time='2026-11-25T01:45:01Z'],
  ['stale event',e=>e.time='2026-11-25T01:39:59Z'],['missing synthesis disclosure',e=>delete e.synthesized],
  ['BarentsWatch credit phrase drift',e=>e.attribution=e.attribution.replace('Data delivered by BarentsWatch.','Data supplied without named provider.')],['missing credit',e=>delete e.attribution],['missing licence',e=>delete e.license],
  ['changed licence',e=>e.license='unverified'],['GeoJSON snapshot',e=>e.type='Feature'],
 ];
 for(const[name,fn]of controls)it('refuses '+name,()=>expect(()=>parse(changed(fn),vessel,now)).toThrow());
 it('refuses invalid calendar day even when normalized date would be fresh',()=>expect(()=>parse(changed(e=>e.time='2026-11-31T01:44:57Z'),vessel,Date.parse('2026-12-01T01:45:00Z'))).toThrow());
 it('accepts exactly five minutes but not a millisecond older',()=>{const t=Date.parse(JSON.parse(raw).time);expect(()=>parse(raw,vessel,t+300000)).not.toThrow();expect(()=>parse(raw,vessel,t+300001)).toThrow();});
 it('refuses otherwise-valid oversized event with irrelevant padding',()=>{const oversized=changed(e=>e.padding='x'.repeat(32768));expect(()=>parse(oversized,vessel,now)).toThrow();});
 it('refuses nonfinite clock and oversized body',()=>{expect(()=>parse(raw,vessel,NaN)).toThrow();expect(()=>parse(' '.repeat(32769),vessel,now)).toThrow();});
});
