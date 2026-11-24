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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
  } catch (e) {
    throw upstreamUnavailable(code, `${url} could not be reached: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  const body = await res.text();
  if (!res.ok) throw upstreamUnavailable(code, `${url} answered HTTP ${res.status}; refusing to guess a score`);
  try {
    return { body, parsed: JSON.parse(body) };
  } catch {
    throw upstreamUnavailable(code, `${url} returned a body that is not JSON; refusing to answer`);
  }
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

export async function handleSportsScore(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const game = query.game?.trim();
  if (!game) throw badRequest("MISSING_PARAM", "game is required: free text naming the teams, e.g. 'Hurricanes at Rangers'");
  if (game.length > 200) throw badRequest("INVALID_GAME", "game is over 200 characters");
  const asOf = new Date().toISOString();
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400_000);
  const dates = [isoDate(today), isoDate(yesterday)];

  const [nhl, mlb] = await Promise.all([nhlCandidates(dates), mlbCandidates(dates)]);
  const seen = new Set<string>();
  const candidates = [...nhl.candidates, ...mlb.candidates].filter((c) => {
    const key = `${c.league}|${c.date}|${c.home_team}|${c.away_team}`;
    if (seen.has(key)) return false; // same game returned under two date fetches
    seen.add(key);
    return true;
  });
  const bodies = [...nhl.bodies, ...mlb.bodies];
  const q = game.toLowerCase();
  const words = q.split(/[^a-z0-9]+/).filter(Boolean);
  const matches = candidates.filter((c) => {
    // A candidate matches when at least one of its tokens appears as a
    // whole word in the query; multiword MLB names match on the
    // distinctive last word (team name) or full string containment.
    return c.tokens.some((t) => words.includes(t) || (t.includes(" ") && q.includes(t)));
  });

  if (matches.length === 0) {
    let football: Awaited<ReturnType<typeof footballLookup>>;
    try { football = await footballLookup(game, today); } catch { throw upstreamUnavailable("FOOTBALL_UNAVAILABLE", "major-football reference unavailable or ambiguous; refusing to guess"); }
    const m = football.match;
    const scope = "NHL and MLB official scoreboards for today/yesterday; major football current-season openfootball snapshot (five leagues), not a live score feed; other leagues including NBA are not covered";
    const evidence = JSON.stringify({ game_query: game, matched: m, scope, upstream_bodies: [...bodies, ...football.bodies], football_urls: football.urls, fetched_at: asOf });
    const receipt = makeReceipt(INTENT, football.urls[0], evidence, "openfootball football.json CC0 snapshot; exact source bytes; null means no score, never zero");
    receipt.fetched_at = asOf;
    try { await saveReceipt(receipt, evidence); } catch { throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable"); }
    const fields = m ?? { home_team: null, away_team: null, home_score: null, away_score: null, status: "not_found", date: null, league: null };
    const answer = m ? `${m.league}, ${m.date}: ${m.away_team} ${m.away_score ?? "no score"} at ${m.home_team} ${m.home_score ?? "no score"} (${m.status}). Source: openfootball football.json, CC0, community snapshot. ${scope}.` : `No matching fixture in sources covered: ${scope}. Scores are null, not zero.`;
    return envelope(INTENT, { ...fields, found: !!m, summary: answer }, receipt, { answer, verdict: m ? "verified" : "not_found", confidence: m ? 0.8 : 0, source: "openfootball football.json, CC0 public-domain current-season snapshots" });
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
