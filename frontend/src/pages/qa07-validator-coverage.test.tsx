// QA-07 (external live-site QA, 2026-11-21): /status and /benchmarks
// listed /health + 5 intents and still said "all" — the validator intent
// was never probed. Now both cover /health + all six intents, and a
// validator failure prevents "ALL SYSTEMS UP".

import { readFileSync } from "node:fs";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import Status from "./Status";

const RECEIPT = {
  receipt_id: "rcpt_QA07000000000000000001",
  intent: "X",
  upstream_url: "https://example.org",
  raw_response_sha256: "d".repeat(64),
  quorum_votes: "4/4 sources agreed",
  fetched_at: "2026-11-21T16:00:00.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_QA07000000000000000001",
};

function stub(validatorStatus: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(String(url), "http://x");
      const env = (x: Record<string, unknown>) => ({ ...x, answer: "a", verdict: "verified", confidence: 1, source: "s", checked_at: "2026-11-21T16:00:00.000Z", receipt: RECEIPT });
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.pathname.endsWith("/health")) return ok({ status: "ok", service: "verireceipt", uptime_s: 1, upstreams: {} });
      if (u.pathname.endsWith("/v1/tx")) return ok(env({ tx_hash: u.searchParams.get("tx_hash"), status: "confirmed", block_number: 1 }));
      if (u.pathname.endsWith("/v1/filings")) return ok(env({ entity: "AAPL", filing_count: 1, filings: [], urls: [] }));
      if (u.pathname.endsWith("/v1/tvl")) return ok(env({ protocol_or_chain: "aave-v3", tvl_usd: 1, chain_tvl_usd: 1, as_of: "x" }));
      if (u.pathname.endsWith("/v1/route")) return ok(env({ amount_out: 1 }));
      if (u.pathname.endsWith("/v1/grid-price")) return ok(env({ lmp_usd_per_mwh: 1, node_or_zone: "TH_NP15_GEN-APND", market: "CAISO" }));
      if (u.pathname.endsWith("/v1/validator")) {
        return validatorStatus === 200
          ? ok(env({ validator_index: 1, effective_balance: 32000000000, status: "active_ongoing" }))
          : new Response(JSON.stringify({ error: "upstream", code: "UPSTREAM_UNAVAILABLE", message: "beacon down" }), { status: validatorStatus, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "nf" }), { status: 404 });
    }),
  );
}

describe("QA-07 /status covers the validator intent", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("probes /v1/validator and counts 7 checks", async () => {
    stub(200);
    render(<MemoryRouter><Status /></MemoryRouter>);
    expect(screen.getByText("GET /v1/validator")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/7 of 7 checks up · \/health \+ all 6 intent endpoints/)).toBeTruthy());
    expect(screen.getByText("ALL SYSTEMS UP")).toBeTruthy();
  });

  it("a validator failure prevents ALL SYSTEMS UP", async () => {
    stub(503);
    render(<MemoryRouter><Status /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("1 ENDPOINT DOWN")).toBeTruthy());
    expect(screen.queryByText("ALL SYSTEMS UP")).toBeNull();
    expect(screen.getByText(/6 of 7 checks up/)).toBeTruthy();
  });
});

describe("QA-07 /benchmarks measures the validator intent", () => {
  it("the measured population includes /v1/validator and is named", () => {
    const src = readFileSync("src/pages/Benchmarks.tsx", "utf8");
    expect(src).toContain("getValidator({ validator_index: '1' }, signal)");
    expect(src).toContain("Measured population: /health plus all six intent endpoints.");
  });
});
