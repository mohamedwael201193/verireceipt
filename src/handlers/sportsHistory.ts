import teams from '../data/sportsHistoryTeams.json';
import {upstreamUnavailable} from '../core/errors';
export interface SportsPair {league:'MLB'|'NHL';a:number;b:number;club:string;names:string[]}
const normalized=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export function sportsPair(query:string):SportsPair|undefined{
 const q=' '+normalized(query)+' ';const hits:SportsPair[]=[];
 const spans:{start:number;end:number}[]=[];
 for(const league of ['MLB','NHL'] as const)for(const team of teams[league])for(const alias of team.aliases){const token=' '+normalized(alias)+' ';let start=q.indexOf(token);while(start>=0){spans.push({start,end:start+token.length-1});start=q.indexOf(token,start+1);}}
 const identities=spans.filter((x,i)=>!spans.some((y,j)=>(y.start<=x.start&&y.end>=x.end)&&(y.start<x.start||y.end>x.end||j<i)));
 if(identities.length!==2||(q.match(/\b(?:vs|versus|at)\b/g)||[]).length>1)return undefined;
 for(const league of ['MLB','NHL'] as const){const found=teams[league].filter(t=>t.aliases.some(a=>identities.some(x=>q.slice(x.start,x.end)===' '+normalized(a))));if(found.length===2)hits.push({league,a:found[0].id,b:found[1].id,club:'abbrev'in found[0]?String(found[0].abbrev):'',names:found.map(t=>t.name)});}
 return hits.length===1?hits[0]:undefined;
}
function realDate(s:unknown):s is string{return typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;}
export function parseSportsHistory(raw:string,pair:SportsPair,start:string,end:string){
 const data=JSON.parse(raw);if(!data||typeof data!=='object')throw Error('invalid schedule shape');
 if(pair.league==='MLB'&&(!Array.isArray(data.dates)||data.dates.some((d:any)=>!d||!Array.isArray(d.games))))throw Error('invalid schedule dates');
 const games=pair.league==='MLB'?data.dates.flatMap((d:any)=>d.games):data.games;if(!Array.isArray(games))throw Error('invalid schedule shape');
 return games.flatMap((g:any)=>{const home=pair.league==='MLB'?g?.teams?.home?.team:g?.homeTeam,away=pair.league==='MLB'?g?.teams?.away?.team:g?.awayTeam;const ids=[home?.id,away?.id];if(!g||!ids.every(Number.isSafeInteger)||ids[0]===ids[1])throw Error('invalid schedule teams');if(!(ids.includes(pair.a)&&ids.includes(pair.b)&&ids[0]!==ids[1]))return[];
 const date=pair.league==='MLB'?g.officialDate:g.gameDate;if(!realDate(date))throw Error('invalid candidate date');if(date<start||date>end)return[];
 if(pair.league==='MLB'&&(!g.status||typeof g.status.abstractGameState!=='string'||typeof g.status.detailedState!=='string'||typeof g.status.codedGameState!=='string'))throw Error('invalid candidate status');if(pair.league==='NHL'&&typeof g.gameState!=='string')throw Error('invalid candidate status');
 const homeName=pair.league==='MLB'?home.name:home.placeName?.default+' '+home.commonName?.default,awayName=pair.league==='MLB'?away.name:away.placeName?.default+' '+away.commonName?.default;if(typeof homeName!=='string'||typeof awayName!=='string'||!homeName||!awayName)throw Error('invalid candidate names');const registry=teams[pair.league];if(!registry.some(t=>t.id===home.id&&t.name===homeName)||!registry.some(t=>t.id===away.id&&t.name===awayName))throw Error('invalid candidate identity');
 const final=pair.league==='MLB'?g.status?.abstractGameState==='Final'&&g.status?.detailedState==='Final'&&g.status?.codedGameState==='F':['FINAL','OFF'].includes(g.gameState);if(!final)return[];
 const hs=pair.league==='MLB'?g?.teams?.home?.score:home.score,as=pair.league==='MLB'?g?.teams?.away?.score:away.score;if(!Number.isInteger(hs)||!Number.isInteger(as)||hs<0||as<0||hs>1000||as>1000||!Number.isSafeInteger(g.gamePk??g.id))throw Error('invalid final candidate score');

 return[{league:pair.league,home_team:homeName,away_team:awayName,home_score:hs,away_score:as,status:'Final',date,game_id:g.gamePk??g.id,start_time:(pair.league==='MLB'?g.gameDate:g.startTimeUTC)??date}];}).sort((a:any,b:any)=>b.date.localeCompare(a.date)||String(b.start_time).localeCompare(String(a.start_time))||b.game_id-a.game_id)[0];
}
async function fetchSchedule(url:string){const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;const io=(async()=>{const r=await fetch(url,{signal:controller.signal,redirect:'error',headers:{accept:'application/json'}});if(!r.ok||!r.body)throw Error('schedule transport');const reader=r.body.getReader();let size=0;const parts:Uint8Array[]=[];try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>4000000){void reader.cancel().catch(()=>{});throw Error('schedule size');}parts.push(p.value);}}finally{reader.releaseLock();}return Buffer.concat(parts).toString('utf8');})();try{return await Promise.race([io,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('schedule deadline'));},3000);})]);}finally{clearTimeout(timer);controller.abort();}}
export async function sportsHistory(pair:SportsPair,today:Date){const days=pair.league==='MLB'?200:60,end=today.toISOString().slice(0,10),start=new Date(Date.parse(end+'T00:00:00Z')-(days-1)*86400000).toISOString().slice(0,10);const season=(d:string)=>{const y=Number(d.slice(0,4))-(Number(d.slice(5,7))<7?1:0);return String(y)+String(y+1);};
 const urls=pair.league==='MLB'?[`https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${pair.a}&startDate=${start}&endDate=${end}&hydrate=linescore`]:[...new Set([season(start),season(end)])].map(s=>`https://api-web.nhle.com/v1/club-schedule-season/${pair.club}/${s}`);
 let bodies:string[];try{bodies=await Promise.all(urls.map(fetchSchedule));}catch{throw upstreamUnavailable('SPORTS_HISTORY_UNAVAILABLE','official bounded pair schedule unavailable; no score guessed');}
 let candidates;try{candidates=bodies.map(raw=>parseSportsHistory(raw,pair,start,end)).filter(Boolean).sort((a,b)=>b.date.localeCompare(a.date)||String(b.start_time).localeCompare(String(a.start_time))||b.game_id-a.game_id);}catch{throw upstreamUnavailable('SPORTS_HISTORY_UNAVAILABLE','official bounded pair schedule invalid; no score guessed');}return{match:candidates[0],bodies,urls,start,end,days};
}
