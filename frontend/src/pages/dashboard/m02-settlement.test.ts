// Mission 02 "Pre-Settlement Compliance Screen" preset.
// Two live checks: a sanctions screen on the declared payee and a reserve
// attestation on the declared asset. APPROVE only when both verify AND the
// sanctions best score is below the declared 0.85 threshold AND the attested
// reserve clears the declared 100,000,000 whole-unit floor on a fresh feed.
// Anything unverified is HOLD; a verified sanctions hit is HOLD pending
// review (a fuzzy match is not identity confirmation), never a REJECT;
// a stale reserve feed is HOLD; only the declared reserve floor may REJECT
// (a floor screen, not a solvency opinion). The settlement is always
// simulated; no wallet, signing or transfer exists in this page.

import { afterEach, describe, expect, it, vi } from "vitest";
import { getReserveAttestation, getSanctionsScreen } from "../../lib/api";
import { DESK_PRESETS, type DeskCheckResult } from "./presets";
import { toLiveReceipt } from "./utils";

const SANCTIONS_RECEIPT = {
  receipt_id: "rcpt_M02S000000000000000001",
  intent: "SANCTIONS_SCREENING_MATCH_GENERAL",
  upstream_url: "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV",
  raw_response_sha256: "a".repeat(64),
  quorum_votes: "3/3 published lists parsed",
  fetched_at: "2026-11-25T01:29:00.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_M02S000000000000000001",
};

const RESERVE_RECEIPT = {
  receipt_id: "rcpt_M02R000000000000000001",
  intent: "ASSET_RESERVE_ATTESTATION_GENERAL",
  upstream_url: "ethereum RPC quorum, Chainlink PoR 0xBE456fd14720C3aCCc30A2013Bffd782c9Cb75D5",
  raw_response_sha256: "b".repeat(64),
  quorum_votes: "Chainlink Proof of Reserve via 2-of-N RPC quorum",
  fetched_at: "2026-11-25T01:29:00.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_M02R000000000000000001",
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

// Live shapes checked 2026-11-25 01:29 UTC (unbilled probes).
const SANCTIONS_BODY = {
  name: "Ares Capital Corporation",
  matched: false,
  match_score: 0.666667,
  lists: ["OFAC SDN", "OFAC SDN aliases", "UN Consolidated"],
  threshold: null,
  verdict: "verified",
  confidence: 0.9,
  checked_at: "2026-11-25T01:29:21.714Z",
};

const RESERVE_BODY = {
  attested_reserve: 501928900880000,
  asset: "TUSD",
  reserve_units: 501928900.88,
  verdict: "verified",
  confidence: 0.9,
  round_id: "55340232221128655713",
  updated_at: "2026-11-24T04:24:47.000Z",
  feed_age_seconds: 75875,
  heartbeat_seconds: 86400,
};

const S_URL = "https://verireceipt.onrender.com/v1/sanctions-screen?name=Ares+Capital+Corporation";
const R_URL = "https://verireceipt.onrender.com/v1/reserve-attestation?asset=TUSD";

const okSanctions = () => verified("SANCTIONS_SCREENING_MATCH_GENERAL", S_URL, SANCTIONS_BODY, SANCTIONS_RECEIPT);
const okReserve = () => verified("ASSET_RESERVE_ATTESTATION_GENERAL", R_URL, RESERVE_BODY, RESERVE_RECEIPT);

describe("M02 pre-settlement compliance screen preset", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds two checks carrying the payee name and the reserve asset on the wire", () => {
    const p = preset("m02-settlement");
    const checks = p.buildChecks(p.inputs);
    expect(checks).toHaveLength(2);
    const [s, r] = checks;
    expect(new URL(s.requestUrl).searchParams.get("name")).toBe("Ares Capital Corporation");
    expect(new URL(r.requestUrl).searchParams.get("asset")).toBe("TUSD");
    expect(s.intent).toBe("SANCTIONS_SCREENING_MATCH_GENERAL");
    expect(r.intent).toBe("ASSET_RESERVE_ATTESTATION_GENERAL");
  });

  it("declares the simulation scope in its inputs", () => {
    expect(preset("m02-settlement").inputs.scope).toContain("simulated");
    expect(preset("m02-settlement").inputs.scope).toContain("no funds move");
  });

  it("APPROVEs the simulated settlement when both checks verify and clear the declared thresholds", () => {
    const out = preset("m02-settlement").evaluate([okSanctions(), okReserve()]);
    expect(out.verdict).toBe("APPROVE");
    expect(out.score).toBe(100);
    expect(out.headline).toContain("Simulated settlement authorized");
    expect(out.headline).toContain("No funds move");
    expect(out.headline).toContain("attested, not audited");
    expect(out.headline).toContain("not legal clearance or investment advice");
    const sCard = out.why.find((c) => c.k === "Sanctions Screen")!;
    expect(sCard.v).toContain("0.666667");
    expect(sCard.v).toContain("0.85");
    expect(sCard.ok).toBe(true);
    const rCard = out.why.find((c) => c.k === "Attested Reserve")!;
    expect(rCard.v).toContain("501,928,900");
    expect(rCard.ok).toBe(true);
  });

  it("HOLDs for review when the sanctions score meets the declared threshold, never a REJECT on a fuzzy match", () => {
    const hot = verified("SANCTIONS_SCREENING_MATCH_GENERAL", S_URL, { ...SANCTIONS_BODY, matched: true, match_score: 0.91 }, SANCTIONS_RECEIPT);
    const out = preset("m02-settlement").evaluate([hot, okReserve()]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toContain("NEEDS REVIEW");
    expect(out.headline).toContain("0.91");
    expect(out.headline).toContain("a fuzzy match is not identity confirmation");
    expect(out.headline).toContain("no funds move");
    expect(out.why.find((c) => c.k === "Sanctions Screen")!.ok).toBe(false);
    expect(out.why.find((c) => c.k === "Attested Reserve")!.ok).toBe(true);
  });

  it("HOLDs when the sanctions hit and the reserve floor both fail", () => {
    const hot = verified("SANCTIONS_SCREENING_MATCH_GENERAL", S_URL, { ...SANCTIONS_BODY, matched: true, match_score: 0.91 }, SANCTIONS_RECEIPT);
    const thin = verified("ASSET_RESERVE_ATTESTATION_GENERAL", R_URL, { ...RESERVE_BODY, attested_reserve: 99999999999999 }, RESERVE_RECEIPT);
    const out = preset("m02-settlement").evaluate([hot, thin]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toContain("NEEDS REVIEW");
    expect(out.headline).toContain("a fuzzy match is not identity confirmation");
    expect(out.why.find((c) => c.k === "Sanctions Screen")!.ok).toBe(false);
    expect(out.why.find((c) => c.k === "Attested Reserve")!.ok).toBe(false);
  });

  it("HOLDs when the reserve feed is older than its heartbeat, even above the floor", () => {
    const stale = verified("ASSET_RESERVE_ATTESTATION_GENERAL", R_URL, { ...RESERVE_BODY, feed_age_seconds: 90000 }, RESERVE_RECEIPT);
    const out = preset("m02-settlement").evaluate([okSanctions(), stale]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toContain("NEEDS REVIEW");
    expect(out.headline).toContain("older than its heartbeat");
    expect(out.headline).toContain("attested, not audited");
    expect(out.why.find((c) => c.k === "Attested Reserve")!.ok).toBe(false);
  });

  it("REJECTs when the attested reserve alone is below the declared floor on verified data", () => {
    const thin = verified("ASSET_RESERVE_ATTESTATION_GENERAL", R_URL, { ...RESERVE_BODY, attested_reserve: 99999999999999 }, RESERVE_RECEIPT);
    const out = preset("m02-settlement").evaluate([okSanctions(), thin]);
    expect(out.verdict).toBe("REJECT");
    expect(out.headline).toContain("below the declared floor");
    expect(out.headline).toContain("declared rule outcome");
    expect(out.headline).toContain("not a solvency opinion");
    expect(out.why.find((c) => c.k === "Attested Reserve")!.ok).toBe(false);
  });

  it("HOLDs as unverified when the reserve response omits feed freshness metadata", () => {
    const noAge = verified("ASSET_RESERVE_ATTESTATION_GENERAL", R_URL, { ...RESERVE_BODY, feed_age_seconds: undefined }, RESERVE_RECEIPT);
    const out = preset("m02-settlement").evaluate([okSanctions(), noAge]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toContain("Evidence did not verify");
    expect(out.why.find((c) => c.k === "Attested Reserve")!.ok).toBe(false);
  });

  it("HOLDs when the sanctions screen does not verify, never authorizing", () => {
    const out = preset("m02-settlement").evaluate([refused("SANCTIONS_SCREENING_MATCH_GENERAL", S_URL), okReserve()]);
    expect(out.verdict).toBe("HOLD");
    expect(out.score).toBe(50);
    expect(out.headline).toContain("not authorized");
    expect(out.why.find((c) => c.k === "Sanctions Screen")!.ok).toBe(false);
  });

  it("HOLDs when the reserve attestation does not verify, never authorizing", () => {
    const out = preset("m02-settlement").evaluate([okSanctions(), refused("ASSET_RESERVE_ATTESTATION_GENERAL", R_URL)]);
    expect(out.verdict).toBe("HOLD");
    expect(out.score).toBe(50);
  });

  it("HOLDs when both checks fail and reports a zero verification score", () => {
    const out = preset("m02-settlement").evaluate([refused("SANCTIONS_SCREENING_MATCH_GENERAL", S_URL), refused("ASSET_RESERVE_ATTESTATION_GENERAL", R_URL)]);
    expect(out.verdict).toBe("HOLD");
    expect(out.score).toBe(0);
  });

  it("sends the declared payee and asset to the live endpoints", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return Response.json({ error: "unit" }, { status: 503 });
    });
    const checks = preset("m02-settlement").buildChecks(preset("m02-settlement").inputs);
    await Promise.allSettled(checks.map((c) => c.run()));
    expect(seen.some((u) => u.includes("/v1/sanctions-screen") && u.includes("Ares"))).toBe(true);
    expect(seen.some((u) => u.includes("/v1/reserve-attestation") && u.includes("asset=TUSD"))).toBe(true);
  });

  it("exposes both live clients", () => {
    expect(typeof getSanctionsScreen).toBe("function");
    expect(typeof getReserveAttestation).toBe("function");
  });
});
