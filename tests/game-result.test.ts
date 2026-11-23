import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/game-result-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); });
import { handleGameResult, parseGameInput, teamNameMatches } from "../src/handlers/gameResult";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real ESPN site API body for the NFL scoreboard of 2026-11-16, retrieved 2026-11-23.
const nfl = readFileSync(join(__dirname, "fixtures/game-result/espn-nfl-20261116.json"), "utf8");
const EMPTY = JSON.stringify({ events: [] });
function stub(opts: { nfl?: string } = {}): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    if (u.includes("football/nfl")) {
      if (opts.nfl === "ERR") throw new Error("test outage");
      return new Response(opts.nfl ?? nfl, { status: 200 });
    }
    return new Response(EMPTY, { status: 200 });
  });
}
describe("GAME_RESULT_GENERAL", () => {
  it("parses the input fail-closed: date and two teams required", () => {
    expect(parseGameInput("Chargers vs Ravens 2026-11-16")).toMatchObject({ date: "2026-11-16", dates: "20261116", teamA: "Chargers", teamB: "Ravens" });
    expect(() => parseGameInput("Chargers vs Ravens")).toThrow();
    expect(() => parseGameInput("Ravens 2026-11-16")).toThrow();
  });
  it("team-name matching is forgiving on city/punctuation, strict on unrelated names", () => {
    expect(teamNameMatches("Chargers", "Los Angeles Chargers")).toBe(true);
    expect(teamNameMatches("baltimore ravens", "Baltimore Ravens")).toBe(true);
    expect(teamNameMatches("Ravens", "Los Angeles Chargers")).toBe(false);
  });
  it("validates before fetching", async () => {
    await expect(handleGameResult({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleGameResult({ game: "Chargers vs Ravens" })).rejects.toMatchObject({ status: 400, code: "DATE_REQUIRED" });
  });
  it("serves the real completed final with a receipt over the exact bodies", async () => {
    stub();
    const result = await handleGameResult({ game: "Chargers vs Ravens 2026-11-16" });
    expect(result.home_team).toBe("Baltimore Ravens");
    expect(result.away_team).toBe("Los Angeles Chargers");
    expect(result.home_score).toBe(20);
    expect(result.away_score).toBe(23);
    expect(result.winner).toBe("Los Angeles Chargers");
    expect(result.league).toBe("NFL");
    expect(String(result.answer)).toContain("ESPN");
    expect(String(result.answer)).toContain("not a live score");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("GAME_RESULT_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    const body = JSON.parse(stored.evidence.toString("utf8"));
    expect(body.raw_bodies.NFL).toBe(nfl);
  });
  it("a non-final matching game is refused, final scores never guessed", async () => {
    const edited = JSON.parse(nfl);
    edited.events[0].competitions[0].status.type.completed = false;
    stub({ nfl: JSON.stringify(edited) });
    await expect(handleGameResult({ game: "Chargers vs Ravens 2026-11-16" }))
      .rejects.toMatchObject({ status: 422, code: "GAME_NOT_FINAL" });
  });
  it("no matching game is an honest 422 naming the covered leagues", async () => {
    stub();
    await expect(handleGameResult({ game: "Eagles vs Cowboys 2026-11-16" }))
      .rejects.toMatchObject({ status: 422, code: "GAME_NOT_FOUND" });
  });
  it("several completed matches are ambiguous, never a guess", async () => {
    const edited = JSON.parse(nfl);
    edited.events.push(edited.events[0]); // same game twice
    stub({ nfl: JSON.stringify(edited) });
    await expect(handleGameResult({ game: "Chargers vs Ravens 2026-11-16" }))
      .rejects.toMatchObject({ status: 422, code: "AMBIGUOUS_GAME" });
  });
  it("every league feed down is an honest 502", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("test outage"); });
    await expect(handleGameResult({ game: "Chargers vs Ravens 2026-11-16" }))
      .rejects.toMatchObject({ status: 502, code: "ESPN_UNREACHABLE" });
  });
  it("GET /v1/game-result is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/game-result" })).toBe(true);
    stub();
    const res = await app.inject({ method: "GET", url: "/v1/game-result?game=Chargers%20vs%20Ravens%202026-11-16" });
    expect(res.statusCode).toBe(200);
    expect(res.json().winner).toBe("Los Angeles Chargers");
    await app.close();
  });
  it.each(['', ' ', null, false, [], 'NaN', '1.5'])('negative mutation: unusable final score %j is not zero', async(score) => {
    const edited = JSON.parse(nfl);
    edited.events[0].competitions[0].competitors.find((c:any)=>c.homeAway==='home').score = score;
    stub({nfl:JSON.stringify(edited)});
    await expect(handleGameResult({game:'Chargers vs Ravens 2026-11-16'})).rejects.toMatchObject({code:'NO_USABLE_SCORE'});
  });
  it.each(['2026-02-30','2026-13-01','2026-00-01'])('invalid calendar date %s fails before network', async(date) => {
    const f=vi.fn();vi.stubGlobal('fetch',f);
    await expect(handleGameResult({game:'Chargers vs Ravens '+date})).rejects.toMatchObject({code:'INVALID_DATE'});
    expect(f).not.toHaveBeenCalled();
  });
  it('negative mutation: winner flag contradicting scores is refused',async()=>{
    const edited=JSON.parse(nfl);
    for(const c of edited.events[0].competitions[0].competitors)c.winner=c.homeAway==='home';
    stub({nfl:JSON.stringify(edited)});
    await expect(handleGameResult({game:'Chargers vs Ravens 2026-11-16'})).rejects.toMatchObject({code:'INCONSISTENT_FINAL_RESULT'});
  });
  it('negative mutation: absent winner is not silently inferred from scores',async()=>{
    const edited=JSON.parse(nfl);
    for(const c of edited.events[0].competitions[0].competitors)delete c.winner;
    stub({nfl:JSON.stringify(edited)});
    await expect(handleGameResult({game:'Chargers vs Ravens 2026-11-16'})).rejects.toMatchObject({code:'INCONSISTENT_FINAL_RESULT'});
  });
  it('real scoreboard day and UTC event start date differ honestly across midnight',async()=>{
    stub();const out=await handleGameResult({game:'Chargers vs Ravens 2026-11-16'});
    expect(out.date).toBe('2026-11-17');expect(out.requested_scoreboard_date).toBe('2026-11-16');
    expect(String(out.date_semantics)).toContain('UTC');
  });

});
