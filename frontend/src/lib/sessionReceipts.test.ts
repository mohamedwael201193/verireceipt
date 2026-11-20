import { beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_RECEIPTS_CAP,
  SESSION_RECEIPTS_CORRUPT_BACKUP_KEY,
  SESSION_RECEIPTS_GEN_KEY,
  SESSION_RECEIPTS_KEY,
  appendSessionReceipt,
  backupCorruptSessionReceipts,
  bumpLedgerGeneration,
  clearSessionReceipts,
  readLedgerGeneration,
  readSessionReceipts,
  uniqueSessionReceiptKey,
  type SessionReceipt,
} from "./sessionReceipts";

function entry(overrides: Partial<SessionReceipt> = {}): SessionReceipt {
  return {
    key: "tvl-rcpt_test1",
    endpoint: "tvl",
    label: "tvl protocol=aave-v3",
    params: "protocol=aave-v3",
    fetchedAt: "2026-11-20T10:00:00Z",
    receipt: {
      receipt_id: "rcpt_test1",
      upstream_url: "https://api.llama.fi/protocol/aave-v3",
      raw_response_sha256: `0x${"a".repeat(64)}`,
      fetched_at: "2026-11-20T10:00:00Z",
    },
    summary: "Aave V3 has a total value locked of $1",
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("sessionReceipts (shared ledger, 2026-11-20 click-test fix)", () => {
  it("appends and reads back a valid entry", () => {
    expect(appendSessionReceipt(entry())).toBe(true);
    const { entries, corrupt } = readSessionReceipts();
    expect(corrupt).toBe(false);
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe("tvl protocol=aave-v3");
  });

  it("is newest-first and dedupes by the per-call key, NOT by receipt_id (J2 R2 B1)", () => {
    appendSessionReceipt(entry());
    appendSessionReceipt(entry({ key: "tvl-rcpt_test2", label: "second", receipt: {
      receipt_id: "rcpt_test2",
      upstream_url: "https://example.com",
      raw_response_sha256: `0x${"b".repeat(64)}`,
      fetched_at: "2026-11-20T10:01:00Z",
    } }));
    // Same key again: replaces, does not duplicate.
    appendSessionReceipt(entry({ label: "tvl again" }));
    const { entries } = readSessionReceipts();
    expect(entries).toHaveLength(2);
    expect(entries[0].receipt.receipt_id).toBe("rcpt_test1");
    expect(entries[0].label).toBe("tvl again");
  });

  it("keeps two legitimate calls that share one receipt_id (J2 R2 B1)", () => {
    // The same not_found answer (or a burst) legitimately shares one
    // receipt_id: the old receipt_id dedupe collapsed 25 dashboard rows
    // to 1 on /receipts. Distinct per-call keys must both survive.
    const burst = Array.from({ length: 25 }, (_, i) => entry({ key: `tx-burst-${i}` }));
    for (const e of burst) expect(appendSessionReceipt(e)).toBe(true);
    const { entries } = readSessionReceipts();
    expect(entries).toHaveLength(25);
    expect(new Set(entries.map((e) => e.key)).size).toBe(25);
  });

  it("uniqueSessionReceiptKey never repeats within a session", () => {
    const keys = new Set(
      Array.from({ length: 100 }, () => uniqueSessionReceiptKey("tx", "rcpt_same")),
    );
    expect(keys.size).toBe(100);
  });

  it("uniqueSessionReceiptKey carries a stable per-tab segment (cross-tab uniqueness)", () => {
    // Two tabs mint keys from the same counter, so the counter alone is
    // not enough: the key must also carry a per-tab random segment, so
    // the same receipt_id appended as call N in two tabs never collides.
    const a = uniqueSessionReceiptKey("tx", "rcpt_same");
    const b = uniqueSessionReceiptKey("tx", "rcpt_same");
    const tabA = a.split("-")[2];
    expect(tabA.length).toBeGreaterThanOrEqual(1);
    expect(b.split("-")[2]).toBe(tabA); // same tab, same segment
    expect(a).not.toBe(b); // the counter still separates calls
  });

  it("append refuses an invalid entry and writes nothing (J2 R2 B2)", () => {
    const bad = entry({ label: "" });
    expect(appendSessionReceipt(bad)).toBe(false);
    expect(window.localStorage.getItem(SESSION_RECEIPTS_KEY)).toBeNull();
    const badVerify = entry({ verifyData: { tx_hash: 42 as unknown as string } });
    expect(appendSessionReceipt(badVerify)).toBe(false);
    expect(window.localStorage.getItem(SESSION_RECEIPTS_KEY)).toBeNull();
  });

  it("append refuses over-long ledger text fields (J2 R2 M4)", () => {
    expect(appendSessionReceipt(entry({ label: "x".repeat(1201) }))).toBe(false);
    expect(appendSessionReceipt(entry({ params: "x".repeat(2001) }))).toBe(false);
    expect(appendSessionReceipt(entry({ summary: "x".repeat(2001) }))).toBe(false);
    expect(window.localStorage.getItem(SESSION_RECEIPTS_KEY)).toBeNull();
  });

  it("accepts the longest label the app builds from API-accepted params (J2 R3 M4)", () => {
    // entity and period are each accepted up to 512 chars (lib/api.ts
    // MAX_PARAM_LENGTH): "filings " + 512 + " · " + 512 ≈ 1035 chars.
    // The old 500 cap refused such receipts while the API accepted them.
    const label = `filings ${"e".repeat(512)} · ${"p".repeat(512)}`;
    expect(label.length).toBeGreaterThan(1000);
    expect(appendSessionReceipt(entry({ label }))).toBe(true);
    expect(readSessionReceipts().entries).toHaveLength(1);
  });

  it("a partially-poisoned stored array is backed up before the filtering rewrite (J2 R2 B3)", () => {
    const raw = JSON.stringify([entry(), { nope: true }, "junk"]);
    window.localStorage.setItem(SESSION_RECEIPTS_KEY, raw);
    expect(readSessionReceipts().dropped).toBe(2);
    expect(appendSessionReceipt(entry({ key: "tvl-rcpt_new" }))).toBe(true);
    // The raw pre-rewrite value is preserved under the backup key…
    expect(window.localStorage.getItem(SESSION_RECEIPTS_CORRUPT_BACKUP_KEY)).toBe(raw);
    // …and the live ledger now holds only the two valid entries.
    const { entries, corrupt } = readSessionReceipts();
    expect(corrupt).toBe(false);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.key)).toEqual(["tvl-rcpt_new", "tvl-rcpt_test1"]);
  });

  it("storage throwing on read is unavailable, not corrupt (J2 R2 M1)", () => {
    // vi.spyOn(window.localStorage, "getItem") does NOT intercept in this
    // jsdom setup, so the global is replaced with a throwing fake instead
    // (verified by probe 2026-11-20) and restored afterwards.
    const real = globalThis.localStorage;
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    };
    Object.defineProperty(globalThis, "localStorage", {
      value: throwing,
      configurable: true,
      writable: true,
    });
    try {
      expect(readSessionReceipts()).toEqual({
        entries: [],
        corrupt: false,
        unavailable: true,
        dropped: 0,
      });
      expect(appendSessionReceipt(entry())).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        value: real,
        configurable: true,
        writable: true,
      });
    }
  });

  it("caps the ledger at SESSION_RECEIPTS_CAP", () => {
    for (let i = 0; i < SESSION_RECEIPTS_CAP + 5; i++) {
      appendSessionReceipt(
        entry({
          key: `tvl-rcpt_${i}`,
          receipt: {
            receipt_id: `rcpt_${i}`,
            upstream_url: "https://example.com",
            raw_response_sha256: `0x${"c".repeat(64)}`,
            fetched_at: "2026-11-20T10:00:00Z",
          },
        }),
      );
    }
    expect(readSessionReceipts().entries).toHaveLength(SESSION_RECEIPTS_CAP);
  });

  it("drops invalid entries on read", () => {
    window.localStorage.setItem(
      SESSION_RECEIPTS_KEY,
      JSON.stringify([entry(), { nope: true }, "junk", 42]),
    );
    const { entries, corrupt, dropped } = readSessionReceipts();
    expect(corrupt).toBe(false);
    expect(entries).toHaveLength(1);
    expect(dropped).toBe(3);
  });

  it("a stored empty array is a legitimate empty ledger, not corrupt", () => {
    window.localStorage.setItem(SESSION_RECEIPTS_KEY, "[]");
    expect(readSessionReceipts()).toEqual({
      entries: [],
      corrupt: false,
      unavailable: false,
      dropped: 0,
    });
  });

  it("unparseable stored data is corrupt and append refuses to overwrite it (M6)", () => {
    window.localStorage.setItem(SESSION_RECEIPTS_KEY, "{not json");
    expect(readSessionReceipts().corrupt).toBe(true);
    expect(appendSessionReceipt(entry())).toBe(false);
    expect(window.localStorage.getItem(SESSION_RECEIPTS_KEY)).toBe("{not json");
  });

  it("a non-empty array of only invalid entries is corrupt, not empty", () => {
    window.localStorage.setItem(SESSION_RECEIPTS_KEY, JSON.stringify([1, 2, 3]));
    const { entries, corrupt } = readSessionReceipts();
    expect(entries).toHaveLength(0);
    expect(corrupt).toBe(true);
  });

  it("backupCorruptSessionReceipts preserves the corrupt value under the backup key", () => {
    window.localStorage.setItem(SESSION_RECEIPTS_KEY, "{not json");
    backupCorruptSessionReceipts();
    expect(window.localStorage.getItem(SESSION_RECEIPTS_CORRUPT_BACKUP_KEY)).toBe("{not json");
    // The corrupt value itself is untouched.
    expect(window.localStorage.getItem(SESSION_RECEIPTS_KEY)).toBe("{not json");
  });

  it("clearSessionReceipts removes the ledger and its corrupt-data backup (J2 R2 M5)", () => {
    appendSessionReceipt(entry());
    window.localStorage.setItem(SESSION_RECEIPTS_CORRUPT_BACKUP_KEY, "{not json");
    clearSessionReceipts();
    expect(window.localStorage.getItem(SESSION_RECEIPTS_KEY)).toBeNull();
    expect(window.localStorage.getItem(SESSION_RECEIPTS_CORRUPT_BACKUP_KEY)).toBeNull();
    expect(readSessionReceipts().entries).toHaveLength(0);
  });

  it("clearSessionReceipts does NOT bump the ledger generation (J2 R6 — Discard calls it)", () => {
    // Discard calls clearSessionReceipts; if that bumped the
    // generation, an in-flight receipt across Discard would be dropped
    // — the opposite of the Discard promise (J2 R4 B1). Only the Clear
    // action bumps, via bumpLedgerGeneration().
    expect(readLedgerGeneration()).toBe(0);
    clearSessionReceipts();
    expect(readLedgerGeneration()).toBe(0);
    expect(window.localStorage.getItem(SESSION_RECEIPTS_GEN_KEY)).toBeNull();
  });
});

describe("ledger generation (J2 R6 cross-tab Clear gate)", () => {
  it("reads 0 when no generation is stored", () => {
    expect(readLedgerGeneration()).toBe(0);
  });

  it("bumps monotonically and survives re-reads", () => {
    bumpLedgerGeneration();
    expect(readLedgerGeneration()).toBe(1);
    bumpLedgerGeneration();
    expect(readLedgerGeneration()).toBe(2);
    expect(window.localStorage.getItem(SESSION_RECEIPTS_GEN_KEY)).toBe("2");
  });

  it("reads 0 for a corrupt or negative stored value (fail closed, never NaN)", () => {
    window.localStorage.setItem(SESSION_RECEIPTS_GEN_KEY, "not-a-number");
    expect(readLedgerGeneration()).toBe(0);
    window.localStorage.setItem(SESSION_RECEIPTS_GEN_KEY, "-5");
    expect(readLedgerGeneration()).toBe(0);
    bumpLedgerGeneration();
    expect(readLedgerGeneration()).toBe(1);
  });

});
