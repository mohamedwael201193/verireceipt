import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {selectGridEvictions} from '../src/core/db';
import {gridCacheEvictionPriority,GRID_EVICT_REFERENCE,GRID_REFERENCE_INTERVAL} from '../src/jobs/gridFinality';

describe('overflow eviction CPU bound',()=>{
 it('keeps exact ordering, invalid removal and node-specific reference protection',()=>{
  const now=Date.parse('2026-11-22T20:52:54Z');
  const rows=[
   {node_or_zone:'TH_NP15_GEN-APND',interval_start:GRID_REFERENCE_INTERVAL,market:'CAISO'},
   {node_or_zone:'other',interval_start:GRID_REFERENCE_INTERVAL,market:'CAISO'},
   {node_or_zone:'EE',interval_start:'2026-11-21T00:00:00.000Z',market:'Elering EE'},
   {node_or_zone:'ZONE_A',interval_start:'2026-11-21T00:00:00.000Z',market:'NYISO'},
   {node_or_zone:'ZONE_B',interval_start:'2026-11-21T00:00:00.000Z',market:'NYISO'},
   {node_or_zone:'bad',interval_start:'not-a-date',market:'NYISO'},
   {node_or_zone:'old',interval_start:'2026-01-01T00:00:00.000Z',market:'unknown'},
  ];
  const rank=(r:typeof rows[number])=>gridCacheEvictionPriority(r.node_or_zone,r.interval_start,r.market,now);
  for(const cap of [0,3,100]){
   const sorted=[...rows].sort((a,b)=>rank(a)-rank(b)||(a.interval_start<b.interval_start?-1:a.interval_start>b.interval_start?1:0)||(a.node_or_zone<b.node_or_zone?-1:a.node_or_zone>b.node_or_zone?1:0));let left=rows.length;const expected=[];
   for(const r of sorted){const p=rank(r);if(p>=GRID_EVICT_REFERENCE)continue;if(left<=cap&&p>0)continue;expected.push({node_or_zone:r.node_or_zone,interval_start:r.interval_start});left--;}
   const original=structuredClone(rows);expect(selectGridEvictions(rows,rows.length,cap,now)).toEqual(expected);expect(rows).toEqual(original);
  }
 });
 it('finishes a real-cap-sized table without a health-check-length CPU stall',()=>{
  // Run in a child with an OS deadline: a broken synchronous sort cannot hide
  // behind Vitest timers, which cannot interrupt a blocked event loop.
  const source=resolve('src/core/db.ts');
  const code=`import {selectGridEvictions} from ${JSON.stringify(source)};import {performance} from 'node:perf_hooks';const now=Date.parse('2026-11-22T20:52:54Z');const rows=Array.from({length:25001},(_,i)=>({node_or_zone:'ZONE_'+(i%22),interval_start:new Date(now-(Math.floor(i/22)+1)*300000).toISOString(),market:'NYISO'}));const start=performance.now();const victims=selectGridEvictions(rows,rows.length,25000,now);console.log(JSON.stringify({elapsed:performance.now()-start,count:victims.length}));`;
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),timeout:2500,encoding:'utf8'});
  expect(child.error?.message??'',child.stderr).toBe('');expect(child.status,child.stderr).toBe(0);const result=JSON.parse(child.stdout.trim().split('\n').at(-1)!);expect(result.count).toBe(1);expect(result.elapsed).toBeLessThan(1500);
 },5000);
});
