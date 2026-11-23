// Independently authored tests for the epoch balance-delta performance
// section on /v1/validator. No evaluator examples, live sources, or
// network requests are used: every beacon call is stubbed.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";

const SCRATCH_PARENT = resolve(process.cwd(), "..", "tmp");
mkdirSync(SCRATCH_PARENT, { recursive: true });
const SCRATCH_DIR = mkdtempSync(join(SCRATCH_PARENT, "validator-perf-test-"));
process.env.SQLITE_PATH = join(SCRATCH_DIR, "verireceipt.sqlite");

afterAll(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

import {
  BEACON_SOURCES,
  handleValidator as handleValidatorImpl,
  resetValidatorCachesForTests,
} from "../src/handlers/validator";
import { countReceipts } from "./helpers/storeView";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";

const TEST_FINALIZED_ROOT = "0x" + "cd".repeat(32);
const INDEX = "1";
const SLOT_NEW = 100032; // divisible by 32: an epoch boundary slot
const SLOT_OLD = SLOT_NEW - 32;
const BALANCE_OLD = "32088062388";
const BALANCE_NEW = "32088070549";
const EXPECTED_APR = ((8161n * 82125n * 10000n) / 32088070549n).toString();

beforeEach(() => resetValidatorCachesForTests());
afterEach(() => resetValidatorCachesForTests());

function handleValidator(
  ...args: Parameters<typeof handleValidatorImpl>
): ReturnType<typeof handleValidatorImpl> {
  resetValidatorCachesForTests();
  return handleValidatorImpl(...args);
}

function validatorBody(): string {
  return JSON.stringify({
    data: {
      index: INDEX,
      balance: "32088070549",
      status: "active_ongoing",
      validator: {
        pubkey: "0x" + "ab".repeat(48),
        withdrawal_credentials: "0x02" + "00".repeat(31),
        effective_balance: "32000000000",
        slashed: false,
        activation_eligibility_epoch: "0",
        activation_epoch: "0",
        exit_epoch: "18446744073709551615",
        withdrawable_epoch: "18446744073709551615",
      },
    },
    execution_optimistic: false,
    finalized: true,
  });
}

function balancesBody(balance: string): string {
  return JSON.stringify({
    execution_optimistic: false,
    finalized: true,
    data: [{ index: INDEX, balance }],
  });
}

interface PerfOpts {
  /** Per source index: balance returned for the OLD slot (undefined = down). */
  oldBalances: (string | undefined)[];
  newBalance?: string;
  headersDown?: boolean;
}

function makeStubFetch(opts: PerfOpts): typeof fetch {
  const impl = async (url: string | URL | Request): Promise<Response> => {
    const urlStr = String(url);
    const idx = BEACON_SOURCES.findIndex((base) => urlStr.startsWith(base));
    if (idx < 0) throw new Error("stub fetch got unexpected URL: " + urlStr);
    const jsonRes = (body: string): Response =>
      ({
        ok: true,
        status: 200,
        text: async () => body,
        json: async () => JSON.parse(body),
      }) as unknown as Response;

    if (/\/eth\/v1\/beacon\/headers\/finalized/.test(urlStr)) {
      if (opts.headersDown || idx > 1) throw new Error("headers down");
      return jsonRes(
        JSON.stringify({
          execution_optimistic: false,
          finalized: true,
          data: { root: TEST_FINALIZED_ROOT, header: { message: { slot: String(SLOT_NEW) } } },
        }),
      );
    }
    if (/\/eth\/v1\/beacon\/states\/[^/]+\/root\/?$/.test(urlStr)) {
      return jsonRes(
        JSON.stringify({
          data: { root: TEST_FINALIZED_ROOT },
          execution_optimistic: false,
          finalized: true,
        }),
      );
    }
    if (/\/validator_balances/.test(urlStr)) {
      if (idx > 1) throw new Error("balances down");
      const isOld = urlStr.includes(`/states/${SLOT_OLD}/`);
      const bal = isOld ? opts.oldBalances[idx] : (opts.newBalance ?? BALANCE_NEW);
      if (bal === undefined) throw new Error("balances down");
      return jsonRes(balancesBody(bal));
    }
    if (/\/eth\/v1\/beacon\/states\/[^/]+\/validators\//.test(urlStr)) {
      // Only the first two sources carry staged validator legs.
      if (idx > 1) throw new Error("validator leg down");
      return jsonRes(validatorBody());
    }
    throw new Error("stub fetch got unexpected URL: " + urlStr);
  };
  return impl as typeof fetch;
}

describe("handleValidator epoch balance-delta performance section", () => {
  it("adds the delta fields, sentence and a second stored receipt when two sources agree", async () => {
    const result = await handleValidator(
      { validator_index: INDEX },
      { fetchImpl: makeStubFetch({ oldBalances: [BALANCE_OLD, BALANCE_OLD] }) },
    );
    expect(result.verdict).toBe("verified");
    const perf = result.recent_epoch_balance_delta as Record<string, unknown>;
    expect(perf).toMatchObject({
      from_slot: String(SLOT_OLD),
      to_slot: String(SLOT_NEW),
      balance_from_gwei: BALANCE_OLD,
      balance_to_gwei: BALANCE_NEW,
      net_change_gwei: "8161",
    });
    expect(perf.annualized_rate_estimate_pct).toBe(
      (Number(EXPECTED_APR) / 100).toFixed(2),
    );
    expect(String(perf.basis)).toContain("one epoch");
    expect(String(result.answer)).toContain("gained 8161 gwei");
    expect(String(result.answer)).toContain("attestation rewards");
    const perfReceipt = result.performance_receipt as { receipt_id: string; raw_response_sha256: string };
    expect(perfReceipt.receipt_id).toMatch(/^rcpt_/);
    // The stored evidence re-hashes to the receipt digest.
    const evidence = await getReceiptEvidence(perfReceipt.receipt_id);
    expect(evidence.found).toBe(true);
    expect(sha256Hex(evidence.evidence!)).toBe(perfReceipt.raw_response_sha256);
    expect(JSON.parse(evidence.evidence!.toString("utf8"))).toEqual(JSON.parse(balancesBody(BALANCE_OLD)));
    // Fresh scratch DB per run: the balance receipt plus the performance receipt.
    expect(await countReceipts()).toBe(2);
  });

  it("omits the section (verified answer intact) when sources disagree on a slot sample", async () => {
    const result = await handleValidator(
      { validator_index: INDEX },
      { fetchImpl: makeStubFetch({ oldBalances: [BALANCE_OLD, "32088062000"] }) },
    );
    expect(result.verdict).toBe("verified");
    expect(result.effective_balance).toBe(32000000000);
    expect(result).not.toHaveProperty("recent_epoch_balance_delta");
    expect(result).not.toHaveProperty("performance_receipt");
    expect(String(result.answer)).not.toContain("one epoch apart");
  });

  it("omits the section when the finalized-header read fails", async () => {
    const result = await handleValidator(
      { validator_index: INDEX },
      { fetchImpl: makeStubFetch({ oldBalances: [BALANCE_OLD, BALANCE_OLD], headersDown: true }) },
    );
    expect(result.verdict).toBe("verified");
    expect(result).not.toHaveProperty("recent_epoch_balance_delta");
  });
});
