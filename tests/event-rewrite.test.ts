import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/event-rewrite-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
import { handleEventOutcome } from "../src/handlers/eventOutcome";
import { willRewrite, scopeTokens, sameContent } from "../src/handlers/eventRewrite";
import { getReceiptEvidence } from "../src/core/storage";
const fx = (n: string) => readFileSync(join(__dirname, "fixtures/event-outcome", n), "utf8");
// Real Polymarket gamma public-search bodies retrieved 2026-11-26.
const didTrump = fx("did-trump-2024-search.json");
const willTrump = fx("will-trump-2024-search.json");
const didOpp = fx("did-oppenheimer-search.json");
const willOpp = fx("will-oppenheimer-search.json");
const DID = "Did Donald Trump win the 2024 US presidential election?";
const WILL = "Will Donald Trump win the 2024 US presidential election?";
function stub(map: Record<string, string>, calls: string[] = []): string[] {
  vi.stubGlobal("fetch", async (u: unknown) => {
    const url = new URL(String(u)); calls.push(url.hostname + ":" + (url.searchParams.get("q") ?? url.pathname));
    if (url.hostname === "gamma-api.polymarket.com") {
      const body = map[url.searchParams.get("q") ?? ""];
      return body === undefined ? new Response("{}", { status: 500 }) : new Response(body, { status: 200 });
    }
    return new Response("{}", { status: 500 });
  });
  return calls;
}
const ev = async (id: string) => JSON.parse(String((await getReceiptEvidence(id)).evidence));
describe("past-tense to Will rewrite", () => {
  it("willRewrite rules", () => {
    expect(willRewrite(DID)).toEqual({ query: WILL, rule: "did" });
    expect(willRewrite("Has Donald Trump won the 2024 US presidential election?")).toEqual({ query: WILL, rule: "has_have_had" });
    expect(willRewrite("Have the Fed cut rates in 2025")?.query).toBe("Will the Fed cut rates in 2025?");
    expect(willRewrite("Had Biden resigned by 2024?")?.query).toBe("Will Biden resign by 2024?");
    expect(willRewrite("Has Won Stuff Inc. won the 2024 award?")?.query).toBe("Will Won Stuff Inc. win the 2024 award?");
    expect(willRewrite(WILL)).toBeNull();
    expect(willRewrite("Has Trump spoken today?")).toBeNull();
    expect(willRewrite("Does Trump win")).toBeNull();
  });
  it("scope tokens (recorded in the receipt)", () => {
    expect(scopeTokens("Will BTC hit $100,000 by Dec 31, 2025?")).toEqual(["100000", "2025", "31", "month:dec"]);
    expect(scopeTokens("hit 100k")).toEqual(["100000"]);
    expect(scopeTokens("rate above 5%")).toEqual(["5%"]);
    expect(scopeTokens("in May 2025")).toEqual(["2025", "month:may"]);
    expect(scopeTokens("you may win in 2025")).toEqual(["2025"]);
    expect(scopeTokens("on May 5")).toEqual(["5", "month:may"]);
  });
  it("sameContent: identical or stopword-only differences pass, content words fail", () => {
    expect(sameContent(WILL, "Will Donald Trump win the 2024 US Presidential Election?")).toBe(true);
    expect(sameContent("Will A B?", "Will A B of the?")).toBe(true);
    expect(sameContent("Will A B in the?", "Will A B?")).toBe(true);
    expect(sameContent("Will Donald Trump win the 2024 US presidential election in Michigan?", WILL)).toBe(false);
    expect(sameContent(WILL, "Will Donald Trump win the 2024 US Presidential Election in Michigan?")).toBe(false);
    expect(sameContent(WILL, "Will Donald Trump win the 2024 US Presidential Election as a Republican?")).toBe(false);
    expect(sameContent("Will A win?", "Will B win?")).toBe(false);
    expect(sameContent("Will A B?", "Crypto: Will A B?")).toBe(false);
    expect(sameContent("Will A B?", "Will A B? Michigan")).toBe(false);
  });
  it("a state or party qualifier on the Did question never resolves to the national market", async () => {
    for (const tail of ["in Michigan", "as a Republican", "in Texas by a Republican"]) {
      const q = `Did Donald Trump win the 2024 US presidential election ${tail}?`; const w = `Will Donald Trump win the 2024 US presidential election ${tail}?`;
      stub({ [q]: JSON.stringify({ events: [] }), [w]: willTrump });
      const out = await handleEventOutcome({ event: q }) as any;
      expect(out.outcome).toBe("unresolved"); expect(out.resolved_yes).toBe(false); expect(out.question_rewrite).toBeUndefined();
    }
  });
  it("a longer market question (extra state) than the input is not accepted (synthetic body)", async () => {
    const synth = willTrump.replace("Will Donald Trump win the 2024 US Presidential Election?", "Will Donald Trump win the 2024 US Presidential Election in Michigan?");
    expect(synth).not.toBe(willTrump);
    stub({ [DID]: didTrump, [WILL]: synth });
    const out = await handleEventOutcome({ event: DID }) as any;
    expect(out.outcome).toBe("unresolved"); expect(out.resolved_yes).toBe(false);
  });
  it("resolves a Did question through the Will wording, recording both searches", async () => {
    const calls = stub({ [DID]: didTrump, [WILL]: willTrump });
    const out = await handleEventOutcome({ event: DID }) as any;
    expect(calls).toEqual(["gamma-api.polymarket.com:" + DID, "gamma-api.polymarket.com:" + WILL]);
    expect(out.outcome).toBe("yes"); expect(out.resolved_yes).toBe(true); expect(out.winner).toBe("Yes");
    expect(out.event).toBe("Will Donald Trump win the 2024 US Presidential Election?");
    expect(String(out.source)).toContain(encodeURIComponent(WILL));
    expect(String(out.answer)).toContain("rewriting the past-tense form"); expect(String(out.answer)).toContain("one venue's resolution record");
    const e = await ev(out.receipt.id ?? out.receipt_id ?? out.receipt?.receipt_id);
    expect(e.raw_bodies.search).toBe(didTrump); expect(e.raw_bodies.rewritten_search).toBe(willTrump);
    expect(e.question_rewrite).toMatchObject({ rewritten_query: WILL, rule: "did", scope_tokens: ["2024"] });
    expect(e.question_rewrite.first_search_url).toContain(encodeURIComponent(DID));
    expect(e.question_rewrite.rewritten_search_url).toContain(encodeURIComponent(WILL));
  });
  it("Has/Have/Had form resolves the same way", async () => {
    stub({ "Has Donald Trump won the 2024 US presidential election?": didTrump, [WILL]: willTrump });
    const out = await handleEventOutcome({ event: "Has Donald Trump won the 2024 US presidential election?" }) as any;
    expect(out.outcome).toBe("yes"); expect(out.resolved_yes).toBe(true);
  });
  it("a No market resolves to no through the rewrite", async () => {
    const q = "Did Joe Biden win the 2024 US presidential election?"; const w = "Will Joe Biden win the 2024 US presidential election?";
    const first = JSON.stringify({ events: [] });
    stub({ [q]: first, [w]: willTrump });
    const out = await handleEventOutcome({ event: q }) as any;
    expect(out.outcome).toBe("no"); expect(out.resolved_yes).toBe(false);
  });
  it("a Did question that already matches directly never retries (synthetic body)", async () => {
    const direct = willTrump.replace("Will Donald Trump win the 2024 US Presidential Election?", DID);
    const calls = stub({ [DID]: direct });
    const out = await handleEventOutcome({ event: DID }) as any;
    expect(out.outcome).toBe("yes"); expect(calls).toEqual(["gamma-api.polymarket.com:" + DID]);
  });
  it("an open market found through the rewrite is disclosed unresolved and records both searches (synthetic body)", async () => {
    const o = JSON.parse(willTrump); const m = o.events.flatMap((e: any) => e.markets).find((x: any) => x.question.toLowerCase() === WILL.toLowerCase());
    m.closed = false; m.umaResolutionStatus = ""; m.outcomePrices = '["0.6","0.4"]'; m.slug = "open-slug";
    const calls = stub({ [DID]: didTrump, [WILL]: JSON.stringify(o) });
    const out = await handleEventOutcome({ event: DID }) as any;
    expect(out.outcome).toBe("unresolved"); expect(out.resolved_yes).toBe(false); expect(calls.length).toBe(2);
    const e = await ev(out.receipt.id ?? out.receipt_id ?? out.receipt?.receipt_id);
    expect(e.raw_bodies.search).toBe(didTrump); expect(e.question_rewrite.rule).toBe("did");
  });
  it("an exact Will question never retries", async () => {
    const calls = stub({ [WILL]: willTrump });
    const out = await handleEventOutcome({ event: WILL }) as any;
    expect(out.outcome).toBe("yes"); expect(calls).toEqual(["gamma-api.polymarket.com:" + WILL]);
    expect((await ev(out.receipt.id ?? out.receipt_id ?? out.receipt?.receipt_id)).question_rewrite).toBeUndefined();
  });
  it("scope guard: a contained match whose year differs is not accepted (synthetic body)", async () => {
    const q = "Did Donald Trump win the presidential election?"; const w = "Will Donald Trump win the presidential election?";
    const synth = willTrump.replace("Will Donald Trump win the 2024 US Presidential Election?", "Will Donald Trump win the presidential election in 2020?");
    expect(synth).not.toBe(willTrump);
    stub({ [q]: JSON.stringify({ events: [] }), [w]: synth });
    let result: any; try { result = await handleEventOutcome({ event: q }); } catch (e) { result = { refused: true }; }
    expect(result.outcome).not.toBe("yes"); expect(result.resolved_yes).not.toBe(true);
    expect(result.question_rewrite).toBeUndefined();
  });
  it("scope guard unit: differing threshold in the rewritten match is rejected (synthetic body)", async () => {
    const q = "Did Bitcoin hit 100k"; const w = "Will Bitcoin hit 100k?";
    const mk = (question: string) => JSON.stringify({ events: [{ markets: [{ question, closed: true, umaResolutionStatus: "resolved", outcomes: '["Yes","No"]', outcomePrices: '["1","0"]', endDate: "2025-01-01", slug: "x" }] }] });
    stub({ [q]: JSON.stringify({ events: [] }), [w]: mk("Will Bitcoin hit 100k? (Jan 5)") });
    let r1: any; try { r1 = await handleEventOutcome({ event: q }); } catch { r1 = { refused: true }; }
    expect(r1.outcome).not.toBe("yes");
    stub({ [q]: JSON.stringify({ events: [] }), [w]: mk("Will Bitcoin hit 100k?") });
    const r2 = await handleEventOutcome({ event: q }) as any;
    expect(r2.outcome).toBe("yes");
  });
  it("an ambiguous rewritten match refuses", async () => {
    const dup = JSON.parse(willTrump); dup.events[0].markets.push({ ...dup.events[0].markets[0], slug: "dup" });
    stub({ [DID]: didTrump, [WILL]: JSON.stringify(dup) });
    await expect(handleEventOutcome({ event: DID })).rejects.toMatchObject({ code: "AMBIGUOUS_EVENT" });
  });
  it("a failed rewrite search leaves the old answer unchanged", async () => {
    const calls = stub({ [DID]: didTrump });
    let r: any; try { r = await handleEventOutcome({ event: DID }); } catch { r = { refused: true }; }
    expect(r.outcome).not.toBe("yes");
    expect(calls[1]).toBe("gamma-api.polymarket.com:" + WILL);
  });
  it("Oppenheimer stays honestly unresolved: market is quoted, undated and only UMA-proposed", async () => {
    const q = "Did Oppenheimer win Best Picture at the 2024 Oscars?"; const w = "Will Oppenheimer win Best Picture at the 2024 Oscars?";
    stub({ [q]: didOpp, [w]: willOpp });
    let r: any; try { r = await handleEventOutcome({ event: q }); } catch { r = { refused: true }; }
    expect(r.outcome).not.toBe("yes"); expect(r.outcome).not.toBe("no");
  });
});
