import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/sports-score-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
import { handleSportsScore } from "../src/handlers/sportsScore";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";

// Fixtures: real excerpts retrieved 2026-11-23. NHL: two games from the
// 2026-11-22 scoreboard (Hurricanes 5 @ Rangers 2, Sabres 6 @
// Lightning 2). MLB: two games from 2026-06-15 (Marlins 0 @ Phillies
// 7, Royals 3 @ Nationals 7), trimmed to the fields the handler reads.
const FX = join(__dirname, "fixtures/sports-score");
const NHL = readFileSync(join(FX, "nhl-2026-11-22.json"), "utf8");
const MLB = readFileSync(join(FX, "mlb-2026-06-15.json"), "utf8");
// Pinned so the requested dates are deterministic.
const PINNED = new Date("2026-11-22T18:00:00.000Z");

function stub(opts: { nhlDown?: boolean; mlbDown?: boolean; nhlBody?: string } = {}): void {
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url);
    if (u.includes("api-web.nhle.com")) {
      if (opts.nhlDown) throw new Error("nhl outage");
      if (u.includes("/score/2026-11-22")) return new Response(opts.nhlBody ?? NHL, { status: 200 });
      return new Response(JSON.stringify({ games: [] }), { status: 200 });
    }
    if (u.includes("statsapi.mlb.com")) {
      if (opts.mlbDown) throw new Error("mlb outage");
      return new Response(MLB, { status: 200 });
    }
    if (u.includes("raw.githubusercontent.com")) return new Response(JSON.stringify({matches:[]}));
    throw new Error(`unexpected fetch ${u}`);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(PINNED);
});

describe("SPORTS_SCORE_GENERAL", () => {
  it("matches an NHL game by team names and returns the official score with a verifiable receipt", async () => {
    stub();
    const result = await handleSportsScore({ game: "Hurricanes at Rangers" });
    expect(result.league).toBe("NHL");
    expect(result.home_team).toBe("Rangers");
    expect(result.away_team).toBe("Hurricanes");
    expect(result.home_score).toBe(2);
    expect(result.away_score).toBe(5);
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("SPORTS_SCORE_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    expect(String(stored.evidence)).toContain("NHL and MLB official scoreboards");
  });
  it("matches an MLB game by a distinctive team word", async () => {
    stub();
    const result = await handleSportsScore({ game: "Phillies game" });
    expect(result.league).toBe("MLB");
    expect(result.home_team).toBe("Philadelphia Phillies");
    expect(result.home_score).toBe(7);
    expect(result.away_score).toBe(0);
    expect(result.status).toBe("Final");
    expect(result.date).toBe("2026-06-15");
  });
  it("several matches fail closed as ambiguous, listing the candidates", async () => {
    stub();
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/v1/sports-score?game=Rangers%20or%20Lightning" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("AMBIGUOUS_GAME");
    expect(res.body).toContain("Rangers");
    expect(res.body).toContain("Lightning");
    await app.close();
  });
  it("an uncovered game returns disclosed null-score coverage result", async () => {
    stub();
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/v1/sports-score?game=Lakers%20vs%20Celtics" });
    expect(res.statusCode).toBe(200);
    expect(res.json().home_score).toBeNull();
    expect(res.json().status).toBe("not_found");
    expect(res.body).toContain("NHL and MLB official scoreboards");
    expect(res.body).not.toContain("ESPN");
    await app.close();
  });
  it("a matched game with no recorded score is a 502, never an estimate", async () => {
    const live = NHL.replace('"score": 2', '"x": 2'); // Rangers home score removed
    stub({ nhlBody: live });
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/v1/sports-score?game=Hurricanes%20at%20Rangers" });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("SCORE_NOT_FINAL");
    await app.close();
  });
  it("a league outage fails closed with a 502", async () => {
    stub({ nhlDown: true });
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/v1/sports-score?game=Hurricanes%20at%20Rangers" });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("NHL_SCOREBOARD_UNAVAILABLE");
    await app.close();
  });
});

it("football answer persists exact captured bytes and never exposes hosting links",async()=>{
 stub(); const base=globalThis.fetch;
 vi.stubGlobal("fetch",async(u:unknown)=>String(u).includes("raw.githubusercontent.com")?new Response(readFileSync(join(__dirname,"fixtures/sports-football",String(u).split("/").pop()!),"utf8")):base(u as string));
 const out=await handleSportsScore({game:"Arsenal vs Chelsea"});expect(out.home_score).toBe(2);expect(out.away_score).toBe(1);expect(out.answer).not.toContain("github");
 const r=out.receipt as {receipt_id:string;raw_response_sha256:string};const stored=await getReceiptEvidence(r.receipt_id);expect(sha256Hex(stored.evidence!)).toBe(r.raw_response_sha256);expect(String(stored.evidence)).toContain("Arsenal FC");
});
