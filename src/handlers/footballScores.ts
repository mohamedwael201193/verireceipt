import {readPublicBody} from "../core/publicSource";
// Openfootball football.json, CC0 public-domain fixture snapshots, not a live score feed.
export const FOOTBALL_LEAGUES = ['en.1','es.1','de.1','it.1','fr.1'] as const;
export interface FootballMatch {league:string;date:string;home_team:string;away_team:string;home_score:number|null;away_score:number|null;status:string}
interface Row {date?:string;team1?:string;team2?:string;score?:{ft?:unknown}}
const norm=(s:string)=>s.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\b(fc|cf|afc|sc)\b/g,'').replace(/[^a-z0-9]+/g,' ').trim();
function named(query:string,team:string):boolean {const q=' '+norm(query)+' ';const t=norm(team);return !!t && q.includes(' '+t+' ')}
export function selectFootball(raws:string[],query:string,today:string,requestedDate?:string):FootballMatch|null {
 const matches:FootballMatch[]=[];
 for(const raw of raws){const j=JSON.parse(raw);if(!Array.isArray(j.matches))throw new Error('invalid football dataset');
 for(const m of j.matches as Row[]){if(!m.team1||!m.team2||!m.date||!/^\d{4}-\d{2}-\d{2}$/.test(m.date))continue;
 if(!named(query,m.team1)||!named(query,m.team2)||requestedDate&&m.date!==requestedDate)continue;
 const ft=m.score?.ft;const final=Array.isArray(ft)&&ft.length===2&&ft.every(x=>Number.isInteger(x)&&x>=0&&x<=100);
 if(final&&m.date>today)continue;
 matches.push({league:String(j.name),date:m.date,home_team:m.team1,away_team:m.team2,home_score:final?ft[0]:null,away_score:final?ft[1]:null,status:final?'final':'scheduled'});
 }}
 const identities=new Set(matches.map(m=>[norm(m.home_team),norm(m.away_team)].sort().join('|')));
 if(identities.size>1)throw new Error('ambiguous football teams');
 const finals=matches.filter(m=>m.status==='final').sort((a,b)=>b.date.localeCompare(a.date));
 return finals[0]??matches.filter(m=>m.status==='scheduled'&&m.date>=today).sort((a,b)=>a.date.localeCompare(b.date))[0]??null;
}
export async function footballLookup(query:string,now:Date,requestedDate?:string):Promise<{match:FootballMatch|null;bodies:string[];urls:string[]}> {
 const anchor=requestedDate?new Date(requestedDate+"T00:00:00Z"):now;
 const year=anchor.getUTCMonth()>=6?anchor.getUTCFullYear():anchor.getUTCFullYear()-1;
 const season=`${year}-${String(year+1).slice(-2)}`;
 const urls=FOOTBALL_LEAGUES.map(l=>`https://raw.githubusercontent.com/openfootball/football.json/master/${season}/${l}.json`);
 const bodies=await Promise.all(urls.map(async url=>(await readPublicBody(url,1500000,3000)).raw));
 let match=selectFootball(bodies,query,now.toISOString().slice(0,10),requestedDate);
 // A current-season future pairing must not hide the last completed meeting.
 // Search one prior season only; this is bounded snapshot coverage, not all history.
 if(!requestedDate&&(!match||match.status!=='final')){
  const previous=`${year-1}-${String(year).slice(-2)}`;
  const priorUrls=FOOTBALL_LEAGUES.map(l=>`https://raw.githubusercontent.com/openfootball/football.json/master/${previous}/${l}.json`);
  const priorBodies=await Promise.all(priorUrls.map(async url=>(await readPublicBody(url,1500000,3000)).raw));
  urls.push(...priorUrls);bodies.push(...priorBodies);match=selectFootball(bodies,query,now.toISOString().slice(0,10));
 }
 return {match,bodies,urls};
}
