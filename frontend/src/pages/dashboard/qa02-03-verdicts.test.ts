// QA-02 / QA-03 / QA-12 (external live-site QA, 2026-11-21).
// QA-02: the 10-K preset must send form_type=10-K, check the answer's
//        form, and give a current-compliance verdict ONLY under its
//        stated rule (10-K within the last 12 months); a historical
//        window is VERIFIED data, never "current".
// QA-03: the power scenario never APPROVEs without a user threshold;
//        with one, LMP above -> CURTAIL, at/below -> RUN; the ETH quote
//        never drives the power outcome.
// QA-12: the malformed-hash probe is labelled HTTP 400, not 422.

import { afterEach, describe, expect, it, vi } from "vitest";
import { getFilings } from "../../lib/api";
import { DESK_PRESETS, parseThreshold, type DeskCheckResult } from "./presets";
import { toLiveReceipt } from "./utils";

const RECEIPT = {
  receipt_id: "rcpt_QA02000000000000000001",
  intent: "REGULATORY_FILING_MONITOR_GENERAL",
  upstream_url: "https://data.sec.gov/submissions/CIK0000320193.json",
  raw_response_sha256: "c".repeat(64),
  quorum_votes: "1/1 primary source",
  fetched_at: "2026-11-21T16:22:54.378Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_QA02000000000000000001",
};

function preset(id: string) {
  const p = DESK_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return p;
}

function verified(intent: string, url: string, body: Record<string, unknown>): DeskCheckResult {
  const full = { ...body, receipt: RECEIPT };
  const receipt = toLiveReceipt(intent, "q", url, { ok: true, body: full, receipt: RECEIPT, latencyMs: 5, ledgerGenAtStart: 0 });
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

// Live shape of GET /v1/filings?entity=AAPL&period=last 12 months&form_type=10-K
// (checked 2026-11-21 16:22 UTC: 1 filing, 10-K filed 2026-11-03).
const LIVE_10K = {
  entity: "AAPL",
  form_type: "10-K",
  filing_count: 1,
  filings: ["Form 10-K filed 2026-11-03"],
  filings_detail: [
    { form: "10-K", accession: "0000320193-26-000026", filing_date: "2026-11-03", url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm" },
  ],
  urls: ["https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm"],
};

const SEC_URL = (q: Record<string, string>) => `https://verireceipt.onrender.com/v1/filings?${new URLSearchParams(q).toString()}`;

describe("QA-02 SEC 10-K preset", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds a request that includes form_type=10-K", () => {
    const p = preset("m13-sec");
    const [check] = p.buildChecks(p.inputs);
    const u = new URL(check.requestUrl);
    expect(u.searchParams.get("form_type")).toBe("10-K");
    expect(u.searchParams.get("entity")).toBe("AAPL");
    expect(u.searchParams.get("period")).toBe("last 12 months");
    expect(p.buildChecks(p.inputs)).toHaveLength(1);
  });

  it("getFilings actually sends form_type on the wire (and omits it when absent)", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      seen.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({ ...LIVE_10K, receipt: RECEIPT }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    await getFilings({ entity: "AAPL", period: "last 12 months", form_type: "10-K" });
    await getFilings({ entity: "AAPL", period: "last 12 months" });
    expect(new URL(seen[0], "http://x").searchParams.get("form_type")).toBe("10-K");
    expect(new URL(seen[1], "http://x").searchParams.has("form_type")).toBe(false);
  });

  it("10-K within the last 12 months -> APPROVE under the stated rule, with date and evaluation day", () => {
    const p = preset("m13-sec");
    const ev = p.evaluate([verified("REGULATORY_FILING_MONITOR_GENERAL", SEC_URL({ entity: "AAPL", period: "last 12 months", form_type: "10-K" }), LIVE_10K)]);
    expect(ev.verdict).toBe("APPROVE");
    expect(ev.headline).toContain("latest filed 2026-11-03");
    expect(ev.headline).toMatch(/evaluated \d{4}-\d{2}-\d{2} UTC/);
    expect(ev.headline).not.toMatch(/current and verified verbatim/);
  });

  it("a historical window (TSLA 2023) is VERIFIED data, never a current-compliance approval", () => {
    const p = preset("m13-sec");
    const body = {
      ...LIVE_10K,
      entity: "TSLA",
      filings_detail: [{ form: "10-K", accession: "a", filing_date: "2023-01-31", url: "https://www.sec.gov/x" }],
    };
    const ev = p.evaluate([verified("REGULATORY_FILING_MONITOR_GENERAL", SEC_URL({ entity: "TSLA", period: "2023", form_type: "10-K" }), body)]);
    expect(ev.verdict).toBe("VERIFIED");
    expect(ev.headline).toContain("No current-compliance verdict");
    expect(ev.why.find((c) => c.k === "Currentness Rule")?.ok).toBe("na");
  });

  it("an all-forms answer to a 10-K question is a mismatch -> HOLD", () => {
    const p = preset("m13-sec");
    const body = {
      entity: "AAPL",
      form_type: null,
      filing_count: 2,
      filings: ["Form 4 filed 2026-11-19", "Form 10-K filed 2026-11-03"],
      filings_detail: [
        { form: "4", accession: "a", filing_date: "2026-11-19", url: "https://www.sec.gov/a" },
        { form: "10-K", accession: "b", filing_date: "2026-11-03", url: "https://www.sec.gov/b" },
      ],
      urls: ["https://www.sec.gov/a", "https://www.sec.gov/b"],
    };
    const ev = p.evaluate([verified("REGULATORY_FILING_MONITOR_GENERAL", SEC_URL({ entity: "AAPL", period: "last 12 months", form_type: "10-K" }), body)]);
    expect(ev.verdict).toBe("HOLD");
    expect(ev.why.find((c) => c.k === "Form Filter")?.ok).toBe(false);
  });

  it("no 10-K in the last 12 months -> NEEDS REVIEW (HOLD), not APPROVE", () => {
    const p = preset("m13-sec");
    const body = { entity: "AAPL", form_type: "10-K", filing_count: 0, filings: [], filings_detail: [], urls: [] };
    const ev = p.evaluate([verified("REGULATORY_FILING_MONITOR_GENERAL", SEC_URL({ entity: "AAPL", period: "last 12 months", form_type: "10-K" }), body)]);
    expect(ev.verdict).toBe("HOLD");
    expect(ev.headline).toContain("NEEDS REVIEW");
  });

  it("a refused filings call -> HOLD", () => {
    const p = preset("m13-sec");
    const ev = p.evaluate([refused("REGULATORY_FILING_MONITOR_GENERAL", SEC_URL({ entity: "AAPL", period: "last 12 months", form_type: "10-K" }))]);
    expect(ev.verdict).toBe("HOLD");
  });
});

describe("QA-03 power scenario", () => {
  const GRID_URL = "https://verireceipt.onrender.com/v1/grid-price?node_or_zone=TH_NP15_GEN-APND&interval_start=2026-11-21T14%3A00%3A00.000Z";
  const ROUTE_URL = "https://verireceipt.onrender.com/v1/route?pair=ETH%2FUSDC";
  const grid = (lmp: number) =>
    verified("GRID_POWER_PRICE_GENERAL", GRID_URL, { lmp_usd_per_mwh: lmp, node_or_zone: "TH_NP15_GEN-APND", market: "CAISO" });
  const route = verified("OPTIMAL_EXECUTION_ROUTE_GENERAL", ROUTE_URL, { amount_out: 1675210910 });
  const routeRefused = refused("OPTIMAL_EXECUTION_ROUTE_GENERAL", ROUTE_URL);
  const p = preset("m12-curtail");
  const inputs = (scope: string) => ({ ...p.inputs, scope });

  it("default inputs carry no threshold", () => {
    expect(parseThreshold(p.inputs.scope)).toBeNull();
  });

  it("parseThreshold reads only an explicit threshold", () => {
    expect(parseThreshold("2026-11-21T14:00:00.000Z · threshold 60")).toBe(60);
    expect(parseThreshold("2026-11-21T14:00:00.000Z · Threshold $57.5")).toBe(57.5);
    expect(parseThreshold("2026-11-21T14:00:00.000Z · no threshold")).toBeNull();
    expect(parseThreshold("2026-11-21T14:00:00.000Z")).toBeNull();
    expect(parseThreshold("threshold 1.2.3")).toBeNull();
  });

  it("no threshold -> VERIFIED, never APPROVE, even with a successful ETH quote", () => {
    const ev = p.evaluate([grid(57.17), route], p.inputs);
    expect(ev.verdict).toBe("VERIFIED");
    expect(ev.verdict).not.toBe("APPROVE");
    expect(ev.headline).toContain("No threshold set");
  });

  it("with a threshold: above -> CURTAIL, at/below -> RUN, units stated", () => {
    expect(p.evaluate([grid(57.17), route], inputs("x · threshold 50")).verdict).toBe("CURTAIL");
    const run = p.evaluate([grid(57.17), route], inputs("x · threshold 60"));
    expect(run.verdict).toBe("RUN");
    expect(run.headline).toContain("/ MWh");
    expect(p.evaluate([grid(60), route], inputs("x · threshold 60")).verdict).toBe("RUN");
  });

  it("the ETH quote does not drive the power outcome", () => {
    expect(p.evaluate([grid(57.17), routeRefused], inputs("x · threshold 60")).verdict).toBe("RUN");
    expect(p.evaluate([grid(57.17), routeRefused], p.inputs).verdict).toBe("VERIFIED");
  });

  it("a failed grid call -> HOLD regardless of threshold", () => {
    const g = refused("GRID_POWER_PRICE_GENERAL", GRID_URL);
    expect(p.evaluate([g, route], inputs("x · threshold 60")).verdict).toBe("HOLD");
  });
});

describe("QA-12 refusal probe label", () => {
  it("the malformed-hash probe is labelled HTTP 400, not 422", () => {
    const p = preset("m13-422");
    expect(p.tag).toContain("400");
    expect(`${p.tag} ${p.title} ${p.sub}`).not.toContain("422");
  });
});
