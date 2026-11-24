// Mission 03 "Defensible Mark Evidence Check" preset.
// The scenario must send form_type=10-Q AND ticker on the wire, and give
// an evidence-complete verdict ONLY under its stated rule (10-Q within
// the last 12 months plus a live verified share price). A price that
// does not verify is HOLD, never APPROVE; a different form/window is
// VERIFIED data, never "evidence complete".

import { afterEach, describe, expect, it, vi } from "vitest";
import { getStockPrice } from "../../lib/api";
import { DESK_PRESETS, type DeskCheckResult } from "./presets";
import { toLiveReceipt } from "./utils";

const FILINGS_RECEIPT = {
  receipt_id: "rcpt_M03F000000000000000001",
  intent: "REGULATORY_FILING_MONITOR_GENERAL",
  upstream_url: "https://data.sec.gov/submissions/CIK0001287750.json",
  raw_response_sha256: "d".repeat(64),
  quorum_votes: "1/1 primary source",
  fetched_at: "2026-11-24T19:32:00.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_M03F000000000000000001",
};

const PRICE_RECEIPT = {
  receipt_id: "rcpt_M03P000000000000000001",
  intent: "STOCK_PRICE_US_EQUITY",
  upstream_url: "https://query1.finance.yahoo.com/v8/finance/chart/ARCC",
  raw_response_sha256: "e".repeat(64),
  quorum_votes: "1/1 primary source",
  fetched_at: "2026-11-24T19:32:05.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_M03P000000000000000001",
};

function preset(id: string) {
  const p = DESK_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return p;
}

function verified(intent: string, url: string, body: Record<string, unknown>, rcpt: typeof FILINGS_RECEIPT): DeskCheckResult {
  const full = { ...body, receipt: rcpt };
  const receipt = toLiveReceipt(intent, "q", url, { ok: true, body: full, receipt: rcpt, latencyMs: 5, ledgerGenAtStart: 0 });
  return { check: { label: "x", intent, query: "q", requestUrl: url, run: async () => { throw new Error("unused"); } }, receipt };
}

function refused(intent: string, url: string): DeskCheckResult {
  const receipt = toLiveReceipt(intent, "q", url, {
    ok: false,
    body: { error: "x", message: "refused" },
    latencyMs: 5,
    status: 503,
    errorCode: "UPSTREAM_UNAVAILABLE",
    errorMessage: "refused",
  });
  return { check: { label: "x", intent, query: "q", requestUrl: url, run: async () => { throw new Error("unused"); } }, receipt };
}

// Live shape of GET /v1/filings?entity=ARCC&period=last 12 months&form_type=10-Q
// (checked 2026-11-24 19:32 UTC: 3 filings, latest 2026-10-27; fixture keeps one).
const LIVE_10Q = {
  entity: "ARCC",
  form_type: "10-Q",
  filing_count: 1,
  filings: ["Form 10-Q filed 2026-10-27"],
  filings_detail: [
    { form: "10-Q", accession: "0001628280-26-067383", filing_date: "2026-10-27", url: "https://www.sec.gov/Archives/edgar/data/1287750/000162828026067383/arcc-20260930.htm" },
  ],
  urls: ["https://www.sec.gov/Archives/edgar/data/1287750/000162828026067383/arcc-20260930.htm"],
};

// Live shape of GET /v1/stock-price?ticker=ARCC (checked 2026-11-24 19:32 UTC).
const LIVE_PRICE = {
  ticker: "ARCC",
  price_usd: 18.82,
  currency: "USD",
  exchange: "NasdaqGS",
  market_time: "2026-11-24T18:59:00.000Z",
  as_of: "2026-11-24T19:32:05.000Z",
  stale: false,
  quote_age_seconds: 33,
  verdict: "VERIFIED",
};

const FILINGS_URL = "https://verireceipt.onrender.com/v1/filings?entity=ARCC&period=last+12+months&form_type=10-Q";
const PRICE_URL = "https://verireceipt.onrender.com/v1/stock-price?ticker=ARCC";

const okFilings = () => verified("REGULATORY_FILING_MONITOR_GENERAL", FILINGS_URL, LIVE_10Q, FILINGS_RECEIPT);
const okPrice = () => verified("STOCK_PRICE_US_EQUITY", PRICE_URL, LIVE_PRICE, PRICE_RECEIPT);

describe("M03 defensible-mark preset", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds two checks: a 10-Q filings request and a stock-price request for the same entity", () => {
    const p = preset("m03-mark");
    const checks = p.buildChecks(p.inputs);
    expect(checks).toHaveLength(2);
    const [fil, px] = checks;
    const fu = new URL(fil.requestUrl);
    expect(fu.pathname).toBe("/v1/filings");
    expect(fu.searchParams.get("form_type")).toBe("10-Q");
    expect(fu.searchParams.get("entity")).toBe("ARCC");
    expect(fu.searchParams.get("period")).toBe("last 12 months");
    const pu = new URL(px.requestUrl);
    expect(pu.pathname).toBe("/v1/stock-price");
    expect(pu.searchParams.get("ticker")).toBe("ARCC");
    expect(fil.intent).toBe("REGULATORY_FILING_MONITOR_GENERAL");
    expect(px.intent).toBe("STOCK_PRICE_US_EQUITY");
  });

  it("getStockPrice sends the ticker on the wire", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      seen.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ ...LIVE_PRICE, receipt: PRICE_RECEIPT }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    const out = await getStockPrice({ ticker: "ARCC" });
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0], "http://x").searchParams.get("ticker")).toBe("ARCC");
    expect(out.price_usd).toBe(18.82);
    expect(out.exchange).toBe("NasdaqGS");
  });

  it("APPROVEs only when the 10-Q verifies within 12 months and the price verifies", () => {
    const p = preset("m03-mark");
    const out = p.evaluate([okFilings(), okPrice()]);
    expect(out.verdict).toBe("APPROVE");
    expect(out.score).toBe(100);
    expect(out.headline).toContain("Evidence complete");
  });

  it("HOLDs when the price does not verify even though the filing does", () => {
    const p = preset("m03-mark");
    const out = p.evaluate([okFilings(), refused("STOCK_PRICE_US_EQUITY", PRICE_URL)]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).not.toContain("Evidence complete");
    const priceCard = out.why.find((w) => w.k === "Share Price (live)");
    expect(priceCard?.ok).toBe(false);
  });

  it("HOLDs when the filing does not verify even though the price does", () => {
    const p = preset("m03-mark");
    const out = p.evaluate([refused("REGULATORY_FILING_MONITOR_GENERAL", FILINGS_URL), okPrice()]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).not.toContain("Evidence complete");
  });

  it("HOLDs with NEEDS REVIEW when no 10-Q was filed in the window", () => {
    const p = preset("m03-mark");
    const none = { ...LIVE_10Q, filing_count: 0, filings: [], filings_detail: [], urls: [] };
    const out = p.evaluate([verified("REGULATORY_FILING_MONITOR_GENERAL", FILINGS_URL, none, FILINGS_RECEIPT), okPrice()]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toContain("NEEDS REVIEW");
    // Two live checks, both verified: the score denominator is the
    // check count, not an invented larger number.
    expect(out.score).toBe(100);
  });

  it("VERIFIED, never evidence-complete, outside the 10-Q / last-12-months rule", () => {
    const p = preset("m03-mark");
    const inputs = { entity: "ARCC", ref: "10-K", scope: "last 12 months · SEC EDGAR + Yahoo Finance" };
    const checks = p.buildChecks(inputs);
    expect(new URL(checks[0].requestUrl).searchParams.get("form_type")).toBe("10-K");
    const kBody = { ...LIVE_10Q, form_type: "10-K", filings_detail: [{ form: "10-K", accession: "x", filing_date: "2026-03-01", url: "https://www.sec.gov/x" }] };
    const out = p.evaluate([
      verified("REGULATORY_FILING_MONITOR_GENERAL", checks[0].requestUrl, kBody, FILINGS_RECEIPT),
      okPrice(),
    ]);
    expect(out.verdict).toBe("VERIFIED");
    expect(out.score).toBe(100);
    expect(out.headline).toContain("Data verified");
    expect(out.headline).not.toContain("Evidence complete");
  });
});
