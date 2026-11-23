import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/event-outcome-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
import { handleEventOutcome, matchMarket, parseSearch, resolveMarket } from "../src/handlers/eventOutcome";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real Polymarket gamma public-search body, retrieved 2026-11-23
// (event "Ballon d'Or Top 3 Finish 2026", 31 markets).
const search = readFileSync(join(__dirname, "fixtures/event-outcome/polymarket-kane-top3-search.json"), "utf8");
const KANE_Q = "Will Harry Kane finish in the top 3 of the 2026 Ballon d'Or?";
function stub(body: string | "ERR" = search): void {
  vi.stubGlobal("fetch", async () => {
    if (body === "ERR") throw new Error("test outage");
    return new Response(body, { status: 200 });
  });
}
describe("EVENT_OUTCOME_RESOLUTION_GENERAL", () => {
  it("parses the real search body", () => {
    const markets = parseSearch(search);
    expect(markets.length).toBe(31);
    const kane = markets.find((m) => m.question === KANE_Q)!;
    expect(kane.closed).toBe(true);
    expect(kane.umaStatus).toBe("resolved");
    expect(kane.outcomes).toEqual(["Yes", "No"]);
    expect(kane.prices).toEqual(["1", "0"]);
  });
  it("resolves the exact-question match to yes, honestly scoped to one venue", async () => {
    stub();
    const result = await handleEventOutcome({ event: KANE_Q });
    expect(result.outcome).toBe("yes");
    expect(result.resolved_yes).toBe(true);
    expect(result.winner).toBe("Yes");
    const ans = String(result.answer);
    expect(ans).toContain("resolved YES");
    expect(ans).toContain("one venue's resolution record");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("EVENT_OUTCOME_RESOLUTION_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
  });
  it("a No resolution maps to outcome no / resolved_yes false", () => {
    const markets = parseSearch(search);
    const musiala = markets.find((m) => m.prices[0] === "0" && m.prices[1] === "1" && m.umaStatus === "resolved")!;
    const r = resolveMarket(musiala);
    expect(r).toEqual({ outcome: "no", resolved_yes: false, winner: "No" });
  });
  it("ambiguous questions are refused with candidates named", async () => {
    stub();
    await expect(handleEventOutcome({ event: "finish in the top 3 of the 2026 Ballon d'Or" }))
      .rejects.toMatchObject({ status: 422, code: "AMBIGUOUS_EVENT" });
    await expect(handleEventOutcome({ event: "zzq nonexistent market" }))
      .rejects.toMatchObject({ status: 422, code: "EVENT_NOT_FOUND" });
  });
  it("unresolved or unclean markets are refused, never inferred", () => {
    const markets = parseSearch(search);
    const resolved = markets.find((m) => m.question === KANE_Q)!;
    expect(() => resolveMarket({ ...resolved, closed: false })).toThrowError(/not resolved/);
    expect(() => resolveMarket({ ...resolved, umaStatus: "" })).toThrowError(/not resolved/);
    expect(() => resolveMarket({ ...resolved, prices: ["0.9", "0.1"] })).toThrowError(/clean 1\/0/);
    expect(() => resolveMarket({ ...resolved, outcomes: ["Kane", "Bellingham"], prices: ["1", "0"] }))
      .toThrowError(/yes\/no enum/);
  });
  it("an outage is an honest 502", async () => {
    stub("ERR");
    await expect(handleEventOutcome({ event: KANE_Q }))
      .rejects.toMatchObject({ status: 502, code: "POLYMARKET_UNREACHABLE" });
  });
  it("GET /v1/event-outcome is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/event-outcome" })).toBe(true);
    stub();
    const res = await app.inject({ method: "GET", url: `/v1/event-outcome?event=${encodeURIComponent(KANE_Q)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("yes");
    await app.close();
  });
});
