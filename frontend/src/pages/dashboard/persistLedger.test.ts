import { beforeEach, describe, expect, it } from "vitest";
import {
  bumpLedgerGeneration,
  readLedgerGeneration,
  readSessionReceipts,
} from "../../lib/sessionReceipts";
import type { Receipt } from "../../lib/types";
import { persistLiveReceiptToSessionLedger, probe, toLiveReceipt } from "./utils";
import type { LiveReceipt } from "./types";

function receipt(id = "rcpt_test1"): Receipt {
  return {
    receipt_id: id,
    upstream_url: "https://example.com/upstream",
    raw_response_sha256: `0x${"a".repeat(64)}`,
    fetched_at: "2026-11-20T10:00:00Z",
  };
}

function liveReceipt(
  intent: string,
  query: string,
  requestUrl: string,
  body: unknown,
  rcpt: Receipt | null = receipt(),
): LiveReceipt {
  return toLiveReceipt(intent, query, requestUrl, {
    ok: true,
    body,
    receipt: rcpt,
    latencyMs: 123,
    // localStorage is cleared in beforeEach, so the stored generation
    // is 0 — the row is current unless a test bumps it (J2 R6).
    ledgerGenAtStart: 0,
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("persistLiveReceiptToSessionLedger (2026-11-20 click-test defect 2)", () => {
  it.each([
    ["ONCHAIN_TX_LOOKUP_GENERAL", "tx", "https://verireceipt.onrender.com/v1/tx?tx_hash=0xabc&chain=ethereum"],
    ["REGULATORY_FILING_MONITOR_GENERAL", "filings", "https://verireceipt.onrender.com/v1/filings?entity=AAPL&period=last+12+months"],
    ["TVL_LOOKUP_GENERAL", "tvl", "https://verireceipt.onrender.com/v1/tvl?protocol=aave-v3"],
    ["OPTIMAL_EXECUTION_ROUTE_GENERAL", "route", "https://verireceipt.onrender.com/v1/route?pair=ETH%2FUSDC"],
    ["GRID_POWER_PRICE_GENERAL", "grid", "https://verireceipt.onrender.com/v1/grid-price?node_or_zone=ZONE_J&interval_start=2026-11-20T11%3A00%3A00Z"],
  ])("persists a %s receipt as a %s ledger entry", (intent, endpoint, url) => {
    const row = liveReceipt(intent, "query text", url, { answer: "live answer" });
    expect(persistLiveReceiptToSessionLedger(row)).toBe("persisted");
    const { entries } = readSessionReceipts();
    expect(entries).toHaveLength(1);
    expect(entries[0].endpoint).toBe(endpoint);
    expect(entries[0].summary).toBe("live answer");
    expect(entries[0].params).toBe(new URL(url).search.slice(1));
  });

  it("keeps two identical dashboard calls that share one receipt_id (J2 R2 B1)", () => {
    // The same not_found answer twice: the old receipt_id dedupe
    // collapsed the burst to one row on /receipts. The dashboard key
    // (lr-<seq>-…) is unique per call, so both rows survive.
    const url = "https://verireceipt.onrender.com/v1/tx?tx_hash=0xabc&chain=ethereum";
    const first = liveReceipt("ONCHAIN_TX_LOOKUP_GENERAL", "0xabc (ethereum)", url, {
      answer: "not found",
    });
    const second = liveReceipt("ONCHAIN_TX_LOOKUP_GENERAL", "0xabc (ethereum)", url, {
      answer: "not found",
    });
    expect(first.key).not.toBe(second.key);
    expect(first.receipt?.receipt_id).toBe(second.receipt?.receipt_id);
    expect(persistLiveReceiptToSessionLedger(first)).toBe("persisted");
    expect(persistLiveReceiptToSessionLedger(second)).toBe("persisted");
    expect(readSessionReceipts().entries).toHaveLength(2);
  });

  it("reports 'failed' when the shared ledger refuses the write (J2 R2 M2)", () => {
    window.localStorage.setItem("verireceipt.session-receipts.v1", "{not json");
    const row = liveReceipt(
      "TVL_LOOKUP_GENERAL",
      "protocol=aave-v3",
      "https://verireceipt.onrender.com/v1/tvl?protocol=aave-v3",
      { answer: "live answer" },
    );
    expect(persistLiveReceiptToSessionLedger(row)).toBe("failed");
    expect(readSessionReceipts().entries).toHaveLength(0);
  });

  it("carries the tx hash so the ledger can replay the JSON-RPC verification", () => {
    const row = liveReceipt(
      "ONCHAIN_TX_LOOKUP_GENERAL",
      "0xabc (ethereum)",
      "https://verireceipt.onrender.com/v1/tx?tx_hash=0xabc&chain=ethereum",
      { answer: "found", tx_hash: "0xabc" },
    );
    expect(persistLiveReceiptToSessionLedger(row)).toBe("persisted");
    expect(readSessionReceipts().entries[0].verifyData?.tx_hash).toBe("0xabc");
  });

  it("carries the four grid evidence fields for the canonical re-hash", () => {
    const row = liveReceipt(
      "GRID_POWER_PRICE_GENERAL",
      "ZONE_J · 2026-11-20T11:00:00Z",
      "https://verireceipt.onrender.com/v1/grid-price?node_or_zone=ZONE_J&interval_start=2026-11-20T11%3A00%3A00Z",
      {
        answer: "LMP $43.79/MWh",
        node_or_zone: "ZONE_J",
        interval_start: "2026-11-20T11:00:00Z",
        lmp_usd_per_mwh: 43.79,
        market: "NYISO",
      },
    );
    expect(persistLiveReceiptToSessionLedger(row)).toBe("persisted");
    expect(readSessionReceipts().entries[0].verifyData).toEqual({
      node_or_zone: "ZONE_J",
      interval_start: "2026-11-20T11:00:00Z",
      lmp_usd_per_mwh: 43.79,
      market: "NYISO",
    });
  });

  it("falls back to the filing count — with its window — when the body carries no answer", () => {
    const row = liveReceipt(
      "REGULATORY_FILING_MONITOR_GENERAL",
      "AAPL · last 12 months",
      "https://verireceipt.onrender.com/v1/filings?entity=AAPL&period=last+12+months",
      { filing_count: 95 },
    );
    expect(persistLiveReceiptToSessionLedger(row)).toBe("persisted");
    expect(readSessionReceipts().entries[0].summary).toBe("95 filings · AAPL · last 12 months");
  });

  it("carries the window when requestUrl is unparseable and only the human-readable query remains (filings J1/J2 R4 M1)", () => {
    // Latent hole: params falls back to receipt.query when requestUrl
    // is unparseable, and the human-readable "AAPL · last 12 months"
    // has no `=` pairs for URLSearchParams — the old code rendered a
    // bare "95 filings". summaryFor now parses the "entity · period"
    // form as a fallback.
    const row = liveReceipt(
      "REGULATORY_FILING_MONITOR_GENERAL",
      "AAPL · last 12 months",
      "not a url",
      { filing_count: 95 },
    );
    expect(persistLiveReceiptToSessionLedger(row)).toBe("persisted");
    expect(readSessionReceipts().entries[0].summary).toBe("95 filings · AAPL · last 12 months");
  });

  it("does not misattribute a window from a query fragment containing '=' (filings J2 R5 N1)", () => {
    // The "·" fallback is for the human form "AAPL · last 12 months"
    // only: a segment containing `=` is a query-string fragment, and
    // filling from it would silently mislabel the window. The guard
    // skips the fallback entirely — bare count, honest rather than wrong.
    const row = liveReceipt(
      "REGULATORY_FILING_MONITOR_GENERAL",
      "foo=bar · baz",
      "not a url",
      { filing_count: 95 },
    );
    expect(persistLiveReceiptToSessionLedger(row)).toBe("persisted");
    expect(readSessionReceipts().entries[0].summary).toBe("95 filings");
  });

  it("does not invent an entity when only the period parses (filings J2 R5 N1)", () => {
    // Mixed path: URLSearchParams parses period="last · 12 months"
    // from this hybrid, entity stays missing, and the fallback must
    // NOT fill it from the `=`-carrying segment (the old code rendered
    // "95 filings · period=last · last · 12 months"). The period
    // echoed is the URLSearchParams value, not a fallback product.
    const row = liveReceipt(
      "REGULATORY_FILING_MONITOR_GENERAL",
      "period=last · 12 months",
      "not a url",
      { filing_count: 95 },
    );
    expect(persistLiveReceiptToSessionLedger(row)).toBe("persisted");
    expect(readSessionReceipts().entries[0].summary).toBe("95 filings · last · 12 months");
  });

  it("does not fill from a three-segment '·' query (filings J2 R5 N1)", () => {
    const row = liveReceipt(
      "REGULATORY_FILING_MONITOR_GENERAL",
      "a · b · c",
      "not a url",
      { filing_count: 95 },
    );
    expect(persistLiveReceiptToSessionLedger(row)).toBe("persisted");
    expect(readSessionReceipts().entries[0].summary).toBe("95 filings");
  });

  it("uses the live answer verbatim when the body carries one (filings J2 R5 N2)", () => {
    // The live filings body always carries `answer` — the filings
    // branch is fallback-only for an answer-less response. The
    // stored summary must be the answer, not a re-derived count.
    const row = liveReceipt(
      "REGULATORY_FILING_MONITOR_GENERAL",
      "AAPL · last 12 months",
      "https://verireceipt.onrender.com/v1/filings?entity=AAPL&period=last+12+months",
      { filing_count: 95, answer: "Found 95 filings for AAPL in last 12 months." },
    );
    expect(persistLiveReceiptToSessionLedger(row)).toBe("persisted");
    expect(readSessionReceipts().entries[0].summary).toBe(
      "Found 95 filings for AAPL in last 12 months.",
    );
  });

  it("does not persist health checks (no receipt block, not a ledger intent)", () => {
    const row = liveReceipt(
      "HEALTH",
      "GET /health",
      "https://verireceipt.onrender.com/health",
      { status: "ok" },
    );
    expect(persistLiveReceiptToSessionLedger(row)).toBe("skipped");
    expect(readSessionReceipts().entries).toHaveLength(0);
  });

  it("does not persist refusals (receipt is null)", () => {
    const row = toLiveReceipt("TVL_LOOKUP_GENERAL", "protocol=nope", "https://example.com", {
      ok: false,
      body: { error: "not_found" },
      latencyMs: 50,
      status: 404,
      errorCode: "NOT_FOUND",
      errorMessage: "nope",
    });
    expect(row.receipt).toBeNull();
    expect(persistLiveReceiptToSessionLedger(row)).toBe("skipped");
    expect(readSessionReceipts().entries).toHaveLength(0);
  });

  it("does not misattribute a window from an encoded '=' (filings J2 R6 #1)", () => {
    // URLSearchParams decodes %3D to `=`, so the old guard — which
    // checked only for a literal `=` in the raw segment — admitted
    // "foo%3Dbar" as an entity. The guard now rejects the encoded form
    // the same way as the literal one.
    const row = liveReceipt(
      "REGULATORY_FILING_MONITOR_GENERAL",
      "foo%3Dbar · baz",
      "not a url",
      { filing_count: 95 },
    );
    expect(persistLiveReceiptToSessionLedger(row)).toBe("persisted");
    expect(readSessionReceipts().entries[0].summary).toBe("95 filings");
  });

  it("does not misattribute a window from an encoded entity key (filings J2 R6 #2)", () => {
    const row = liveReceipt(
      "REGULATORY_FILING_MONITOR_GENERAL",
      "entity%3DAAPL · last 12 months",
      "not a url",
      { filing_count: 95 },
    );
    expect(persistLiveReceiptToSessionLedger(row)).toBe("persisted");
    expect(readSessionReceipts().entries[0].summary).toBe("95 filings");
  });

  it("does not invent an entity from a trailing '&' fragment (filings J2 R6 #3)", () => {
    // The human form "AAPL · last 12 months" with a query fragment
    // appended used to yield entity MSFT from URLSearchParams — the
    // pre-pass ran on a string that is not a query string. The shape
    // check now refuses the pre-pass unless every `&` segment is a
    // key=value pair, so the human fallback sees the `=` in the second
    // segment and falls through to a bare count.
    const row = liveReceipt(
      "REGULATORY_FILING_MONITOR_GENERAL",
      "AAPL · last 12 months&entity=MSFT",
      "not a url",
      { filing_count: 95 },
    );
    expect(persistLiveReceiptToSessionLedger(row)).toBe("persisted");
    expect(readSessionReceipts().entries[0].summary).toBe("95 filings");
  });

  it("still reads entity + period from a real query string (shape pin)", () => {
    // The shape check must not break the real path: a genuine
    // "entity=AAPL&period=last 12 months" still parses via
    // URLSearchParams, including a `·` inside the period value.
    const row = liveReceipt(
      "REGULATORY_FILING_MONITOR_GENERAL",
      "entity=AAPL&period=last 12 months",
      "not a url",
      { filing_count: 95 },
    );
    expect(persistLiveReceiptToSessionLedger(row)).toBe("persisted");
    expect(readSessionReceipts().entries[0].summary).toBe("95 filings · AAPL · last 12 months");
  });

  it("skips (not failed) a row whose call predates a Clear in another tab (J2 R6 cross-tab)", async () => {
    // The dashboard variant of the cross-tab resurrection: probe()
    // stamps the stored generation at call start; a Clear in another
    // tab bumps it, so persist must drop the row silently — 'skipped',
    // never 'failed' (no toast), and the store stays empty.
    const outcome = await probe(
      async () => ({ answer: "live answer", receipt: receipt() }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("probe unexpectedly failed");
    expect(outcome.ledgerGenAtStart).toBe(0);
    // Another tab clears while the call was in flight.
    bumpLedgerGeneration();
    expect(readLedgerGeneration()).toBe(1);
    const row = toLiveReceipt(
      "TVL_LOOKUP_GENERAL",
      "protocol=aave-v3",
      "https://verireceipt.onrender.com/v1/tvl?protocol=aave-v3",
      outcome,
    );
    expect(persistLiveReceiptToSessionLedger(row)).toBe("skipped");
    expect(readSessionReceipts().entries).toHaveLength(0);
  });

  it("persists a row whose generation is current (cross-tab control)", async () => {
    const outcome = await probe(
      async () => ({ answer: "live answer", receipt: receipt() }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("probe unexpectedly failed");
    const row = toLiveReceipt(
      "TVL_LOOKUP_GENERAL",
      "protocol=aave-v3",
      "https://verireceipt.onrender.com/v1/tvl?protocol=aave-v3",
      outcome,
    );
    expect(row.ledgerGenAtStart).toBe(readLedgerGeneration());
    expect(persistLiveReceiptToSessionLedger(row)).toBe("persisted");
    expect(readSessionReceipts().entries).toHaveLength(1);
  });
});
