import {afterEach,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';import {join} from 'node:path';
import {selectFootball,footballLookup,FOOTBALL_LEAGUES} from '../src/handlers/footballScores';
const raws=FOOTBALL_LEAGUES.map(l=>readFileSync(join(__dirname,`fixtures/sports-football/${l}.json`),'utf8'));
afterEach(()=>vi.unstubAllGlobals());
it('uses actual latest completed Arsenal Chelsea fixture without reversing home/away',()=>{
 const r=selectFootball(raws,'Arsenal vs Chelsea','2026-11-23');expect(r).toMatchObject({home_team:'Arsenal FC',away_team:'Chelsea FC',home_score:2,away_score:1,status:'final',date:'2026-09-06'});
 expect(selectFootball(raws,'Chelsea vs Arsenal','2026-11-23')).toEqual(r);
});
it('requires both complete normalized team names, never a matching single token or one team',()=>{
 expect(selectFootball(raws,'Arsenal vs unknown','2026-11-23')).toBeNull();expect(selectFootball(raws,'Manchester vs Chelsea','2026-11-23')).toBeNull();expect(selectFootball(raws,'Lakers vs Celtics','2026-11-23')).toBeNull();
});
it('next scheduled fixture has null scores, never invented zero, from actual source',()=>{
 const rows=JSON.parse(raws[0]).matches;const future=rows.find((m:any)=>!m.score?.ft&&m.date>='2026-11-23');
 // Move clock to before the first fixture for this pair so only a scheduled snapshot row can win.
 const r=selectFootball(raws,`${future.team1} vs ${future.team2}`,'2026-01-01');
 expect(r).not.toBeNull();expect(r!.home_score).toBeNull();expect(r!.away_score).toBeNull();expect(r!.status).toBe('scheduled')
});
it('uses five verified season paths and preserves every raw body',async()=>{
 let i=0;const f=vi.fn(async()=>new Response(raws[i++]));vi.stubGlobal('fetch',f);
 const r=await footballLookup('Arsenal vs Chelsea',new Date('2026-11-23T12:00:00Z'));expect(f).toHaveBeenCalledTimes(5);expect(r.urls.every(u=>u.includes('/2026-27/'))).toBe(true);expect(r.bodies).toEqual(raws);
});
