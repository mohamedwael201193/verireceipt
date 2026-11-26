import {readPublicBody} from "../core/publicSource";
// SPORTS_SCORE_GENERAL — GET /v1/sports-score?game=<free text>
//
// Zero-LLM. Answers "what is/was the score of this game?" with a
// SHA-256 receipt over the exact upstream bodies.
//
// Intent contract (read 2026-11-23): request game (free-text string);
// scored home_score (number); response home_team, away_team,
// home_score, away_score, status, date.
//
// NHL and MLB official today/yesterday scoreboards, plus major football
// current-season openfootball CC0 snapshot fallback. Football picks most recent
// final between both complete named teams, else next scheduled fixture.
// Unknown coverage is a disclosed200 null-score result, never a made-up zero.
// ESPN remains excluded after403; no alternate route to blocked sources.
import { footballLookup } from "./footballScores";
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

const SOURCE_TIMEOUT_MS = 10000;
const UA = "VeriReceipt/2.0 sports-score observer (+https://verireceipt.vercel.app)";

export const INTENT = "SPORTS_SCORE_GENERAL";

interface Candidate {
  league: "NHL" | "MLB";
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  status: string;
  date: string;
  tokens: string[]; // lowercased match tokens for both teams
}

async function fetchJson(url: string, code: string): Promise<{ body: string; parsed: unknown }> {
  let timer:ReturnType<typeof setTimeout>;
  try{
   const body=await Promise.race([readPublicBody(url,1500000,3000,UA).then(r=>r.raw),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('scoreboard deadline')),3100);})]);
   return {body,parsed:JSON.parse(body)};
  }catch{throw upstreamUnavailable(code,'official scoreboard unavailable or invalid; no score asserted');}finally{clearTimeout(timer!);}
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface NhlTeam { name?: { default?: string }; abbrev?: string; score?: number }
interface NhlGame { gameState?: string; gameDate?: string; startTimeUTC?: string; homeTeam?: NhlTeam; awayTeam?: NhlTeam }
async function nhlCandidates(dates: string[]): Promise<{ candidates: Candidate[]; bodies: string[] }> {
  const candidates: Candidate[] = [];
  const bodies: string[] = [];
  for (const date of dates) {
    const url = `https://api-web.nhle.com/v1/score/${date}`;
    const { body, parsed } = await fetchJson(url, "NHL_SCOREBOARD_UNAVAILABLE");
    bodies.push(body);
    const games = (parsed as { games?: NhlGame[] }).games;
    if (!Array.isArray(games)) continue;
    for (const g of games) {
      const home = g.homeTeam?.name?.default;
      const away = g.awayTeam?.name?.default;
      if (!home || !away) continue;
      candidates.push({
        league: "NHL",
        home_team: home, away_team: away,
        home_score: typeof g.homeTeam?.score === "number" ? g.homeTeam.score : null,
        away_score: typeof g.awayTeam?.score === "number" ? g.awayTeam.score : null,
        status: g.gameState ?? "unknown",
        date: (g.gameDate ?? g.startTimeUTC ?? date).slice(0, 10),
        tokens: [home, away, g.homeTeam?.abbrev ?? "", g.awayTeam?.abbrev ?? ""].filter(Boolean).map((t) => t.toLowerCase()),
      });
    }
  }
  return { candidates, bodies };
}

interface MlbTeam { team?: { name?: string } }
interface MlbGame {
  gameDate?: string;
  officialDate?: string;
  status?: { detailedState?: string };
  teams?: { home?: MlbTeam; away?: MlbTeam };
  linescore?: { teams?: { home?: { runs?: number }; away?: { runs?: number } } };
}
async function mlbCandidates(dates: string[]): Promise<{ candidates: Candidate[]; bodies: string[] }> {
  const candidates: Candidate[] = [];
  const bodies: string[] = [];
  for (const date of dates) {
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore`;
    const { body, parsed } = await fetchJson(url, "MLB_SCOREBOARD_UNAVAILABLE");
    bodies.push(body);
    const days = (parsed as { dates?: { games?: MlbGame[] }[] }).dates;
    if (!Array.isArray(days)) continue;
    for (const day of days) {
      for (const g of day.games ?? []) {
        const home = g.teams?.home?.team?.name;
        const away = g.teams?.away?.team?.name;
        if (!home || !away) continue;
        candidates.push({
          league: "MLB",
          home_team: home, away_team: away,
          home_score: typeof g.linescore?.teams?.home?.runs === "number" ? g.linescore.teams.home.runs : null,
          away_score: typeof g.linescore?.teams?.away?.runs === "number" ? g.linescore.teams.away.runs : null,
          status: g.status?.detailedState ?? "unknown",
          date: (g.officialDate ?? g.gameDate ?? date).slice(0, 10),
          tokens: [...home.toLowerCase().split(/\s+/), ...away.toLowerCase().split(/\s+/)],
        });
      }
    }
  }
  return { candidates, bodies };
}

function teamIdentities(team:string,abbrev?:string):string[]{
 const full=team.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
 // MLB compound nicknames are identities in their own right, never shared Sox.
 const compound=/\b(red sox|white sox|blue jays)$/.exec(full)?.[1];
 const nickname=compound??full.split(/\s+/).slice(-1)[0];
 return [...new Set([full,nickname,...(abbrev?[abbrev.toLowerCase()]:[])])].filter(t=>t.length>=3);
}
function teamNamed(query:string,team:string,abbrev?:string):boolean{
 const q=' '+query.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()+' ';
 return teamIdentities(team,abbrev).some(t=>q.includes(' '+t+' '));
}
function requestedDate(game:string,today:Date):string|null{
 const dates:string[]=game.match(/\b\d{4}-\d{2}-\d{2}\b/g)??[];
 if(/\byesterday\b/i.test(game))dates.push(isoDate(new Date(today.getTime()-86400000)));
 if(/\btoday\b/i.test(game))dates.push(isoDate(today));
 if(new Set(dates).size>1)throw badRequest('AMBIGUOUS_DATE','name exactly one game date');
 const date=dates[0]??null;
 if(date&&(!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date))throw badRequest('INVALID_DATE','game date must be a real ISO calendar date');
 return date;
}
function candidateMatches(c:Candidate,game:string):boolean{
 const sides=game.toLowerCase().split(/\s+(?:vs\.?|versus|at|v\.?|@)\s+/);
 const homeAbbr=c.league==='NHL'?c.tokens[2]:undefined,awayAbbr=c.league==='NHL'?c.tokens[3]:undefined;
 if(sides.length===2){if(sides.some(side=>teamNamed(side,c.home_team,homeAbbr)&&teamNamed(side,c.away_team,awayAbbr)))return false;return (teamNamed(sides[0],c.home_team,homeAbbr)&&teamNamed(sides[1],c.away_team,awayAbbr))||(teamNamed(sides[1],c.home_team,homeAbbr)&&teamNamed(sides[0],c.away_team,awayAbbr));}
 if(sides.length>2)return false;
 // Unseparated queries must name both teams, or exactly one team with only
 // ordinary score-query filler. City-only MLB tokens are never identities.
 const home=teamNamed(game,c.home_team,homeAbbr),away=teamNamed(game,c.away_team,awayAbbr);
 if(home&&away)return true;
 let remainder=game.toLowerCase().replace(/\b\d{4}-\d{2}-\d{2}\b/g,' ');
 const terms=[...teamIdentities(c.home_team,homeAbbr),...teamIdentities(c.away_team,awayAbbr)].sort((a,b)=>b.length-a.length);
 for(const term of terms)remainder=(' '+remainder+' ').replace(' '+term.toLowerCase()+' ',' ');
 remainder=remainder.replace(/\b(?:what|was|is|the|score|of|game|result|today|yesterday|nhl|mlb|on|please)\b/g,'').replace(/[^a-z0-9]/g,'');
 return (home||away)&&remainder==='';
}

export async function handleSportsScore(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const game = query.game?.trim();
  if (!game) throw badRequest("MISSING_PARAM", "game is required: free text naming the teams, e.g. 'Hurricanes at Rangers'");
  if (game.length > 200) throw badRequest("INVALID_GAME", "game is over 200 characters");
  const asOf = new Date().toISOString();
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400_000);
  const explicitDate=requestedDate(game,today);
  const dates = explicitDate?[explicitDate]:[isoDate(today), isoDate(yesterday)];

  const [nhl, mlb] = await Promise.all([nhlCandidates(dates), mlbCandidates(dates)]);
  const seen = new Set<string>();
  const candidates = [...nhl.candidates, ...mlb.candidates].filter((c) => {
    const key = `${c.league}|${c.date}|${c.home_team}|${c.away_team}`;
    if (seen.has(key)) return false; // same game returned under two date fetches
    seen.add(key);
    return true;
  });
  const bodies = [...nhl.bodies, ...mlb.bodies];
  const matches=candidates.filter(c=>(!explicitDate||c.date===explicitDate)&&candidateMatches(c,game));

  if (matches.length === 0) {
    let football: Awaited<ReturnType<typeof footballLookup>>;
    try { football = await footballLookup(game, today,explicitDate??undefined); } catch { throw upstreamUnavailable("FOOTBALL_UNAVAILABLE", "major-football reference unavailable or ambiguous; refusing to guess"); }
    const m = football.match;
    const scope = "NHL and MLB official scoreboards for requested ISO date (UTC today/yesterday if no date); major football current/prior-season openfootball snapshot (five leagues), not a live score feed; other leagues including NBA are not covered";
    const evidence = JSON.stringify({ game_query: game, matched: m, scope, upstream_bodies: [...bodies, ...football.bodies], football_urls: football.urls, fetched_at: asOf });
    const receipt = makeReceipt(INTENT, football.urls[0], evidence, "openfootball football.json CC0 snapshot; exact source bytes; null means no score, never zero");
    receipt.fetched_at = asOf;
    try { await saveReceipt(receipt, evidence); } catch { throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable"); }
    const fields = m ?? {reason_code:"no_match",requested_date:explicitDate, home_team: null, away_team: null, home_score: null, away_score: null, status: "not_found", date: null, league: null };
    const selection=explicitDate?'Exact requested ISO date only.':m?.status==='final'?'Most recent completed scored fixture in current/prior-season snapshots; no date requested.':'No completed scored fixture found in covered current/prior-season snapshots; next scheduled fixture only, scores unknown.';
    const answer = m ? `${m.league}, ${m.date}: ${m.away_team} ${m.away_score ?? "no score"} at ${m.home_team} ${m.home_score ?? "no score"} (${m.status}). Source: openfootball football.json, CC0, community snapshot. ${scope}. ${selection}` : `No matching fixture in sources covered: ${scope}. Scores are null, not zero.`;
    return envelope(INTENT, { ...fields, found: !!m, selection_scope:selection,requested_date:explicitDate, summary: answer }, receipt, { answer, verdict: m ? "verified" : "not_found", confidence: m ? 0.8 : 0, source: "openfootball football.json, CC0 public-domain current-season snapshots" });
  }
  if (matches.length > 1) {
    const listing = matches.map((m) => `${m.league} ${m.away_team} at ${m.home_team} (${m.date})`).join("; ");
    throw badRequest("AMBIGUOUS_GAME", `"${game.slice(0, 80)}" matches ${matches.length} games: ${listing}. Name the teams more specifically`);
  }
  const m = matches[0];
  if (m.home_score === null || m.away_score === null) {
    throw upstreamUnavailable("SCORE_NOT_FINAL", `${m.league} ${m.away_team} at ${m.home_team} (${m.date}) has no recorded score yet (status: ${m.status}); refusing to invent one`);
  }

  const evidence = JSON.stringify({
    game_query: game, matched: { league: m.league, home_team: m.home_team, away_team: m.away_team, home_score: m.home_score, away_score: m.away_score, status: m.status, date: m.date },
    scope: "NHL and MLB official scoreboards for the dates searched; other leagues are not answered by this endpoint",
    as_of: asOf,
    upstream_bodies: bodies,
    honesty: "the score is the league's own published number for the uniquely matched game; a non-final game is an error, never an estimate",
    fetched_at: asOf,
  });
  const upstreamDesc = m.league === "NHL"
    ? `NHL official scoreboard https://api-web.nhle.com/v1/score/{${dates.join(",")}} (fetched ${asOf})`
    : `MLB official statsapi schedule https://statsapi.mlb.com/api/v1/schedule (hydrate=linescore, fetched ${asOf})`;
  const receipt = makeReceipt(INTENT, upstreamDesc.slice(0, 500), evidence, "keyless official league scoreboards; exact upstream bodies embedded");
  receipt.fetched_at = asOf;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const answer = `${m.league}, ${m.date}: ${m.away_team} ${m.away_score} at ${m.home_team} ${m.home_score} (status: ${m.status}). This is the league's official scoreboard number; coverage is NHL and MLB only.`;
  return envelope(INTENT, {
    home_team: m.home_team,
    away_team: m.away_team,
    home_score: m.home_score,
    away_score: m.away_score,
    status: m.status,
    date: m.date,
    league: m.league,
    summary: `${m.league} ${m.date}: ${m.away_team} ${m.away_score} @ ${m.home_team} ${m.home_score} (${m.status}).`,
  }, receipt, { answer, verdict: "verified", confidence: 0.85, source: upstreamDesc });
}
