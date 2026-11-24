// A9 r2: verified-result cache, ChainSafe token bucket, Stakely root-pin
// bind, blockreq 4th source, 2-of-4 conflict rules.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";

const SCRATCH_PARENT = resolve(process.cwd(), "..", "tmp");
mkdirSync(SCRATCH_PARENT, { recursive: true });
const SCRATCH_DIR = mkdtempSync(join(SCRATCH_PARENT, "validator-r2-test-"));
process.env.SQLITE_PATH = join(SCRATCH_DIR, "verireceipt.sqlite");

afterAll(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

import { ApiError } from "../src/core/errors";
import type { Receipt } from "../src/core/receipt";
import {
  BEACON_SOURCE_CAPS,
  BEACON_SOURCES,
  FINALIZED_ROOT_CACHE_TTL_MS,
  VALIDATOR_MIN_AGREEING,
  canStartSource,
  chainsafeCanStart,
  chainsafeOn429,
  chainsafeTakeToken,
  handleValidator,
  noteSource429,
  parseStateRootResponse,
  parseValidatorResponse,
  resetValidatorCachesForTests,
  verifiedCacheSizeForTests,
} from "../src/handlers/validator";

const TEST_ROOT_A = "0x" + "ab".repeat(32);
const TEST_ROOT_B = "0x" + "cd".repeat(32);

beforeEach(() => {
  resetValidatorCachesForTests();
});
afterEach(() => {
  resetValidatorCachesForTests();
});

function isStateRootUrl(url: string): boolean {
  return /\/eth\/v1\/beacon\/states\/[^/]+\/root\/?$/.test(url);
}

function stateIdOf(url: string): string | undefined {
  const m = url.match(/\/eth\/v1\/beacon\/states\/([^/]+)\//);
  return m?.[1];
}

function rootBody(root: string, optimistic = false): string {
  return JSON.stringify({
    data: { root },
    execution_optimistic: optimistic,
    finalized: true,
  });
}

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
      validator: { effective_balance: effectiveBalance, slashed: false,
        pubkey: "0x" + "ab".repeat(48), activation_eligibility_epoch: "0", activation_epoch: "0",
        exit_epoch: "18446744073709551615", withdrawable_epoch: "18446744073709551615" },
    },
    execution_optimistic: optimistic,
    finalized: true,
  });
}

const OK1 = beaconBody(1, "32000000000", "active_ongoing");
const OK1_OPT = beaconBody(1, "32000000000", "active_ongoing", true);
const DISSENT = beaconBody(1, "31000000000", "active_ongoing");

type StubCfg = {
  /** Per-source validator body or status. Missing = down. */
  legs?: Array<{ status: number; body?: string } | Error | undefined>;
  /** Per-source finalized/root value. Default TEST_ROOT_A, non-optimistic. */
  roots?: Array<{ root: string; optimistic?: boolean } | { status: number } | undefined>;
  /** If set, root-pin /root for this source returns this (Stakely bind). */
  pinRoots?: Array<{ root: string; optimistic?: boolean } | { status: number } | undefined>;
};

function stub(cfg: StubCfg): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    urls.push(u);
    const src = BEACON_SOURCES.findIndex((b) => u.startsWith(b));
    if (src < 0) throw new Error("unexpected URL " + u);
    if (isStateRootUrl(u)) {
      const sid = stateIdOf(u);
      const pin = sid && sid.startsWith("0x") ? cfg.pinRoots?.[src] : undefined;
      const row = pin ?? cfg.roots?.[src];
      if (row && "status" in row && row.status !== 200) {
        return { ok: false, status: row.status, headers: new Headers(), text: async () => "" } as unknown as Response;
      }
      const root = row && "root" in row ? row.root : TEST_ROOT_A;
      const optimistic = row && "root" in row ? Boolean(row.optimistic) : false;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => rootBody(root, optimistic),
      } as unknown as Response;
    }
    const leg = cfg.legs?.[src];
    if (leg === undefined) throw new Error("stub: source " + src + " down");
    if (leg instanceof Error) throw leg;
    return {
      ok: leg.status >= 200 && leg.status < 300,
      status: leg.status,
      headers: new Headers(),
      text: async () => leg.body ?? "",
    } as unknown as Response;
  };
  return { fetchImpl: impl as unknown as typeof fetch, urls };
}

async function expectApiError(promise: Promise<unknown>, status: number, code: string): Promise<ApiError> {
  try {
    await promise;
    throw new Error(`expected ${status} ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status).toBe(status);
    expect(e.code).toBe(code);
    return e;
  }
}

describe("A9 r2 source inventory", () => {
  it("wires four independent keyless bases, 2-of-N, blockreq last", () => {
    expect(BEACON_SOURCES).toHaveLength(4);
    expect(BEACON_SOURCE_CAPS).toHaveLength(4);
    expect(new Set(BEACON_SOURCES.map((b) => new URL(b).hostname)).size).toBe(4);
    expect(VALIDATOR_MIN_AGREEING).toBe(2);
    expect(BEACON_SOURCE_CAPS[3]?.id).toBe("blockreq");
    expect(BEACON_SOURCE_CAPS[3]?.base).toBe("https://ethereum-beacon-rpc.blockreq.com");
    expect(BEACON_SOURCE_CAPS[3]?.rootPin).toBe(false);
    expect(BEACON_SOURCE_CAPS[2]?.id).toBe("stakely");
    expect(BEACON_SOURCE_CAPS[2]?.allowOptimisticIfRootBound).toBe(true);
    expect(BEACON_SOURCE_CAPS[0]?.paced).toBe(true);
  });
});

describe("parseStateRootResponse / parseValidatorResponse root-pin option", () => {
  it("accepts a finalized non-optimistic root", () => {
    const got = parseStateRootResponse(rootBody(TEST_ROOT_A), "https://example/root");
    expect(got.root).toBe(TEST_ROOT_A);
    expect(got.executionOptimistic).toBe(false);
  });
  it("rejects a missing or unfinalized root", () => {
    expect(() => parseStateRootResponse("{}", "https://example/root")).toThrow(/execution_optimistic/);
    expect(() =>
      parseStateRootResponse(
        JSON.stringify({ data: { root: TEST_ROOT_A }, execution_optimistic: false, finalized: false }),
        "https://example/root",
      ),
    ).toThrow(/finalized/);
  });
  it("rejects optimistic unless allowOptimisticIfRootBound", () => {
    expect(() => parseValidatorResponse(OK1_OPT, "https://example/v", 1)).toThrow(/execution_optimistic is true/);
    const leg = parseValidatorResponse(OK1_OPT, "https://example/v", 1, { allowOptimisticIfRootBound: true });
    expect(leg.effectiveBalance).toBe(32_000_000_000);
    expect(leg.status).toBe("active_ongoing");
  });
});

describe("verified-result cache", () => {
  it("serves the original receipt until the finalized root advances", async () => {
    const first = stub({
      legs: [
        { status: 200, body: OK1 },
        { status: 200, body: OK1 },
        { status: 200, body: OK1 },
        { status: 200, body: OK1 },
      ],
    });
    const a = (await handleValidator({ validator_index: "1" }, { fetchImpl: first.fetchImpl })) as Record<
      string,
      unknown
    >;
    expect(a.verdict).toBe("verified");
    expect((a.receipt as Receipt).receipt_id).toBeTruthy();
    expect(verifiedCacheSizeForTests()).toBe(1);
    const validatorCalls1 = first.urls.filter((u) => u.includes("/validators/")).length;
    expect(validatorCalls1).toBeGreaterThanOrEqual(2);

    const second = stub({
      legs: [
        { status: 200, body: OK1 },
        { status: 200, body: OK1 },
        { status: 200, body: OK1 },
        { status: 200, body: OK1 },
      ],
    });
    const b = (await handleValidator({ validator_index: "1" }, { fetchImpl: second.fetchImpl })) as Record<
      string,
      unknown
    >;
    expect(b.receipt).toEqual(a.receipt);
    expect(b.effective_balance).toBe(a.effective_balance);
    expect(b.checked_at).toBe(a.checked_at);
    // Root is re-checked (or served from the short root cache); validator
    // legs must not run again on a hit.
    expect(second.urls.filter((u) => u.includes("/validators/"))).toHaveLength(0);
  });

  it("re-verifies when the finalized root advances, and does not reuse the cache across indexes", async () => {
    const first = stub({
      legs: [
        { status: 200, body: OK1 },
        { status: 200, body: OK1 },
        undefined,
        { status: 200, body: OK1 },
      ],
      roots: [{ root: TEST_ROOT_A }, { root: TEST_ROOT_A }, { root: TEST_ROOT_A }, { root: TEST_ROOT_A }],
    });
    const a = (await handleValidator({ validator_index: "1" }, { fetchImpl: first.fetchImpl })) as Record<
      string,
      unknown
    >;
    const id1 = (a.receipt as Receipt).receipt_id;

    // Same root, different index: miss, new receipt.
    const other = stub({
      legs: [
        { status: 200, body: beaconBody(2, "32000000000", "active_ongoing") },
        { status: 200, body: beaconBody(2, "32000000000", "active_ongoing") },
        undefined,
        { status: 200, body: beaconBody(2, "32000000000", "active_ongoing") },
      ],
    });
    const c = (await handleValidator({ validator_index: "2" }, { fetchImpl: other.fetchImpl })) as Record<
      string,
      unknown
    >;
    expect(c.validator_index).toBe(2);
    expect((c.receipt as Receipt).receipt_id).not.toBe(id1);
    expect(other.urls.some((u) => u.includes("/validators/2"))).toBe(true);

    // Advance the root: expire the short root cache so the new root is
    // observed, then index 1 is re-verified (new receipt, same values).
    let now = 10_000;
    const primed = stub({
      legs: [
        { status: 200, body: OK1 },
        { status: 200, body: OK1 },
        undefined,
        { status: 200, body: OK1 },
      ],
      roots: [{ root: TEST_ROOT_A }, { root: TEST_ROOT_A }, { root: TEST_ROOT_A }, { root: TEST_ROOT_A }],
    });
    resetValidatorCachesForTests(now);
    const primedRes = (await handleValidator(
      { validator_index: "1" },
      { fetchImpl: primed.fetchImpl, nowMs: () => now },
    )) as Record<string, unknown>;
    const oldId = (primedRes.receipt as Receipt).receipt_id;

    now = 10_000 + FINALIZED_ROOT_CACHE_TTL_MS + 1;
    const advanced = stub({
      legs: [
        { status: 200, body: OK1 },
        { status: 200, body: OK1 },
        undefined,
        { status: 200, body: OK1 },
      ],
      roots: [{ root: TEST_ROOT_B }, { root: TEST_ROOT_B }, { root: TEST_ROOT_B }, { root: TEST_ROOT_B }],
      pinRoots: [{ root: TEST_ROOT_B }, { root: TEST_ROOT_B }, { root: TEST_ROOT_B }, { root: TEST_ROOT_B }],
    });
    const d = (await handleValidator(
      { validator_index: "1" },
      { fetchImpl: advanced.fetchImpl, nowMs: () => now },
    )) as Record<string, unknown>;
    expect(d.effective_balance).toBe(32_000_000_000);
    expect((d.receipt as Receipt).receipt_id).not.toBe(oldId);
    expect(advanced.urls.filter((u) => u.includes("/validators/")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("ChainSafe token bucket and 429 pacing", () => {
  it("does not start ChainSafe when the bucket is empty; still requires 2 agreeing sources", async () => {
    chainsafeOn429(5_000);
    expect(chainsafeCanStart()).toBe(false);
    expect(canStartSource(BEACON_SOURCE_CAPS[0]!)).toBe(false);

    const s = stub({
      legs: [
        { status: 200, body: DISSENT }, // would dissent if started
        { status: 200, body: OK1 },
        { status: 200, body: OK1 },
        { status: 200, body: OK1 },
      ],
    });
    const res = (await handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl })) as Record<
      string,
      unknown
    >;
    expect(res.verdict).toBe("verified");
    expect(String(res.source)).not.toContain("chainsafe");
    expect(s.urls.some((u) => u.includes("chainsafe") && u.includes("/validators/"))).toBe(false);
    expect((res.receipt as Receipt).quorum_votes).toMatch(/^[2-4]\/4 sources agreed$/);
  });

  it("never serves a 1-source verified answer when ChainSafe is skipped", async () => {
    chainsafeOn429(5_000);
    const s = stub({
      legs: [
        { status: 200, body: OK1 },
        { status: 200, body: OK1 },
        undefined,
        undefined,
      ],
    });
    // Only PublicNode can answer; blockreq+Stakely down, ChainSafe skipped.
    await expectApiError(
      handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl }),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  it("takeToken empties a 1-token bucket until refill", () => {
    const now = 1_000_000;
    resetValidatorCachesForTests(now);
    expect(chainsafeTakeToken(now)).toBe(true);
    expect(chainsafeTakeToken(now)).toBe(false);
    expect(chainsafeTakeToken(now + 1_999)).toBe(false);
    expect(chainsafeTakeToken(now + 2_000)).toBe(true);
  });

  it("generic 429 cooldown also skips a non-ChainSafe host", async () => {
    noteSource429(BEACON_SOURCES[1]!, 5_000); // PublicNode
    const s = stub({
      legs: [
        { status: 200, body: OK1 },
        { status: 200, body: DISSENT },
        { status: 200, body: OK1 },
        { status: 200, body: OK1 },
      ],
    });
    const res = (await handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl })) as Record<
      string,
      unknown
    >;
    expect(res.verdict).toBe("verified");
    expect(s.urls.some((u) => u.includes("publicnode") && u.includes("/validators/"))).toBe(false);
  });
});

describe("Stakely root-pin bind", () => {
  it("accepts Stakely optimistic when states/{root}/root matches the agreed root", async () => {
    const s = stub({
      legs: [
        undefined,
        { status: 200, body: OK1 },
        { status: 200, body: OK1_OPT },
        { status: 200, body: OK1 },
      ],
      roots: [
        undefined,
        { root: TEST_ROOT_A },
        { root: TEST_ROOT_A, optimistic: true },
        { root: TEST_ROOT_A },
      ],
      pinRoots: [
        undefined,
        { root: TEST_ROOT_A },
        { root: TEST_ROOT_A, optimistic: true },
        { root: TEST_ROOT_A },
      ],
    });
    const res = (await handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl })) as Record<
      string,
      unknown
    >;
    expect(res.verdict).toBe("verified");
    expect(String(res.source)).toContain("stakely");
    expect(s.urls.some((u) => u.includes("stakely.io") && u.includes(TEST_ROOT_A) && u.includes("/validators/"))).toBe(
      true,
    );
  });

  it("rejects Stakely when the bind root does not match, even if values would agree", async () => {
    const s = stub({
      legs: [
        undefined,
        { status: 200, body: OK1 },
        { status: 200, body: OK1_OPT },
        { status: 200, body: OK1 },
      ],
      roots: [undefined, { root: TEST_ROOT_A }, { root: TEST_ROOT_A, optimistic: true }, { root: TEST_ROOT_A }],
      pinRoots: [undefined, { root: TEST_ROOT_A }, { root: TEST_ROOT_B }, { root: TEST_ROOT_A }],
    });
    const res = (await handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl })) as Record<
      string,
      unknown
    >;
    expect(res.verdict).toBe("verified");
    expect(String(res.source)).not.toContain("stakely");
    expect((res.receipt as Receipt).quorum_votes).toBe("2/4 sources agreed");
  });
});

describe("blockreq finalized-root bind and 2-of-4 conflicts", () => {
  it("does not count a blockreq validator vote whose finalized root differs", async () => {
    const s = stub({
      legs: [
        undefined,
        { status: 200, body: OK1 },
        { status: 200, body: OK1 },
        { status: 200, body: DISSENT },
      ],
      roots: [undefined, { root: TEST_ROOT_A }, { root: TEST_ROOT_A }, { root: TEST_ROOT_B }],
    });
    // Root conflict across sources fails closed (different finalized roots).
    await expectApiError(
      handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl }),
      502,
      "QUORUM_CONFLICT",
    );
  });

  it("any value dissent among four sources is still 502", async () => {
    const s = stub({
      legs: [
        { status: 200, body: OK1 },
        { status: 200, body: OK1 },
        { status: 200, body: OK1 },
        { status: 200, body: DISSENT },
      ],
    });
    await expectApiError(
      handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl }),
      502,
      "QUORUM_CONFLICT",
    );
  });

  it("first agreeing pair of 4 is verified when the others are down", async () => {
    const s = stub({
      legs: [undefined, { status: 200, body: OK1 }, undefined, { status: 200, body: OK1 }],
    });
    const res = (await handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl })) as Record<
      string,
      unknown
    >;
    expect(res.verdict).toBe("verified");
    expect(String(res.source)).toContain("publicnode");
    expect(String(res.source)).toContain("blockreq");
    expect((res.receipt as Receipt).quorum_votes).toBe("2/4 sources agreed");
  });
});
