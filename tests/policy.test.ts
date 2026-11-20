// Desk policy tests — offline, deterministic, no network, no mocks of
// live data: every case feeds literal evidence objects to the pure
// evaluators and asserts the verdict + per-check statuses. 75+ assertions.
//
// Fail-closed drills covered: unverifiable input, 422 refusal on an
// unsupported pair, wrong-location hold, unfinished-interval hold,
// reverted / not-found counterparty tx, sanctions match, thin TVL,
// out-of-range quote, spot deviation, deadband edges.

import { describe, expect, it } from "vitest";
import { ApiError } from "../src/core/errors";
import {
  evaluateM13,
  M13_MAX_ROUTE_DEVIATION,
  M13_MIN_TVL_USD,
  type M13Evidence,
  type M13Input,
} from "../src/desk/policyM13";
import {
  evaluateM12,
  M12_DEADBAND,
  type M12Evidence,
  type M12Input,
} from "../src/desk/policyM12";
import {
  buildM12Evidence,
  buildM13Evidence,
  decideM12,
} from "../src/desk/scenarios";
import { buildEscrowPayment, fillEscrowTemplate, type AskResult } from "../src/desk/telegraphClient";

const CONFIRMED_TX = "0x1b9e2b48eb3510ee1a8aae2fc402139784f32d43b76d5853387cacb484a9a9d3";
const REVERTED_TX = "0x1a1467893eaed124a13164b589f1ed7a70ec203257084a7be27eee8f93bd8ba9";
const NOT_FOUND_TX = "0x0000000000000000000000000000000000000000000000000000000000000001";

function m13Input(over: Partial<M13Input> = {}): M13Input {
  return {
    protocol: "aave-v3",
    tx_hash: CONFIRMED_TX,
    chain: "ethereum",
    issuer_entity: "Apple Inc",
    period: "last 12 months",
    trade_pair: "ETH/USDC",
    ...over,
  };
}

function m13Evidence(over: Partial<M13Evidence> = {}): M13Evidence {
  return {
    tx: { status: "confirmed", chain: "ethereum", tx_hash: CONFIRMED_TX, block_number: 26454409 },
    filings: { entity: "Apple Inc", filing_count: 12 },
    tvl: { tvl_usd: 15_000_000_000, protocol_or_chain: "aave-v3" },
    route: { amount_out: 3_000_000_000, pair: "ETH/USDC" },
    price: { price_usd: 3000, symbol: "ETH" },
    sanctions: { matched: false, name: "Apple Inc", match_score: 0.12 },
    ...over,
  };
}

function checkById(result: { checks: Array<{ id: string; status: string }> }, id: string) {
  const c = result.checks.find((x) => x.id === id);
  expect(c).toBeDefined();
  return c as { id: string; status: string; reason: string };
}

function expectApiError(fn: () => unknown, status: number, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(status);
    expect(apiErr.code).toBe(code);
    return;
  }
  throw new Error(`expected ApiError ${status}/${code} but the call succeeded`);
}

describe("M13 validation (refusals, never verdicts)", () => {
  it("rejects a too-short tx hash with 400", () => {
    expectApiError(() => evaluateM13(m13Input({ tx_hash: "0x1234" }), m13Evidence()), 400, "INVALID_TX_HASH");
  });
  it("rejects a tx hash without 0x with 400", () => {
    expectApiError(
      () => evaluateM13(m13Input({ tx_hash: CONFIRMED_TX.slice(2) }), m13Evidence()),
      400,
      "INVALID_TX_HASH",
    );
  });
  it("rejects an unknown chain with 400", () => {
    expectApiError(() => evaluateM13(m13Input({ chain: "solana" }), m13Evidence()), 400, "INVALID_CHAIN");
  });
  it("rejects an empty protocol with 400", () => {
    expectApiError(() => evaluateM13(m13Input({ protocol: "  " }), m13Evidence()), 400, "INVALID_PROTOCOL");
  });
  it("rejects an empty issuer with 400", () => {
    expectApiError(() => evaluateM13(m13Input({ issuer_entity: "" }), m13Evidence()), 400, "INVALID_ISSUER");
  });
  it("rejects an empty period with 400", () => {
    expectApiError(() => evaluateM13(m13Input({ period: "" }), m13Evidence()), 400, "INVALID_PERIOD");
  });
  it("refuses BTC/USD with 422 UNSUPPORTED_TRADE_PAIR", () => {
    expectApiError(
      () => evaluateM13(m13Input({ trade_pair: "BTC/USD" }), m13Evidence()),
      422,
      "UNSUPPORTED_TRADE_PAIR",
    );
  });
  it("refuses an empty trade pair with 422", () => {
    expectApiError(
      () => evaluateM13(m13Input({ trade_pair: "" }), m13Evidence()),
      422,
      "UNSUPPORTED_TRADE_PAIR",
    );
  });
  it("accepts a lowercase eth/usdc pair (normalised)", () => {
    const r = evaluateM13(m13Input({ trade_pair: "eth/usdc" }), m13Evidence());
    expect(r.verdict).toBe("APPROVE");
    expect(r.input.trade_pair).toBe("ETH/USDC");
  });
});

describe("M13 verdicts", () => {
  it("APPROVEs when every check passes", () => {
    const r = evaluateM13(m13Input(), m13Evidence());
    expect(r.verdict).toBe("APPROVE");
    expect(r.checks).toHaveLength(8);
    expect(r.checks.every((c) => c.status === "pass")).toBe(true);
    expect(r.why).toHaveLength(8);
    expect(r.why[0]).toContain("PASS");
  });

  it("REJECTs a reverted counterparty tx", () => {
    const r = evaluateM13(m13Input({ tx_hash: REVERTED_TX }), m13Evidence({
      tx: { status: "reverted", chain: "ethereum", tx_hash: REVERTED_TX },
    }));
    expect(r.verdict).toBe("REJECT");
    expect(checkById(r, "tx_status").status).toBe("reject");
    expect(checkById(r, "tx_status").reason).toContain("reverted");
  });

  it("REJECTs a counterparty tx that does not exist", () => {
    const r = evaluateM13(m13Input({ tx_hash: NOT_FOUND_TX }), m13Evidence({
      tx: { status: "not_found", chain: "ethereum", tx_hash: NOT_FOUND_TX },
    }));
    expect(r.verdict).toBe("REJECT");
    expect(checkById(r, "tx_status").status).toBe("reject");
  });

  it("REJECTs a sanctions match even when everything else passes", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      sanctions: { matched: true, name: "Apple Inc", match_score: 0.97, lists: ["OFAC SDN"] },
    }));
    expect(r.verdict).toBe("REJECT");
    expect(checkById(r, "sanctions").status).toBe("reject");
    expect(checkById(r, "sanctions").reason).toContain("OFAC SDN");
  });

  it("REJECTs a chain mismatch", () => {
    const r = evaluateM13(m13Input({ chain: "base" }), m13Evidence({
      tx: { status: "confirmed", chain: "ethereum", tx_hash: CONFIRMED_TX },
    }));
    expect(r.verdict).toBe("REJECT");
    expect(checkById(r, "tx_chain").status).toBe("reject");
  });

  it("REJECTs a tx_hash mismatch (answer names a different transaction)", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      tx: { status: "confirmed", chain: "ethereum", tx_hash: "0xabababababababababababababababababababababababababababababababab" },
    }));
    expect(r.verdict).toBe("REJECT");
    expect(checkById(r, "tx_hash").status).toBe("reject");
    expect(checkById(r, "tx_hash").reason).toContain("0xabab");
  });

  it("HOLDs when the tx lookup returns no tx_hash (identity cannot be bound)", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      tx: { status: "confirmed", chain: "ethereum" },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "tx_hash").status).toBe("unverifiable");
  });

  it("HOLDs when the tx lookup returns no chain (fail-closed, no echo fallback)", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      tx: { status: "confirmed", tx_hash: CONFIRMED_TX },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "tx_chain").status).toBe("unverifiable");
  });

  it("HOLDs when filings name no entity (count cannot be bound)", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      filings: { filing_count: 12 },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "filings").status).toBe("hold");
  });

  it("HOLDs when TVL names no protocol (figure cannot be bound)", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      tvl: { tvl_usd: 15_000_000_000 },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "tvl").status).toBe("hold");
  });

  it("HOLDs a pending counterparty tx (settlement unproven)", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      tx: { status: "pending", chain: "ethereum", tx_hash: CONFIRMED_TX },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "tx_status").status).toBe("unverifiable");
  });

  it("HOLDs when the tx lookup returns nothing (fail-closed drill)", () => {
    const r = evaluateM13(m13Input(), m13Evidence({ tx: null }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "tx_status").status).toBe("unverifiable");
    expect(checkById(r, "tx_chain").status).toBe("unverifiable");
  });

  it("HOLDs when the tx lookup returns an unknown status", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      tx: { status: "weird", chain: "ethereum" },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "tx_status").status).toBe("unverifiable");
  });

  it("HOLDs on zero filings for the issuer in the period", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      filings: { entity: "Apple Inc", filing_count: 0 },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "filings").status).toBe("unverifiable");
  });

  it("HOLDs when filings name a different entity", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      filings: { entity: "Microsoft Corporation", filing_count: 9 },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "filings").status).toBe("unverifiable");
  });

  it("HOLDs when filings evidence is missing", () => {
    const r = evaluateM13(m13Input(), m13Evidence({ filings: null }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "filings").status).toBe("unverifiable");
  });

  it("HOLDs a protocol below the $1M TVL minimum", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      tvl: { tvl_usd: M13_MIN_TVL_USD - 1, protocol_or_chain: "aave-v3" },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "tvl").status).toBe("hold");
  });

  it("APPROVEs a protocol exactly at the $1M TVL minimum", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      tvl: { tvl_usd: M13_MIN_TVL_USD, protocol_or_chain: "aave-v3" },
    }));
    expect(r.verdict).toBe("APPROVE");
    expect(checkById(r, "tvl").status).toBe("pass");
  });

  it("HOLDs when TVL names a different protocol", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      tvl: { tvl_usd: 15_000_000_000, protocol_or_chain: "uniswap" },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "tvl").status).toBe("unverifiable");
  });

  it("HOLDs when TVL evidence is missing", () => {
    const r = evaluateM13(m13Input(), m13Evidence({ tvl: null }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "tvl").status).toBe("unverifiable");
  });

  it("HOLDs a quote below the intent's declared amount_out range", () => {
    const r = evaluateM13(m13Input(), m13Evidence({ route: { amount_out: 99_999_999, pair: "ETH/USDC" } }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "route").status).toBe("hold");
  });

  it("HOLDs a quote above the intent's declared amount_out range", () => {
    const r = evaluateM13(m13Input(), m13Evidence({ route: { amount_out: 100_000_000_001, pair: "ETH/USDC" } }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "route").status).toBe("hold");
  });

  it("HOLDs when the route quote is missing", () => {
    const r = evaluateM13(m13Input(), m13Evidence({ route: null }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "route").status).toBe("unverifiable");
  });

  it("HOLDs when the quote deviates more than 2% from independent spot", () => {
    // Implied $3,300 vs spot $3,000 = +10% deviation.
    const r = evaluateM13(m13Input(), m13Evidence({
      route: { amount_out: 3_300_000_000, pair: "ETH/USDC" },
      price: { price_usd: 3000, symbol: "ETH" },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "route_vs_spot").status).toBe("hold");
    expect(checkById(r, "route_vs_spot").reason).toContain("10.00%");
  });

  it("HOLDs a route deviating +2.5% from spot (just over the limit)", () => {
    // Implied $3,075 vs spot $3,000 = +2.5% deviation.
    const r = evaluateM13(m13Input(), m13Evidence({
      route: { amount_out: 3_075_000_000, pair: "ETH/USDC" },
      price: { price_usd: 3000, symbol: "ETH" },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "route_vs_spot").status).toBe("hold");
    expect(checkById(r, "route_vs_spot").reason).toContain("2.50%");
  });

  it("HOLDs a $100 quote for 1 ETH against a $3,000 spot (absurd quote cannot APPROVE)", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      route: { amount_out: 100_000_000, pair: "ETH/USDC" },
      price: { price_usd: 3000, symbol: "ETH" },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "route_vs_spot").status).toBe("hold");
  });

  it("APPROVEs a quote exactly at the 2% deviation limit", () => {
    // Implied $3,060 vs spot $3,000 = exactly +2%.
    const r = evaluateM13(m13Input(), m13Evidence({
      route: { amount_out: 3_060_000_000, pair: "ETH/USDC" },
      price: { price_usd: 3000, symbol: "ETH" },
    }));
    expect(r.verdict).toBe("APPROVE");
    expect(checkById(r, "route_vs_spot").status).toBe("pass");
    expect(M13_MAX_ROUTE_DEVIATION).toBe(0.02);
  });

  it("HOLDs when no price evidence was bought (a missing spot price can no longer be skipped into APPROVE)", () => {
    const ev = m13Evidence();
    delete ev.price;
    const r = evaluateM13(m13Input(), ev);
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "route_vs_spot").status).toBe("unverifiable");
    expect(checkById(r, "route_vs_spot").reason.length).toBeGreaterThan(0);
    expect(checkById(r, "route_vs_spot").reason).toContain("No independent spot-price");
  });

  it("marks sanctions SKIPPED when no sanctions evidence was bought", () => {
    const ev = m13Evidence();
    delete ev.sanctions;
    const r = evaluateM13(m13Input(), ev);
    expect(r.verdict).toBe("APPROVE");
    expect(checkById(r, "sanctions").status).toBe("skipped");
  });

  it("HOLDs when sanctions returns no usable match verdict", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      sanctions: { name: "Apple Inc" },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "sanctions").status).toBe("unverifiable");
  });

  it("REJECT wins over HOLD when both are present", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      tx: { status: "reverted", chain: "ethereum" },
      tvl: { tvl_usd: 100, protocol_or_chain: "aave-v3" },
    }));
    expect(r.verdict).toBe("REJECT");
  });

  it("Why box names every check with its status", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      tvl: { tvl_usd: 100, protocol_or_chain: "aave-v3" },
    }));
    expect(r.why).toHaveLength(8);
    expect(r.why.some((line) => line.startsWith("HOLD — Protocol TVL"))).toBe(true);
    expect(r.why.some((line) => line.startsWith("PASS — Counterparty transaction status"))).toBe(true);
  });
});

describe("M13 round-2 identity bindings (J2 F1–F3: sanctions name, spot symbol, route pair, missing price)", () => {
  it("F1: HOLDs when sanctions names a different entity than the issuer (screening does not cover the issuer)", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      sanctions: { matched: false, name: "Totally Different Corp", match_score: 0.05 },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "sanctions").status).toBe("unverifiable");
    expect(checkById(r, "sanctions").reason).toContain("Totally Different Corp");
    expect(checkById(r, "sanctions").reason).not.toContain('Issuer "Apple Inc" has no sanctions-list match');
  });

  it("F1: HOLDs when sanctions MATCHES but names a different entity than the issuer (matched:true + wrong name is unverifiable, never a pass — and not a reject of the issuer)", () => {
    // Name binding runs before the match verdict: a match against
    // "Microsoft Corporation" says nothing about issuer "Apple Inc".
    const r = evaluateM13(m13Input(), m13Evidence({
      sanctions: { matched: true, name: "Microsoft Corporation", match_score: 0.95 },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "sanctions").status).toBe("unverifiable");
    expect(checkById(r, "sanctions").reason).toContain("Microsoft Corporation");
  });

  it("F1: HOLDs when sanctions names no entity at all (match verdict cannot be bound)", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      sanctions: { matched: false, match_score: 0.05 },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "sanctions").status).toBe("unverifiable");
  });

  it("F1: passes sanctions when the named entity matches the issuer and matched is false", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      sanctions: { matched: false, name: "Apple Inc", match_score: 0.12 },
    }));
    expect(r.verdict).toBe("APPROVE");
    expect(checkById(r, "sanctions").status).toBe("pass");
  });

  it("F2: does NOT pass route_vs_spot when the spot price is for BTC, not ETH", () => {
    // Implied $1,637.15 vs BTC spot $1,637.15 = 0% deviation — would pass
    // if the symbol were ignored; the quote is for ETH, the spot is for BTC.
    const r = evaluateM13(m13Input(), m13Evidence({
      route: { amount_out: 1_637_150_000, pair: "ETH/USDC" },
      price: { price_usd: 1637.15, symbol: "BTC" },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "route_vs_spot").status).not.toBe("pass");
    expect(checkById(r, "route_vs_spot").reason).toContain("BTC");
  });

  it("F2: HOLDs when the spot price carries no symbol (asset unknown, cannot validate an ETH quote)", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      price: { price_usd: 3000 },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "route_vs_spot").status).toBe("unverifiable");
  });

  it("F2: REJECTs a route quote for the wrong pair (evidence belongs to another market)", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      route: { amount_out: 3_000_000_000, pair: "BTC/USD" },
    }));
    expect(r.verdict).toBe("REJECT");
    expect(checkById(r, "route").status).toBe("reject");
    expect(checkById(r, "route").reason).toContain("BTC/USD");
  });

  it("F2: HOLDs a route quote that names no pair (cannot be bound to ETH/USDC)", () => {
    const r = evaluateM13(m13Input(), m13Evidence({
      route: { amount_out: 3_000_000_000 },
    }));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "route").status).toBe("unverifiable");
  });

  it("F2: passes route + route_vs_spot when pair is ETH/USDC and symbol is ETH", () => {
    const r = evaluateM13(m13Input(), m13Evidence());
    expect(r.verdict).toBe("APPROVE");
    expect(checkById(r, "route").status).toBe("pass");
    expect(checkById(r, "route_vs_spot").status).toBe("pass");
  });

  it("F3: HOLDs with a non-empty reason when price is undefined, and APPROVEs when it is present and passing", () => {
    const noPrice = m13Evidence();
    delete noPrice.price;
    const held = evaluateM13(m13Input(), noPrice);
    expect(held.verdict).toBe("HOLD");
    expect(checkById(held, "route_vs_spot").reason.length).toBeGreaterThan(0);
    const withPrice = evaluateM13(m13Input(), m13Evidence());
    expect(withPrice.verdict).toBe("APPROVE");
  });

  it("F3: the sanctions skip is still the only skipped check (price missing is unverifiable, not skipped)", () => {
    const ev = m13Evidence();
    delete ev.price;
    delete ev.sanctions;
    const r = evaluateM13(m13Input(), ev);
    expect(checkById(r, "sanctions").status).toBe("skipped");
    expect(checkById(r, "route_vs_spot").status).toBe("unverifiable");
    expect(r.checks.filter((c) => c.status === "skipped")).toHaveLength(1);
    expect(r.verdict).toBe("HOLD");
  });
});

describe("M13 evidence binding (buildM13Evidence reads result only, never the echoed input)", () => {
  function askResult(intent: string, result: Record<string, unknown>, input?: Record<string, unknown>): AskResult {
    return {
      intent,
      params: {},
      result,
      input,
      miner_id: "1",
      miner_name: "test",
      signal_hash: "0x" + "aa".repeat(32),
      payments: [{ miner: "1", intent, amount_uusdc: 10000, receipt_hash: "0x" + "bb".repeat(32) }],
      receipt: null,
      rail: "escrow",
      fetched_at: "2026-11-20T00:00:00.000Z",
    };
  }

  function fullAsks(txResult: Record<string, unknown>, txInput?: Record<string, unknown>): AskResult[] {
    return [
      askResult("ONCHAIN_TX_LOOKUP_GENERAL", txResult, txInput),
      askResult("REGULATORY_FILING_MONITOR_GENERAL", { entity: "Apple Inc", filing_count: 12 }),
      askResult("TVL_LOOKUP_GENERAL", { protocol_or_chain: "aave-v3", tvl_usd: 15_000_000_000 }),
      askResult("OPTIMAL_EXECUTION_ROUTE_GENERAL", { amount_out: 3_000_000_000, pair: "ETH/USDC" }),
      askResult("SANCTIONS_SCREENING_MATCH_GENERAL", { matched: false, name: "Apple Inc", match_score: 0.12 }),
      askResult("CRYPTO_PRICE_USD", { symbol: "ETH", price_usd: 3000 }),
    ];
  }

  it("REJECTs when result.chain is base but ethereum was requested (echo cannot rescue it)", () => {
    const ev = buildM13Evidence(fullAsks(
      { status: "confirmed", chain: "base", tx_hash: CONFIRMED_TX },
      { chain: "ethereum" },
    ));
    const r = evaluateM13(m13Input(), ev);
    expect(r.verdict).toBe("REJECT");
    expect(checkById(r, "tx_chain").status).toBe("reject");
  });

  it("HOLDs when the result carries no chain even though the echoed input says ethereum", () => {
    const ev = buildM13Evidence(fullAsks(
      { status: "confirmed", tx_hash: CONFIRMED_TX },
      { chain: "ethereum" },
    ));
    expect(ev.tx?.chain).toBeUndefined();
    const r = evaluateM13(m13Input(), ev);
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "tx_chain").status).toBe("unverifiable");
  });

  it("REJECTs when the result names a different tx_hash than requested", () => {
    const ev = buildM13Evidence(fullAsks({
      status: "confirmed",
      chain: "ethereum",
      tx_hash: "0xabababababababababababababababababababababababababababababababab",
    }));
    const r = evaluateM13(m13Input(), ev);
    expect(r.verdict).toBe("REJECT");
    expect(checkById(r, "tx_hash").status).toBe("reject");
  });

  it("F2: buildM13Evidence does NOT default a missing price symbol to ETH", () => {
    const asks = fullAsks({ status: "confirmed", chain: "ethereum", tx_hash: CONFIRMED_TX });
    const priceAsk = asks.find((a) => a.intent === "CRYPTO_PRICE_USD") as AskResult;
    priceAsk.result = { price_usd: 3000 };
    const ev = buildM13Evidence(asks);
    expect(ev.price?.symbol).toBeUndefined();
    expect(evaluateM13(m13Input(), ev).verdict).toBe("HOLD");
  });

  it("F2: buildM13Evidence carries the route pair from the answer body, and leaves it absent when the answer carries none", () => {
    const withPair = buildM13Evidence(fullAsks({ status: "confirmed", chain: "ethereum", tx_hash: CONFIRMED_TX }));
    expect(withPair.route?.pair).toBe("ETH/USDC");
    const asks = fullAsks({ status: "confirmed", chain: "ethereum", tx_hash: CONFIRMED_TX });
    const routeAsk = asks.find((a) => a.intent === "OPTIMAL_EXECUTION_ROUTE_GENERAL") as AskResult;
    routeAsk.result = { amount_out: 3_000_000_000 };
    const withoutPair = buildM13Evidence(asks);
    expect(withoutPair.route?.pair).toBeUndefined();
    expect(evaluateM13(m13Input(), withoutPair).verdict).toBe("HOLD");
  });

  it("F2: buildM13Evidence + evaluateM13 HOLD a run whose spot price is for BTC", () => {
    const asks = fullAsks({ status: "confirmed", chain: "ethereum", tx_hash: CONFIRMED_TX });
    const priceAsk = asks.find((a) => a.intent === "CRYPTO_PRICE_USD") as AskResult;
    priceAsk.result = { price_usd: 1637.15, symbol: "BTC" };
    const routeAsk = asks.find((a) => a.intent === "OPTIMAL_EXECUTION_ROUTE_GENERAL") as AskResult;
    routeAsk.result = { amount_out: 1_637_150_000, pair: "ETH/USDC" };
    const r = evaluateM13(m13Input(), buildM13Evidence(asks));
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "route_vs_spot").status).not.toBe("pass");
  });
});

function m12Input(over: Partial<M12Input> = {}): M12Input {
  return {
    node_or_zone: "TH_NP15_GEN-APND",
    interval_start: "2026-11-19T00:00:00Z",
    breakeven_usd_per_mwh: 40,
    ...over,
  };
}

function m12Evidence(over: Partial<M12Evidence> = {}): M12Evidence {
  return {
    grid: {
      lmp_usd_per_mwh: 30,
      node_or_zone: "TH_NP15_GEN-APND",
      market: "day-ahead",
      interval_start: "2026-11-19T00:00:00Z",
      currency: "USD",
    },
    hashprice: {
      hashprice_sats_per_ph_day: 50000,
      hashprice_usd_per_ph_day: 50,
      block_height: 900000,
    },
    ...over,
  };
}

// Fixed "now" for deterministic interval tests: 2026-11-20T12:00:00Z.
const NOW_MS = Date.parse("2026-11-20T12:00:00Z");
// Standard evaluation options: the evidence block height (900000) is
// the tip height the hashprice ask was bought with.
const M12_OPTS = { nowMs: NOW_MS, expectedBlockHeight: 900000 };

describe("M12 validation (refusals, never verdicts)", () => {
  it("rejects an empty node with 400", () => {
    expectApiError(() => evaluateM12(m12Input({ node_or_zone: " " }), m12Evidence(), NOW_MS), 400, "INVALID_NODE");
  });
  it("rejects a malformed interval with 400", () => {
    expectApiError(
      () => evaluateM12(m12Input({ interval_start: "yesterday" }), m12Evidence(), NOW_MS),
      400,
      "INVALID_INTERVAL",
    );
  });
  it("rejects a date-only interval with 400", () => {
    expectApiError(
      () => evaluateM12(m12Input({ interval_start: "2026-11-19" }), m12Evidence(), NOW_MS),
      400,
      "INVALID_INTERVAL",
    );
  });
  it("rejects a zero break-even with 400", () => {
    expectApiError(
      () => evaluateM12(m12Input({ breakeven_usd_per_mwh: 0 }), m12Evidence(), NOW_MS),
      400,
      "INVALID_BREAKEVEN",
    );
  });
  it("rejects a negative break-even with 400", () => {
    expectApiError(
      () => evaluateM12(m12Input({ breakeven_usd_per_mwh: -5 }), m12Evidence(), NOW_MS),
      400,
      "INVALID_BREAKEVEN",
    );
  });
  it("rejects a NaN break-even with 400", () => {
    expectApiError(
      () => evaluateM12(m12Input({ breakeven_usd_per_mwh: Number.NaN }), m12Evidence(), NOW_MS),
      400,
      "INVALID_BREAKEVEN",
    );
  });
});

describe("M12 verdicts", () => {
  it("MINEs when the price clears the deadband below break-even", () => {
    const r = evaluateM12(m12Input(), m12Evidence(), M12_OPTS);
    expect(r.verdict).toBe("MINE");
    expect(r.checks).toHaveLength(7);
    expect(r.checks.every((c) => c.status === "pass")).toBe(true);
    expect(r.why).toHaveLength(7);
  });

  it("CURTAILs when the price clears the deadband above break-even", () => {
    const r = evaluateM12(m12Input(), m12Evidence({
      grid: { lmp_usd_per_mwh: 100, node_or_zone: "TH_NP15_GEN-APND", interval_start: "2026-11-19T00:00:00Z", currency: "USD" },
    }), M12_OPTS);
    expect(r.verdict).toBe("CURTAIL");
  });

  it("HOLDs a price inside the 5% deadband (too close to call)", () => {
    const r = evaluateM12(m12Input(), m12Evidence({
      grid: { lmp_usd_per_mwh: 39, node_or_zone: "TH_NP15_GEN-APND", interval_start: "2026-11-19T00:00:00Z", currency: "USD" },
    }), M12_OPTS);
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "dispatch").status).toBe("hold");
    expect(checkById(r, "dispatch").reason).toContain("too close to call");
  });

  it("MINEs exactly at the lower deadband edge (0.95 * break-even)", () => {
    const r = evaluateM12(m12Input(), m12Evidence({
      grid: { lmp_usd_per_mwh: 40 * (1 - M12_DEADBAND), node_or_zone: "TH_NP15_GEN-APND", interval_start: "2026-11-19T00:00:00Z", currency: "USD" },
    }), M12_OPTS);
    expect(r.verdict).toBe("MINE");
    expect(M12_DEADBAND).toBe(0.05);
  });

  it("CURTAILs exactly at the upper deadband edge (1.05 * break-even)", () => {
    const r = evaluateM12(m12Input(), m12Evidence({
      grid: { lmp_usd_per_mwh: 40 * (1 + M12_DEADBAND), node_or_zone: "TH_NP15_GEN-APND", interval_start: "2026-11-19T00:00:00Z", currency: "USD" },
    }), M12_OPTS);
    expect(r.verdict).toBe("CURTAIL");
  });

  it("HOLDs an unfinished interval (fail-closed drill)", () => {
    const r = evaluateM12(
      m12Input({ interval_start: "2026-11-20T11:30:00Z" }),
      m12Evidence({
        grid: { lmp_usd_per_mwh: 30, node_or_zone: "TH_NP15_GEN-APND", interval_start: "2026-11-20T11:30:00Z", currency: "USD" },
      }),
      M12_OPTS,
    );
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "interval_finished").status).toBe("hold");
  });

  it("HOLDs a future interval", () => {
    const r = evaluateM12(
      m12Input({ interval_start: "2026-11-21T00:00:00Z" }),
      m12Evidence(),
      NOW_MS,
    );
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "interval_finished").status).toBe("hold");
    expect(checkById(r, "interval_finished").reason).toContain("future");
  });

  it("passes an interval that finished exactly 60 minutes ago", () => {
    const r = evaluateM12(
      m12Input({ interval_start: "2026-11-20T11:00:00Z" }),
      m12Evidence({
        grid: { lmp_usd_per_mwh: 30, node_or_zone: "TH_NP15_GEN-APND", interval_start: "2026-11-20T11:00:00Z", currency: "USD" },
      }),
      M12_OPTS,
    );
    expect(r.verdict).toBe("MINE");
    expect(checkById(r, "interval_finished").status).toBe("pass");
  });

  it("HOLDs a location mismatch (wrong-location drill)", () => {
    const r = evaluateM12(m12Input(), m12Evidence({
      grid: { lmp_usd_per_mwh: 30, node_or_zone: "HB_NORTH", interval_start: "2026-11-19T00:00:00Z", currency: "USD" },
    }), M12_OPTS);
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "location").status).toBe("hold");
    expect(checkById(r, "location").reason).toContain("HB_NORTH");
  });

  it("matches locations case-insensitively", () => {
    const r = evaluateM12(m12Input(), m12Evidence({
      grid: { lmp_usd_per_mwh: 30, node_or_zone: "th_np15_gen-apnd", interval_start: "2026-11-19T00:00:00Z", currency: "USD" },
    }), M12_OPTS);
    expect(r.verdict).toBe("MINE");
    expect(checkById(r, "location").status).toBe("pass");
  });

  it("HOLDs when grid evidence is missing", () => {
    const r = evaluateM12(m12Input(), m12Evidence({ grid: null }), NOW_MS);
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "grid_price").status).toBe("unverifiable");
    expect(checkById(r, "location").status).toBe("unverifiable");
  });

  it("HOLDs when the grid price itself is missing", () => {
    const r = evaluateM12(m12Input(), m12Evidence({
      grid: { node_or_zone: "TH_NP15_GEN-APND", currency: "USD" },
    }), NOW_MS);
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "grid_price").status).toBe("unverifiable");
  });

  it("HOLDs a non-USD grid price (cannot compare with a USD break-even)", () => {
    const r = evaluateM12(m12Input(), m12Evidence({
      grid: { lmp_usd_per_mwh: 30, node_or_zone: "TH_NP15_GEN-APND", interval_start: "2026-11-19T00:00:00Z", currency: "EUR" },
    }), M12_OPTS);
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "grid_price").status).toBe("hold");
  });

  it("F5: HOLDs a grid price that names no currency (denomination unknown, cannot compare with a USD break-even)", () => {
    const r = evaluateM12(m12Input(), m12Evidence({
      grid: { lmp_usd_per_mwh: 30, node_or_zone: "TH_NP15_GEN-APND", interval_start: "2026-11-19T00:00:00Z" },
    }), M12_OPTS);
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "grid_price").status).toBe("hold");
    expect(checkById(r, "grid_price").reason.length).toBeGreaterThan(0);
  });

  it("F5: passes a grid price explicitly quoted in USD", () => {
    const r = evaluateM12(m12Input(), m12Evidence(), M12_OPTS);
    expect(r.verdict).toBe("MINE");
    expect(checkById(r, "grid_price").status).toBe("pass");
  });

  it("HOLDs when hashprice evidence is missing", () => {
    const r = evaluateM12(m12Input(), m12Evidence({ hashprice: null }), NOW_MS);
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "hashprice").status).toBe("unverifiable");
  });

  it("HOLDs when hashprice carries no usable figure", () => {
    const r = evaluateM12(m12Input(), m12Evidence({ hashprice: { block_height: 900000 } }), NOW_MS);
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "hashprice").status).toBe("unverifiable");
  });

  it("passes hashprice evidence with sats only", () => {
    const r = evaluateM12(m12Input(), m12Evidence({
      hashprice: { hashprice_sats_per_ph_day: 50000, block_height: 900000 },
    }), M12_OPTS);
    expect(r.verdict).toBe("MINE");
    expect(checkById(r, "hashprice").status).toBe("pass");
  });

  it("HOLDs a negative LMP that is still inside the deadband logic (sanity: very cheap power mines)", () => {
    const r = evaluateM12(m12Input(), m12Evidence({
      grid: { lmp_usd_per_mwh: -5, node_or_zone: "TH_NP15_GEN-APND", interval_start: "2026-11-19T00:00:00Z", currency: "USD" },
    }), M12_OPTS);
    expect(r.verdict).toBe("MINE");
  });

  it("Why box names every check with its status", () => {
    const r = evaluateM12(m12Input(), m12Evidence({
      grid: { lmp_usd_per_mwh: 100, node_or_zone: "TH_NP15_GEN-APND", interval_start: "2026-11-19T00:00:00Z", currency: "USD" },
    }), M12_OPTS);
    expect(r.why).toHaveLength(7);
    expect(r.why.some((line) => line.startsWith("PASS — Dispatch economics"))).toBe(true);
  });
});

describe("M12 evidence binding (interval + block must match the ask)", () => {
  function m12AskResult(intent: string, result: Record<string, unknown>): AskResult {
    return {
      intent,
      params: {},
      result,
      miner_id: "1",
      miner_name: "test",
      signal_hash: "0x" + "aa".repeat(32),
      payments: [{ miner: "1", intent, amount_uusdc: 10000, receipt_hash: "0x" + "bb".repeat(32) }],
      receipt: null,
      rail: "escrow",
      fetched_at: "2026-11-20T00:00:00.000Z",
    };
  }

  function m12Asks(grid: Record<string, unknown>, hashprice: Record<string, unknown>): AskResult[] {
    return [
      m12AskResult("GRID_POWER_PRICE_GENERAL", grid),
      m12AskResult("MINING_HASHPRICE_VERIFY_GENERAL", hashprice),
    ];
  }

  const GOOD_GRID = {
    lmp_usd_per_mwh: 30,
    node_or_zone: "TH_NP15_GEN-APND",
    market: "day-ahead",
    interval_start: "2026-11-19T00:00:00Z",
    currency: "USD",
  };
  const GOOD_HASHPRICE = {
    hashprice_sats_per_ph_day: 50000,
    hashprice_usd_per_ph_day: 50,
    block_height: 900000,
  };

  it("MINEs when interval and block both match the ask", () => {
    const r = decideM12(m12Input(), m12Asks(GOOD_GRID, GOOD_HASHPRICE), {
      expectedBlockHeight: 900000,
      nowMs: NOW_MS,
    });
    expect(r.verdict).toBe("MINE");
    expect(checkById(r, "interval_match").status).toBe("pass");
    expect(checkById(r, "hashprice_block").status).toBe("pass");
  });

  it("HOLDs grid evidence for the wrong day (interval 2026-11-18, $10 LMP)", () => {
    const r = decideM12(m12Input(), m12Asks(
      { ...GOOD_GRID, interval_start: "2026-11-18T00:00:00Z", lmp_usd_per_mwh: 10 },
      GOOD_HASHPRICE,
    ), { expectedBlockHeight: 900000, nowMs: NOW_MS });
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "interval_match").status).toBe("hold");
    expect(checkById(r, "interval_match").reason).toContain("2026-11-18");
  });

  it("HOLDs grid evidence that names no interval at all", () => {
    const { interval_start: _dropped, ...noInterval } = GOOD_GRID;
    void _dropped;
    const r = decideM12(m12Input(), m12Asks(noInterval, GOOD_HASHPRICE), {
      expectedBlockHeight: 900000,
      nowMs: NOW_MS,
    });
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "interval_match").status).toBe("hold");
  });

  it("HOLDs hashprice evidence for a different block than the ask", () => {
    const r = decideM12(m12Input(), m12Asks(GOOD_GRID, { ...GOOD_HASHPRICE, block_height: 899999 }), {
      expectedBlockHeight: 900000,
      nowMs: NOW_MS,
    });
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "hashprice_block").status).toBe("hold");
  });

  it("HOLDs hashprice evidence that names no block height", () => {
    const { block_height: _dropped, ...noBlock } = GOOD_HASHPRICE;
    void _dropped;
    const r = decideM12(m12Input(), m12Asks(GOOD_GRID, noBlock), {
      expectedBlockHeight: 900000,
      nowMs: NOW_MS,
    });
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "hashprice_block").status).toBe("hold");
  });

  it("HOLDs when no expected block height is supplied (binding cannot be checked)", () => {
    const r = decideM12(m12Input(), m12Asks(GOOD_GRID, GOOD_HASHPRICE), { nowMs: NOW_MS });
    expect(r.verdict).toBe("HOLD");
    expect(checkById(r, "hashprice_block").status).toBe("unverifiable");
  });
});

describe("escrow template helpers (pure, offline)", () => {
  const TEMPLATE =
    "Telegraph Escrow Payment\n\nWallet: {from}\nPay To: 0x72a70e94…\nNetwork: eip155:11155111\nAmount: 10000 uUSDC\nResource: /v1/ask\nNonce: {nonce}\nValid After: {validAfter}\nValid Before: {validBefore}";

  it("fills the template in place and lowercases the payer", () => {
    const filled = fillEscrowTemplate(TEMPLATE, {
      from: "0xf76e6b0920e9332ff4410f6dd53f01722abc71a3",
      nonce: "test-nonce-1",
      validAfter: "1795179600",
      validBefore: "1795179700",
    });
    expect(filled).toContain("Wallet: 0xf76e6b0920e9332ff4410f6dd53f01722abc71a3");
    expect(filled).toContain("Nonce: test-nonce-1");
    expect(filled).toContain("Valid After: 1795179600");
    expect(filled).toContain("Valid Before: 1795179700");
    expect(filled).not.toContain("{from}");
    expect(filled).not.toContain("{nonce}");
  });

  it("builds a base64 X-PAYMENT envelope that decodes to the escrow scheme", () => {
    const payment = buildEscrowPayment(
      "0xdeadbeef",
      {
        from: "0xf76e6b0920e9332ff4410f6dd53f01722abc71a3",
        to: "0x72a70e949362670bf8bcead24efc5b8f950aa08b",
        value: "10000",
        validAfter: "1795179600",
        validBefore: "1795179700",
        nonce: "test-nonce-1",
      },
    );
    const decoded = JSON.parse(Buffer.from(payment, "base64").toString("utf8")) as Record<string, unknown>;
    expect(decoded.x402Version).toBe(2);
    expect(decoded.scheme).toBe("escrow");
    expect(decoded.network).toBe("eip155:11155111");
    const payload = decoded.payload as Record<string, unknown>;
    const auth = payload.authorization as Record<string, unknown>;
    expect(auth.value).toBe("10000");
    expect(auth.nonce).toBe("test-nonce-1");
  });
});
