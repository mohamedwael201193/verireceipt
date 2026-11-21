// A9 r3: honest finalized-root labelling, no last-known-root fallback,
// bounded LRU verified cache, after-budget replies documented as uncounted.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";

const SCRATCH_PARENT = resolve(process.cwd(), "..", "tmp");
mkdirSync(SCRATCH_PARENT, { recursive: true });
const SCRATCH_DIR = mkdtempSync(join(SCRATCH_PARENT, "validator-r3-test-"));
process.env.SQLITE_PATH = join(SCRATCH_DIR, "verireceipt.sqlite");

afterAll(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

import { ApiError } from "../src/core/errors";
import type { Receipt } from "../src/core/receipt";
import {
  BEACON_SOURCES,
  FINALIZED_ROOT_CACHE_TTL_MS,
  VERIFIED_CACHE_MAX_ENTRIES,
  handleValidator,
  rememberVerifiedForTests,
  resetValidatorCachesForTests,
  touchVerifiedForTests,
  verifiedCacheHasForTests,
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
      validator: { effective_balance: effectiveBalance, slashed: false },
    },
    execution_optimistic: optimistic,
    finalized: true,
  });
}

const OK1 = beaconBody(1, "32000000000", "active_ongoing");
const OK1_NEW = beaconBody(1, "31000000000", "active_ongoing");

type StubCfg = {
  legs?: Array<{ status: number; body?: string } | Error | undefined>;
  roots?: Array<{ root: string; optimistic?: boolean } | { status: number } | undefined>;
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

const AGREEING_LEGS = [
  { status: 200, body: OK1 },
  { status: 200, body: OK1 },
  { status: 200, body: OK1 },
  { status: 200, body: OK1 },
];

describe("A9 r3 honest finalized-root labelling", () => {
  it("every verified envelope names the finalized root it is bound to", async () => {
    const s = stub({ legs: AGREEING_LEGS });
    const res = (await handleValidator({ validator_index: "1" }, { fetchImpl: s.fetchImpl })) as Record<
      string,
      unknown
    >;
    expect(res.verdict).toBe("verified");
    expect(res.finalized_state_root).toBe(TEST_ROOT_A);
    expect(String(res.answer)).toContain(`at finalized state root ${TEST_ROOT_A}`);
    expect((res.receipt as Receipt).receipt_id).toBeTruthy();
  });

  it("a 12 s root-cache hit still reports the bound root, never a newer one", async () => {
    const first = stub({ legs: AGREEING_LEGS });
    let now = 50_000;
    const a = (await handleValidator(
      { validator_index: "1" },
      { fetchImpl: first.fetchImpl, nowMs: () => now },
    )) as Record<string, unknown>;
    expect(a.finalized_state_root).toBe(TEST_ROOT_A);
    const id = (a.receipt as Receipt).receipt_id;

    // Inside the 12 s TTL every source has advanced to root B with a
    // different effective balance. The handler must not present B (or
    // an unlabelled "current" answer); it may serve the original
    // envelope, which still names root A.
    now = 50_000 + FINALIZED_ROOT_CACHE_TTL_MS - 1;
    const advanced = stub({
      legs: [
        { status: 200, body: OK1_NEW },
        { status: 200, body: OK1_NEW },
        { status: 200, body: OK1_NEW },
        { status: 200, body: OK1_NEW },
      ],
      roots: [{ root: TEST_ROOT_B }, { root: TEST_ROOT_B }, { root: TEST_ROOT_B }, { root: TEST_ROOT_B }],
    });
    const b = (await handleValidator(
      { validator_index: "1" },
      { fetchImpl: advanced.fetchImpl, nowMs: () => now },
    )) as Record<string, unknown>;
    expect(b.finalized_state_root).toBe(TEST_ROOT_A);
    expect(b.effective_balance).toBe(32_000_000_000);
    expect((b.receipt as Receipt).receipt_id).toBe(id);
    expect(b.checked_at).toBe(a.checked_at);
    expect(String(b.answer)).toContain(TEST_ROOT_A);
    expect(String(b.answer)).not.toContain(TEST_ROOT_B);
    expect(advanced.urls.filter((u) => u.includes("/validators/"))).toHaveLength(0);
  });

  it("after the 12 s TTL, a failed fresh root quorum fails closed (no last-known fallback)", async () => {
    let now = 50_000;
    const first = stub({ legs: AGREEING_LEGS });
    const a = (await handleValidator(
      { validator_index: "1" },
      { fetchImpl: first.fetchImpl, nowMs: () => now },
    )) as Record<string, unknown>;
    expect(a.finalized_state_root).toBe(TEST_ROOT_A);
    expect(verifiedCacheHasForTests(1, TEST_ROOT_A)).toBe(true);

    now = 50_000 + FINALIZED_ROOT_CACHE_TTL_MS + 1;
    const down = stub({
      legs: AGREEING_LEGS,
      roots: [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }],
    });
    const err = await expectApiError(
      handleValidator({ validator_index: "1" }, { fetchImpl: down.fetchImpl, nowMs: () => now }),
      502,
      "QUORUM_UNREACHABLE",
    );
    expect(err.message).toMatch(/finalized state root/);
    // The previous envelope is still in the Map, but it was not served:
    // no validator legs ran and the call failed closed.
    expect(verifiedCacheHasForTests(1, TEST_ROOT_A)).toBe(true);
    expect(down.urls.filter((u) => u.includes("/validators/"))).toHaveLength(0);
  });
});

describe("A9 r3 verified-cache LRU cap", () => {
  it(`caps the verified Map at ${10000} and evicts the least-recently used entry`, () => {
    expect(VERIFIED_CACHE_MAX_ENTRIES).toBe(10_000);
    for (let i = 0; i < VERIFIED_CACHE_MAX_ENTRIES; i++) {
      rememberVerifiedForTests(i, TEST_ROOT_A);
    }
    expect(verifiedCacheSizeForTests()).toBe(VERIFIED_CACHE_MAX_ENTRIES);
    expect(verifiedCacheHasForTests(0, TEST_ROOT_A)).toBe(true);
    expect(verifiedCacheHasForTests(VERIFIED_CACHE_MAX_ENTRIES - 1, TEST_ROOT_A)).toBe(true);

    rememberVerifiedForTests(VERIFIED_CACHE_MAX_ENTRIES, TEST_ROOT_A);
    expect(verifiedCacheSizeForTests()).toBe(VERIFIED_CACHE_MAX_ENTRIES);
    expect(verifiedCacheHasForTests(0, TEST_ROOT_A)).toBe(false);
    expect(verifiedCacheHasForTests(1, TEST_ROOT_A)).toBe(true);
    expect(verifiedCacheHasForTests(VERIFIED_CACHE_MAX_ENTRIES, TEST_ROOT_A)).toBe(true);
  });

  it("a cache hit refreshes LRU order so a hot entry is not evicted first", () => {
    for (let i = 0; i < VERIFIED_CACHE_MAX_ENTRIES; i++) {
      rememberVerifiedForTests(i, TEST_ROOT_A);
    }
    expect(touchVerifiedForTests(0, TEST_ROOT_A)).toBe(true);
    rememberVerifiedForTests(VERIFIED_CACHE_MAX_ENTRIES, TEST_ROOT_A);
    expect(verifiedCacheSizeForTests()).toBe(VERIFIED_CACHE_MAX_ENTRIES);
    expect(verifiedCacheHasForTests(0, TEST_ROOT_A)).toBe(true);
    expect(verifiedCacheHasForTests(1, TEST_ROOT_A)).toBe(false);
    expect(verifiedCacheHasForTests(VERIFIED_CACHE_MAX_ENTRIES, TEST_ROOT_A)).toBe(true);
  });
});
