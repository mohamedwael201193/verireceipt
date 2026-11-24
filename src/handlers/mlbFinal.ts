import {readPublicBody,StartBudget} from '../core/publicSource';
import {envelope,makeReceipt} from '../core/receipt';
import {saveReceipt} from '../core/storage';
import {upstreamUnavailable} from '../core/errors';
import {teamNameMatches} from './gameTeams';
const persistenceFailures=new WeakSet<object>();
export function isMlbPersistenceFailure(error:unknown):boolean {return error!==null&&typeof error==='object'&&persistenceFailures.has(error);}
let starts=new StartBudget(20,60000);
export function resetMlbBudgetForTests():void {starts=new StartBudget(20,60000);}
interface Final {home:string;away:string;homeScore:number;awayScore:number;winner:string;id:number}
export function parseMlbFinal(raw:string,date:string,teamA:string,teamB:string):Final {
 const j=JSON.parse(raw);
 if(!Array.isArray(j?.dates)||j.dates.some((d:any)=>d?.date!==date||!Array.isArray(d.games)))throw Error('wrong schedule date');
 const matches=j.dates.flatMap((d:any)=>d.games).filter((g:any)=>{
  const home=g?.teams?.home?.team?.name,away=g?.teams?.away?.team?.name;
  return typeof home==='string'&&typeof away==='string'&&((teamNameMatches(teamA,home)&&teamNameMatches(teamB,away))||(teamNameMatches(teamA,away)&&teamNameMatches(teamB,home)));
 });
 // Includes non-final matches so doubleheaders are never guessed by finality.
 if(matches.length!==1)throw Error('missing or ambiguous game');
 const g=matches[0],h=g.teams.home,a=g.teams.away;
 if(g.officialDate!==date||g.status?.abstractGameState!=='Final'||g.status?.codedGameState!=='F'||g.status?.statusCode!=='F'||g.status?.detailedState!=='Final')throw Error('game not official final');
 if(!Number.isSafeInteger(g.gamePk)||g.gamePk<=0||![h.score,a.score].every(v=>typeof v==='number'&&Number.isInteger(v)&&v>=0&&v<=1000))throw Error('invalid game score or id');
 const tie=h.score===a.score;
 if(typeof g.isTie!=='boolean'||g.isTie!==tie||typeof h.isWinner!=='boolean'||typeof a.isWinner!=='boolean'||h.isWinner!==(h.score>a.score)||a.isWinner!==(a.score>h.score))throw Error('winner flags disagree with scores');
 return {home:h.team.name,away:a.team.name,homeScore:h.score,awayScore:a.score,winner:tie?'':h.isWinner?h.team.name:a.team.name,id:g.gamePk};
}
/** Independent provider fallback, never another route to a blocked provider. */
export async function observeMlbFinal(date:string,teamA:string,teamB:string,timeoutMs=1500):Promise<Record<string,unknown>> {
 if(!/^20\d{2}-\d{2}-\d{2}$/.test(date)||!starts.take())throw Error('MLB start budget or date');
 const url=`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`;
 const deadline=Math.min(1500,timeoutMs);let timer:ReturnType<typeof setTimeout>|undefined;
 let body;
 try{body=await Promise.race([readPublicBody(url,250000,deadline),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('MLB deadline')),deadline);})]);}finally{clearTimeout(timer);}
 const g=parseMlbFinal(body.raw,date,teamA,teamB);
 const evidence=JSON.stringify({provider:'MLB Stats API',source_url:url,source_raw_body:body.raw,official_date:date,matched_game:g,fetched_at:body.fetchedAt,scope:'MLB only; official final status; single source, not cross-provider consensus',terms_basis:'Owner standing terms-risk waiver dated 2026-11-23 for this testnet project only; not a provider licence'});
 const receipt=makeReceipt('GAME_RESULT_GENERAL',url,evidence,'MLB Stats API single source; official final only');receipt.fetched_at=body.fetchedAt;
 try{await saveReceipt(receipt,evidence);}catch{const error=upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');persistenceFailures.add(error);throw error;}
 return envelope('GAME_RESULT_GENERAL',{winner:g.winner,home_team:g.home,away_team:g.away,home_score:g.homeScore,away_score:g.awayScore,date,requested_scoreboard_date:date,date_semantics:'MLB officialDate, not UTC start date',league:'MLB'},receipt,{answer:`${g.away} ${g.awayScore}, ${g.home} ${g.homeScore}, ${date}: official final. ${g.winner?g.winner+' won.':'Tie, no winner.'} Source: MLB Stats API, single source. MLB-only independent fallback; ESPN unavailable. Date is MLB officialDate.`,verdict:'verified',confidence:.9,source:`${url}; MLB Stats API; official final only; fetched ${body.fetchedAt}`});
}
