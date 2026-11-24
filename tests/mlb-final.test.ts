import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {parseMlbFinal,observeMlbFinal,resetMlbBudgetForTests} from '../src/handlers/mlbFinal';
import {handleGameResult} from '../src/handlers/gameResult';
const raw=readFileSync('tests/fixtures/mlb-final/schedule-2026-10-24.json','utf8');
const date='2026-10-24',a='Brewers',b='Rays';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.clearAllMocks();resetMlbBudgetForTests();});
it('captured MLB official final has exact score, teams, winner and official date',()=>{
 expect(parseMlbFinal(raw,date,a,b)).toEqual({home:'Milwaukee Brewers',away:'Tampa Bay Rays',homeScore:5,awayScore:4,winner:'Milwaukee Brewers',id:849802});
});
it.each(['day','officialDay','state','code','detail','score','winner','tie','duplicate','missing','id'])('refuses mutated %s',mode=>{
 const j=JSON.parse(raw),g=j.dates[0].games[0];
 if(mode==='day')j.dates[0].date='2026-10-25';if(mode==='officialDay')g.officialDate='2026-10-25';if(mode==='state')g.status.abstractGameState='Live';if(mode==='code')g.status.codedGameState='I';if(mode==='detail')g.status.detailedState='Game Over';if(mode==='score')g.teams.home.score='5';if(mode==='winner')g.teams.away.isWinner=true;if(mode==='tie')g.isTie=true;if(mode==='duplicate')j.dates[0].games.push(g);if(mode==='missing')j.dates[0].games=[];if(mode==='id')g.gamePk=null;
 expect(()=>parseMlbFinal(JSON.stringify(j),date,a,b)).toThrow();
});
it('ESPN403 can use independent official MLB final and preserves exact raw evidence',async()=>{
 const f=vi.fn(async(u:unknown)=>String(u).startsWith('https://statsapi.mlb.com/')?new Response(raw):new Response('blocked',{status:403}));vi.stubGlobal('fetch',f);
 const out=await handleGameResult({game:'Brewers vs Rays 2026-10-24'});expect(out.home_score).toBe(5);expect(out.date).toBe(date);expect(out.date_semantics).toContain('officialDate');expect(out.source).toContain('MLB Stats API');expect(f).toHaveBeenCalledTimes(5);
 const evidence=JSON.parse(String(vi.mocked(saveReceipt).mock.calls[0][1]));expect(evidence.source_raw_body).toBe(raw);expect(evidence.scope).toContain('MLB only');expect(evidence).not.toHaveProperty('ESPN_scores');
});
it('all blocked sources retain original honest refusal, no receipt or retries',async()=>{
 const f=vi.fn(async()=>new Response('blocked',{status:403}));vi.stubGlobal('fetch',f);
 await expect(handleGameResult({game:'Brewers vs Rays 2026-10-24'})).rejects.toMatchObject({code:'ESPN_UNREACHABLE'});expect(f).toHaveBeenCalledTimes(5);expect(saveReceipt).not.toHaveBeenCalled();
});
it('MLB timeout rejects at1500ms even if fetch ignores abort and cannot save late',async()=>{
 vi.useFakeTimers();vi.stubGlobal('fetch',()=>new Promise(resolve=>setTimeout(()=>resolve(new Response(raw)),2000)));
 const p=expect(observeMlbFinal(date,a,b)).rejects.toThrow('deadline');await vi.advanceTimersByTimeAsync(1500);await p;await vi.advanceTimersByTimeAsync(2000);expect(saveReceipt).not.toHaveBeenCalled();
});
it('stalled body is covered by rejecting deadline',async()=>{
 vi.useFakeTimers();vi.stubGlobal('fetch',async()=>new Response(new ReadableStream({start(){}})));
 const p=expect(observeMlbFinal(date,a,b)).rejects.toThrow('deadline');await vi.advanceTimersByTimeAsync(1500);await p;expect(saveReceipt).not.toHaveBeenCalled();
});
it('start budget permits20calls, rejects21without a fetch',async()=>{
 const f=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',f);for(let i=0;i<20;i++)await observeMlbFinal(date,a,b);await expect(observeMlbFinal(date,a,b)).rejects.toThrow('budget');expect(f).toHaveBeenCalledTimes(20);
});
it('persistence failure never becomes a fallback answer or another provider attempt',async()=>{
 vi.mocked(saveReceipt).mockRejectedValueOnce(Error('disk'));
 vi.stubGlobal('fetch',async(u:unknown)=>String(u).startsWith('https://statsapi.mlb.com/')?new Response(raw):new Response('blocked',{status:403}));
 await expect(handleGameResult({game:'Brewers vs Rays 2026-10-24'})).rejects.toMatchObject({code:'RECEIPT_PERSIST_FAILED'});expect(saveReceipt).toHaveBeenCalledTimes(1);
});
it('slow ESPN time leaves only the remainder of original6second budget for fallback',async()=>{
 vi.useFakeTimers();const f=vi.fn((u:unknown)=>new Promise<Response>(resolve=>setTimeout(()=>resolve(String(u).startsWith('https://statsapi.mlb.com/')?new Response(raw):new Response('outage',{status:503})),String(u).startsWith('https://statsapi.mlb.com/')?1400:5000)));vi.stubGlobal('fetch',f);
 const p=expect(handleGameResult({game:'Brewers vs Rays 2026-10-24'})).rejects.toMatchObject({code:'ESPN_UNREACHABLE'});await vi.advanceTimersByTimeAsync(6000);await p;await vi.advanceTimersByTimeAsync(1000);expect(saveReceipt).not.toHaveBeenCalled();expect(f).toHaveBeenCalledTimes(5);
});
it('successful ESPN observation never starts independent fallback',async()=>{
 const nfl=readFileSync('tests/fixtures/game-result/espn-nfl-20261116.json','utf8');const f=vi.fn(async(u:unknown)=>new Response(String(u).includes('/nfl/')?nfl:'{"events":[]}'));vi.stubGlobal('fetch',f);
 await handleGameResult({game:'Chargers vs Ravens 2026-11-16'});expect(f).toHaveBeenCalledTimes(4);
});

it('statusCode is independently required even when every other final field agrees',()=>{
 const j=JSON.parse(raw);j.dates[0].games[0].status.statusCode='I';expect(()=>parseMlbFinal(JSON.stringify(j),date,a,b)).toThrow();
});
it.each([-1,1001])('out-of-range score %s refuses with internally consistent winner flags',score=>{
 const j=JSON.parse(raw),g=j.dates[0].games[0];g.teams.home.score=score;g.teams.home.isWinner=score>g.teams.away.score;g.teams.away.isWinner=score<g.teams.away.score;g.isTie=score===g.teams.away.score;
 expect(()=>parseMlbFinal(JSON.stringify(j),date,a,b)).toThrow();
});
it('abort-ignoring primary body reads terminate at6seconds and never start fallback or save late',async()=>{
 vi.useFakeTimers();const f=vi.fn(async()=>({ok:true,text:()=>new Promise(resolve=>setTimeout(()=>resolve(raw),7000))}));vi.stubGlobal('fetch',f);
 let settled=false;const p=handleGameResult({game:'Brewers vs Rays 2026-10-24'}).finally(()=>{settled=true;});const checked=expect(p).rejects.toMatchObject({code:'ESPN_UNREACHABLE'});
 await vi.advanceTimersByTimeAsync(5999);expect(settled).toBe(false);await vi.advanceTimersByTimeAsync(1);await checked;expect(f).toHaveBeenCalledTimes(4);await vi.advanceTimersByTimeAsync(2000);expect(saveReceipt).not.toHaveBeenCalled();
});
it('abort-ignoring primary header waits also terminate at6seconds',async()=>{
 vi.useFakeTimers();const f=vi.fn(()=>new Promise(()=>{}));vi.stubGlobal('fetch',f);
 const p=expect(handleGameResult({game:'Brewers vs Rays 2026-10-24'})).rejects.toMatchObject({code:'ESPN_UNREACHABLE'});await vi.advanceTimersByTimeAsync(6000);await p;expect(f).toHaveBeenCalledTimes(4);expect(saveReceipt).not.toHaveBeenCalled();
});

it('receipt contains neutral source scope and no private owner permission claim',async()=>{
 vi.stubGlobal('fetch',async()=>new Response(raw));await observeMlbFinal(date,a,b);const evidence=String(vi.mocked(saveReceipt).mock.calls[0][1]);expect(evidence).not.toMatch(/owner|waiver|terms_basis|2026-11-23/i);expect(JSON.parse(evidence).source_note).toBe('MLB Stats API official final; single-source observation, not cross-provider consensus');
});
