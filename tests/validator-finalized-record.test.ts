import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { BEACON_SOURCES, handleValidator, parseValidatorResponse, resetValidatorCachesForTests } from "../src/handlers/validator";

const scratchParent = resolve(process.cwd(), "..", "tmp");
mkdirSync(scratchParent, { recursive: true });
const scratch = mkdtempSync(join(scratchParent, "validator-record-"));
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => resetValidatorCachesForTests());

// Frozen public beacon API record for transport tests. This fixture is not
// the retained native-acceptance receipt or proof of a production request.
const fixture = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/validator-finalized-record.json"), "utf8"));
const root = "0x" + "ac".repeat(32);
const pubkey: string = fixture.data.validator.pubkey;
const farFuture = "18446744073709551615";
const body = (): typeof fixture => structuredClone(fixture);
function transport(change?: (record: typeof fixture, source: number) => void): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith("/root")) return new Response(JSON.stringify({ data: { root }, finalized: true, execution_optimistic: false }));
    const record = body();
    const source = BEACON_SOURCES.findIndex((base) => url.startsWith(base + "/"));
    if (source < 0) throw new Error("Unexpected test URL");
    change?.(record, source);
    return new Response(JSON.stringify(record));
  }) as unknown as typeof fetch;
}

describe("complete finalized validator record", () => {
  it("keeps uint64 balances and far-future epochs exact", () => {
    const b = body(); b.data.balance = farFuture;
    const parsed = parseValidatorResponse(JSON.stringify(b), "public fixture", 0);
    expect(parsed.balance).toBe(farFuture);
    expect(parsed.exitEpoch).toBe(farFuture);
    expect(parsed.withdrawableEpoch).toBe(farFuture);
    expect(parsed.effectiveBalance).toBe(34000000000);
    expect(parsed.slashed).toBe(false);
  });

  it("accepts a bytes48 public-key identity and checks its returned index", () => {
    const parsed = parseValidatorResponse(JSON.stringify(body()), "public fixture", pubkey.toUpperCase());
    expect(parsed.index).toBe(0);
    expect(parsed.pubkey).toBe(pubkey);
  });

  it("rejects a different returned public key", () => {
    expect(() => parseValidatorResponse(JSON.stringify(body()), "public fixture", "0x" + "11".repeat(48))).toThrow(/pubkey.*match/);
  });

  for (const field of ["balance", "activation_eligibility_epoch", "activation_epoch", "exit_epoch", "withdrawable_epoch"]) {
    for (const bad of ["-1", "1.2", "18446744073709551616", 1, null]) {
      it(`rejects invalid uint64 ${field}: ${String(bad)}`, () => {
        const b = body();
        if (field === "balance") b.data.balance = bad;
        else b.data.validator[field] = bad;
        expect(() => parseValidatorResponse(JSON.stringify(b), "public fixture", 0)).toThrow(/uint64/);
      });
    }
  }

  for (const bad of ["false", 0, null]) {
    it(`rejects non-boolean slashed: ${String(bad)}`, () => {
      const b = body(); b.data.validator.slashed = bad;
      expect(() => parseValidatorResponse(JSON.stringify(b), "public fixture", 0)).toThrow(/slashed/);
    });
  }

  it("returns every enriched field only after full-record quorum", async () => {
    const result = await handleValidator({ validator_index: "0" }, { fetchImpl: transport() });
    expect(result).toMatchObject({ validator_index: 0, validator_pubkey: pubkey,
      balance: "34302537532", balance_unit: "gwei", effective_balance: 34000000000,
      slashed: false, activation_eligibility_epoch: "0", activation_epoch: "0",
      exit_epoch: farFuture, withdrawable_epoch: farFuture, finalized_state_root: root });
    // V1 framing: status and slashed first, ETH balances (effective in
    // both ETH and gwei), then activation and exit, pubkey last and
    // shortened. Fields stay in gwei.
    expect(String(result.answer)).toContain("Validator 0 is active_ongoing and has not been slashed");
    expect(String(result.answer)).toContain("balance 34.302537532 ETH (effective 34 ETH = 34000000000 gwei)");
    expect(String(result.answer)).toContain("active since epoch 0");
    expect(String(result.answer)).toContain("no exit scheduled");
    expect(String(result.answer)).toContain("far-future sentinel");
    expect(String(result.answer)).toMatch(/pubkey 0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}\./);
  });

  it("omits the far-future explanation when no returned epoch is the sentinel", async () => {
    const fetchImpl = transport((b) => {
      for (const field of ["activation_eligibility_epoch", "activation_epoch", "exit_epoch", "withdrawable_epoch"]) {
        b.data.validator[field] = "0";
      }
    });
    const result = await handleValidator({ validator_index: "0" }, { fetchImpl });
    expect(String(result.answer)).not.toContain("far-future sentinel");
    expect(String(result.answer)).toContain("exit scheduled at epoch 0, withdrawable epoch 0.");
    expect(result.balance).toBe(fixture.data.balance);
  });

  it("renders a dust balance exactly (1 gwei = 0.000000001 ETH)", async () => {
    const fetchImpl = transport((b) => { b.data.balance = "1"; });
    const result = await handleValidator({ validator_index: "0" }, { fetchImpl });
    expect(String(result.answer)).toContain("balance 0.000000001 ETH");
    expect(result.balance).toBe("1");
  });

  for (const sentinelField of ["activation_eligibility_epoch", "activation_epoch", "exit_epoch", "withdrawable_epoch"] as const) {
    it(`explains a sentinel returned in ${sentinelField}`, async () => {
      const fetchImpl = transport((b) => {
        for (const field of ["activation_eligibility_epoch", "activation_epoch", "exit_epoch", "withdrawable_epoch"]) {
          b.data.validator[field] = field === sentinelField ? farFuture : "0";
        }
      });
      const result = await handleValidator({ validator_index: "0" }, { fetchImpl });
      expect(String(result.answer)).toContain("far-future sentinel, not a scheduled date");
      expect(result[sentinelField]).toBe(farFuture);
    });
  }

  for (const query of [{ validator_pubkey: pubkey }, { validator_index: pubkey }]) {
    it(`resolves native BLS lookup through ${Object.keys(query)[0]}`, async () => {
      const fetchImpl = transport();
      const result = await handleValidator(query, { fetchImpl });
      expect(result.validator_index).toBe(0);
      expect(result.validator_pubkey).toBe(pubkey);
      expect(vi.mocked(fetchImpl).mock.calls.some(([url]) => String(url).endsWith("/validators/" + pubkey))).toBe(true);
    });
  }

  it("refuses ambiguous identifiers before network access", async () => {
    const fetchImpl = transport();
    await expect(handleValidator({ validator_index: "0", validator_pubkey: pubkey }, { fetchImpl })).rejects.toMatchObject({ status: 400, code: "AMBIGUOUS_VALIDATOR_ID" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses malformed public keys before network access", async () => {
    const fetchImpl = transport();
    await expect(handleValidator({ validator_pubkey: "0x1234" }, { fetchImpl })).rejects.toMatchObject({ status: 400, code: "INVALID_VALIDATOR_PUBKEY" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  for (const field of ["balance", "slashed", "activation_eligibility_epoch", "activation_epoch", "exit_epoch", "withdrawable_epoch", "pubkey"]) {
    it(`refuses a dissenting ${field} at the same finalized root`, async () => {
      const fetchImpl = transport((b, source) => {
        if (source !== 1) return;
        if (field === "balance") b.data.balance = "34302537533";
        else if (field === "slashed") b.data.validator.slashed = true;
        else if (field === "pubkey") b.data.validator.pubkey = "0x" + "11".repeat(48);
        else b.data.validator[field] = "1";
      });
      await expect(handleValidator({ validator_index: "0" }, { fetchImpl })).rejects.toMatchObject({ status: 502, code: "QUORUM_CONFLICT" });
    });
  }

  it("binds a public-key request rather than trusting its returned numeric index", async () => {
    const fetchImpl = transport((b) => { b.data.validator.pubkey = "0x" + "11".repeat(48); });
    await expect(handleValidator({ validator_pubkey: pubkey }, { fetchImpl })).rejects.toMatchObject({ status: 502, code: "QUORUM_UNREACHABLE" });
  });
});
