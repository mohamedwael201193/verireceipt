// VR: validator quorum resilience tests (vitest).
//
// The validator answers only on >= 2 agreeing sources out of three
// (BEACON_SOURCES). Transient upstream errors (429/500/502/503/504) get
// one bounded retry per source that honours Retry-After. These tests
// drive every path with a scripted stub fetch (per-source response
// sequences + call log) and assert that a single-source answer is never
// served as "verified" and that no receipt is minted on any failure.
//
// Hermetic DB: SQLITE_PATH points at a scratch dir next to the repo
// (same pattern as tests/validator.test.ts), never the production DB.

import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";

// Unique scratch dir per run (mkdtemp; J1 round-2 m7).
const SCRATCH_PARENT = resolve(process.cwd(), "..", "tmp");
mkdirSync(SCRATCH_PARENT, { recursive: true });
const SCRATCH_DIR = mkdtempSync(join(SCRATCH_PARENT, "validator-resilience-test-"));
process.env.SQLITE_PATH = join(SCRATCH_DIR, "verireceipt.sqlite");

afterAll(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

import { ApiError } from "../src/core/errors";
import { sha256Hex, type Receipt } from "../src/core/receipt";
import { getDb, getReceiptEvidence } from "../src/core/db";
import {
  BEACON_SOURCES,
  MIN_RETRY_WINDOW_MS,
  RETRY_AFTER_CAP_MS,
  RETRY_BASE_DELAY_MS,
  RETRY_429_DEFAULT_DELAY_MS,
  RETRYABLE_STATUSES,
  VALIDATOR_MAX_ATTEMPTS,
  VALIDATOR_STRAGGLER_GRACE_MS,
  handleValidator,
  parseRetryAfterMs,
} from "../src/handlers/validator";

async function expectApiError(promise: Promise<unknown>, status: number, code: string): Promise<ApiError> {
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

function beaconBody(index: number, effectiveBalance: string, status: string, optimistic = false): string {
  return JSON.stringify({
    data: {
      index: String(index),
      balance: "32083979186",
      status,
      validator: { effective_balance: effectiveBalance, slashed: false },
    },
    execution_optimistic: optimistic,
    finalized: false,
  });
}

type Step =
  | { status: number; body?: string; retryAfter?: string; delayMs?: number }
  | Error;

/** Per-source scripted responses; the last step repeats. Records every call. */
function scripted(script: Array<Step[] | undefined>): {
  fetchImpl: typeof fetch;
  calls: Array<{ src: number; at: number }>;
  count: (src: number) => number;
} {
  const calls: Array<{ src: number; at: number }> = [];
  const seen = BEACON_SOURCES.map(() => 0);
  const impl = async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    const src = BEACON_SOURCES.findIndex((b) => u.startsWith(b));
    if (src < 0) throw new Error("unexpected URL " + u);
    calls.push({ src, at: Date.now() });
    const steps = script[src];
    if (!steps || steps.length === 0) throw new Error("stub: source " + src + " down");
    const step = steps[Math.min(seen[src], steps.length - 1)];
    seen[src]++;
    if (step instanceof Error) throw step;
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    const headers = new Headers();
    if (step.retryAfter !== undefined) headers.set("retry-after", step.retryAfter);
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers,
      text: async () => step.body ?? "",
    } as unknown as Response;
  };
  return {
    fetchImpl: impl as unknown as typeof fetch,
    calls,
    count: (src) => calls.filter((c) => c.src === src).length,
  };
}

const OK1 = { status: 200, body: beaconBody(1, "32000000000", "active_ongoing") };
const NF = { status: 404, body: JSON.stringify({ code: 404, message: "NOT_FOUND: validator" }) };

describe("parseRetryAfterMs (RFC 9110 Retry-After)", () => {
  const now = Date.parse("2026-11-21T01:00:00Z");
  it("delta-seconds", () => {
    expect(parseRetryAfterMs("0", now)).toBe(0);
    expect(parseRetryAfterMs("1", now)).toBe(1000);
    expect(parseRetryAfterMs(" 2 ", now)).toBe(2000);
    expect(parseRetryAfterMs("120", now)).toBe(120000);
  });
  it("HTTP-date (future -> delta, past -> 0)", () => {
    expect(parseRetryAfterMs("Sat, 21 Nov 2026 01:00:03 GMT", now)).toBe(3000);
    expect(parseRetryAfterMs("Sat, 21 Nov 2026 00:59:00 GMT", now)).toBe(0);
  });
  it("absent / unparseable -> undefined", () => {
    for (const v of [null, undefined, "", "   ", "-1", "1.5", "+3", "soon", "0x10"]) {
      expect(parseRetryAfterMs(v as string | null | undefined, now)).toBeUndefined();
    }
  });
});

describe("policy constants", () => {
  it("bounded: one retry, transient statuses only, capped wait", () => {
    expect(BEACON_SOURCES.length).toBe(3);
    expect(new Set(BEACON_SOURCES.map((b) => new URL(b).hostname)).size).toBe(3);
    expect(VALIDATOR_MAX_ATTEMPTS).toBe(2);
    expect([...RETRYABLE_STATUSES].sort()).toEqual([429, 500, 502, 503, 504]);
    expect(RETRY_AFTER_CAP_MS).toBeLessThan(4500);
    expect(RETRY_BASE_DELAY_MS).toBeLessThan(RETRY_AFTER_CAP_MS);
    expect(RETRY_429_DEFAULT_DELAY_MS).toBeLessThanOrEqual(RETRY_AFTER_CAP_MS);
    expect(RETRY_429_DEFAULT_DELAY_MS + MIN_RETRY_WINDOW_MS).toBeLessThan(4500);
    expect(MIN_RETRY_WINDOW_MS).toBeGreaterThan(0);
  });
});

describe("VR: retry on transient errors (stub fetch)", () => {
  it("429 (no Retry-After) then 200 is retried after RETRY_429_DEFAULT_DELAY_MS and the quorum succeeds", async () => {
    const s = scripted([[{ status: 429 }, OK1], [OK1], undefined]);
    const res = (await handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl })) as Record<string, unknown>;
    expect(res.verdict).toBe("verified");
    expect(res.effective_balance).toBe(32000000000);
    expect(s.count(0)).toBe(2);
    expect(s.count(1)).toBe(1);
    const c0 = s.calls.filter((c) => c.src === 0);
    expect(c0[1].at - c0[0].at).toBeGreaterThanOrEqual(RETRY_429_DEFAULT_DELAY_MS - 20);
    const receipt = res.receipt as Receipt;
    expect(receipt.quorum_votes).toBe("2/3 sources agreed");
    expect(getReceiptEvidence(receipt.receipt_id).evidence?.toString("utf8")).toBe(OK1.body);
    expect(receipt.raw_response_sha256).toBe(sha256Hex(OK1.body));
  });

  it("honours Retry-After: 1 (retry no sooner than ~1 s)", async () => {
    const s = scripted([[{ status: 429, retryAfter: "1" }, OK1], undefined, [{ status: 200, body: OK1.body, delayMs: 50 }]]);
    const res = (await handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl, timeoutMs: 3000 })) as Record<string, unknown>;
    expect(res.verdict).toBe("verified");
    const c0 = s.calls.filter((c) => c.src === 0);
    expect(c0.length).toBe(2);
    expect(c0[1].at - c0[0].at).toBeGreaterThanOrEqual(950);
  }, 8000);

  it("honours an HTTP-date Retry-After", async () => {
    const when = new Date(Date.now() + 1000).toUTCString();
    const s = scripted([[{ status: 503, retryAfter: when }, OK1], [OK1], undefined]);
    const res = (await handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl, timeoutMs: 3500 })) as Record<string, unknown>;
    expect(res.verdict).toBe("verified");
    expect(s.count(0)).toBe(2);
  }, 8000);

  it("no Retry-After -> base delay, 500/502/503/504 all retried once", async () => {
    for (const code of [500, 502, 503, 504]) {
      const s = scripted([[{ status: code }, OK1], [{ status: code }, OK1], undefined]);
      const t0 = Date.now();
      const res = (await handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl })) as Record<string, unknown>;
      expect(res.verdict).toBe("verified");
      expect(s.count(0)).toBe(2);
      expect(s.count(1)).toBe(2);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(RETRY_BASE_DELAY_MS - 20);
    }
  }, 10000);

  it("Retry-After above the cap is honoured by NOT retrying -> fails closed", async () => {
    const before = receiptCount();
    const s = scripted([[{ status: 429, retryAfter: "5" }, OK1], [OK1], undefined]);
    const t0 = Date.now();
    await expectApiError(handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl }), 502, "QUORUM_UNREACHABLE");
    expect(s.count(0)).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(receiptCount()).toBe(before);
  });

  it("no retry when the wait would leave < MIN_RETRY_WINDOW_MS of budget", async () => {
    const before = receiptCount();
    const s = scripted([[{ status: 429, retryAfter: "1" }, OK1], [OK1], undefined]);
    await expectApiError(
      handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl, timeoutMs: 1500 }),
      502,
      "QUORUM_UNREACHABLE",
    );
    expect(s.count(0)).toBe(1);
    expect(receiptCount()).toBe(before);
  });

  it("retry is bounded: persistent 503 -> exactly 2 attempts per source, then 502", async () => {
    const before = receiptCount();
    const s = scripted([[{ status: 503 }], [{ status: 503 }], [{ status: 503 }]]);
    const t0 = Date.now();
    await expectApiError(handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl }), 502, "QUORUM_UNREACHABLE");
    expect(Date.now() - t0).toBeLessThan(4500);
    // Two sources exhausted their 2 attempts -> quorum impossible -> 502
    // at once. The third source must not be retried after the request
    // has been decided (no wasted calls to a rate-limiting upstream).
    await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS + 200));
    const counts = [s.count(0), s.count(1), s.count(2)];
    expect(Math.max(...counts)).toBeLessThanOrEqual(VALIDATOR_MAX_ATTEMPTS);
    expect(counts.filter((c) => c === 2).length).toBeGreaterThanOrEqual(2);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(5);
    expect(receiptCount()).toBe(before);
  });

  it("non-transient statuses (400, 403, 404) and network errors are not retried", async () => {
    for (const code of [400, 403]) {
      const s = scripted([[{ status: code }], [OK1], undefined]);
      await expectApiError(handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl }), 502, "QUORUM_UNREACHABLE");
      expect(s.count(0)).toBe(1);
    }
    const s404 = scripted([[NF], [NF], [NF]]);
    await expectApiError(handleValidator({ validator_index: "99999999" }, { fetchImpl: s404.fetchImpl }), 422, "VALIDATOR_NOT_FOUND");
    expect([s404.count(0), s404.count(1), s404.count(2)]).toEqual([1, 1, 1]);
    const sNet = scripted([[new Error("ECONNRESET")], [OK1], undefined]);
    await expectApiError(handleValidator({ validator_index: "1" }, { fetchImpl: sNet.fetchImpl }), 502, "QUORUM_UNREACHABLE");
    expect(sNet.count(0)).toBe(1);
  });
});

describe("VR: execution_optimistic=true is retried once, never accepted", () => {
  const OPT = { status: 200, body: beaconBody(1, "32000000000", "active_ongoing", true) };

  it("optimistic then non-optimistic -> retried, verified with the non-optimistic body", async () => {
    const s = scripted([[OPT, OK1], [OK1], undefined]);
    const res = (await handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl })) as Record<string, unknown>;
    expect(res.verdict).toBe("verified");
    expect(s.count(0)).toBe(2);
    const receipt = res.receipt as Receipt;
    expect(getReceiptEvidence(receipt.receipt_id).evidence?.toString("utf8")).not.toContain('"execution_optimistic":true');
  });

  it("persistently optimistic source is dropped (2 attempts), others still verify", async () => {
    const s = scripted([[OPT], [OK1], [OK1]]);
    const res = (await handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl })) as Record<string, unknown>;
    expect(res.verdict).toBe("verified");
    expect(String(res.source)).not.toContain(new URL(BEACON_SOURCES[0]).hostname);
  });

  it("two persistently optimistic sources + one good -> 502, no receipt", async () => {
    const before = receiptCount();
    const s = scripted([[OPT], [OPT], [OK1]]);
    await expectApiError(handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl }), 502, "QUORUM_UNREACHABLE");
    expect(s.count(0)).toBe(2);
    expect(s.count(1)).toBe(2);
    expect(receiptCount()).toBe(before);
  });

  it("502 message names each source's failure (operator diagnostics, no bodies)", async () => {
    const s = scripted([[{ status: 429 }], [OPT], [OK1]]);
    const err = await expectApiError(handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl }), 502, "QUORUM_UNREACHABLE");
    const h = BEACON_SOURCES.map((b) => new URL(b).hostname);
    // quorum stays possible until source 0's 429 retry also fails
    expect(err.message).toContain(`${h[0]}: HTTP 429`);
    expect(s.count(0)).toBe(2);
    expect(err.message).toContain(`${h[1]}: optimistic answer (execution_optimistic=true), rejected`);
    expect(err.message).not.toContain("malformed");
    expect(err.message).toContain(`${h[2]}: ok`);
    expect(err.message).not.toContain("32000000000");
  });
});

describe("VR: third source fallback (stub fetch)", () => {
  it("source 0 rate-limited throughout -> sources 1+2 agree -> verified, source names honest", async () => {
    const s = scripted([[{ status: 429 }], [OK1], [OK1]]);
    const res = (await handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl })) as Record<string, unknown>;
    expect(res.verdict).toBe("verified");
    expect(res.confidence).toBe(1.0);
    expect(res.source).toBe(BEACON_SOURCES[1] + " + " + BEACON_SOURCES[2]);
    expect(String(res.source)).not.toContain(new URL(BEACON_SOURCES[0]).hostname);
    expect((res.receipt as Receipt).quorum_votes).toBe("2/3 sources agreed");
    expect((res.receipt as Receipt).upstream_url.startsWith(BEACON_SOURCES[0])).toBe(false);
  });

  it("any one source down -> the other two still verify", async () => {
    for (let down = 0; down < 3; down++) {
      const script: Array<Step[] | undefined> = [[OK1], [OK1], [OK1]];
      script[down] = [new Error("connection refused")];
      const res = (await handleValidator({ validator_index: "1" }, { fetchImpl: scripted(script).fetchImpl })) as Record<string, unknown>;
      expect(res.verdict).toBe("verified");
      expect(String(res.source)).not.toContain(new URL(BEACON_SOURCES[down]).hostname);
    }
  });

  it("NEVER single-source: two sources 429/down, one answers -> 502, no receipt", async () => {
    const before = receiptCount();
    for (const script of [
      [[{ status: 429 }], [{ status: 429 }], [OK1]],
      [[OK1], [new Error("down")], [{ status: 503 }]],
      [[OK1], undefined, undefined],
    ] as Array<Array<Step[] | undefined>>) {
      await expectApiError(handleValidator({ validator_index: "1" }, { fetchImpl: scripted(script).fetchImpl }), 502, "QUORUM_UNREACHABLE");
    }
    expect(receiptCount()).toBe(before);
  });

  it("502 while a retry is still pending says so (no stale reason)", async () => {
    const s = scripted([[{ status: 429 }], [new Error("down")], [new Error("down")]]);
    const err = await expectApiError(handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl }), 502, "QUORUM_UNREACHABLE");
    expect(err.message).toContain(`${new URL(BEACON_SOURCES[0]).hostname}: HTTP 429, retry pending`);
    // the pending retry is abandoned once the request is decided
    await new Promise((r) => setTimeout(r, RETRY_429_DEFAULT_DELAY_MS + 200));
    expect(s.count(0)).toBe(1);
  }, 8000);

  it("2-vs-1 split (dissent already received) -> 502 QUORUM_CONFLICT, no receipt", async () => {
    const before = receiptCount();
    const dissent = { status: 200, body: beaconBody(1, "31000000000", "active_ongoing") };
    const s = scripted([[dissent], [{ ...OK1, delayMs: 20 }], [{ ...OK1, delayMs: 40 }]]);
    await expectApiError(handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl }), 502, "QUORUM_CONFLICT");
    expect(receiptCount()).toBe(before);
  });

  it("three-way disagreement -> 502 QUORUM_UNREACHABLE", async () => {
    const s = scripted([
      [{ status: 200, body: beaconBody(1, "32000000000", "active_ongoing") }],
      [{ status: 200, body: beaconBody(1, "31000000000", "active_ongoing") }],
      [{ status: 200, body: beaconBody(1, "32000000000", "active_exiting") }],
    ]);
    await expectApiError(handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl }), 502, "QUORUM_UNREACHABLE");
  });

  it("not-found needs two 404s and no answer", async () => {
    const before = receiptCount();
    await expectApiError(
      handleValidator({ validator_index: "99999999" }, { fetchImpl: scripted([[NF], [NF], undefined]).fetchImpl }),
      422,
      "VALIDATOR_NOT_FOUND",
    );
    await expectApiError(
      handleValidator({ validator_index: "99999999" }, { fetchImpl: scripted([[NF], [{ status: 429 }], [NF]]).fetchImpl }),
      422,
      "VALIDATOR_NOT_FOUND",
    );
    // a single 404 is not "does not exist"
    await expectApiError(
      handleValidator({ validator_index: "99999999" }, { fetchImpl: scripted([[NF], [{ status: 429 }], [{ status: 503 }]]).fetchImpl }),
      502,
      "QUORUM_UNREACHABLE",
    );
    // two 404s but a source DID return the validator -> not 422
    await expectApiError(
      handleValidator({ validator_index: "1" }, { fetchImpl: scripted([[NF], [NF], [OK1]]).fetchImpl }),
      502,
      "QUORUM_UNREACHABLE",
    );
    expect(receiptCount()).toBe(before);
  });

  it("429 storm stays inside the request budget", async () => {
    const s = scripted([
      [{ status: 429, retryAfter: "1" }],
      [{ status: 429, retryAfter: "1" }],
      [{ status: 429, retryAfter: "1" }],
    ]);
    const t0 = Date.now();
    await expectApiError(handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl, timeoutMs: 2500 }), 502, "QUORUM_UNREACHABLE");
    expect(Date.now() - t0).toBeLessThan(2500 + 500);
    expect(s.calls.length).toBeLessThanOrEqual(6);
  }, 8000);
});

// ---- V-M1 (J2 round 2): the verdict must not depend on arrival order ----
describe("V-M1: order-independent verdicts (straggler grace)", () => {
  const X = beaconBody(1, "32000000000", "active_ongoing");
  const Y = beaconBody(1, "31000000000", "active_ongoing");
  const at = (body: string, delayMs: number): Step[] => [{ status: 200, body, delayMs }];

  it("same answers {X, X, Y}: 502 QUORUM_CONFLICT for every source assignment and every arrival order", async () => {
    const before = receiptCount();
    const delayOrders = [
      [20, 60, 120],
      [120, 20, 60],
      [60, 120, 20],
      [20, 120, 60],
      [120, 60, 20],
      [60, 20, 120],
    ];
    let runs = 0;
    for (let dissent = 0; dissent < 3; dissent++) {
      for (const delays of delayOrders) {
        const script = [0, 1, 2].map((i) => at(i === dissent ? Y : X, delays[i]));
        await expectApiError(
          handleValidator({ validator_index: "1" }, { fetchImpl: scripted(script).fetchImpl }),
          502,
          "QUORUM_CONFLICT",
        );
        runs++;
      }
    }
    expect(runs).toBe(18); // dissent first, middle and last, on each source
    expect(receiptCount()).toBe(before);
  }, 20000);

  it("J2 S1: X@50, X@80, late dissent Y@600 (inside the grace) -> 502 QUORUM_CONFLICT, same as dissent-first", async () => {
    const late = scripted([at(X, 50), at(X, 80), at(Y, 600)]);
    await expectApiError(handleValidator({ validator_index: "1" }, { fetchImpl: late.fetchImpl }), 502, "QUORUM_CONFLICT");
    const first = scripted([at(Y, 50), at(X, 300), at(X, 350)]);
    await expectApiError(handleValidator({ validator_index: "1" }, { fetchImpl: first.fetchImpl }), 502, "QUORUM_CONFLICT");
  });

  it("J2 S4: a WRONG pair Y@50, Y@60 with the correct X@400 is never certified", async () => {
    const before = receiptCount();
    const s = scripted([at(Y, 50), at(Y, 60), at(X, 400)]);
    await expectApiError(handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl }), 502, "QUORUM_CONFLICT");
    expect(receiptCount()).toBe(before);
  });

  it("dissent at ~grace edge inside the budget: pair at 20/40, dissent at 900 ms -> conflict", async () => {
    const s = scripted([at(X, 20), at(X, 40), at(Y, 900)]);
    await expectApiError(handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl }), 502, "QUORUM_CONFLICT");
  });

  it("dissent after the budget (5 s > 4.5 s) does not count: pair verifies at ~grace, never waits for it", async () => {
    const s = scripted([at(X, 20), at(X, 40), at(Y, 5000)]);
    const t0 = Date.now();
    const res = (await handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl })) as Record<string, unknown>;
    const wall = Date.now() - t0;
    expect(res.verdict).toBe("verified");
    expect(res.effective_balance).toBe(32000000000);
    expect((res.receipt as Receipt).quorum_votes).toBe("2/3 sources agreed");
    expect(res.source).toBe(BEACON_SOURCES[0] + " + " + BEACON_SOURCES[1]);
    expect(wall).toBeGreaterThanOrEqual(40 + VALIDATOR_STRAGGLER_GRACE_MS - 30);
    expect(wall).toBeLessThan(40 + VALIDATOR_STRAGGLER_GRACE_MS + 400);
  }, 10000);

  it("grace is capped by the remaining budget (pair at 400 ms, budget 900 ms -> ends by ~900 ms)", async () => {
    const s = scripted([at(X, 380), at(X, 400), at(Y, 3000)]);
    const t0 = Date.now();
    const res = (await handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl, timeoutMs: 900 })) as Record<string, unknown>;
    expect(res.verdict).toBe("verified");
    expect(Date.now() - t0).toBeLessThan(900 + 300);
  }, 8000);

  it("all three agree -> 3/3, all three named; a failed third does not block (no grace wait)", async () => {
    const all = (await handleValidator(
      { validator_index: "1" },
      { fetchImpl: scripted([at(X, 10), at(X, 30), at(X, 60)]).fetchImpl },
    )) as Record<string, unknown>;
    expect((all.receipt as Receipt).quorum_votes).toBe("3/3 sources agreed");
    expect(all.source).toBe(BEACON_SOURCES.join(" + "));
    const t0 = Date.now();
    const failed = (await handleValidator(
      { validator_index: "1" },
      { fetchImpl: scripted([at(X, 10), at(X, 30), [new Error("down")]]).fetchImpl },
    )) as Record<string, unknown>;
    expect(failed.verdict).toBe("verified");
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("evidence is the first-arrived body of the agreeing group", async () => {
    const Xa = beaconBody(1, "32000000000", "active_ongoing").replace('"32083979186"', '"32083979187"'); // same eb/status, different balance bytes
    const res = (await handleValidator(
      { validator_index: "1" },
      { fetchImpl: scripted([at(X, 80), at(Xa, 20), at(X, 50)]).fetchImpl },
    )) as Record<string, unknown>;
    const receipt = res.receipt as Receipt;
    expect(receipt.raw_response_sha256).toBe(sha256Hex(Xa));
    expect(receipt.upstream_url.startsWith(BEACON_SOURCES[1])).toBe(true);
  });
});

describe("v-m1 (J2 round 2): a 404 next to an agreeing pair is a dissent", () => {
  it("[X, X, 404] -> 502 QUORUM_CONFLICT for every position/order, no receipt", async () => {
    const before = receiptCount();
    for (let nf = 0; nf < 3; nf++) {
      for (const delays of [[10, 30, 60], [60, 10, 30], [30, 60, 10]]) {
        const script: Step[][] = [0, 1, 2].map((i) =>
          i === nf ? [{ ...NF, delayMs: delays[i] }] : [{ ...OK1, delayMs: delays[i] }],
        );
        await expectApiError(
          handleValidator({ validator_index: "1" }, { fetchImpl: scripted(script).fetchImpl }),
          502,
          "QUORUM_CONFLICT",
        );
      }
    }
    expect(receiptCount()).toBe(before);
  });
});
