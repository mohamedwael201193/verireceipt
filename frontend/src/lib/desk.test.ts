import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELATED_PARTY_DISCLOSURE, runDeskCheck } from "./desk";
import { DESK_PRESETS, presetRunRequest, recentIntervalIso } from "../pages/desk/presets";

// Parser tests for POST /api/desk/run (lib/desk.ts). Fixtures use the
// REAL backend shape (backend/src/desk/routes.ts); the parser must fail
// closed (INVALID_RESPONSE) on anything else — never render it.

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "desk_run_1",
    mission: "M13",
    scenario_id: "m13-institutional-defi",
    verdict: "APPROVE",
    checks: [
      {
        id: "tx_status",
        name: "Counterparty transaction status",
        status: "pass",
        reason: "Counterparty transaction is confirmed on chain.",
        detail: "block 26454869",
      },
    ],
    why: ["PASS — Counterparty transaction status: Counterparty transaction is confirmed on chain."],
    calls: [
      {
        intent: "ONCHAIN_TX_LOOKUP_GENERAL",
        params: { tx_hash: "0x1b9e2b48eb3510ee1a8aae2fc402139784f32d43b76d5853387cacb484a9a9d3", chain: "ethereum" },
        miner_id: "774921",
        miner_name: "verireceipt",
        signal_hash: "abc123hash",
        receipt_hash: "rcpt_hash_1",
        cost_uusdc: 10000,
        rail: "escrow",
        fetched_at: "2026-11-20T05:30:00Z",
        signal_url: "https://devnode.telegraphprotocol.com/engine/v1/signal/abc123hash",
      },
    ],
    total_cost_uusdc: 10000,
    total_cost_usd: 0.01,
    related_party: true,
    disclosure: RELATED_PARTY_DISCLOSURE,
    ...overrides,
  };
}

const M13_REQUEST = {
  mission: "M13",
  scenario_id: "m13-institutional-defi",
  protocol: "aave-v3",
  tx_hash: "0x1b9e2b48eb3510ee1a8aae2fc402139784f32d43b76d5853387cacb484a9a9d3",
  chain: "ethereum",
  issuer_entity: "AAPL",
  period: "last 12 months",
  trade_pair: "ETH/USDC",
} as const;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runDeskCheck parser — mission/verdict mapping", () => {
  it("accepts M13 APPROVE and M12 MINE", async () => {
    fetchMock.mockResolvedValue(jsonResponse(validRun()));
    const res = await runDeskCheck(M13_REQUEST);
    expect(res.verdict).toBe("APPROVE");
  });

  it("rejects M12 + APPROVE (cross-mission verdict)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(validRun({ mission: "M12", verdict: "APPROVE" })),
    );
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/not valid for mission M12/);
  });

  it("rejects M13 + MINE (cross-mission verdict)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(validRun({ verdict: "MINE" })));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/not valid for mission M13/);
  });

  it("rejects M12 + REJECT and accepts M12 HOLD / CURTAIL", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(validRun({ mission: "M12", verdict: "REJECT" })),
    );
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/not valid for mission M12/);
    fetchMock.mockResolvedValue(
      jsonResponse(validRun({ mission: "M12", verdict: "CURTAIL", scenario_id: "m12-grid-low-breakeven" })),
    );
    const res = await runDeskCheck({
      mission: "M12",
      scenario_id: "m12-grid-low-breakeven",
      node_or_zone: "TH_NP15_GEN-APND",
      interval_start: "2026-11-20T15:00:00Z",
      breakeven_usd_per_mwh: 10,
    });
    expect(res.verdict).toBe("CURTAIL");
  });
});

describe("runDeskCheck parser — evidence, cost, time", () => {
  it("rejects empty checks[] + empty why[] — no APPROVE banner on zero evidence", async () => {
    fetchMock.mockResolvedValue(jsonResponse(validRun({ checks: [], why: [] })));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/checks must not be empty/);
  });

  it("rejects a negative per-call cost", async () => {
    const body = validRun();
    (body["calls"] as Record<string, unknown>[])[0]!["cost_uusdc"] = -5000;
    fetchMock.mockResolvedValue(jsonResponse(body));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/negative cost_uusdc/);
  });

  it("rejects a negative total cost", async () => {
    fetchMock.mockResolvedValue(jsonResponse(validRun({ total_cost_uusdc: -1 })));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/non-negative numbers/);
    fetchMock.mockResolvedValue(jsonResponse(validRun({ total_cost_usd: -0.01 })));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/non-negative numbers/);
  });

  it("rejects garbage fetched_at", async () => {
    const body = validRun();
    (body["calls"] as Record<string, unknown>[])[0]!["fetched_at"] = "not-a-date";
    fetchMock.mockResolvedValue(jsonResponse(body));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/unparseable fetched_at/);
  });

  it("rejects APPROVE on zero calls — calls: [] is INVALID_RESPONSE, never rendered", async () => {
    // F2 (round 3): every per-call assertion is vacuously skipped on an
    // empty calls[], so the old parser ACCEPTED an APPROVE verdict with
    // 0 ranked calls and $0.00 spent. Zero evidence is not a verdict.
    fetchMock.mockResolvedValue(jsonResponse(validRun({ calls: [] })));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/calls must not be empty/);
  });

  it("rejects empty why[] with non-empty checks — the why-box the UI renders must exist", async () => {
    // F3 (round 3): why: [] passed the old parser while the UI renders
    // a why-box ("The run returned no why entries") for it.
    fetchMock.mockResolvedValue(jsonResponse(validRun({ why: [] })));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/why must not be empty/);
  });

  it("rejects a fetched_at in the future — zero tolerance (round 4, F3)", async () => {
    // F3 (round 3) bounded the hole to 5 minutes; round 4 closes it.
    // fetched_at is stamped by the BACKEND itself (telegraphClient.ts:
    // toAskResult sets `fetched_at: new Date().toISOString()`), so the
    // "miner/client clock skew" rationale for the old 5-minute tolerance
    // was wrong — the miner's clock is never involved — and a repo-wide
    // grep found zero evidence of minutes of skew. The only clock
    // difference that could exist is Render-server vs browser clock,
    // unmeasured, so the tolerance is zero: ANY future stamp is
    // INVALID_RESPONSE, and no future-stamped stream line can render
    // for an accepted response.
    const body = validRun();
    (body["calls"] as Record<string, unknown>[])[0]!["fetched_at"] = "2031-01-01T00:00:00Z";
    fetchMock.mockResolvedValue(jsonResponse(body));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/fetched_at in the future/);
    for (const msAhead of [6 * 60 * 1000, 4 * 60 * 1000 + 59 * 1000, 5 * 60 * 1000, 1000]) {
      (body["calls"] as Record<string, unknown>[])[0]!["fetched_at"] = new Date(
        Date.now() + msAhead,
      ).toISOString();
      fetchMock.mockResolvedValue(jsonResponse(body));
      await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/fetched_at in the future/);
    }
  });

  it("accepts a fetched_at at or before now — the new zero-tolerance boundary (round 4, F3)", async () => {
    // Replaces the round-3 "accepts within the 5-minute tolerance" test:
    // now+4min is REJECTED under the new rule (see the test above); only
    // a stamp at or before the parse-time clock is accepted.
    const body = validRun();
    (body["calls"] as Record<string, unknown>[])[0]!["fetched_at"] = new Date(
      Date.now() - 1000,
    ).toISOString();
    fetchMock.mockResolvedValue(jsonResponse(body));
    expect((await runDeskCheck(M13_REQUEST)).verdict).toBe("APPROVE");
    (body["calls"] as Record<string, unknown>[])[0]!["fetched_at"] =
      new Date().toISOString();
    fetchMock.mockResolvedValue(jsonResponse(body));
    expect((await runDeskCheck(M13_REQUEST)).verdict).toBe("APPROVE");
  });
});

describe("runDeskCheck parser — totals must equal the sum of the calls (round 4, F1)", () => {
  function twoCallRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const body = validRun();
    const call = (body["calls"] as Record<string, unknown>[])[0]!;
    const second = {
      ...call,
      intent: "TVL_LOOKUP_GENERAL",
      params: { protocol: "aave-v3" },
      cost_uusdc: 5000,
    };
    return validRun({ calls: [call, second], total_cost_uusdc: 15000, total_cost_usd: 0.015, ...overrides });
  }

  it("rejects total_cost_uusdc 0 with a call at 10000 — the total is a sum by construction", async () => {
    // J2 round 4: the old parser accepted this and the UI rendered a
    // "$0.00 Test USDC spent" banner beside two "$0.01" lines. The
    // backend defines the total as the sum (scenarios.ts:327,380:
    // `records.reduce((s, c) => s + c.cost_uusdc, 0)`), so a total that
    // is not the sum is malformed per the backend's own contract.
    fetchMock.mockResolvedValue(jsonResponse(validRun({ total_cost_uusdc: 0 })));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(
      /total_cost_uusdc does not equal the sum/,
    );
  });

  it("rejects a total_cost_uusdc too HIGH vs the calls", async () => {
    fetchMock.mockResolvedValue(jsonResponse(validRun({ total_cost_uusdc: 20000 })));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(
      /total_cost_uusdc does not equal the sum/,
    );
    fetchMock.mockResolvedValue(jsonResponse(twoCallRun({ total_cost_uusdc: 99999 })));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(
      /total_cost_uusdc does not equal the sum/,
    );
  });

  it("rejects a mismatched total_cost_usd — routes.ts defines it as total_uusdc / 1_000_000", async () => {
    fetchMock.mockResolvedValue(jsonResponse(validRun({ total_cost_usd: 0.02 })));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(
      /total_cost_usd does not equal/,
    );
    fetchMock.mockResolvedValue(jsonResponse(twoCallRun({ total_cost_usd: 0.01 })));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(
      /total_cost_usd does not equal/,
    );
  });

  it("accepts consistent totals — one call and two calls", async () => {
    fetchMock.mockResolvedValue(jsonResponse(validRun()));
    const one = await runDeskCheck(M13_REQUEST);
    expect(one.total_cost_uusdc).toBe(10000);
    expect(one.total_cost_usd).toBe(0.01);
    fetchMock.mockResolvedValue(jsonResponse(twoCallRun()));
    const two = await runDeskCheck(M13_REQUEST);
    expect(two.total_cost_uusdc).toBe(15000);
    expect(two.total_cost_usd).toBe(0.015);
  });

  it("accepts cost_uusdc 0 with totals 0 — the real unbilled-refusal shape", async () => {
    // F2 behaviour preserved: a zero-cost call is legitimate (a call
    // that bought nothing), so totals of 0/0 with a 0-cost call parse.
    const body = validRun();
    (body["calls"] as Record<string, unknown>[])[0]!["cost_uusdc"] = 0;
    fetchMock.mockResolvedValue(
      jsonResponse({ ...body, total_cost_uusdc: 0, total_cost_usd: 0 }),
    );
    const res = await runDeskCheck(M13_REQUEST);
    expect(res.total_cost_uusdc).toBe(0);
    expect(res.total_cost_usd).toBe(0);
  });
});

describe("runDeskCheck parser — why entries and all-skipped checks (round 4, F4)", () => {
  it("rejects why: [\"\"] and why: [\" \"] — an empty bullet is not an explanation", async () => {
    // The old check was only `typeof w === "string"` plus a non-empty
    // array; the isNonEmptyString helper used for check reasons was
    // never applied to why entries, so [""] rendered an empty bullet.
    fetchMock.mockResolvedValue(jsonResponse(validRun({ why: [""] })));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(
      /why entries must be non-empty strings/,
    );
    fetchMock.mockResolvedValue(jsonResponse(validRun({ why: [" "] })));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(
      /why entries must be non-empty strings/,
    );
    fetchMock.mockResolvedValue(
      jsonResponse(
        validRun({
          why: [
            "PASS — Counterparty transaction status: Counterparty transaction is confirmed on chain.",
            "",
          ],
        }),
      ),
    );
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(
      /why entries must be non-empty strings/,
    );
  });

  it("rejects APPROVE with EVERY check skipped — the backend can never emit it", async () => {
    // Round 6, F2 (corrected model — the round-4 comment below was
    // FALSE): only M13 checkSanctions can ever return "skipped"
    // (policyM13.ts:309, the ONLY such return in the file);
    // checkRouteVsSpot returns "unverifiable" for a missing spot price,
    // never "skipped" (:471). So an all-skipped fixture must NOT use a
    // route_vs_spot-skipped check — that shape is never emittable and
    // is rejected by the per-check skip rule, not by the all-skipped
    // rule. The single sanctions-skipped check below is the minimal
    // all-skipped run, rejected by the all-skipped rule itself.
    // policyM12.ts has no skipped branch at all (:45), so any skipped
    // M12 check is rejected by the per-check rule.
    const skipped = {
      id: "sanctions",
      name: "Sanctions screening (issuer)",
      status: "skipped",
      reason: "No sanctions-screening evidence was bought in this run.",
    };
    fetchMock.mockResolvedValue(jsonResponse(validRun({ checks: [skipped] })));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/must not all be skipped/);
    fetchMock.mockResolvedValue(
      jsonResponse(
        validRun({ mission: "M12", verdict: "MINE", checks: [skipped] }),
      ),
    );
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/must never be skipped/);
  });

  it("rejects a skipped route_vs_spot check in M13 — missing spot price is unverifiable, never skipped", async () => {
    // Round 6, F2 (J2 proved the old parser ACCEPTED this): an M13
    // APPROVE with both sanctions and route_vs_spot skipped parsed.
    // checkRouteVsSpot (policyM13.ts:471) returns "unverifiable" for a
    // missing spot price and forces HOLD — a skipped route_vs_spot is
    // malformed, never rendered.
    const body = validRun({
      checks: [
        {
          id: "tx_status",
          name: "Counterparty transaction status",
          status: "pass",
          reason: "Counterparty transaction is confirmed on chain.",
        },
        {
          id: "sanctions",
          name: "Sanctions screening (issuer)",
          status: "skipped",
          reason: "No sanctions-screening evidence was bought in this run.",
        },
        {
          id: "route_vs_spot",
          name: "Execution quote vs independent spot price",
          status: "skipped",
          reason: "No spot price was bought in this run.",
        },
      ],
    });
    fetchMock.mockResolvedValue(jsonResponse(body));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/must never be skipped/);
  });

  it("rejects a skipped route_vs_spot check on its own in M13 — the skip is never emittable, with or without sanctions", async () => {
    const body = validRun({
      checks: [
        {
          id: "tx_status",
          name: "Counterparty transaction status",
          status: "pass",
          reason: "Counterparty transaction is confirmed on chain.",
        },
        {
          id: "route_vs_spot",
          name: "Execution quote vs independent spot price",
          status: "skipped",
          reason: "No spot price was bought in this run.",
        },
      ],
    });
    fetchMock.mockResolvedValue(jsonResponse(body));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/must never be skipped/);
  });

  it("rejects ANY skipped check in M12 — policyM12 has no skipped branch at all", async () => {
    // Round 6, F2 (J2 proved the old parser ACCEPTED this): an M12 run
    // with a skipped check parsed. M12CheckStatus (policyM12.ts:45) is
    // "pass" | "hold" | "unverifiable" — a skipped M12 check of any id
    // is malformed, never rendered.
    const body = validRun({
      mission: "M12",
      verdict: "MINE",
      scenario_id: "m12-grid-low-breakeven",
      checks: [
        {
          id: "interval_finished",
          name: "Settlement interval finished",
          status: "pass",
          reason: "Settlement interval is finished.",
        },
        {
          id: "dispatch",
          name: "Dispatch economics vs break-even",
          status: "skipped",
          reason: "No dispatch evidence was bought in this run.",
        },
      ],
    });
    fetchMock.mockResolvedValue(jsonResponse(body));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/must never be skipped/);
  });

  it("still accepts a run with SOME checks skipped — the one blueprint-sanctioned skip", async () => {
    const body = validRun();
    (body["checks"] as Record<string, unknown>[]).push({
      id: "sanctions",
      name: "Sanctions screening (issuer)",
      status: "skipped",
      reason: "No sanctions-screening evidence was bought in this run.",
    });
    fetchMock.mockResolvedValue(jsonResponse(body));
    const res = await runDeskCheck(M13_REQUEST);
    expect(res.verdict).toBe("APPROVE");
    expect(res.checks).toHaveLength(2);
  });
});

describe("runDeskCheck parser — verdict/check-status consistency (round 7, F1)", () => {
  // J2 reproduced 8 impossible combos with a throwaway probe test
  // (__j2probe.test.ts, since deleted); each is now a permanent test
  // here. The backend derives the verdict from the statuses alone
  // (policyM13.ts:558-560, policyM12.ts:391-393; routes.ts copies the
  // verdict verbatim), so any of these can never be a real reply — and
  // Desk.tsx renders banner + checks with no cross-check, so accepting
  // one renders a self-contradictory verdict page.
  // Fixtures keep why[] consistent with the CHECKS (so the verdict is
  // the only inconsistent dimension) and reuse validRun's call/totals.
  const M12_REQUEST = {
    mission: "M12",
    scenario_id: "m12-grid-low-breakeven",
    node_or_zone: "TH_NP15_GEN-APND",
    interval_start: "2026-11-20T15:00:00Z",
    breakeven_usd_per_mwh: 10,
  } as const;

  type FixtureCheck = { id: string; name: string; status: string; reason: string };

  function runWith(
    mission: "M13" | "M12",
    verdict: string,
    checks: FixtureCheck[],
  ): Record<string, unknown> {
    return validRun({
      mission,
      verdict,
      scenario_id: mission === "M13" ? "m13-institutional-defi" : "m12-grid-low-breakeven",
      checks,
      why: checks.map(
        (c) =>
          `${c.status === "pass" ? "PASS" : c.status.toUpperCase()} — ${c.name}: ${c.reason}`,
      ),
    });
  }

  const TX_PASS: FixtureCheck = {
    id: "tx_status",
    name: "Counterparty transaction status",
    status: "pass",
    reason: "Counterparty transaction is confirmed on chain.",
  };
  const TX_REJECT: FixtureCheck = {
    id: "tx_status",
    name: "Counterparty transaction status",
    status: "reject",
    reason: "Counterparty transaction is reverted.",
  };
  const TVL_HOLD: FixtureCheck = {
    id: "tvl",
    name: "Protocol TVL vs institutional minimum",
    status: "hold",
    reason: "Protocol TVL is below the $1M institutional minimum.",
  };
  const ROUTE_UNVERIFIABLE: FixtureCheck = {
    id: "route_vs_spot",
    name: "Execution quote vs independent spot price",
    status: "unverifiable",
    reason: "No spot price was bought in this run.",
  };
  const INTERVAL_PASS: FixtureCheck = {
    id: "interval_finished",
    name: "Settlement interval finished",
    status: "pass",
    reason: "Settlement interval is finished.",
  };
  const DISPATCH_PASS: FixtureCheck = {
    id: "dispatch",
    name: "Dispatch economics vs break-even",
    status: "pass",
    reason: "Price $25.00 / MWh is at or below $475.00 — mining clears its power cost.",
  };
  const DISPATCH_HOLD: FixtureCheck = {
    id: "dispatch",
    name: "Dispatch economics vs break-even",
    status: "hold",
    reason: "Price is within 5% of break-even $500 / MWh — too close to call.",
  };
  // Impossible in M12 (policyM12.ts:45 types M12CheckStatus without
  // "reject" — the backend can never emit one); used only to prove the
  // parser rejects a verdict that contradicts its checks (round 8, F1).
  const DISPATCH_REJECT: FixtureCheck = {
    id: "dispatch",
    name: "Dispatch economics vs break-even",
    status: "reject",
    reason: "Price is above break-even $500 / MWh — mining loses money.",
  };
  const DISPATCH_UNVERIFIABLE: FixtureCheck = {
    id: "dispatch",
    name: "Dispatch economics vs break-even",
    status: "unverifiable",
    reason: "No price was bought in this run.",
  };

  it("rejects M13 APPROVE + a reject check — any reject means REJECT", async () => {
    fetchMock.mockResolvedValue(jsonResponse(runWith("M13", "APPROVE", [TX_REJECT])));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(
      /APPROVE contradicts its checks.*reject check is present/,
    );
  });

  it("rejects M13 APPROVE + an unverifiable route_vs_spot — any unverifiable means HOLD", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(runWith("M13", "APPROVE", [TX_PASS, ROUTE_UNVERIFIABLE])),
    );
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/APPROVE contradicts its checks/);
  });

  it("rejects M13 APPROVE + a hold tvl — any hold means HOLD", async () => {
    fetchMock.mockResolvedValue(jsonResponse(runWith("M13", "APPROVE", [TX_PASS, TVL_HOLD])));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(/APPROVE contradicts its checks/);
  });

  it("rejects M13 REJECT + all checks pass — all-pass means APPROVE", async () => {
    fetchMock.mockResolvedValue(jsonResponse(runWith("M13", "REJECT", [TX_PASS])));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(
      /REJECT contradicts its checks: no check rejected/,
    );
  });

  it("rejects M13 HOLD + all checks pass — all-pass means APPROVE", async () => {
    fetchMock.mockResolvedValue(jsonResponse(runWith("M13", "HOLD", [TX_PASS])));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(
      /HOLD contradicts its checks: no check held or was unverifiable/,
    );
  });

  it("rejects M13 REJECT + a hold check and no reject — the backend would say HOLD", async () => {
    fetchMock.mockResolvedValue(jsonResponse(runWith("M13", "REJECT", [TX_PASS, TVL_HOLD])));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(
      /REJECT contradicts its checks: no check rejected/,
    );
  });

  it("rejects M12 MINE + a hold dispatch — any hold/unverifiable blocks (blocked=true) so HOLD", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(runWith("M12", "MINE", [INTERVAL_PASS, DISPATCH_HOLD])),
    );
    await expect(runDeskCheck(M12_REQUEST)).rejects.toThrow(
      /MINE contradicts its checks: every check must pass/,
    );
  });

  it("rejects M12 HOLD + all checks pass — all-pass + dispatch.side set means MINE/CURTAIL", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(runWith("M12", "HOLD", [INTERVAL_PASS, DISPATCH_PASS])),
    );
    await expect(runDeskCheck(M12_REQUEST)).rejects.toThrow(
      /HOLD contradicts its checks: no check held or was unverifiable/,
    );
  });

  // Round 8, F1 — J1 probed these with a throwaway probe test (since
  // deleted); each is now a permanent test here. The old M12 HOLD
  // branch only checked !hasHold, so a reject check hiding beside a
  // hold/unverifiable was ACCEPTED even though the backend can never
  // emit a reject check in M12 (policyM12.ts:45).
  it("rejects M12 HOLD + [pass, hold, reject] — hasHold true does not excuse a reject check", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(runWith("M12", "HOLD", [INTERVAL_PASS, DISPATCH_HOLD, DISPATCH_REJECT])),
    );
    await expect(runDeskCheck(M12_REQUEST)).rejects.toThrow(
      /HOLD contradicts its checks: a reject check is present/,
    );
  });

  it("rejects M12 HOLD + [hold, reject] — a reject check is impossible in M12 under any verdict", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(runWith("M12", "HOLD", [DISPATCH_HOLD, DISPATCH_REJECT])),
    );
    await expect(runDeskCheck(M12_REQUEST)).rejects.toThrow(
      /HOLD contradicts its checks: a reject check is present/,
    );
  });

  it("rejects M12 HOLD + [unverifiable, reject] — same hole via unverifiable", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(runWith("M12", "HOLD", [DISPATCH_UNVERIFIABLE, DISPATCH_REJECT])),
    );
    await expect(runDeskCheck(M12_REQUEST)).rejects.toThrow(
      /HOLD contradicts its checks: a reject check is present/,
    );
  });

  it("rejects M12 HOLD + [reject] only — the reject check is now named, not the missing hold", async () => {
    fetchMock.mockResolvedValue(jsonResponse(runWith("M12", "HOLD", [DISPATCH_REJECT])));
    await expect(runDeskCheck(M12_REQUEST)).rejects.toThrow(
      /HOLD contradicts its checks: a reject check is present/,
    );
  });

  it("rejects M12 MINE + [pass, reject] — any non-pass check blocks MINE/CURTAIL", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(runWith("M12", "MINE", [INTERVAL_PASS, DISPATCH_REJECT])),
    );
    await expect(runDeskCheck(M12_REQUEST)).rejects.toThrow(
      /MINE contradicts its checks: every check must pass/,
    );
  });

  it("rejects M13 HOLD + [reject] only — the M13 branch already guards on hasReject", async () => {
    fetchMock.mockResolvedValue(jsonResponse(runWith("M13", "HOLD", [TX_REJECT])));
    await expect(runDeskCheck(M13_REQUEST)).rejects.toThrow(
      /HOLD contradicts its checks: a reject check is present/,
    );
  });

  it("still accepts the consistent verdicts — REJECT + reject, HOLD + hold, M12 HOLD + hold", async () => {
    fetchMock.mockResolvedValue(jsonResponse(runWith("M13", "REJECT", [TX_REJECT])));
    expect((await runDeskCheck(M13_REQUEST)).verdict).toBe("REJECT");
    fetchMock.mockResolvedValue(jsonResponse(runWith("M13", "HOLD", [TX_PASS, TVL_HOLD])));
    expect((await runDeskCheck(M13_REQUEST)).verdict).toBe("HOLD");
    fetchMock.mockResolvedValue(
      jsonResponse(runWith("M12", "HOLD", [INTERVAL_PASS, DISPATCH_HOLD])),
    );
    expect((await runDeskCheck(M12_REQUEST)).verdict).toBe("HOLD");
  });

  it("still accepts M13 APPROVE + pass beside a skipped sanctions check — skipped is ignored for the verdict", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        runWith("M13", "APPROVE", [
          TX_PASS,
          {
            id: "sanctions",
            name: "Sanctions screening (issuer)",
            status: "skipped",
            reason: "No sanctions-screening evidence was bought in this run.",
          },
        ]),
      ),
    );
    expect((await runDeskCheck(M13_REQUEST)).verdict).toBe("APPROVE");
  });
});

describe("Desk presets — verdict-free ids and on-boundary intervals", () => {
  it("no preset id embeds a verdict", () => {
    for (const p of DESK_PRESETS) {
      expect(p.id).not.toMatch(/approve|reject|hold|mine|curtail/i);
    }
    expect(DESK_PRESETS.map((p) => p.id)).toEqual([
      "m13-institutional-defi",
      "m13-thin-tvl",
      "m13-reverted-counterparty-tx",
      "m12-grid-low-breakeven",
      "m12-grid-high-breakeven",
    ]);
  });

  it("recentIntervalIso is always on the CAISO 60-minute boundary and finished", () => {
    const iso = recentIntervalIso();
    const ms = Date.parse(iso);
    expect(ms % 3_600_000).toBe(0);
    expect(new Date(ms).getUTCSeconds()).toBe(0);
    // Finished: the interval ends (start + 60 min) before now.
    expect(ms + 3_600_000).toBeLessThan(Date.now());
  });

  it("M12 preset interval_start values are on the 60-minute boundary", () => {
    for (const p of DESK_PRESETS.filter((x) => x.mission === "M12")) {
      const req = presetRunRequest(p, p.inputs);
      if (req.mission !== "M12") throw new Error("expected M12 request");
      expect(Date.parse(req.interval_start) % 3_600_000).toBe(0);
    }
  });

  it("M13 hold/reject presets use 200-able inputs — listed protocol, real issuer, real tx", () => {
    const hold = DESK_PRESETS.find((p) => p.id === "m13-thin-tvl")!;
    expect(hold.inputs["protocol"]).toBe("wingriders");
    expect(hold.inputs["issuer_entity"]).toBe("AAPL");
    expect(hold.inputs["tx_hash"]).toMatch(/^0x1b9e2b48/);
    const reject = DESK_PRESETS.find((p) => p.id === "m13-reverted-counterparty-tx")!;
    expect(reject.inputs["protocol"]).toBe("aave-v3");
    expect(reject.inputs["issuer_entity"]).toBe("AAPL");
    expect(reject.inputs["tx_hash"]).toMatch(/^0x1a146789/);
  });
});
