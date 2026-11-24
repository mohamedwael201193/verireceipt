// Mission 04 "Overnight Counterparty Diligence" preset.
// Three live checks (sanctions screen, corporate registry, SEC 10-Q).
// APPROVE only when: no sanctions match above threshold AND registry
// active AND >= 1 Form 10-Q in the last 12 months. A sanctions match is
// HOLD (blocked pending review); anything unverified is HOLD; outside the 10-Q/12-month rule is
// VERIFIED data, never a diligence pass.

import { afterEach, describe, expect, it, vi } from "vitest";
import { getCorporateRegistry, getSanctionsScreen } from "../../lib/api";
import { DESK_PRESETS, type DeskCheckResult } from "./presets";
import { toLiveReceipt } from "./utils";

const SANCTIONS_RECEIPT = {
  receipt_id: "rcpt_M04S000000000000000001",
  intent: "SANCTIONS_SCREENING_MATCH_GENERAL",
  upstream_url: "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV",
  raw_response_sha256: "a".repeat(64),
  quorum_votes: "1/1 primary source",
  fetched_at: "2026-11-24T19:44:22.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_M04S000000000000000001",
};

const REGISTRY_RECEIPT = {
  receipt_id: "rcpt_M04R000000000000000001",
  intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
  upstream_url: "https://api.gleif.org/api/v1/lei-records?filter%5Bentity.legalName%5D=Ares+Capital+Corporation",
  raw_response_sha256: "b".repeat(64),
  quorum_votes: "1/1 primary source",
  fetched_at: "2026-11-24T19:44:15.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_M04R000000000000000001",
};

const FILINGS_RECEIPT = {
  receipt_id: "rcpt_M04F000000000000000001",
  intent: "REGULATORY_FILING_MONITOR_GENERAL",
  upstream_url: "https://data.sec.gov/submissions/CIK0001287750.json",
  raw_response_sha256: "c".repeat(64),
  quorum_votes: "1/1 primary source",
  fetched_at: "2026-11-24T19:45:00.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_M04F000000000000000001",
};

function preset(id: string) {
  const p = DESK_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return p;
}

function verified(intent: string, url: string, body: Record<string, unknown>, rcpt: typeof SANCTIONS_RECEIPT): DeskCheckResult {
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

// Live shapes checked 2026-11-24 19:44 UTC (unbilled probes).
const CLEAR_SCREEN = {
  name: "Ares Capital Corporation",
  matched: false,
  matches: [{ list: "OFAC SDN", name: "KANGEN MARITIME CORPORATION", score: 0.666667 }],
  lists: ["OFAC SDN", "OFAC SDN aliases", "UN Consolidated"],
  match_score: 0.666667,
  verdict: "verified",
  confidence: 0.9,
};

const HIT_SCREEN = {
  ...CLEAR_SCREEN,
  matched: true,
  match_score: 0.91,
  matches: [{ list: "OFAC SDN", name: "ARES CAPITAL CORP", score: 0.91 }],
};

const ACTIVE_REGISTRY = {
  legal_name: "ARES CAPITAL CORPORATION",
  registration_id: "D07905672",
  active: true,
  jurisdiction: "US-MD",
  registered_address: "C/O UNITED AGENT GROUP INC., LUTHERVILLE-TIMONIUM, US-MD",
  incorporated: "2004-04-16",
  lei: "WEQ82666OJYSI5GUAB47",
  lookup_status: "found",
  verdict: "verified",
};

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

const S_URL = "https://verireceipt.onrender.com/v1/sanctions-screen?name=Ares+Capital+Corporation";
const R_URL = "https://verireceipt.onrender.com/v1/corporate-registry?company=Ares+Capital+Corporation&jurisdiction=US-MD";
const F_URL = "https://verireceipt.onrender.com/v1/filings?entity=ARCC&period=last+12+months&form_type=10-Q";

const okScreen = () => verified("SANCTIONS_SCREENING_MATCH_GENERAL", S_URL, CLEAR_SCREEN, SANCTIONS_RECEIPT);
const okRegistry = () => verified("CORPORATE_REGISTRY_LOOKUP_GENERAL", R_URL, ACTIVE_REGISTRY, REGISTRY_RECEIPT);
const okFilings = () => verified("REGULATORY_FILING_MONITOR_GENERAL", F_URL, LIVE_10Q, FILINGS_RECEIPT);

describe("M04 overnight diligence preset", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds three checks carrying the name, company+jurisdiction, and ticker+form+period on the wire", () => {
    const p = preset("m04-diligence");
    const checks = p.buildChecks(p.inputs);
    expect(checks).toHaveLength(3);
    const [s, r, f] = checks;
    expect(new URL(s.requestUrl).searchParams.get("name")).toBe("Ares Capital Corporation");
    expect(new URL(r.requestUrl).searchParams.get("company")).toBe("Ares Capital Corporation");
    expect(new URL(r.requestUrl).searchParams.get("jurisdiction")).toBe("US-MD");
    const fu = new URL(f.requestUrl);
    expect(fu.searchParams.get("entity")).toBe("ARCC");
    expect(fu.searchParams.get("form_type")).toBe("10-Q");
    expect(fu.searchParams.get("period")).toBe("last 12 months");
    expect(s.intent).toBe("SANCTIONS_SCREENING_MATCH_GENERAL");
    expect(r.intent).toBe("CORPORATE_REGISTRY_LOOKUP_GENERAL");
  });

  it("getSanctionsScreen and getCorporateRegistry send their params on the wire", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      seen.push(String(url));
      const body = String(url).includes("sanctions")
        ? { ...CLEAR_SCREEN, receipt: SANCTIONS_RECEIPT }
        : { ...ACTIVE_REGISTRY, receipt: REGISTRY_RECEIPT };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    });
    const s = await getSanctionsScreen({ name: "Ares Capital Corporation" });
    const r = await getCorporateRegistry({ company: "Ares Capital Corporation", jurisdiction: "US-MD" });
    expect(new URL(seen[0], "http://x").searchParams.get("name")).toBe("Ares Capital Corporation");
    expect(new URL(seen[1], "http://x").searchParams.get("jurisdiction")).toBe("US-MD");
    expect(s.matched).toBe(false);
    expect(r.active).toBe(true);
  });

  it("APPROVEs only when all three legs pass under the stated rule", () => {
    const p = preset("m04-diligence");
    const out = p.evaluate([okScreen(), okRegistry(), okFilings()]);
    expect(out.verdict).toBe("APPROVE");
    expect(out.score).toBe(100);
    expect(out.headline).toContain("diligence pass");
  });

  it("HOLDs blocked-pending-review on a sanctions match above threshold, never a public finding", () => {
    const p = preset("m04-diligence");
    const out = p.evaluate([
      verified("SANCTIONS_SCREENING_MATCH_GENERAL", S_URL, HIT_SCREEN, SANCTIONS_RECEIPT),
      okRegistry(),
      okFilings(),
    ]);
    expect(out.verdict).toBe("HOLD");
    expect(out.verdict).not.toBe("REJECT");
    expect(out.headline).toContain("blocked pending review");
    expect(out.headline).toContain("not identity confirmation");
  });

  it("HOLDs when any leg fails verification", () => {
    const p = preset("m04-diligence");
    const out = p.evaluate([refused("SANCTIONS_SCREENING_MATCH_GENERAL", S_URL), okRegistry(), okFilings()]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).not.toContain("diligence pass");
    expect(out.score).toBe(67);
  });

  it("HOLDs with NEEDS REVIEW when the registry record is not active", () => {
    const p = preset("m04-diligence");
    const out = p.evaluate([
      okScreen(),
      verified("CORPORATE_REGISTRY_LOOKUP_GENERAL", R_URL, { ...ACTIVE_REGISTRY, active: false }, REGISTRY_RECEIPT),
      okFilings(),
    ]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toContain("NEEDS REVIEW");
  });

  it("HOLDs with NEEDS REVIEW when no 10-Q was filed in the window", () => {
    const p = preset("m04-diligence");
    const none = { ...LIVE_10Q, filing_count: 0, filings: [], filings_detail: [], urls: [] };
    const out = p.evaluate([okScreen(), okRegistry(), verified("REGULATORY_FILING_MONITOR_GENERAL", F_URL, none, FILINGS_RECEIPT)]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toContain("NEEDS REVIEW");
    expect(out.score).toBe(67);
  });

  it("VERIFIED, never a diligence pass, outside the 10-Q / last-12-months rule", () => {
    const p = preset("m04-diligence");
    const inputs = { entity: "Ares Capital Corporation", ref: "10-K", scope: "last 12 months · ARCC · US-MD" };
    const checks = p.buildChecks(inputs);
    expect(new URL(checks[2].requestUrl).searchParams.get("form_type")).toBe("10-K");
    const kBody = { ...LIVE_10Q, form_type: "10-K", filings_detail: [{ form: "10-K", accession: "x", filing_date: "2026-03-01", url: "https://www.sec.gov/x" }] };
    const out = p.evaluate([
      okScreen(),
      okRegistry(),
      verified("REGULATORY_FILING_MONITOR_GENERAL", checks[2].requestUrl, kBody, FILINGS_RECEIPT),
    ]);
    expect(out.verdict).toBe("VERIFIED");
    expect(out.headline).toContain("Data verified");
    expect(out.headline).not.toContain("diligence pass");
  });
});
