// GAME_RESULT_GENERAL — GET /v1/game-result?game=<teams and date>
//
// Zero-LLM. Resolves a finished game's result from the ESPN site API,
// with a SHA-256 receipt over the exact upstream response bodies.
//
// Intent contract (https://devnode.telegraphprotocol.com/engine/v1/intents/GAME_RESULT_GENERAL,
// read 2026-11-22): request game (string — teams or competitors, and
// date); response winner/home_team/away_team/date (off-chain) and
// scored home_score/away_score (points, [0, 1000], integers).
//
// SOURCE: ESPN site API (site.api.espn.com), keyless and unauthenticated,
// probed live 2026-11-23 — the only concrete keyless feed that verified;
// the official league APIs are keyed. Single source, honestly named, 0.9.
//
// INPUT SHAPE (fail closed, never guess): the string must carry an ISO
// date (YYYY-MM-DD) and two competitor names separated by "vs"/"at"/"v".
// Leagues searched: NFL, NBA, MLB, NHL — named in every answer; other
// sports are not covered. Only COMPLETED events serve; a scheduled or
// in-progress game is 422 GAME_NOT_FINAL. Exactly one completed event
// must match both names (normalized substring or token overlap); zero
// matches is 422 GAME_NOT_FOUND, several is 422 AMBIGUOUS_GAME with the
// candidates named. Team-name matching is name matching, not identity
// resolution — the answer always names the exact teams ESPN carried.
import {teamNameMatches,norm} from './gameTeams';
export {teamNameMatches} from './gameTeams';
import {observeMlbFinal,isMlbPersistenceFailure} from './mlbFinal';
import {withAnswerClass} from "../core/answerClass";
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

const SOURCE_TIMEOUT_MS = 6000;
const UA = "VeriReceipt/2.0 game-result observer (+https://verireceipt.vercel.app)";
const LEAGUES = [
  ["NFL", "football/nfl"],
  ["NBA", "basketball/nba"],
  ["MLB", "baseball/mlb"],
  ["NHL", "hockey/nhl"],
] as const;

type GameSourceFailure = 'http_403'|'http_429'|'http_4xx'|'http_5xx'|'http_other'|'timeout'|'transport'|'body_read'|'unknown';
const sourceFailures = new WeakMap<object,GameSourceFailure>();
function failureClass(error:unknown):GameSourceFailure {
  try {return error && typeof error==='object' ? sourceFailures.get(error) ?? 'unknown' : 'unknown';} catch {return 'unknown';}
}
async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  let stage:GameSourceFailure = 'transport';
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) {
      const status=res.status;
      stage=status===403?'http_403':status===429?'http_429':status>=400&&status<500?'http_4xx':status>=500&&status<600?'http_5xx':'http_other';
      throw new Error(`HTTP ${status}`);
    }
    stage='body_read';
    return await res.text();
  } catch(error) {
    try {if(error && typeof error==='object')sourceFailures.set(error,controller.signal.aborted?'timeout':stage);} catch {}
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function parseGameInput(raw: string): { date: string; dates: string; teamA: string; teamB: string } {
  const m = /(20\d{2})-(\d{2})-(\d{2})/.exec(raw);
  if (!m) throw badRequest("DATE_REQUIRED", "game must name the date in YYYY-MM-DD form, e.g. \"Chargers vs Ravens 2026-11-16\"");
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const instant = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== date)
    throw badRequest('INVALID_DATE', 'game must carry a real calendar date in YYYY-MM-DD form');
  const rest = raw.replace(m[0], " ").trim();
  const parts = rest.split(/\s+(?:vs\.?|v|at|@)\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 2 || !norm(parts[0]) || !norm(parts[1])) {
    throw badRequest("TEAMS_REQUIRED", "game must name two competitors separated by 'vs' or 'at'");
  }
  return { date, dates: `${m[1]}${m[2]}${m[3]}`, teamA: parts[0], teamB: parts[1] };
}

interface Candidate {
  league: string; name: string; date: string; completed: boolean;
  home: string; away: string; homeScore: number | null; awayScore: number | null; winner: string;
}

export function parseScoreboard(raw: string, league: string): Candidate[] {
  const d = JSON.parse(raw) as { events?: unknown };
  if (!Array.isArray(d.events)) return [];
  const out: Candidate[] = [];
  for (const e of d.events as Record<string, unknown>[]) {
    const comp = (e.competitions as Record<string, unknown>[] | undefined)?.[0];
    if (!comp) continue;
    const status = (comp.status as { type?: { completed?: unknown } } | undefined)?.type;
    const competitors = (comp.competitors as Record<string, unknown>[] | undefined) ?? [];
    const home = competitors.find((c) => c.homeAway === "home");
    const away = competitors.find((c) => c.homeAway === "away");
    if (!home || !away) continue;
    const scoreOf = (c: Record<string, unknown>): number | null => {
      if ((typeof c.score !== 'string' && typeof c.score !== 'number') ||
          (typeof c.score === 'string' && !/^\d+$/.test(c.score))) return null;
      const s = Number(c.score);
      return Number.isInteger(s) && s >= 0 && s <= 1000 ? s : null;
    };
    const homeName = String((home.team as { displayName?: unknown } | undefined)?.displayName ?? "");
    const awayName = String((away.team as { displayName?: unknown } | undefined)?.displayName ?? "");
    const hs = scoreOf(home);
    const as = scoreOf(away);
    out.push({
      league, name: String(e.name ?? ""), date: String(e.date ?? "").slice(0, 10),
      completed: status?.completed === true,
      home: homeName, away: awayName, homeScore: hs, awayScore: as,
      winner: home.winner === true && away.winner !== true ? homeName : away.winner === true && home.winner !== true ? awayName : "",
    });
  }
  return out;
}

export const INTENT = "GAME_RESULT_GENERAL";

export async function handleGameResult(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const raw = query.game?.trim();
  if (!raw) throw badRequest("MISSING_PARAM", "game is required (teams and date, e.g. \"Chargers vs Ravens 2026-11-16\")");
  if (raw.length > 200) throw badRequest("GAME_TOO_LONG", "game must be at most 200 characters");
  const { date, dates, teamA, teamB } = parseGameInput(raw);
  const urls = LEAGUES.map(([label, path]) => ({ label, url: `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${dates}` }));
  const requestStarted=Date.now();
  const fetchedAt = new Date().toISOString();
  const settled = await Promise.allSettled(urls.map((u) => fetchText(u.url)));
  const bodies = new Map<string, string>();
  const failed: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") bodies.set(urls[i].label, r.value);
    else failed.push(urls[i].label);
  });
  if (bodies.size === 0) {
    try {
      const remainingMs=SOURCE_TIMEOUT_MS-(Date.now()-requestStarted);
      if(remainingMs<=0||settled.some(r=>r.status==='rejected'&&failureClass(r.reason)==='timeout'))throw Error('source budget exhausted');
      return await observeMlbFinal(date,teamA,teamB,Math.min(1500,remainingMs));
    }
    catch (error) {
      if (isMlbPersistenceFailure(error)) throw error;
      // Preserve the original closed refusal and diagnostics when no independent
      // final is available. A failed source never becomes a coverage-only score.
    }

    const error=upstreamUnavailable("ESPN_UNREACHABLE", `ESPN scoreboards failed for every covered league (${failed.join(", ")})`);
    try {
      const diagnostic:Record<string,unknown>={};
      settled.forEach((row,i)=>{if(row.status==='rejected')diagnostic['espn_'+urls[i].label.toLowerCase()+'_failure']=failureClass(row.reason);});
      withAnswerClass(error,INTENT,diagnostic);
    } catch {}
    throw error;
  }
  const candidates: Candidate[] = [];
  for (const [label, body] of bodies) candidates.push(...parseScoreboard(body, label));
  const matches = candidates.filter((c) =>
    (teamNameMatches(teamA, c.home) && teamNameMatches(teamB, c.away)) ||
    (teamNameMatches(teamA, c.away) && teamNameMatches(teamB, c.home)));
  if (matches.length === 0) {
    throw unprocessable("GAME_NOT_FOUND", `no game matching "${teamA}" vs "${teamB}" on ${date} in the covered leagues (${[...bodies.keys()].join(", ")})${failed.length ? `; unavailable: ${failed.join(", ")}` : ""}`);
  }
  const final = matches.filter((m) => m.completed);
  if (final.length === 0) {
    throw unprocessable("GAME_NOT_FINAL", `the matching game (${matches[0].name}, ${matches[0].league}) is not completed; final scores are never guessed`);
  }
  if (final.length > 1) {
    throw unprocessable("AMBIGUOUS_GAME", `several completed games match: ${final.map((f) => `${f.name} (${f.league})`).join("; ")}; name the teams more precisely`);
  }
  const g = final[0];
  if (g.homeScore === null || g.awayScore === null) {
    throw unprocessable("NO_USABLE_SCORE", `ESPN carried no usable final scores for ${g.name}`);
  }
  const expectedWinner = g.homeScore > g.awayScore ? g.home : g.awayScore > g.homeScore ? g.away : '';
  if (g.winner !== expectedWinner) {
    throw unprocessable('INCONSISTENT_FINAL_RESULT', 'published winner flag and final scores disagree or winner is missing; refusing to invent a winner');
  }
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ game: raw, parsed: { date, teamA, teamB }, as_of: asOf,
    matched_event: g, covered_leagues: [...bodies.keys()], unavailable_leagues: failed,
    source_policy: "ESPN site API, keyless unauthenticated, single source honestly named; only completed events serve",
    raw_bodies: Object.fromEntries(bodies), fetched_at: fetchedAt });
  const leagueUrl = urls.find((u) => u.label === g.league)!.url;
  const receipt = makeReceipt(INTENT, leagueUrl, evidence, "ESPN site API single source; completed events only");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const tie = g.homeScore === g.awayScore;
  return envelope(INTENT, { winner: tie ? "" : g.winner, home_team: g.home, away_team: g.away,
    home_score: g.homeScore, away_score: g.awayScore, date: g.date || date, requested_scoreboard_date: date, date_semantics: "date is the event UTC start date; requested_scoreboard_date is the source scoreboard day and can differ across midnight", league: g.league }, receipt, {
    answer: `${g.name} (${g.league}), ${g.date || date}: final — ${g.away} ${g.awayScore}, ${g.home} ${g.homeScore}. ` +
      (tie ? "The game ended tied; there is no winner. " : `${g.winner} won. `) +
      `Source: ESPN site API (single source). Covered leagues: ${[...bodies.keys()].join(", ")}${failed.length ? `; unavailable: ${failed.join(", ")}` : ""}. ` +
      "Only completed games serve; this is ESPN's published final, not a live score. The displayed date is the UTC event date; the requested scoreboard day can differ across midnight.",
    verdict: "verified",
    confidence: 0.9,
    source: `${leagueUrl}; ESPN site API single source, honestly named; completed event only; fetched ${fetchedAt}`,
  });
}
