// Validator handler tests (vitest).
//
// Fixture tests use a stub fetch injected via ValidatorDeps (the same
// test-only transport-override pattern as TvlDeps in src/handlers/tvl.ts):
// disagreement and one-source-down cannot be produced deterministically
// from the live beacon nodes, so those paths are driven by fixtures.
// The exact-value tests at the bottom are LIVE: they call the real
// handler against the real keyless beacon sources with no stub, and
// assert the PLAN.md §2 values (1 -> 32000000000, 100000 -> 0,
// 500000 -> 0).
//
// Hermetic DB: SQLITE_PATH points at a scratch dir under
// ~/workspace/verireceipt-build/tmp (never /tmp — a 512 MB tmpfs shared
// by every agent on this VM — and never the production ./data DB).
// getDb() reads SQLITE_PATH lazily at first open, so setting it at
// module top (before any handler call) is sufficient.

import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";

// m7 (J1 round 2): a unique scratch dir per test run (mkdtemp), so
// sibling worktrees / concurrent suites never share one DB.
const SCRATCH_PARENT = resolve(process.cwd(), "..", "tmp");
mkdirSync(SCRATCH_PARENT, { recursive: true });
const SCRATCH_DIR = mkdtempSync(join(SCRATCH_PARENT, "validator-test-"));
process.env.SQLITE_PATH = join(SCRATCH_DIR, "verireceipt.sqlite");

afterAll(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

import { ApiError } from "../src/core/errors";
import { sha256Hex, type Receipt } from "../src/core/receipt";
import { getDb, getReceiptEvidence } from "../src/core/db";
import {
  BEACON_SOURCES,
  INTENT,
  handleValidator,
  parseValidatorResponse,
} from "../src/handlers/validator";
import { buildServer } from "../src/server";

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(status);
    expect(apiErr.code).toBe(code);
    return apiErr;
  }
  throw new Error("expected ApiError " + status + " " + code + " but call succeeded");
}

function receiptCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM miner_receipts").get() as { n: number };
  return row.n;
}

/** Minimal beacon API validator body (standard path shape). */
function beaconBody(
  index: number,
  effectiveBalance: string,
  status: string,
  optimistic = false,
): string {
  return JSON.stringify({
    data: {
      index: String(index),
      balance: "32083979186",
      status,
      validator: {
        pubkey: "0x" + "ab".repeat(48),
        withdrawal_credentials: "0x02000000000000000000000015f4b914a0ccd14333d850ff311d6dafbfbaa32b",
        effective_balance: effectiveBalance,
        slashed: false,
        activation_eligibility_epoch: "0",
        activation_epoch: "0",
        exit_epoch: "18446744073709551615",
        withdrawable_epoch: "18446744073709551615",
      },
    },
    execution_optimistic: optimistic,
    finalized: false,
  });
}

/**
 * Beacon body with an arbitrary (possibly malformed) execution_optimistic
 * value, or the field omitted entirely (F7 round-2 fixtures). Built from
 * beaconBody so the rest of the shape stays the standard one.
 */
function beaconBodyOptimistic(
  index: number,
  effectiveBalance: string,
  status: string,
  optimistic: unknown,
  include = true,
): string {
  const body = JSON.parse(beaconBody(index, effectiveBalance, status)) as Record<string, unknown>;
  if (include) body.execution_optimistic = optimistic;
  else delete body.execution_optimistic;
  return JSON.stringify(body);
}

type StubLeg = { status: number; body: string } | Error;

/**
 * Stub fetch dispatching on the request URL's source base. Each staged
 * leg maps to the BEACON_SOURCES entry at the same index, so agreement /
 * disagreement / down can be staged per source. VR: a source with no
 * staged leg (e.g. the third source when only two are given) is DOWN
 * (network error), so these 2-leg fixtures keep their 2-source meaning.
 */
function makeStubFetch(legs: StubLeg[]): typeof fetch {
  const impl = async (url: string | URL | Request): Promise<Response> => {
    const urlStr = String(url);
    const idx = BEACON_SOURCES.findIndex((base) => urlStr.startsWith(base));
    if (idx < 0) throw new Error("stub fetch got unexpected URL: " + urlStr);
    const leg = legs[idx];
    if (leg === undefined) throw new Error("stub: source " + idx + " not staged (down)");
    if (leg instanceof Error) throw leg;
    return {
      ok: leg.status >= 200 && leg.status < 300,
      status: leg.status,
      text: async () => leg.body,
    } as unknown as Response;
  };
  return impl as unknown as typeof fetch;
}

function bothAgree(
  index: number,
  effectiveBalance: string,
  status: string,
): [StubLeg, StubLeg] {
  const body = beaconBody(index, effectiveBalance, status);
  return [
    { status: 200, body },
    { status: 200, body },
  ];
}

describe("handleValidator validation", () => {
  it("missing validator_index -> 400 INVALID_VALIDATOR_INDEX", async () => {
    await expectApiError(handleValidator({}), 400, "INVALID_VALIDATOR_INDEX");
  });

  it("non-integer validator_index -> 400 INVALID_VALIDATOR_INDEX", async () => {
    // "01" / "007" / "00": leading zeros are not an integer literal in
    // the intent schema (validator_index: integer) -> 400 (J1 m3 / J2).
    for (const bad of ["abc", "-1", "1.5", "0x10", "", "1e3", "+1", " 1", "1 ", "99999999999999999999999", "01", "007", "00"]) {
      await expectApiError(
        handleValidator({ validator_index: bad }),
        400,
        "INVALID_VALIDATOR_INDEX",
      );
    }
  });

  it("accepts index 0 (the only valid value starting with 0)", async () => {
    const res = (await handleValidator(
      { validator_index: "0" },
      { fetchImpl: makeStubFetch(bothAgree(0, "32000000000", "active_ongoing")) },
    )) as Record<string, unknown>;
    expect(res.validator_index).toBe(0);
  });

  it("undeclared `index` alias is 400 UNKNOWN_PARAM, not served", async () => {
    await expectApiError(handleValidator({ index: "1" }), 400, "UNKNOWN_PARAM");
    await expectApiError(
      handleValidator({ validator_index: "1", index: "2" }),
      400,
      "UNKNOWN_PARAM",
    );
  });

  it("validator_index at the official max 1000000000 is accepted; 1000000001 is 400 MAX_PARAM_VALUE", async () => {
    const res = (await handleValidator(
      { validator_index: "1000000000" },
      { fetchImpl: makeStubFetch(bothAgree(1_000_000_000, "0", "withdrawal_done")) },
    )) as Record<string, unknown>;
    expect(res.validator_index).toBe(1_000_000_000);
    await expectApiError(
      handleValidator({ validator_index: "1000000001" }),
      400,
      "MAX_PARAM_VALUE",
    );
  });
});

describe("handleValidator agreement (stub fetch)", () => {
  it("index 1 -> 32000000000, active_ongoing, number, receipt re-hashes", async () => {
    const body = beaconBody(1, "32000000000", "active_ongoing");
    const res = (await handleValidator(
      { validator_index: "1" },
      { fetchImpl: makeStubFetch([{ status: 200, body }, { status: 200, body }]) },
    )) as Record<string, unknown>;
    expect(res.validator_index).toBe(1);
    expect(res.effective_balance).toBe(32000000000);
    expect(typeof res.effective_balance).toBe("number");
    expect(res.status).toBe("active_ongoing");
    expect(res.verdict).toBe("verified");
    expect(res.confidence).toBe(1.0);
    const receipt = res.receipt as Receipt;
    expect(receipt.intent).toBe(INTENT);
    // VR: three sources, two staged + agreeing, the third down.
    expect(receipt.quorum_votes).toBe("2/3 sources agreed");
    expect(res.source).toBe(BEACON_SOURCES[0] + " + " + BEACON_SOURCES[1]);
    expect(receipt.raw_response_sha256).toBe(sha256Hex(body));
    expect(receipt.receipt_id).toMatch(/^rcpt_[A-Z0-9]{26}$/);
    const ev = getReceiptEvidence(receipt.receipt_id);
    expect(ev.found).toBe(true);
    expect(ev.evidence?.toString("utf8")).toBe(body);
  });

  it("index 100000 -> 0 (real zero, never null), withdrawal_done", async () => {
    const res = (await handleValidator(
      { validator_index: "100000" },
      { fetchImpl: makeStubFetch(bothAgree(100000, "0", "withdrawal_done")) },
    )) as Record<string, unknown>;
    expect(res.validator_index).toBe(100000);
    expect(res.effective_balance).toBe(0);
    expect(typeof res.effective_balance).toBe("number");
    expect(res.effective_balance).not.toBeNull();
    expect(res.status).toBe("withdrawal_done");
  });

  it("index 500000 -> 0 (real zero, never null), withdrawal_done", async () => {
    const res = (await handleValidator(
      { validator_index: "500000" },
      { fetchImpl: makeStubFetch(bothAgree(500000, "0", "withdrawal_done")) },
    )) as Record<string, unknown>;
    expect(res.validator_index).toBe(500000);
    expect(res.effective_balance).toBe(0);
    expect(typeof res.effective_balance).toBe("number");
    expect(res.status).toBe("withdrawal_done");
  });
});

describe("handleValidator fail-closed (stub fetch)", () => {
  it("2-of-2 disagreement -> 502 QUORUM_UNREACHABLE, no receipt minted", async () => {
    const before = receiptCount();
    await expectApiError(
      handleValidator(
        { validator_index: "1" },
        {
          fetchImpl: makeStubFetch([
            { status: 200, body: beaconBody(1, "32000000000", "active_ongoing") },
            { status: 200, body: beaconBody(1, "31000000000", "active_ongoing") },
          ]),
        },
      ),
      502,
      "QUORUM_UNREACHABLE",
    );
    expect(receiptCount()).toBe(before);
  });

  it("status disagreement -> 502 QUORUM_UNREACHABLE", async () => {
    await expectApiError(
      handleValidator(
        { validator_index: "1" },
        {
          fetchImpl: makeStubFetch([
            { status: 200, body: beaconBody(1, "32000000000", "active_ongoing") },
            { status: 200, body: beaconBody(1, "32000000000", "active_exiting") },
          ]),
        },
      ),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  it("one source down -> 502 QUORUM_UNREACHABLE, never a single-source answer", async () => {
    const before = receiptCount();
    await expectApiError(
      handleValidator(
        { validator_index: "1" },
        {
          fetchImpl: makeStubFetch([
            { status: 200, body: beaconBody(1, "32000000000", "active_ongoing") },
            new Error("connection refused"),
          ]),
        },
      ),
      502,
      "QUORUM_UNREACHABLE",
    );
    expect(receiptCount()).toBe(before);
  });

  it("one source 404 -> 502 QUORUM_UNREACHABLE", async () => {
    await expectApiError(
      handleValidator(
        { validator_index: "1" },
        {
          fetchImpl: makeStubFetch([
            { status: 200, body: beaconBody(1, "32000000000", "active_ongoing") },
            { status: 404, body: JSON.stringify({ code: 404, message: "validator not found" }) },
          ]),
        },
      ),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  it("malformed leg (non-digit effective_balance) -> 502 QUORUM_UNREACHABLE", async () => {
    const badBody = JSON.stringify({
      execution_optimistic: false,
      data: {
        index: "1",
        balance: "32083979186",
        status: "active_ongoing",
        validator: { effective_balance: "not-a-number" },
      },
    });
    await expectApiError(
      handleValidator(
        { validator_index: "1" },
        {
          fetchImpl: makeStubFetch([
            { status: 200, body: beaconBody(1, "32000000000", "active_ongoing") },
            { status: 200, body: badBody },
          ]),
        },
      ),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  // J2 fix round (F1–F4): each new fail-closed check gets a stub test.
  it("F1: both legs return a DIFFERENT index (ask 1, body 999) -> 502, no receipt", async () => {
    const before = receiptCount();
    await expectApiError(
      handleValidator(
        { validator_index: "1" },
        { fetchImpl: makeStubFetch(bothAgree(999, "32000000000", "active_ongoing")) },
      ),
      502,
      "QUORUM_UNREACHABLE",
    );
    expect(receiptCount()).toBe(before);
  });

  it("F1: one leg returns a different index -> 502, no receipt", async () => {
    const before = receiptCount();
    await expectApiError(
      handleValidator(
        { validator_index: "1" },
        {
          fetchImpl: makeStubFetch([
            { status: 200, body: beaconBody(1, "32000000000", "active_ongoing") },
            { status: 200, body: beaconBody(999, "32000000000", "active_ongoing") },
          ]),
        },
      ),
      502,
      "QUORUM_UNREACHABLE",
    );
    expect(receiptCount()).toBe(before);
  });

  it("F2: both legs execution_optimistic=true -> 502, no receipt", async () => {
    const before = receiptCount();
    await expectApiError(
      handleValidator(
        { validator_index: "1" },
        {
          fetchImpl: makeStubFetch([
            { status: 200, body: beaconBody(1, "32000000000", "active_ongoing", true) },
            { status: 200, body: beaconBody(1, "32000000000", "active_ongoing", true) },
          ]),
        },
      ),
      502,
      "QUORUM_UNREACHABLE",
    );
    expect(receiptCount()).toBe(before);
  });

  it("F3: both legs agree on an unknown status -> 502, no receipt", async () => {
    const before = receiptCount();
    await expectApiError(
      handleValidator(
        { validator_index: "1" },
        { fetchImpl: makeStubFetch(bothAgree(1, "32000000000", "not_a_real_status")) },
      ),
      502,
      "QUORUM_UNREACHABLE",
    );
    expect(receiptCount()).toBe(before);
  });

  it("F4: both legs 404 (nonexistent validator) -> 422 VALIDATOR_NOT_FOUND, no receipt", async () => {
    const before = receiptCount();
    await expectApiError(
      handleValidator(
        { validator_index: "99999999" },
        {
          fetchImpl: makeStubFetch([
            { status: 404, body: JSON.stringify({ code: 404, message: "validator not found" }) },
            { status: 404, body: JSON.stringify({ code: 404, message: "validator not found" }) },
          ]),
        },
      ),
      422,
      "VALIDATOR_NOT_FOUND",
    );
    expect(receiptCount()).toBe(before);
  });

  // J2 fix round 2 (F6): the F4 settlement wait must be bounded by
  // timeoutMs. A 404 + a leg that never settles (ignores the abort
  // signal) must 502 within ~timeoutMs, never hang; a 404 + a
  // slow-but-finite leg must 502 within timeoutMs, not after the leg.
  // Each test carries a 5 s vitest timeout as its own watchdog, so a
  // regression hangs the test, not the suite.
  it("F6: 404 + never-settling leg -> 502 within timeoutMs (no hang)", async () => {
    const before = receiptCount();
    const hanging = (_url: unknown) => new Promise<Response>(() => {});
    const fast404 = makeStubFetch([
      { status: 404, body: "nf" },
      { status: 404, body: "nf" },
    ]);
    const mixed = (async (url: string | URL | Request) => {
      const s = String(url);
      if (s.startsWith(BEACON_SOURCES[1])) return hanging(s);
      return fast404(url);
    }) as unknown as typeof fetch;
    const t0 = Date.now();
    await expectApiError(
      handleValidator({ validator_index: "99999999" }, { fetchImpl: mixed, timeoutMs: 500 }),
      502,
      "QUORUM_UNREACHABLE",
    );
    // ~500 ms budget: quorum rejects at once on the 404, the bounded
    // wait adds at most timeoutMs. Generous ceiling for a loaded VM,
    // still far below the 4000 ms probe watchdog.
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(receiptCount()).toBe(before);
  }, 5000);

  it("F6: 404 + slow-but-finite leg (1200ms) -> 502 within timeoutMs", async () => {
    const before = receiptCount();
    const slow = async (_url: unknown): Promise<Response> => {
      await new Promise<void>((r) => setTimeout(r, 1200));
      return {
        ok: true,
        status: 200,
        text: async () => beaconBody(1, "32000000000", "active_ongoing"),
      } as unknown as Response;
    };
    const fast404 = makeStubFetch([
      { status: 404, body: "nf" },
      { status: 404, body: "nf" },
    ]);
    const mixed = (async (url: string | URL | Request) => {
      const s = String(url);
      if (s.startsWith(BEACON_SOURCES[1])) return slow(s);
      return fast404(url);
    }) as unknown as typeof fetch;
    const t0 = Date.now();
    await expectApiError(
      handleValidator({ validator_index: "1" }, { fetchImpl: mixed, timeoutMs: 500 }),
      502,
      "QUORUM_UNREACHABLE",
    );
    // Must return before the 1200 ms leg settles: proves the wait is
    // bounded by timeoutMs, not by the slowest leg.
    expect(Date.now() - t0).toBeLessThan(1100);
    expect(receiptCount()).toBe(before);
  }, 5000);

  it("F6: both 404 with 2nd leg delayed 300ms -> still 422 VALIDATOR_NOT_FOUND", async () => {
    const before = receiptCount();
    const delayed404 = async (_url: unknown): Promise<Response> => {
      await new Promise<void>((r) => setTimeout(r, 300));
      return { ok: false, status: 404, text: async () => "nf" } as unknown as Response;
    };
    const fast404 = makeStubFetch([
      { status: 404, body: "nf" },
      { status: 404, body: "nf" },
    ]);
    const mixed = (async (url: string | URL | Request) => {
      const s = String(url);
      if (s.startsWith(BEACON_SOURCES[1])) return delayed404(s);
      return fast404(url);
    }) as unknown as typeof fetch;
    await expectApiError(
      handleValidator({ validator_index: "99999999" }, { fetchImpl: mixed, timeoutMs: 1000 }),
      422,
      "VALIDATOR_NOT_FOUND",
    );
    expect(receiptCount()).toBe(before);
  }, 5000);

  // J2 fix round 2 (F7): execution_optimistic must be an explicit
  // boolean. Missing / "true" / 1 / null are malformed and fail closed.
  it("F7: execution_optimistic missing / non-boolean -> 502, no receipt (each variant)", async () => {
    const before = receiptCount();
    const variants: Array<{ label: string; body: string }> = [
      {
        label: "missing",
        body: beaconBodyOptimistic(1, "32000000000", "active_ongoing", undefined, false),
      },
      {
        label: '"true" string',
        body: beaconBodyOptimistic(1, "32000000000", "active_ongoing", "true"),
      },
      {
        label: "1 number",
        body: beaconBodyOptimistic(1, "32000000000", "active_ongoing", 1),
      },
      {
        label: "null",
        body: beaconBodyOptimistic(1, "32000000000", "active_ongoing", null),
      },
    ];
    for (const v of variants) {
      await expectApiError(
        handleValidator(
          { validator_index: "1" },
          { fetchImpl: makeStubFetch([{ status: 200, body: v.body }, { status: 200, body: v.body }]) },
        ),
        502,
        "QUORUM_UNREACHABLE",
      );
    }
    expect(receiptCount()).toBe(before);
  });

  it("F7: one leg with non-boolean execution_optimistic -> 502, no receipt", async () => {
    const before = receiptCount();
    await expectApiError(
      handleValidator(
        { validator_index: "1" },
        {
          fetchImpl: makeStubFetch([
            { status: 200, body: beaconBody(1, "32000000000", "active_ongoing") },
            {
              status: 200,
              body: beaconBodyOptimistic(1, "32000000000", "active_ongoing", "false"),
            },
          ]),
        },
      ),
      502,
      "QUORUM_UNREACHABLE",
    );
    expect(receiptCount()).toBe(before);
  });
});

describe("parseValidatorResponse", () => {
  it("parses a valid body", () => {
    const leg = parseValidatorResponse(
      beaconBody(1, "32000000000", "active_ongoing"),
      "https://example.invalid/eth/v1/beacon/states/head/validators/1",
      1,
    );
    expect(leg.effectiveBalance).toBe(32000000000);
    expect(leg.status).toBe("active_ongoing");
  });

  it("rejects non-JSON, missing data, non-digit balance, empty status", () => {
    const url = "https://example.invalid/v/1";
    expect(() => parseValidatorResponse("not json", url, 1)).toThrow();
    expect(() =>
      parseValidatorResponse(JSON.stringify({ execution_optimistic: false }), url, 1),
    ).toThrow();
    expect(() =>
      parseValidatorResponse(
        JSON.stringify({
          execution_optimistic: false,
          data: { index: "1", status: "active_ongoing", validator: { effective_balance: "12x" } },
        }),
        url,
        1,
      ),
    ).toThrow();
    expect(() =>
      parseValidatorResponse(
        JSON.stringify({
          execution_optimistic: false,
          data: { index: "1", status: "", validator: { effective_balance: "0" } },
        }),
        url,
        1,
      ),
    ).toThrow();
  });

  it("rejects index mismatch (F1), execution_optimistic=true (F2), unknown status (F3)", () => {
    const url = "https://example.invalid/v/1";
    // F1: body is for validator 999, expected 1.
    expect(() => parseValidatorResponse(beaconBody(999, "32000000000", "active_ongoing"), url, 1)).toThrow(
      /does not match requested validator/,
    );
    // F1: missing data.index entirely.
    expect(() =>
      parseValidatorResponse(
        JSON.stringify({
          execution_optimistic: false,
          data: { status: "active_ongoing", validator: { effective_balance: "32000000000" } },
        }),
        url,
        1,
      ),
    ).toThrow(/does not match requested validator/);
    // F2: node flags its own data unverified.
    expect(() =>
      parseValidatorResponse(beaconBody(1, "32000000000", "active_ongoing", true), url, 1),
    ).toThrow(/execution_optimistic/);
    // F3: status outside the nine-value beacon enum.
    expect(() =>
      parseValidatorResponse(beaconBody(1, "32000000000", "not_a_real_status"), url, 1),
    ).toThrow(/unknown status/);
  });

  it("rejects execution_optimistic missing / non-boolean (F7)", () => {
    const url = "https://example.invalid/v/1";
    // Missing field entirely.
    expect(() =>
      parseValidatorResponse(
        beaconBodyOptimistic(1, "32000000000", "active_ongoing", undefined, false),
        url,
        1,
      ),
    ).toThrow(/execution_optimistic/);
    // String "true" / "false" are not booleans.
    for (const bad of ["true", "false"]) {
      expect(() =>
        parseValidatorResponse(
          beaconBodyOptimistic(1, "32000000000", "active_ongoing", bad),
          url,
          1,
        ),
      ).toThrow(/execution_optimistic/);
    }
    // Number 1 / 0 and null are not booleans.
    for (const bad of [1, 0, null]) {
      expect(() =>
        parseValidatorResponse(
          beaconBodyOptimistic(1, "32000000000", "active_ongoing", bad),
          url,
          1,
        ),
      ).toThrow(/execution_optimistic/);
    }
    // Explicit boolean false still parses (positive control).
    const leg = parseValidatorResponse(
      beaconBodyOptimistic(1, "32000000000", "active_ongoing", false),
      url,
      1,
    );
    expect(leg.effectiveBalance).toBe(32000000000);
  });
});

describe("GET /v1/validator routing", () => {
  it("mounts: missing param -> 400 (no network touched)", async () => {
    const app = buildServer();
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/v1/validator" });
      expect(res.statusCode).toBe(400);
      expect((res.json() as Record<string, unknown>).code).toBe("INVALID_VALIDATOR_INDEX");
      const bad = await app.inject({ method: "GET", url: "/v1/validator?validator_index=abc" });
      expect(bad.statusCode).toBe(400);
      const alias = await app.inject({ method: "GET", url: "/v1/validator?index=1" });
      expect(alias.statusCode).toBe(400);
      expect((alias.json() as Record<string, unknown>).code).toBe("UNKNOWN_PARAM");
      const overMax = await app.inject({ method: "GET", url: "/v1/validator?validator_index=1000000001" });
      expect(overMax.statusCode).toBe(400);
      expect((overMax.json() as Record<string, unknown>).code).toBe("MAX_PARAM_VALUE");
    } finally {
      await app.close();
    }
  });
});

describe("handleValidator LIVE (real beacon sources, no stub)", () => {
  // Test-only timeout raise (same pattern as TvlDeps.timeoutMs):
  // production stays at 4500 ms; the sandbox egress proxy is slow,
  // so live tests get 20 s per leg. The production-timeout path is
  // proven separately by the live curl check against the built server.
  const LIVE_TIMEOUT_MS = 20000;

  it("live index 1 -> 32000000000", async () => {
    const res = (await handleValidator(
      { validator_index: "1" },
      { timeoutMs: LIVE_TIMEOUT_MS },
    )) as Record<string, unknown>;
    expect(res.effective_balance).toBe(32000000000);
    expect(typeof res.effective_balance).toBe("number");
    expect(res.status).toBe("active_ongoing");
    // VR: 2-of-3 quorum over three live sources.
    // 2 or 3 of the three live sources (the third may be rate-limited
    // or optimistic and then does not vote).
    expect((res.receipt as Receipt).quorum_votes).toMatch(/^[23]\/3 sources agreed$/);
    expect(res.verdict).toBe("verified");
  }, 30000);

  it("live index 100000 -> 0", async () => {
    const res = (await handleValidator(
      { validator_index: "100000" },
      { timeoutMs: LIVE_TIMEOUT_MS },
    )) as Record<string, unknown>;
    expect(res.effective_balance).toBe(0);
    expect(typeof res.effective_balance).toBe("number");
    expect(res.status).toBe("withdrawal_done");
  }, 30000);

  it("live index 500000 -> 0", async () => {
    const res = (await handleValidator(
      { validator_index: "500000" },
      { timeoutMs: LIVE_TIMEOUT_MS },
    )) as Record<string, unknown>;
    expect(res.effective_balance).toBe(0);
    expect(typeof res.effective_balance).toBe("number");
    expect(res.status).toBe("withdrawal_done");
  }, 30000);
});
