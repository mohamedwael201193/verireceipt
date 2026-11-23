import { getReceiptEvidence } from "../src/core/storage";
// Tests for src/handlers/txLookup.ts (ONCHAIN_TX_LOOKUP_GENERAL).
//
// Unit tests use local fixtures only. Live tests hit the REAL public archive
// RPCs from src/config/chains.ts — no mocks anywhere in handler code.
// Live hashes below were verified against the RPCs before being written here.
import { createHash, randomBytes } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/core/errors";
import { envelope, makeReceipt, sha256Hex, stableStringify } from "../src/core/receipt";
import { CHAIN_RPCS } from "../src/config/chains";
import { handleTx, normalizeChain, receiptStatusNumber, weiToEth } from "../src/handlers/txLookup";

// Verified live 2026-11-20 on eth-mainnet.public.blastapi.io, eth.drpc.org
// and rpc.mevblocker.io (A2: ethereum-rpc.publicnode.com is PRUNED — it
// returns null/null for pre-15.5M-block txs and is no longer a leg):
//   status 0x1, block 0x193a989 (26454409), value 0x0,
//   from 0x5875db54cd9ae2b2a875e09bb731772297ae9d92,
//   to   0x0000000aa232009084bd71a5797d089aa4edfad4
const CONFIRMED_TX = "0x1b9e2b48eb3510ee1a8aae2fc402139784f32d43b76d5853387cacb484a9a9d3";

// Verified live 2026-11-20 (publicnode + drpc): status 0x0,
// block 0x193a98b (26454411),
// from 0x60a518fbbc32d1bedcc02c7d6c7dff5f477e1aec,
// to   0x7156b23feaf295e109d69148665bff737809cea4
const REVERTED_TX = "0x1a1467893eaed124a13164b589f1ed7a70ec203257084a7be27eee8f93bd8ba9";

const SHA256_RE = /^[0-9a-f]{64}$/;

async function expectApiError(
  p: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(status);
    expect(apiErr.code).toBe(code);
    return;
  }
  throw new Error(`expected ApiError ${status}/${code} but the call succeeded`);
}

describe("handleTx validation (unit, no network)", () => {
  it("rejects a too-short hash with 400 INVALID_TX_HASH", async () => {
    await expectApiError(
      handleTx({ tx_hash: "0x1234", chain: "ethereum" }),
      400,
      "INVALID_TX_HASH",
    );
  });

  it("rejects a hash without the 0x prefix with 400 INVALID_TX_HASH", async () => {
    await expectApiError(
      handleTx({ tx_hash: "1b9e2b48eb3510ee1a8aae2fc402139784f32d43b76d5853387cacb484a9a9d3", chain: "ethereum" }),
      400,
      "INVALID_TX_HASH",
    );
  });

  it("rejects non-hex characters with 400 INVALID_TX_HASH", async () => {
    await expectApiError(
      handleTx({ tx_hash: "0x" + "g".repeat(64), chain: "ethereum" }),
      400,
      "INVALID_TX_HASH",
    );
  });

  it("rejects an unsupported chain with 400 UNSUPPORTED_CHAIN", async () => {
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "solana" }),
      400,
      "UNSUPPORTED_CHAIN",
    );
  });

  it("rejects missing params with 400 MISSING_PARAM", async () => {
    await expectApiError(handleTx({}), 400, "MISSING_PARAM");
    await expectApiError(handleTx({ tx_hash: CONFIRMED_TX }), 400, "MISSING_PARAM");
    await expectApiError(handleTx({ chain: "ethereum" }), 400, "MISSING_PARAM");
  });
});

describe("weiToEth (unit)", () => {
  it("converts 1 ETH exactly", () => {
    expect(weiToEth("0xde0b6b3a7640000")).toBe(1);
  });

  it("converts 0 wei to 0", () => {
    expect(weiToEth("0x0")).toBe(0);
  });

  it("converts 1 wei to 1e-18", () => {
    expect(weiToEth("0x1")).toBe(1e-18);
  });

  it("converts 10.5 ETH exactly", () => {
    expect(weiToEth("0x91b77e5e5d9a0000")).toBe(10.5);
  });
});

describe("receipt + envelope shape (unit, local fixtures)", () => {
  it("sha256Hex matches an independently computed SHA-256", () => {
    const input = "verireceipt-tx-fixture";
    const independent = createHash("sha256").update(input).digest("hex");
    expect(sha256Hex(input)).toBe(independent);
    expect(sha256Hex(input)).toMatch(SHA256_RE);
  });

  it("receipt hash is recomputable from the raw body", () => {
    const rawBody = '{"jsonrpc":"2.0","id":1,"result":{"status":"0x1"}}';
    const receipt = makeReceipt(
      "ONCHAIN_TX_LOOKUP_GENERAL",
      "https://ethereum-rpc.publicnode.com",
      rawBody,
      "2/2 sources agreed",
    );
    expect(receipt.raw_response_sha256).toBe(sha256Hex(rawBody));
    expect(receipt.raw_response_sha256).toBe(
      createHash("sha256").update(rawBody).digest("hex"),
    );
  });

  it("envelope carries the exact root fields plus a bare-64 sha256 receipt", () => {
    const receipt = makeReceipt(
      "ONCHAIN_TX_LOOKUP_GENERAL",
      "https://ethereum-rpc.publicnode.com",
      '{"jsonrpc":"2.0","id":1,"result":null}',
      "2/2 sources agreed",
    );
    const out = envelope(
      "ONCHAIN_TX_LOOKUP_GENERAL",
      {
        tx_hash: CONFIRMED_TX,
        status: "confirmed",
        from: "0x5875db54cd9ae2b2a875e09bb731772297ae9d92",
        to: "0x0000000aa232009084bd71a5797d089aa4edfad4",
        block_number: 26454409,
        value_eth: 0,
      },
      receipt,
      {
        answer: `Transaction ${CONFIRMED_TX} on ethereum is confirmed in block 26454409.`,
        verdict: "verified",
        confidence: 1.0,
        source: "Archive RPC quorum (ethereum, 2-of-3)",
      },
    );
    expect(out.tx_hash).toBe(CONFIRMED_TX);
    expect(out.status).toBe("confirmed");
    expect(out.from).toBe("0x5875db54cd9ae2b2a875e09bb731772297ae9d92");
    expect(out.to).toBe("0x0000000aa232009084bd71a5797d089aa4edfad4");
    expect(out.block_number).toBe(26454409);
    expect(out.value_eth).toBe(0);
    expect(out.verdict).toBe("verified");
    expect(out.confidence).toBe(1.0);
    const rc = out.receipt as Record<string, unknown>;
    expect(rc.raw_response_sha256).toMatch(SHA256_RE);
    expect(typeof rc.receipt_id).toBe("string");
    expect(typeof rc.upstream_url).toBe("string");
    expect(typeof rc.quorum_votes).toBe("string");
    expect(typeof rc.fetched_at).toBe("string");
    expect(typeof rc.audit_url).toBe("string");
  });
});

describe("handleTx live (real public RPCs, no mocks)", () => {
  it(
    "confirmed mainnet tx returns status confirmed with exact fields",
    async () => {
      const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
      expect(out.tx_hash).toBe(CONFIRMED_TX);
      expect(out.status).toBe("confirmed");
      expect(out.from).toBe("0x5875db54cd9ae2b2a875e09bb731772297ae9d92");
      expect(out.to).toBe("0x0000000aa232009084bd71a5797d089aa4edfad4");
      expect(out.block_number).toBe(26454409);
      expect(out.value_eth).toBe(0);
      expect(out.verdict).toBe("verified");
      expect(out.confidence).toBe(1.0);
      expect(out.source).toBe("Archive RPC quorum (ethereum, 2-of-3)");
      const rc = out.receipt as Record<string, unknown>;
      expect(rc.raw_response_sha256).toMatch(SHA256_RE);
      expect(typeof rc.upstream_url).toBe("string");
      expect((rc.upstream_url as string).startsWith("https://")).toBe(true);
    },
    30000,
  );

  it(
    "reverted mainnet tx returns status reverted",
    async () => {
      const out = await handleTx({ tx_hash: REVERTED_TX, chain: "ethereum" });
      expect(out.tx_hash).toBe(REVERTED_TX);
      expect(out.status).toBe("reverted");
      expect(out.from).toBe("0x60a518fbbc32d1bedcc02c7d6c7dff5f477e1aec");
      expect(out.to).toBe("0x7156b23feaf295e109d69148665bff737809cea4");
      expect(out.block_number).toBe(26454411);
      expect(out.verdict).toBe("reverted");
      expect(out.confidence).toBe(1.0);
      // M1: a reverted tx returns the ATTEMPTED value, not null. This tx's
      // value is 0x0 (verified live against eth.drpc.org 2026-11-20), so
      // the live case pins value_eth 0; the stub case below pins a
      // non-zero reverted value (1 ETH) to prove the value is carried.
      expect(out.value_eth).toBe(0);
    },
    30000,
  );

  it(
    "random unknown hash returns 200 status not_found (never 502)",
    async () => {
      const unknownHash = "0x" + randomBytes(32).toString("hex");
      const out = await handleTx({ tx_hash: unknownHash, chain: "ethereum" });
      expect(out.tx_hash).toBe(unknownHash);
      expect(out.status).toBe("not_found");
      expect(out.from).toBeNull();
      expect(out.to).toBeNull();
      expect(out.block_number).toBeNull();
      expect(out.value_eth).toBeNull();
      expect(out.verdict).toBe("not_found");
      expect(out.confidence).toBe(1.0);
    },
    30000,
  );
});

// ---------------------------------------------------------------------------
// Stubbed quorum tests (F2–F8; Judge 2). These stub global fetch — the
// handler code itself is never mocked — so every branch below is exercised
// deterministically without network. A leg issues exactly ONE batch call
// (eth_getTransactionByHash) per round, then at most one receipt call —
// at most, because fetchFromRpc is sequential: if the batch call throws,
// the receipt call never fires and the leg costs 1 fetch that round, not
// 2. The stub therefore derives the leg's "round" from the count of
// BATCH calls to that URL (the leg-invocation index), not from total
// calls: a batch call's round is its prior batch count, and the receipt
// call that follows it belongs to that same round. (The old
// floor(totalCalls/2) derivation assumed both calls always fire, which
// the old concurrent fan-out guaranteed and the sequential shape does
// not — a failed leg would desync the re-poll into round 0 again.)
// ---------------------------------------------------------------------------

type StubLeg = {
  tx: Record<string, unknown> | null;
  receipt: Record<string, unknown> | null;
  /** Delay the leg's responses by this many ms, honouring the AbortSignal
   * (lets a stubbed leg hit the handler's real 12 s per-call timeout). */
  delayMs?: number;
  /** Throw this error instead of responding (simulates a dead leg). */
  throwError?: string;
};

const STUB_FROM = "0x5875db54cd9ae2b2a875e09bb731772297ae9d92";
const STUB_TO = "0x0000000aa232009084bd71a5797d089aa4edfad4";

function stubTx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash: CONFIRMED_TX,
    from: STUB_FROM,
    to: STUB_TO,
    value: "0xde0b6b3a7640000", // 1 ETH
    blockNumber: "0x193a989",
    ...overrides,
  };
}

function stubReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "0x1",
    blockNumber: "0x193a989",
    from: STUB_FROM,
    to: STUB_TO,
    transactionHash: CONFIRMED_TX,
    ...overrides,
  };
}

const NULL_LEG: StubLeg = { tx: null, receipt: null };
const CONFIRMED_LEG: StubLeg = { tx: stubTx(), receipt: stubReceipt() };

interface StubInstall {
  /** Every fetch call the handler made, in order. */
  requests: Array<{ url: string; body: unknown }>;
}

/**
 * Install a fetch stub driven by `behavior(url, round)`. `table` form:
 * rows are rounds, columns are CHAIN_RPCS[chain] in order; a missing row
 * repeats the last row. Returns the recorded requests for assertions
 * (e.g. F5: no eth_blockNumber anywhere).
 */
function installStub(
  behavior: (url: string, round: number) => StubLeg,
): StubInstall {
  const requests: StubInstall["requests"] = [];
  /** Batch calls per URL: the leg-invocation index ("round") for that leg.
   * See the header comment above for why the round comes from the batch
   * count and not from total calls. */
  const batchCallsPerUrl = new Map<string, number>();
  const fetchStub = async (url: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
    const u = String(url);
    const body: unknown = JSON.parse(String((init as { body?: unknown } | undefined)?.body ?? "null"));
    requests.push({ url: u, body });
    const isBatch = Array.isArray(body);
    const priorBatches = batchCallsPerUrl.get(u) ?? 0;
    if (isBatch) batchCallsPerUrl.set(u, priorBatches + 1);
    // A batch call opens round `priorBatches`; the receipt call that
    // follows it in the same leg invocation belongs to that round.
    const round = isBatch ? priorBatches : priorBatches - 1;
    const leg = behavior(u, round);
    if (leg.throwError !== undefined) throw new Error(leg.throwError);
    if (leg.delayMs !== undefined && leg.delayMs > 0) {
      // Honour the handler's AbortSignal exactly like a real fetch: each
      // upstream POST has its own AbortController at RPC_TIMEOUT_MS
      // (12 s), so a delay above 12 s MUST reject — a stub that ignores
      // the signal would silently never exercise the timeout path.
      const signal = init?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, leg.delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(
            signal?.reason ??
              new DOMException("The operation was aborted", "AbortError"),
          );
        };
        if (signal?.aborted) {
          clearTimeout(timer);
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    const respond = (payload: unknown) => ({
      ok: true,
      text: async () => JSON.stringify(payload),
    });
    if (Array.isArray(body)) {
      return respond(
        body.map((call: Record<string, unknown>, i: number) => {
          if (call.method === "eth_getTransactionByHash") {
            return { jsonrpc: "2.0", id: i + 1, result: leg.tx };
          }
          return { jsonrpc: "2.0", id: i + 1, result: null };
        }),
      );
    }
    return respond({ jsonrpc: "2.0", id: 1, result: leg.receipt });
  };
  vi.stubGlobal("fetch", fetchStub);
  return { requests };
}

/** Behavior from a round × url-index table for one chain. */
function tableBehavior(table: StubLeg[][], chain = "ethereum") {
  const urls = CHAIN_RPCS[chain];
  return (url: string, round: number): StubLeg => {
    const idx = urls.indexOf(url);
    const row = table[Math.min(round, table.length - 1)] ?? [];
    return row[idx] ?? NULL_LEG;
  };
}

describe("handleTx stubbed quorum (fetch stubbed, no network)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pending: tx present + receipt null → pending, block_number null, value_eth from tx, confidence 0.9 (J1a + F8)", async () => {
    // The stubbed tx carries a non-null blockNumber alongside a null
    // receipt: the handler must still report block_number null, because a
    // pending tx is by definition not in a block.
    installStub(() => ({ tx: stubTx({ blockNumber: "0x193a989" }), receipt: null }));
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("pending");
    expect(out.verdict).toBe("pending");
    expect(out.confidence).toBe(0.9);
    expect(out.block_number).toBeNull();
    expect(out.value_eth).toBe(1);
    expect(out.from).toBe(STUB_FROM);
    expect(out.to).toBe(STUB_TO);
  });

  it("l1Fee present on an OP-stack chain → root l1_fee_eth (F8)", async () => {
    installStub(() => ({
      tx: stubTx(),
      receipt: stubReceipt({ l1Fee: "0xde0b6b3a7640000" }),
    }));
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "base" });
    expect(out.status).toBe("confirmed");
    expect(out.l1_fee_eth).toBe(1);
  });

  it("l1Fee absent on an OP-stack chain → field absent, not null/0 (F8)", async () => {
    installStub(() => CONFIRMED_LEG);
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "base" });
    expect(out.status).toBe("confirmed");
    expect("l1_fee_eth" in out).toBe(false);
  });

  it("l1Fee on an Ethereum receipt → dropped by the OP-stack gate (F8)", async () => {
    installStub(() => ({
      tx: stubTx(),
      receipt: stubReceipt({ l1Fee: "0xde0b6b3a7640000" }),
    }));
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect("l1_fee_eth" in out).toBe(false);
  });

  it("F3(i): 1-of-3 sees the tx, re-poll confirms it on a second leg → confirmed", async () => {
    installStub(
      tableBehavior([
        [CONFIRMED_LEG, NULL_LEG, NULL_LEG],
        [CONFIRMED_LEG, CONFIRMED_LEG, NULL_LEG],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.block_number).toBe(26454409);
    expect(out.value_eth).toBe(1);
    expect(out.verdict).toBe("verified");
    expect(out.confidence).toBe(1.0);
  });

  it("F3(ii): 1-of-3 sees the tx, re-poll still null on the others → 502 QUORUM_DISAGREEMENT, never not_found", async () => {
    installStub(
      tableBehavior([
        [CONFIRMED_LEG, NULL_LEG, NULL_LEG],
        [CONFIRMED_LEG, NULL_LEG, NULL_LEG],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_DISAGREEMENT",
    );
  });

  it("F3(iii): all 3 null → not_found with confidence 1.0 (no re-poll on a unanimous null)", async () => {
    const { requests } = installStub(() => NULL_LEG);
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("not_found");
    expect(out.verdict).toBe("not_found");
    expect(out.confidence).toBe(1.0);
    expect(out.from).toBeNull();
    expect(out.to).toBeNull();
    expect(out.block_number).toBeNull();
    expect(out.value_eth).toBeNull();
    // Unanimous null is not a split vote, so no re-poll happens: exactly
    // 2 fetch calls per leg (batch + receipt), no second round.
    expect(requests.length).toBe(CHAIN_RPCS.ethereum.length * 2);
  });

  it("F4: all legs return a mismatched-hash tx → 502, never 200 confirmed", async () => {
    const wrongHash = "0x" + "b".repeat(64);
    installStub(() => ({
      tx: stubTx({ hash: wrongHash }),
      receipt: stubReceipt({ transactionHash: wrongHash }),
    }));
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  it("F4: tx hash matches but receipt transactionHash mismatches → 502", async () => {
    installStub(() => ({
      tx: stubTx(),
      receipt: stubReceipt({ transactionHash: "0x" + "b".repeat(64) }),
    }));
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  it("F5: batch carries no eth_blockNumber and a batch without it still confirms", async () => {
    const { requests } = installStub(() => CONFIRMED_LEG);
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.block_number).toBe(26454409);
    expect(out.confirmations).toBeNull();
    const evidence = await getReceiptEvidence(String((out.receipt as Record<string, unknown>).receipt_id));
    expect(String(evidence.evidence)).toBe(stableStringify({tx: CONFIRMED_LEG.tx, receipt: CONFIRMED_LEG.receipt}));
    // No request anywhere mentions eth_blockNumber, and every batch
    // carries exactly the one eth_getTransactionByHash call.
    expect(requests.filter(r => !Array.isArray(r.body) && (r.body as Record<string, unknown>)?.method === "eth_blockNumber")).toHaveLength(CHAIN_RPCS.ethereum.length);
    const batches = requests.map((r) => r.body).filter((b) => Array.isArray(b));
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches as Array<Array<Record<string, unknown>>>) {
      expect(batch).toHaveLength(1);
      expect(batch[0].method).toBe("eth_getTransactionByHash");
    }
  });

  it("F6: tx blockNumber '0x0193a989' vs '0x193a989' (same block) → confirmed", async () => {
    installStub(
      tableBehavior([
        [
          CONFIRMED_LEG,
          { tx: stubTx({ blockNumber: "0x0193a989" }), receipt: stubReceipt() },
          CONFIRMED_LEG,
        ],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.block_number).toBe(26454409);
  });

  it("F10: source label and quorum_votes derive from the chain's actual RPC count", async () => {
    installStub(() => CONFIRMED_LEG);
    const eth = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(eth.source).toBe(
      `Archive RPC quorum (ethereum, 2-of-${CHAIN_RPCS.ethereum.length})`,
    );
    const ethRc = eth.receipt as Record<string, unknown>;
    expect(ethRc.quorum_votes).toBe(
      `${CHAIN_RPCS.ethereum.length}/${CHAIN_RPCS.ethereum.length} sources agreed`,
    );
    const sep = await handleTx({ tx_hash: CONFIRMED_TX, chain: "sepolia" });
    expect(sep.source).toBe(
      `Archive RPC quorum (sepolia, 2-of-${CHAIN_RPCS.sepolia.length})`,
    );
    const sepRc = sep.receipt as Record<string, unknown>;
    expect(sepRc.quorum_votes).toBe(
      `${CHAIN_RPCS.sepolia.length}/${CHAIN_RPCS.sepolia.length} sources agreed`,
    );
  });

  it("base-sepolia: accepted, 2-of-2 label, and receipt l1Fee → root l1_fee_eth", async () => {
    installStub(() => ({
      tx: stubTx(),
      receipt: stubReceipt({ l1Fee: "0x61" }),
    }));
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "base-sepolia" });
    expect(out.status).toBe("confirmed");
    expect(out.l1_fee_eth).toBe(0x61 / 1e18);
    expect(out.source).toBe(
      `Archive RPC quorum (base-sepolia, 2-of-${CHAIN_RPCS["base-sepolia"].length})`,
    );
    const rc = out.receipt as Record<string, unknown>;
    expect(rc.quorum_votes).toBe(
      `${CHAIN_RPCS["base-sepolia"].length}/${CHAIN_RPCS["base-sepolia"].length} sources agreed`,
    );
  });

  it("rejects 63-hex and 65-hex hashes with 400, accepts a 66-hex hash (F8 boundary)", async () => {
    await expectApiError(
      handleTx({ tx_hash: "0x" + "a".repeat(63), chain: "ethereum" }),
      400,
      "INVALID_TX_HASH",
    );
    await expectApiError(
      handleTx({ tx_hash: "0x" + "a".repeat(65), chain: "ethereum" }),
      400,
      "INVALID_TX_HASH",
    );
    installStub(() => NULL_LEG);
    const out = await handleTx({ tx_hash: "0x" + "a".repeat(64), chain: "ethereum" });
    expect(out.status).toBe("not_found");
  });

  it("accepts uppercase chain 'ETHEREUM' and whitespace-padded ' ethereum ' (F8)", async () => {
    installStub(() => NULL_LEG);
    const upper = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ETHEREUM" });
    expect(upper.status).toBe("not_found");
    const padded = await handleTx({ tx_hash: CONFIRMED_TX, chain: " ethereum " });
    expect(padded.status).toBe("not_found");
  });

  it("accepts chain synonyms 'mainnet', 'eth', '1', 'eip155:1' as ethereum (A2)", async () => {
    // A2 (PLAN.md §6 A2): the reference question says "… on Ethereum" and
    // the builder may send any of these spellings. They all resolve to
    // the ethereum quorum (stubbed null legs → not_found, proving the
    // chain was accepted and routed, not rejected).
    installStub(() => NULL_LEG);
    for (const chain of ["mainnet", "eth", "ETH", "1", "eip155:1", "Ethereum", "on Ethereum"]) {
      const out = await handleTx({ tx_hash: CONFIRMED_TX, chain });
      expect(out.status).toBe("not_found");
    }
  });
});

describe("weiToEth precision limit (F7)", () => {
  it("100000 ETH + 1 wei returns exactly 100000: the 1 wei is lost to IEEE-754 (documented, not exact)", () => {
    expect(weiToEth("0x152d02c7e14af6800001")).toBe(100000);
  });

  it("1.234567890123456789 ETH returns 1.2345678901234567, identical to naive float division", () => {
    expect(weiToEth("0x112210f47de98115")).toBe(1.2345678901234567);
    expect(weiToEth("0x112210f47de98115")).toBe(
      Number(BigInt("0x112210f47de98115")) / 1e18,
    );
  });
});

describe("handleTx live receipt recomputation (M2)", () => {
  it(
    "receipt hash recomputes by re-POSTing BOTH eth_getTransactionByHash and eth_getTransactionReceipt to the winning leg (NOT a GET)",
    async () => {
      // M2 (R2, JUDGE.md §4): the receipt digest is
      // sha256(stableStringify({tx, receipt, optional confirmation_context})) over the PARSED `result`
      // of BOTH upstream calls on the winning leg
      // (src/handlers/txLookup.ts buildTxEvidence) — NOT sha256 of the
      // raw receipt-call text. The recomputation below uses FRESH
      // re-POSTs, never the receipt's own stored evidence, so a wrong
      // result from either call fails the test. A GET to the RPC URL
      // returns HTTP 301 with an empty body and proves nothing.
      const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
      const rc = out.receipt as Record<string, unknown>;
      const upstream = rc.upstream_url as string;
      expect(typeof upstream).toBe("string");
      expect(upstream.startsWith("https://")).toBe(true);
      expect(rc.raw_response_sha256).toMatch(SHA256_RE);
      async function rePost(method: string): Promise<unknown> {
        const res = await fetch(upstream, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: [CONFIRMED_TX],
          }),
        });
        expect(res.ok).toBe(true);
        const json = (await res.json()) as Record<string, unknown>;
        expect(json.error).toBeUndefined();
        return json.result ?? null;
      }
      const txResult = (await rePost(
        "eth_getTransactionByHash",
      )) as Record<string, unknown> | null;
      const rcResult = (await rePost(
        "eth_getTransactionReceipt",
      )) as Record<string, unknown> | null;
      // Strict: both calls must return the tx that was queried — a
      // wrong result must fail the test, not just produce a different hash.
      expect(txResult).not.toBeNull();
      expect(txResult?.hash).toBe(CONFIRMED_TX);
      expect(rcResult).not.toBeNull();
      expect(rcResult?.transactionHash).toBe(CONFIRMED_TX);
      const stored = await getReceiptEvidence(String(rc.receipt_id));
      expect(stored.evidence).toBeDefined();
      const observed = JSON.parse(String(stored.evidence));
      const context = observed.confirmation_context;
      if (context) {
        const votes = context.confirmation_evidence as {height:number;raw:string;url:string}[];
        expect(votes.length).toBeGreaterThanOrEqual(2);
        const heights = votes.map(v => { const j = JSON.parse(v.raw); expect(j.error).toBeUndefined(); expect(j.jsonrpc).toBe("2.0"); expect(j.id).toBe(1); expect(Number(BigInt(j.result))).toBe(v.height); return v.height; });
        const agreed = heights.find(h => heights.filter(x => x === h).length >= 2);
        expect(agreed).toBeDefined();
        expect(context.confirmations).toBe(agreed! - Number(BigInt(String(rcResult!.blockNumber))));
        expect(out.confirmations).toBe(context.confirmations);
      } else expect(out.confirmations).toBeNull();
      // Fresh calls independently verify the immutable tx/receipt. Historical
      // moving-head observations must come from preserved raw responses, not
      // a later head read that would no longer reproduce the acquisition time.
      const recomputed = context ? { tx: txResult, receipt: rcResult, confirmation_context: context } : { tx: txResult, receipt: rcResult };
      expect(sha256Hex(stableStringify(recomputed))).toBe(rc.raw_response_sha256);
    },
    60000,
  );

  it(
    "nonzero-value tx: receipt hash recomputes by re-POSTing BOTH calls (value covered by the hash)",
    async () => {
      // R3 (J2 R2 coverage gap): the M2 suite had NO live nonzero-value
      // test — the only nonzero assertion (base-sepolia trap, value
      // 0.001 ETH) never recomputed the digest. This tx was recorded
      // live by J2 (R2): 0x413bc4… (block 0x193b33a, value
      // 0x36ef19ec4c00 = 0.00006040056 ETH). The value lives ONLY in
      // the tx result (an Ethereum receipt has no `value` field), so
      // a receipt-only hash could never cover it — the digest equality
      // below is the check that the money field is inside the hash.
      // No digest is hardcoded: the expected digest is recomputed
      // from FRESH re-POSTs, never from the receipt's stored evidence.
      const NONZERO_TX =
        "0x413bc4d899236f22004dd9bacf546730b796a06016517d724966a1e22f1cb564";
      const out = await handleTx({ tx_hash: NONZERO_TX, chain: "ethereum" });
      expect(out.status).toBe("confirmed");
      expect(out.block_number).toBe(26456890);
      expect(out.value_eth).toBe(weiToEth("0x36ef19ec4c00"));
      expect(out.value_eth).toBeGreaterThan(0);
      const rc = out.receipt as Record<string, unknown>;
      const upstream = rc.upstream_url as string;
      expect(typeof upstream).toBe("string");
      expect(upstream.startsWith("https://")).toBe(true);
      expect(rc.raw_response_sha256).toMatch(SHA256_RE);
      async function rePost(method: string): Promise<unknown> {
        const res = await fetch(upstream, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: [NONZERO_TX],
          }),
        });
        expect(res.ok).toBe(true);
        const json = (await res.json()) as Record<string, unknown>;
        expect(json.error).toBeUndefined();
        return json.result ?? null;
      }
      const txResult = (await rePost(
        "eth_getTransactionByHash",
      )) as Record<string, unknown> | null;
      const rcResult = (await rePost(
        "eth_getTransactionReceipt",
      )) as Record<string, unknown> | null;
      // Strict: both calls must return the tx that was queried, and
      // the tx result must carry the nonzero value the answer reports.
      expect(txResult).not.toBeNull();
      expect(txResult?.hash).toBe(NONZERO_TX);
      expect(txResult?.value).toBe("0x36ef19ec4c00");
      expect(weiToEth(txResult?.value as string)).toBe(out.value_eth);
      expect(rcResult).not.toBeNull();
      expect(rcResult?.transactionHash).toBe(NONZERO_TX);
      const stored = await getReceiptEvidence(String(rc.receipt_id));
      expect(stored.evidence).toBeDefined();
      const observed = JSON.parse(String(stored.evidence));
      const context = observed.confirmation_context;
      if (context) {
        const votes = context.confirmation_evidence as {height:number;raw:string;url:string}[];
        expect(votes.length).toBeGreaterThanOrEqual(2);
        const heights = votes.map(v => { const j = JSON.parse(v.raw); expect(j.error).toBeUndefined(); expect(j.jsonrpc).toBe("2.0"); expect(j.id).toBe(1); expect(Number(BigInt(j.result))).toBe(v.height); return v.height; });
        const agreed = heights.find(h => heights.filter(x => x === h).length >= 2);
        expect(agreed).toBeDefined();
        expect(context.confirmations).toBe(agreed! - Number(BigInt(String(rcResult!.blockNumber))));
        expect(out.confirmations).toBe(context.confirmations);
      } else expect(out.confirmations).toBeNull();
      // Fresh calls independently verify the immutable tx/receipt. Historical
      // moving-head observations must come from preserved raw responses, not
      // a later head read that would no longer reproduce the acquisition time.
      const recomputed = context ? { tx: txResult, receipt: rcResult, confirmation_context: context } : { tx: txResult, receipt: rcResult };
      expect(sha256Hex(stableStringify(recomputed))).toBe(rc.raw_response_sha256);
    },
    60000,
  );
});

describe("handleTx live non-ethereum chains (M2 + Blocker 1)", () => {
  it(
    "base old tx (block 30,000,000) returns confirmed via the replaced BlastAPI leg",
    async () => {
      // Blocker 1: 0x7f18654a… is the first tx of base block 30,000,000
      // (verified live via mainnet.base.org eth_getBlockByNumber
      // 2026-11-20). The old publicnode leg -32602'd on it; the
      // replacement leg must serve it.
      const out = await handleTx({
        tx_hash: "0x7f18654ad60076c65e88ecb2dd626c3de0d58ff355a9b10cc1de762025d2e1e1",
        chain: "base",
      });
      expect(out.status).toBe("confirmed");
      expect(out.block_number).toBe(30000000);
      expect(out.value_eth).toBe(0);
      expect(typeof out.l1_fee_eth).toBe("number");
      const rc = out.receipt as Record<string, unknown>;
      expect(rc.raw_response_sha256).toMatch(SHA256_RE);
    },
    60000,
  );

  it(
    "polygon old tx (block 69,999,424) returns confirmed via the 2-leg quorum",
    async () => {
      // Blocker 1: 0x85263e85… is the first tx of polygon block 69,999,424
      // (0x42C1B40 — verified live via polygon.drpc.org
      // eth_getBlockByNumber + eth_getTransactionByHash 2026-11-20).
      // The gated publicnode leg is gone; drpc + Tenderly
      // must serve it as a 2-of-2 quorum.
      const out = await handleTx({
        tx_hash: "0x85263e854c21b5ac7fe67915c26815fb640cf404b259ec735855b69f0940e8f4",
        chain: "polygon",
      });
      expect(out.status).toBe("confirmed");
      expect(out.block_number).toBe(69999424);
      expect(out.source).toBe("Archive RPC quorum (polygon, 2-of-2)");
      const rc = out.receipt as Record<string, unknown>;
      expect(rc.raw_response_sha256).toMatch(SHA256_RE);
    },
    60000,
  );

  it(
    "base-sepolia trap t02 returns confirmed with value 0.001 ETH and l1_fee_eth",
    async () => {
      const out = await handleTx({
        tx_hash: "0x2d70ca963eb8763d4704572c62e36a8418d7559e54683ef31c1589d955343687",
        chain: "base-sepolia",
      });
      expect(out.status).toBe("confirmed");
      expect(out.block_number).toBe(55258439);
      expect(out.value_eth).toBe(0.001);
      expect(typeof out.l1_fee_eth).toBe("number");
    },
    60000,
  );
});

describe("handleTx stubbed: B1 errored/timed-out legs fail closed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("B1(i): slow tx-bearing leg (6 s) + 2 immediate nulls → 502, never 200 not_found", async () => {
    // A2-fix re-pin: the per-call budget is now 12 s, so a 6 s-per-call
    // leg no longer times out — it answers in round 0 (6 s tx + 6 s
    // receipt, sequential) and the vote is still 1-tx-vs-2-null with no
    // agreeing pair, re-polled (round 1 returns the tx immediately) and
    // 502 QUORUM_DISAGREEMENT. Either 502 code is acceptable; a 200
    // not_found is not. The timeout behaviour itself is now pinned by
    // the all-slow matrix test below (20 s delays vs the 12 s budget).
    installStub(
      tableBehavior([
        [
          { tx: stubTx(), receipt: stubReceipt(), delayMs: 6000 },
          NULL_LEG,
          NULL_LEG,
        ],
        [CONFIRMED_LEG, NULL_LEG, NULL_LEG],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_DISAGREEMENT",
    );
  }, 30000);

  it("B1(ii): 1 errored leg + 2 nulls, error persists on re-poll → 502 QUORUM_UNREACHABLE", async () => {
    installStub(
      tableBehavior([
        [{ tx: null, receipt: null, throwError: "boom" }, NULL_LEG, NULL_LEG],
        [{ tx: null, receipt: null, throwError: "boom" }, NULL_LEG, NULL_LEG],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  it("B1(iv): transient-error leg returns the tx on re-poll, nulls stay null → 502 QUORUM_DISAGREEMENT, never not_found", async () => {
    // Recorded design limit: a LONE tx-bearing leg cannot form a 2-of-N
    // pair, so "confirmed" would violate the quorum rule. Fail-closed 502
    // is the correct answer here — the tx is neither confirmed nor
    // denied. See the next test for the case where a pair DOES form.
    installStub(
      tableBehavior([
        [{ tx: null, receipt: null, throwError: "transient" }, NULL_LEG, NULL_LEG],
        [CONFIRMED_LEG, NULL_LEG, NULL_LEG],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_DISAGREEMENT",
    );
  });

  it("B1(v): transient-error leg recovers AND a null leg confirms on re-poll → confirmed", async () => {
    installStub(
      tableBehavior([
        [{ tx: null, receipt: null, throwError: "transient" }, NULL_LEG, NULL_LEG],
        [CONFIRMED_LEG, CONFIRMED_LEG, NULL_LEG],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.block_number).toBe(26454409);
    expect(out.value_eth).toBe(1);
  });

  it("B1: 1 errored leg + 2 confirmed legs → confirmed (an errored leg never blocks a reached quorum)", async () => {
    installStub(
      tableBehavior([
        [{ tx: null, receipt: null, throwError: "boom" }, CONFIRMED_LEG, CONFIRMED_LEG],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.block_number).toBe(26454409);
  });
});

describe("handleTx stubbed: M5 receipt-without-tx legs are inconsistent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("M5: receipt-only on ALL legs → 502 QUORUM_UNREACHABLE, never 200 confirmed with value_eth null", async () => {
    const receiptOnly: StubLeg = { tx: null, receipt: stubReceipt() };
    installStub(() => receiptOnly);
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  it("M5: 2 confirmed + 1 receipt-only → confirmed (the inconsistent leg is dropped, the pair wins)", async () => {
    installStub(
      tableBehavior([
        [CONFIRMED_LEG, CONFIRMED_LEG, { tx: null, receipt: stubReceipt() }],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.value_eth).toBe(1);
  });

  it("M5: 1 confirmed + 1 null + 1 receipt-only → 502 QUORUM_DISAGREEMENT", async () => {
    installStub(
      tableBehavior([
        [CONFIRMED_LEG, NULL_LEG, { tx: null, receipt: stubReceipt() }],
        [CONFIRMED_LEG, NULL_LEG, { tx: null, receipt: stubReceipt() }],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_DISAGREEMENT",
    );
  });
});

describe("handleTx stubbed: M1 reverted value_eth + M2 input normalisation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("M1 (stub): reverted tx with a 1 ETH attempted value returns value_eth 1, not null", async () => {
    installStub(() => ({
      tx: stubTx(),
      receipt: stubReceipt({ status: "0x0" }),
    }));
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("reverted");
    expect(out.verdict).toBe("reverted");
    expect(out.value_eth).toBe(1);
    expect(out.block_number).toBe(26454409);
  });

  it("M2 (stub): uppercase tx hash is accepted (hash comparison is case-insensitive)", async () => {
    installStub(() => CONFIRMED_LEG);
    const upperHex = "0x" + CONFIRMED_TX.slice(2).toUpperCase();
    const out = await handleTx({ tx_hash: upperHex, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.value_eth).toBe(1);
  });

  it("M2 (stub): whitespace-padded tx hash is accepted (trimmed before validation)", async () => {
    installStub(() => CONFIRMED_LEG);
    const out = await handleTx({ tx_hash: `  ${CONFIRMED_TX}\n`, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
  });

  it("M2 (stub): uppercase + whitespace-padded chain is accepted", async () => {
    installStub(() => CONFIRMED_LEG);
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "  ETHEREUM " });
    expect(out.status).toBe("confirmed");
  });

  it("M2 (stub): real ethereum tx hash queried on the wrong chain → not_found, no invented fields", async () => {
    installStub(() => NULL_LEG);
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "polygon" });
    expect(out.status).toBe("not_found");
    expect(out.from).toBeNull();
    expect(out.to).toBeNull();
    expect(out.block_number).toBeNull();
    expect(out.value_eth).toBeNull();
    expect(out.verdict).toBe("not_found");
  });
});

describe("handleTx refusal matrix + adversarial inputs (zero-tolerance gate)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("400 matrix: every malformed hash shape is INVALID_TX_HASH and never reaches fetch", async () => {
    const badHashes = [
      // NOTE: "" and "   " are NOT here — a trimmed-empty hash is
      // MISSING_PARAM by design (covered in the MISSING_PARAM test below),
      // not INVALID_TX_HASH.
      "0x",
      "0x" + "a".repeat(63),
      "0x" + "a".repeat(65),
      "0x" + "a".repeat(10000), // oversized
      "0x" + "g".repeat(64),
      "0x" + "é".repeat(64), // unicode
      "0x" + "a".repeat(63) + "\0", // null byte
      "0x" + "a".repeat(32) + " " + "a".repeat(31), // inner space
      "not-a-hash",
      "0X" + "a".repeat(64), // wrong prefix case
      "1b9e2b48eb3510ee1a8aae2fc402139784f32d43b76d5853387cacb484a9a9d3", // no 0x
    ];
    for (const bad of badHashes) {
      const { requests } = installStub(() => CONFIRMED_LEG);
      await expectApiError(
        handleTx({ tx_hash: bad, chain: "ethereum" }),
        400,
        "INVALID_TX_HASH",
      );
      expect(requests.length).toBe(0);
      vi.unstubAllGlobals();
    }
  });

  it("400 matrix: injection strings as tx_hash are rejected before any fetch", async () => {
    const injections = [
      "0x" + "a".repeat(60) + "'; DROP TABLE receipts; --",
      "0x" + "a".repeat(64) + "\nX-Injected: 1",
      "${7*7}",
      "{{7*7}}",
      "0x" + "a".repeat(64) + "<script>alert(1)</script>",
    ];
    for (const bad of injections) {
      const { requests } = installStub(() => CONFIRMED_LEG);
      await expectApiError(
        handleTx({ tx_hash: bad, chain: "ethereum" }),
        400,
        "INVALID_TX_HASH",
      );
      expect(requests.length).toBe(0);
      vi.unstubAllGlobals();
    }
  });

  it("400 matrix: unsupported / injected chain names are UNSUPPORTED_CHAIN and never reach fetch", async () => {
    const badChains = [
      "solana",
      "etherium", // typo must not resolve to ethereum
      "main net", // spaced, not the "mainnet" alias
      "ethereum; DROP TABLE receipts",
      "ethereum\x00",
      "base_sepolia",
      // NOTE: "ethereum\n" is NOT here — chain names are trimmed before
      // lookup, so it is a valid chain (see the F8 test above).
      // NOTE: "BASE-SEPOLIA" is NOT here — chain names are lowercased
      // before lookup, so it is a valid chain (see the F8 test above).
    ];
    for (const bad of badChains) {
      const { requests } = installStub(() => CONFIRMED_LEG);
      await expectApiError(
        handleTx({ tx_hash: CONFIRMED_TX, chain: bad }),
        400,
        "UNSUPPORTED_CHAIN",
      );
      expect(requests.length).toBe(0);
      vi.unstubAllGlobals();
    }
  });

  it("400 matrix: empty / whitespace-only params are MISSING_PARAM", async () => {
    await expectApiError(handleTx({ tx_hash: "", chain: "ethereum" }), 400, "MISSING_PARAM");
    await expectApiError(handleTx({ tx_hash: "   ", chain: "ethereum" }), 400, "MISSING_PARAM");
    await expectApiError(handleTx({ tx_hash: CONFIRMED_TX, chain: "" }), 400, "MISSING_PARAM");
    await expectApiError(handleTx({ tx_hash: CONFIRMED_TX, chain: "   " }), 400, "MISSING_PARAM");
    await expectApiError(handleTx({ tx_hash: undefined, chain: undefined }), 400, "MISSING_PARAM");
  });

  it("502 matrix: all legs down → QUORUM_UNREACHABLE", async () => {
    // R4 MINOR 2: round 0 + one re-poll of all 3 errored legs. A2-fix:
    // a failed leg costs 1 fetch per round (its batch call throws, so
    // the receipt call never fires) — 3 + 3 = 6, not the old 12. The
    // 502 outcome is unchanged.
    const { requests } = installStub(() => ({ tx: null, receipt: null, throwError: "connection refused" }));
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
    expect(requests.length).toBe(6);
  });

  it("502 matrix: 2 of 3 legs down (only 1 success) → QUORUM_UNREACHABLE", async () => {
    // R4 MINOR 2: the <2-successes path now re-polls the errored legs once
    // before 502ing. A2-fix: round 0 is 2 (healthy null leg) + 1 + 1
    // (each down leg costs 1 fetch — its batch call throws, so the
    // receipt call never fires) = 4, plus the re-poll of the 2 errored
    // legs (2) = 6. The 502 outcome is unchanged — only the fetch count
    // changed, because a transient that recovers on re-poll must get its
    // chance before the endpoint gives up.
    const { requests } = installStub(
      tableBehavior([
        [{ tx: null, receipt: null, throwError: "down" }, { tx: null, receipt: null, throwError: "down" }, NULL_LEG],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
    expect(requests.length).toBe(6);
  });

  it("502 matrix: all legs slow (20 s) → every leg times out → QUORUM_UNREACHABLE", async () => {
    // A2-fix re-pin: the per-call budget is 12 s, so the slow delay must
    // exceed 12 s per call to time out (was 6 s vs the old 4.5 s per-leg
    // budget). Sequential legs abort on the first call at 12 s, so the
    // wall is ~2 rounds × 3 legs × 12 s ≈ 72 s — hence the 120 s
    // timeout. The 502 outcome is unchanged.
    installStub(() => ({ tx: stubTx(), receipt: stubReceipt(), delayMs: 20000 }));
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  }, 120000);

  it("502 matrix: legs returning malformed results → QUORUM_UNREACHABLE, never 200", async () => {
    // A leg returning a tx without from/value is malformed and fails the
    // leg; with all legs malformed there are zero successes.
    installStub(() => ({
      tx: { hash: CONFIRMED_TX } as unknown as Record<string, unknown>,
      receipt: null,
    }));
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  it("502 matrix: two legs disagree on block number with no pair → QUORUM_DISAGREEMENT", async () => {
    installStub(
      tableBehavior([
        [
          CONFIRMED_LEG,
          { tx: stubTx({ blockNumber: "0x193a98a" }), receipt: stubReceipt({ blockNumber: "0x193a98a" }) },
          NULL_LEG,
        ],
        [
          CONFIRMED_LEG,
          { tx: stubTx({ blockNumber: "0x193a98a" }), receipt: stubReceipt({ blockNumber: "0x193a98a" }) },
          NULL_LEG,
        ],
      ]),
    );
    // Round 0 is a 1-tx-vs-1-different-tx-vs-null split; the re-poll
    // re-polls only the null leg (the two tx legs keep their answers),
    // so no pair ever forms.
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_DISAGREEMENT",
    );
  });
});

// ---------------------------------------------------------------------------
// ROUND 4 (TX Judge round 4 — J1+J2 re-judge FAILs). Stubbed quorum attacks
// proving each fix. Helpers (installStub/tableBehavior/stubTx/stubReceipt)
// are shared with the round-3 stub suites above.
// ---------------------------------------------------------------------------

const VALUE_100_ETH = "0x56bc75e2d63100000"; // 100 ETH in wei
const VALUE_2_ETH = "0x1bc16d674ec80000";
const VALUE_3_ETH = "0x29a2241af62c0000";
const OTHER_TO = "0x1111111111111111111111111111111111111111";
const OTHER_FROM = "0x2222222222222222222222222222222222222222";
const PENDING_LEG: StubLeg = { tx: stubTx(), receipt: null };

describe("handleTx stubbed R4: BLOCKER A — quorum votes on value/from/to/l1Fee", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("A1: legs value [100, 1, 0] ETH, same hash/block/status → 502 QUORUM_DISAGREEMENT (no majority on value)", async () => {
    installStub(
      tableBehavior([
        [
          { tx: stubTx({ value: VALUE_100_ETH }), receipt: stubReceipt() },
          { tx: stubTx({ value: "0xde0b6b3a7640000" }), receipt: stubReceipt() },
          { tx: stubTx({ value: "0x0" }), receipt: stubReceipt() },
        ],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_DISAGREEMENT",
    );
  });

  it("A1-order: legs value [0, 1, 100] ETH (liar reordered) → still 502 QUORUM_DISAGREEMENT, never first-leg-wins", async () => {
    installStub(
      tableBehavior([
        [
          { tx: stubTx({ value: "0x0" }), receipt: stubReceipt() },
          { tx: stubTx({ value: "0xde0b6b3a7640000" }), receipt: stubReceipt() },
          { tx: stubTx({ value: VALUE_100_ETH }), receipt: stubReceipt() },
        ],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_DISAGREEMENT",
    );
  });

  it("A1b: legs value [100, 100, 0] ETH → winner 100 with votes 2/3 sources agreed", async () => {
    installStub(
      tableBehavior([
        [
          { tx: stubTx({ value: VALUE_100_ETH }), receipt: stubReceipt() },
          { tx: stubTx({ value: VALUE_100_ETH }), receipt: stubReceipt() },
          { tx: stubTx({ value: "0x0" }), receipt: stubReceipt() },
        ],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.value_eth).toBe(100);
    const rc = out.receipt as Record<string, unknown>;
    expect(rc.quorum_votes).toBe("2/3 sources agreed");
  });

  it("A2: legs disagree on `to` only, minority FIRST → majority `to` wins (not first-leg-wins)", async () => {
    installStub(
      tableBehavior([
        [
          CONFIRMED_LEG,
          { tx: stubTx({ to: OTHER_TO }), receipt: stubReceipt({ to: OTHER_TO }) },
          { tx: stubTx({ to: OTHER_TO }), receipt: stubReceipt({ to: OTHER_TO }) },
        ],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.to).toBe(OTHER_TO);
    const rc = out.receipt as Record<string, unknown>;
    expect(rc.quorum_votes).toBe("2/3 sources agreed");
  });

  it("A2b: legs disagree on `from` only, 2-vs-1 → majority `from` wins", async () => {
    installStub(
      tableBehavior([
        [
          { tx: stubTx({ from: OTHER_FROM }), receipt: stubReceipt({ from: OTHER_FROM }) },
          CONFIRMED_LEG,
          CONFIRMED_LEG,
        ],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.from).toBe(STUB_FROM);
  });

  it("A3: legs disagree on l1Fee [1, 0, 0] ETH on base → majority l1Fee 0 wins", async () => {
    installStub(
      tableBehavior(
        [
          [
            { tx: stubTx(), receipt: stubReceipt({ l1Fee: "0xde0b6b3a7640000" }) },
            { tx: stubTx(), receipt: stubReceipt({ l1Fee: "0x0" }) },
            { tx: stubTx(), receipt: stubReceipt({ l1Fee: "0x0" }) },
          ],
        ],
        "base",
      ),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "base" });
    expect(out.status).toBe("confirmed");
    expect(out.l1_fee_eth).toBe(0);
    const rc = out.receipt as Record<string, unknown>;
    expect(rc.quorum_votes).toBe("2/3 sources agreed");
  });

  it("A3b: legs l1Fee [1, 2, 3] ETH on base, no majority → 502 QUORUM_DISAGREEMENT", async () => {
    installStub(
      tableBehavior(
        [
          [
            { tx: stubTx(), receipt: stubReceipt({ l1Fee: "0xde0b6b3a7640000" }) },
            { tx: stubTx(), receipt: stubReceipt({ l1Fee: VALUE_2_ETH }) },
            { tx: stubTx(), receipt: stubReceipt({ l1Fee: VALUE_3_ETH }) },
          ],
        ],
        "base",
      ),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "base" }),
      502,
      "QUORUM_DISAGREEMENT",
    );
  });

  it("A3c: l1Fee present-vs-absent split with no pair on base → 502 QUORUM_DISAGREEMENT", async () => {
    installStub(
      tableBehavior(
        [
          [
            { tx: stubTx(), receipt: stubReceipt({ l1Fee: "0xde0b6b3a7640000" }) },
            { tx: stubTx(), receipt: stubReceipt() },
            { tx: stubTx(), receipt: stubReceipt({ l1Fee: VALUE_2_ETH }) },
          ],
        ],
        "base",
      ),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "base" }),
      502,
      "QUORUM_DISAGREEMENT",
    );
  });

  it("A3d: l1Fee present on some legs only is IGNORED on ethereum (not OP-stack) → confirmed", async () => {
    installStub(
      tableBehavior([
        [
          { tx: stubTx(), receipt: stubReceipt({ l1Fee: "0xde0b6b3a7640000" }) },
          { tx: stubTx(), receipt: stubReceipt() },
          { tx: stubTx(), receipt: stubReceipt({ l1Fee: VALUE_2_ETH }) },
        ],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect("l1_fee_eth" in out).toBe(false);
  });

  it("A4: value hex with leading zeros equals the same value numerically → confirmed, no false 502", async () => {
    installStub(
      tableBehavior([
        [
          CONFIRMED_LEG,
          { tx: stubTx({ value: "0x0de0b6b3a7640000" }), receipt: stubReceipt() },
          CONFIRMED_LEG,
        ],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.value_eth).toBe(1);
  });

  it("A5: intra-leg tx blockNumber != receipt blockNumber on all legs → 502, never confirmed", async () => {
    installStub(() => ({
      tx: stubTx({ blockNumber: "0x193a989" }),
      receipt: stubReceipt({ blockNumber: "0x193a98a" }),
    }));
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  it("A5b: 2 healthy legs + 1 intra-leg block-mismatched leg → confirmed (mismatched leg dropped)", async () => {
    installStub(
      tableBehavior([
        [
          CONFIRMED_LEG,
          CONFIRMED_LEG,
          {
            tx: stubTx({ blockNumber: "0x193a989" }),
            receipt: stubReceipt({ blockNumber: "0x193a98a" }),
          },
        ],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.block_number).toBe(26454409);
  });
});

describe("handleTx stubbed R4: BLOCKER B — re-poll throws mark the leg errored", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("B-repoll-receipt-only: null leg returns a receipt (M5) on re-poll → 502, never 200 not_found", async () => {
    // The round-0 errored leg RECOVERS as a clean null on re-poll, so the
    // re-polled receipt-only leg is the ONLY thing standing between a 502
    // and a 200 not_found: if its re-poll throw were swallowed as a null
    // vote (the round-3 bug), errored would be [] and the answer would be
    // 200 not_found despite a leg returning a receipt.
    installStub(
      tableBehavior([
        [{ tx: null, receipt: null, throwError: "transient" }, NULL_LEG, NULL_LEG],
        [NULL_LEG, { tx: null, receipt: stubReceipt() }, NULL_LEG],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  it("B-repoll-mismatch: null leg returns a mismatched-hash tx (F4) on re-poll → 502, never 200 not_found", async () => {
    const wrongHash = "0x" + "b".repeat(64);
    installStub(
      tableBehavior([
        [{ tx: null, receipt: null, throwError: "transient" }, NULL_LEG, NULL_LEG],
        [
          NULL_LEG,
          { tx: stubTx({ hash: wrongHash }), receipt: stubReceipt({ transactionHash: wrongHash }) },
          NULL_LEG,
        ],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  it("B-repoll-network: null leg throws a network error on re-poll → 502, never 200 not_found", async () => {
    installStub(
      tableBehavior([
        [{ tx: null, receipt: null, throwError: "transient" }, NULL_LEG, NULL_LEG],
        [NULL_LEG, { tx: null, receipt: null, throwError: "down again" }, NULL_LEG],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  });
});

describe("handleTx stubbed R4: MINOR 1 — malformed hex drops the leg, never throws", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("M1-hex-value: all legs value 0xZZZ → 502 ApiError, never a raw SyntaxError", async () => {
    installStub(() => ({
      tx: stubTx({ value: "0xZZZ" }),
      receipt: stubReceipt(),
    }));
    let caught: unknown;
    try {
      await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).not.toBeInstanceOf(SyntaxError);
    expect((caught as ApiError).status).toBe(502);
  });

  it("M1-hex-l1Fee: all legs l1Fee 0xZZZ on base → 502 ApiError, never a raw SyntaxError", async () => {
    installStub(() => ({
      tx: stubTx(),
      receipt: stubReceipt({ l1Fee: "0xZZZ" }),
    }));
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "base" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  it("M1-decimal-value: all legs value decimal 123 (no 0x) → 502, never accepted as 123 wei", async () => {
    installStub(() => ({
      tx: stubTx({ value: "123" }),
      receipt: stubReceipt(),
    }));
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  it("M1-hex-block: all legs blockNumber 0xZZZ → 502, never a raw error", async () => {
    installStub(() => ({
      tx: stubTx({ blockNumber: "0xZZZ" }),
      receipt: stubReceipt({ blockNumber: "0xZZZ" }),
    }));
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  it("M1-mixed: 2 healthy legs + 1 malformed-value leg → confirmed (malformed leg dropped, pair wins)", async () => {
    installStub(
      tableBehavior([
        [
          CONFIRMED_LEG,
          CONFIRMED_LEG,
          { tx: stubTx({ value: "0xZZZ" }), receipt: stubReceipt() },
        ],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.value_eth).toBe(1);
  });

  it("M1-weiToEth: weiToEth rejects 0xZZZ and decimal 123 with a plain Error, never SyntaxError", () => {
    for (const bad of ["0xZZZ", "123", "0x", ""]) {
      let caught: unknown;
      try {
        weiToEth(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(SyntaxError);
      expect((caught as Error).message).toContain("malformed");
    }
  });
});

describe("handleTx stubbed R4: MINOR 2 — re-poll from <2 successes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("M2-recover: 1 confirmed + 2 transient-error legs, one recovers confirmed on re-poll → confirmed", async () => {
    installStub(
      tableBehavior([
        [
          CONFIRMED_LEG,
          { tx: null, receipt: null, throwError: "transient" },
          { tx: null, receipt: null, throwError: "transient" },
        ],
        [
          CONFIRMED_LEG,
          CONFIRMED_LEG,
          { tx: null, receipt: null, throwError: "still down" },
        ],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.value_eth).toBe(1);
    const rc = out.receipt as Record<string, unknown>;
    expect(rc.quorum_votes).toBe("2/3 sources agreed");
  });

  it("M2-still-down: 1 confirmed + 2 errored legs, both stay down on re-poll → 502 QUORUM_UNREACHABLE", async () => {
    const { requests } = installStub(
      tableBehavior([
        [
          CONFIRMED_LEG,
          { tx: null, receipt: null, throwError: "down" },
          { tx: null, receipt: null, throwError: "down" },
        ],
        [
          CONFIRMED_LEG,
          { tx: null, receipt: null, throwError: "down" },
          { tx: null, receipt: null, throwError: "down" },
        ],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
    // Round 0 (2 healthy + 1 + 1: each down leg costs 1 fetch, A2-fix)
    // + re-poll of the 2 errored legs (2) = 6.
    expect(requests.length).toBe(6);
  });
});

describe("handleTx stubbed R4: MINOR 3 — pending/confirmed split gets a re-poll", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("M3-confirm: 2 pending + 1 confirmed, re-poll confirms a second leg → confirmed", async () => {
    installStub(
      tableBehavior([
        [PENDING_LEG, PENDING_LEG, CONFIRMED_LEG],
        [CONFIRMED_LEG, PENDING_LEG, CONFIRMED_LEG],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.block_number).toBe(26454409);
    expect(out.value_eth).toBe(1);
    const rc = out.receipt as Record<string, unknown>;
    expect(rc.quorum_votes).toBe("2/3 sources agreed");
  });

  it("M3-still-split: 2 pending + 1 confirmed, re-poll still split → pending pair wins as pending (0.9) [PINNED RULE]", async () => {
    const { requests } = installStub(
      tableBehavior([
        [PENDING_LEG, PENDING_LEG, CONFIRMED_LEG],
        [PENDING_LEG, PENDING_LEG, CONFIRMED_LEG],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("pending");
    expect(out.verdict).toBe("pending");
    expect(out.confidence).toBe(0.9);
    expect(out.block_number).toBeNull();
    expect(out.value_eth).toBe(1);
    // The re-poll happened: round 0 (6) + re-poll of the 2 pending legs (4) = 10.
    expect(requests.length).toBe(10);
  });

  it("M3-no-pair: 1 confirmed + 1 pending + 1 null, re-poll still split → 502 QUORUM_DISAGREEMENT", async () => {
    installStub(
      tableBehavior([
        [CONFIRMED_LEG, PENDING_LEG, NULL_LEG],
        [CONFIRMED_LEG, PENDING_LEG, NULL_LEG],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_DISAGREEMENT",
    );
  });

  it("M3-confirmed-pair-first: 2 confirmed + 1 pending, re-poll confirms the pending leg → confirmed 3/3", async () => {
    installStub(
      tableBehavior([
        [CONFIRMED_LEG, CONFIRMED_LEG, PENDING_LEG],
        [CONFIRMED_LEG, CONFIRMED_LEG, CONFIRMED_LEG],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    const rc = out.receipt as Record<string, unknown>;
    expect(rc.quorum_votes).toBe("3/3 sources agreed");
  });
});

describe("handleTx stubbed R4: MINOR 5 + MINOR 6 + MINOR 8", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("M5-status-0x2: all legs status 0x2 → 502, never reported as reverted", async () => {
    installStub(() => ({
      tx: stubTx(),
      receipt: stubReceipt({ status: "0x2" }),
    }));
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  it("M5-status-0x2-mixed: 2 healthy confirmed + 1 status-0x2 leg → confirmed (bad leg dropped)", async () => {
    installStub(
      tableBehavior([
        [
          CONFIRMED_LEG,
          CONFIRMED_LEG,
          { tx: stubTx(), receipt: stubReceipt({ status: "0x2" }) },
        ],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.value_eth).toBe(1);
  });

  it("M6: 2 non-empty polygon legs disagree on block (no null, no errored) → 502 QUORUM_DISAGREEMENT, not QUORUM_UNREACHABLE", async () => {
    installStub(
      tableBehavior(
        [
          [
            CONFIRMED_LEG,
            {
              tx: stubTx({ blockNumber: "0x193a98a" }),
              receipt: stubReceipt({ blockNumber: "0x193a98a" }),
            },
          ],
        ],
        "polygon",
      ),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "polygon" }),
      502,
      "QUORUM_DISAGREEMENT",
    );
  });

  it("B1(iii): transient-error leg recovers as NULL, all-null survivors → 200 not_found (zero errors after re-poll)", async () => {
    installStub(
      tableBehavior([
        [{ tx: null, receipt: null, throwError: "transient" }, NULL_LEG, NULL_LEG],
        [NULL_LEG, NULL_LEG, NULL_LEG],
      ]),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("not_found");
    expect(out.verdict).toBe("not_found");
    expect(out.confidence).toBe(1.0);
    expect(out.value_eth).toBeNull();
  });

  it("B1(ii)-second-guard: slow tx-bearing leg (20 s) + 2 nulls, slow leg times out on re-poll too → 502 QUORUM_UNREACHABLE", async () => {
    // A2-fix re-pin: the per-call budget is 12 s, so the slow delay must
    // exceed 12 s per call to time out on both rounds (was 6 s vs the
    // old 4.5 s per-leg budget). Wall is ~2 × 12 s (one aborted call per
    // round; the receipt call never starts) — hence the 60 s timeout.
    installStub(
      tableBehavior([
        [
          { tx: stubTx(), receipt: stubReceipt(), delayMs: 20000 },
          NULL_LEG,
          NULL_LEG,
        ],
        [
          { tx: stubTx(), receipt: stubReceipt(), delayMs: 20000 },
          NULL_LEG,
          NULL_LEG,
        ],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  }, 60000);

  it("M5-second-guard: receipt-only leg + 2 nulls, receipt-only persists on re-poll → 502 QUORUM_UNREACHABLE", async () => {
    installStub(
      tableBehavior([
        [{ tx: null, receipt: stubReceipt() }, NULL_LEG, NULL_LEG],
        [{ tx: null, receipt: stubReceipt() }, NULL_LEG, NULL_LEG],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  });
});

describe("handleTx stubbed R5: receipt.to null + receipt from/to + pending blockNumber", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("R5-F1: contract creation — all legs tx.to=null + receipt.to=null → 200 confirmed with to: null", async () => {
    // Real RPCs return `to: null` on receipts for contract creations
    // (with `contractAddress` instead). Before the fix parseReceipt
    // rejected a null receipt `to` as malformed, so every leg errored
    // and the lookup always 502d. No `contractAddress` field is added:
    // the handler never surfaced one.
    installStub(() => ({
      tx: stubTx({ to: null }),
      receipt: stubReceipt({ to: null }),
    }));
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.verdict).toBe("verified");
    expect(out.confidence).toBe(1.0);
    expect(out.to).toBeNull();
    expect(out.from).toBe(STUB_FROM);
    expect(out.block_number).toBe(26454409);
    expect(out.value_eth).toBe(1);
    const rc = out.receipt as Record<string, unknown>;
    expect(rc.quorum_votes).toBe("3/3 sources agreed");
  });

  it("R5-F2: disagreeing receipt `to` values (all tx.to null) → 502 QUORUM_DISAGREEMENT, never 200 with 3/3 agreed", async () => {
    // J2 repro: tx.to is null on every leg, but the receipts disagree on
    // `to` — and the answer's `to` falls back to the receipt
    // (`tx?.to ?? receipt?.to`). Before the fix receipt `to` was never
    // compared, so this answered 200 confirmed with first-leg-wins `to`
    // and votes 3/3 sources agreed.
    installStub(
      tableBehavior([
        [
          { tx: stubTx({ to: null }), receipt: stubReceipt({ to: "0x0000000aa232009084bd71a5797d089aa4edfad4" }) },
          { tx: stubTx({ to: null }), receipt: stubReceipt({ to: "0x1111111111111111111111111111111111111111" }) },
          { tx: stubTx({ to: null }), receipt: stubReceipt({ to: "0x3333333333333333333333333333333333333333" }) },
        ],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_DISAGREEMENT",
    );
  });

  it("R5-F2b: disagreeing receipt `from` values → 502 QUORUM_DISAGREEMENT", async () => {
    installStub(
      tableBehavior([
        [
          { tx: stubTx(), receipt: stubReceipt({ from: STUB_FROM }) },
          { tx: stubTx(), receipt: stubReceipt({ from: "0x1111111111111111111111111111111111111111" }) },
          { tx: stubTx(), receipt: stubReceipt({ from: "0x3333333333333333333333333333333333333333" }) },
        ],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_DISAGREEMENT",
    );
  });

  it("R5-F3: 2-leg pending on polygon, tx.blockNumber differs (0x193a989 vs null), everything else agrees → pending 0.9, not 502", async () => {
    // block_number is forced null in the answer for pending, so a
    // blockNumber difference between two pending legs is not a
    // disagreement. Before the fix this 502d QUORUM_DISAGREEMENT.
    installStub(
      tableBehavior(
        [
          [
            { tx: stubTx({ blockNumber: "0x193a989" }), receipt: null },
            { tx: stubTx({ blockNumber: null }), receipt: null },
          ],
        ],
        "polygon",
      ),
    );
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "polygon" });
    expect(out.status).toBe("pending");
    expect(out.verdict).toBe("pending");
    expect(out.confidence).toBe(0.9);
    expect(out.block_number).toBeNull();
    expect(out.value_eth).toBe(1);
    const rc = out.receipt as Record<string, unknown>;
    expect(rc.quorum_votes).toBe("2/2 sources agreed");
  });

  it("R5-F3-guard: confirmed legs still 502 when tx blockNumbers all disagree (pending normalization must not leak)", async () => {
    installStub(
      tableBehavior([
        [
          { tx: stubTx({ blockNumber: "0x193a989" }), receipt: stubReceipt({ blockNumber: "0x193a989" }) },
          { tx: stubTx({ blockNumber: "0x193a98a" }), receipt: stubReceipt({ blockNumber: "0x193a98a" }) },
          { tx: stubTx({ blockNumber: "0x193a98b" }), receipt: stubReceipt({ blockNumber: "0x193a98b" }) },
        ],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_DISAGREEMENT",
    );
  });
});

// ---------------------------------------------------------------------------
// A2 (PLAN.md §6 A2, 2026-11-20). Chain synonyms, "… on Ethereum" split
// from tx_hash, status-less pre-Byzantium receipts, and the reference tx.
// ---------------------------------------------------------------------------

describe("normalizeChain (unit, A2)", () => {
  it("maps every Ethereum spelling to ethereum", () => {
    for (const raw of ["ethereum", "Ethereum", "ETHEREUM", "ETH", "eth", "mainnet", "Mainnet", "1", "eip155:1", "EIP155:1", "Ethereum Mainnet", "eth mainnet", "on Ethereum", "on eth", "  ethereum  "]) {
      expect(normalizeChain(raw)).toBe("ethereum");
    }
  });

  it("passes other canonical chains through unchanged", () => {
    for (const raw of ["base", "arbitrum", "optimism", "polygon", "sepolia", "base-sepolia", "BASE-SEPOLIA"]) {
      expect(normalizeChain(raw)).toBe(raw.trim().toLowerCase());
    }
  });

  it("leaves unknown chains unchanged (still rejected downstream) and undefined as undefined", () => {
    expect(normalizeChain("solana")).toBe("solana");
    expect(normalizeChain("etherium")).toBe("etherium");
    expect(normalizeChain("main net")).toBe("main net");
    expect(normalizeChain(undefined)).toBeUndefined();
  });
});

describe("handleTx stubbed A2: chain synonyms + 'on <chain>' split", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("chain '1' and 'eip155:1' route to the ethereum quorum and confirm", async () => {
    installStub(() => CONFIRMED_LEG);
    for (const chain of ["1", "eip155:1"]) {
      const out = await handleTx({ tx_hash: CONFIRMED_TX, chain });
      expect(out.status).toBe("confirmed");
      expect(out.block_number).toBe(26454409);
      expect(out.source).toBe(`Archive RPC quorum (ethereum, 2-of-${CHAIN_RPCS.ethereum.length})`);
    }
  });

  it("tx_hash '… on Ethereum' with NO chain param splits the chain off and confirms", async () => {
    installStub(() => CONFIRMED_LEG);
    const out = await handleTx({ tx_hash: `${CONFIRMED_TX} on Ethereum` });
    expect(out.status).toBe("confirmed");
    expect(out.block_number).toBe(26454409);
    expect(out.tx_hash).toBe(CONFIRMED_TX);
    expect(out.source).toBe(`Archive RPC quorum (ethereum, 2-of-${CHAIN_RPCS.ethereum.length})`);
  });

  it("tx_hash '… on ETH' with NO chain param splits 'ETH' off as ethereum", async () => {
    installStub(() => CONFIRMED_LEG);
    const out = await handleTx({ tx_hash: `${CONFIRMED_TX} on ETH` });
    expect(out.status).toBe("confirmed");
    expect(out.block_number).toBe(26454409);
  });

  it("tx_hash '… on Ethereum' WITH an explicit chain param still confirms (suffix stripped)", async () => {
    installStub(() => CONFIRMED_LEG);
    const out = await handleTx({ tx_hash: `${CONFIRMED_TX} on Ethereum`, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.tx_hash).toBe(CONFIRMED_TX);
  });

  it("tx_hash '… on Solana' with NO chain param → 400 UNSUPPORTED_CHAIN, never a fetch", async () => {
    const { requests } = installStub(() => CONFIRMED_LEG);
    await expectApiError(
      handleTx({ tx_hash: `${CONFIRMED_TX} on Solana` }),
      400,
      "UNSUPPORTED_CHAIN",
    );
    expect(requests.length).toBe(0);
  });

  it("tx_hash '… on Solana' WITH chain=ethereum → 400 CHAIN_MISMATCH, never a fetch (A2-fix F3)", async () => {
    // A contradictory input must fail loudly, not silently prefer the
    // explicit param: the suffix names Solana, the param names ethereum.
    const { requests } = installStub(() => CONFIRMED_LEG);
    await expectApiError(
      handleTx({ tx_hash: `${CONFIRMED_TX} on Solana`, chain: "ethereum" }),
      400,
      "CHAIN_MISMATCH",
    );
    expect(requests.length).toBe(0);
  });

  it("tx_hash '… on ETH' WITH chain=mainnet agrees (both normalise to ethereum) → confirms (A2-fix F3)", async () => {
    installStub(() => CONFIRMED_LEG);
    const out = await handleTx({ tx_hash: `${CONFIRMED_TX} on ETH`, chain: "mainnet" });
    expect(out.status).toBe("confirmed");
    expect(out.block_number).toBe(26454409);
    expect(out.tx_hash).toBe(CONFIRMED_TX);
  });
});

describe("handleTx stubbed A2: status-less pre-Byzantium receipts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A raw pre-Byzantium receipt shape as returned by rpc.mevblocker.io
   * for the reference tx: no `status` field, `root` present. Verified
   * live 2026-11-20 (A2 probe): root 0x96a8e009d2b88b14… Other endpoints
   * return status 0x1 for the SAME tx (Cloudflare, drpc, BlastAPI —
   * verification 2026-11-20 rows 20–21), so the missing status is
   * endpoint-dependent, not a universal property of the receipt. */
  const STATUSLESS_LEG: StubLeg = {
    tx: stubTx(),
    receipt: {
      blockNumber: "0x193a989",
      from: STUB_FROM,
      to: STUB_TO,
      transactionHash: CONFIRMED_TX,
      root: "0x96a8e009d2b88b1483e6941e6812e32263b05683fac202abc622a1b2c3d4e5f6",
    },
  };

  it("receiptStatusNumber: status-less (root present) is 1; 0x0/0x1 pass through", () => {
    expect(receiptStatusNumber({ blockNumber: "0x1", from: STUB_FROM, to: STUB_TO, root: "0x96a8e009d2b88b1483e6941e6812e32263b05683fac202abc622a1b2c3d4e5f6" })).toBe(1);
    expect(receiptStatusNumber({ status: "0x1", blockNumber: "0x1", from: STUB_FROM, to: STUB_TO })).toBe(1);
    expect(receiptStatusNumber({ status: "0x0", blockNumber: "0x1", from: STUB_FROM, to: STUB_TO })).toBe(0);
  });

  it("all legs status-less (root present) → confirmed, never a crash or 502", async () => {
    installStub(() => STATUSLESS_LEG);
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.verdict).toBe("verified");
    expect(out.confidence).toBe(1.0);
    expect(out.block_number).toBe(26454409);
    expect(out.value_eth).toBe(1);
    const rc = out.receipt as Record<string, unknown>;
    expect(rc.quorum_votes).toBe("3/3 sources agreed");
  });

  it("mixed legs: status-less + status 0x1 + status 0x1 agree (effective status 1) → confirmed 3/3", async () => {
    // This is the LIVE shape for the reference tx: mevblocker returns the
    // raw receipt shape without a status field while drpc/BlastAPI
    // return status 0x1 (and Cloudflare likewise — verification rows
    // 20–21). Before the fix the status-less leg errored (missing
    // status) and the quorum could not form.
    installStub(tableBehavior([[STATUSLESS_LEG, CONFIRMED_LEG, CONFIRMED_LEG]]));
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    const rc = out.receipt as Record<string, unknown>;
    expect(rc.quorum_votes).toBe("3/3 sources agreed");
  });

  it("status-less vs reverted (0x0) with no pair → 502 QUORUM_DISAGREEMENT", async () => {
    installStub(
      tableBehavior([
        [STATUSLESS_LEG, { tx: stubTx(), receipt: stubReceipt({ status: "0x0" }) }, NULL_LEG],
        [STATUSLESS_LEG, { tx: stubTx(), receipt: stubReceipt({ status: "0x0" }) }, NULL_LEG],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_DISAGREEMENT",
    );
  });

  it("receipt with NEITHER status NOR root on all legs → 502, never confirmed", async () => {
    installStub(() => ({
      tx: stubTx(),
      receipt: {
        blockNumber: "0x193a989",
        from: STUB_FROM,
        to: STUB_TO,
        transactionHash: CONFIRMED_TX,
      },
    }));
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  it("receipt with a malformed (non-hex) root and no status → 502", async () => {
    installStub(() => ({
      tx: stubTx(),
      receipt: {
        blockNumber: "0x193a989",
        from: STUB_FROM,
        to: STUB_TO,
        transactionHash: CONFIRMED_TX,
        root: "not-a-root",
      },
    }));
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_UNREACHABLE",
    );
  });

  it("two status-less legs differing ONLY in root → 502 QUORUM_DISAGREEMENT, never agreement (A2-fix F2)", async () => {
    // The state root is the one field that distinguishes two raw-shape
    // receipts: same block/value/from/to and the same effective status
    // (1) on both sides, but different roots must NOT agree 3/3. The
    // third leg is null, so after the re-poll the vote is still 1-vs-1
    // with no agreeing pair.
    const rootA = "0x96a8e009d2b88b1483e6941e6812e32263b05683fac202abc622a1b2c3d4e5f6";
    const rootB = "0xffa8e009d2b88b1483e6941e6812e32263b05683fac202abc622a1b2c3d4e5f6";
    const rawLeg = (root: string): StubLeg => ({
      tx: stubTx(),
      receipt: {
        blockNumber: "0x193a989",
        from: STUB_FROM,
        to: STUB_TO,
        transactionHash: CONFIRMED_TX,
        root,
      },
    });
    installStub(
      tableBehavior([
        [rawLeg(rootA), rawLeg(rootB), NULL_LEG],
        [rawLeg(rootA), rawLeg(rootB), NULL_LEG],
      ]),
    );
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" }),
      502,
      "QUORUM_DISAGREEMENT",
    );
  });
});

// Reference tx (PLAN.md §2, S5_scoring_references.md:15,26; corrected by
// verification-2026-11-20.md rows 20–21): the evalpool reference question
// is tx `0x5c504ed4…2060 on Ethereum` → block 46147 (2015, Ethereum's
// first-ever user transfer, pre-Byzantium). NOTE on the receipt shape:
// whether the receipt carries a `status` field is ENDPOINT-DEPENDENT —
// Cloudflare / drpc / BlastAPI return status (0x1) for this tx, while
// mevblocker returns the raw shape with `root` and no `status`. Neither
// shape is universal; the handler accepts both. Full hash + expected
// fields verified live by A2 2026-11-20 against all three configured
// ethereum legs (BlastAPI, drpc, mevblocker): blockNumber 0xb443, from
// 0xa1e4380a3b1f749673e270229993ee55f35663b4, to
// 0x5df9b87991262f6ba471f09758cde1c0fc1de734, value 0x7a69 wei.
const REFERENCE_TX = "0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060";

describe("handleTx live A2: reference tx returns block 46147", () => {
  it(
    "reference tx on ethereum returns confirmed block 46147 with exact fields",
    async () => {
      const out = await handleTx({ tx_hash: REFERENCE_TX, chain: "ethereum" });
      expect(out.tx_hash).toBe(REFERENCE_TX);
      expect(out.status).toBe("confirmed");
      expect(out.from).toBe("0xa1e4380a3b1f749673e270229993ee55f35663b4");
      expect(out.to).toBe("0x5df9b87991262f6ba471f09758cde1c0fc1de734");
      expect(out.block_number).toBe(46147);
      expect(out.value_eth).toBe(weiToEth("0x7a69"));
      expect(out.verdict).toBe("verified");
      expect(out.confidence).toBe(1.0);
      expect(out.source).toBe("Archive RPC quorum (ethereum, 2-of-3)");
      const rc = out.receipt as Record<string, unknown>;
      expect(rc.raw_response_sha256).toMatch(SHA256_RE);
      expect(rc.quorum_votes).toBe("3/3 sources agreed");
    },
    60000,
  );

  it(
    "reference tx under every chain synonym returns block 46147",
    async () => {
      for (const chain of ["ETH", "mainnet", "1", "eip155:1", "Ethereum"]) {
        const out = await handleTx({ tx_hash: REFERENCE_TX, chain });
        expect(out.status).toBe("confirmed");
        expect(out.block_number).toBe(46147);
        expect(out.source).toBe("Archive RPC quorum (ethereum, 2-of-3)");
      }
    },
    120000,
  );

  it(
    "reference tx as '… on Ethereum' with no chain param returns block 46147",
    async () => {
      const out = await handleTx({ tx_hash: `${REFERENCE_TX} on Ethereum` });
      expect(out.status).toBe("confirmed");
      expect(out.block_number).toBe(46147);
      expect(out.tx_hash).toBe(REFERENCE_TX);
    },
    60000,
  );
});

describe("handleTx winning-leg enrichment (stubbed, no network)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("confirmed: exact fee/gas/block-hash/value fields and full-decimal prose from receipt evidence", async () => {
    installStub(() => ({
      tx: stubTx({
        value: "0x7a69", // 31337 wei
        gasPrice: "0xb2d05e00", // 3 gwei (legacy field; effectiveGasPrice wins below)
        input: "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000001",
      }),
      receipt: stubReceipt({
        gasUsed: "0x5208", // 21000
        effectiveGasPrice: "0xb2d05e00", // 3 gwei
        blockHash: "0x" + "ab".repeat(32),
      }),
    }));
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out.receipt_status).toBe("success");
    // The scored contract field keeps its documented display precision;
    // the exact wei string carries the full value.
    expect(out.value_eth).toBe(3.1337e-14);
    expect(out.value_wei).toBe("31337");
    expect(out.gas_used).toBe(21000);
    expect(out.gas_price_wei).toBe("3000000000");
    expect(out.fee_wei).toBe("63000000000000"); // 21000 * 3 gwei
    expect(out.block_hash).toBe("0x" + "ab".repeat(32));
    expect(out.method_selector).toBe("0xa9059cbb");
    const ans = String(out.answer);
    expect(ans).toContain("is confirmed in block 26454409");
    expect(ans).toContain(`sent from ${STUB_FROM} to ${STUB_TO}`);
    expect(ans).toContain("carried 0.000000000000031337 ETH"); // exact, never 3.1337e-14
    expect(ans).toContain("fee was 0.000063 ETH (21000 gas at 3 gwei)");
    expect(ans).not.toContain("e-14");
  });

  it("legacy receipt without effectiveGasPrice: fee derives from tx.gasPrice", async () => {
    installStub(() => ({
      tx: stubTx({ gasPrice: "0xba43b7400" }), // 50 gwei
      receipt: stubReceipt({ gasUsed: "0x5208" }),
    }));
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.gas_price_wei).toBe("50000000000");
    expect(out.fee_wei).toBe("1050000000000000"); // 21000 * 50 gwei
    expect(String(out.answer)).toContain("fee was 0.00105 ETH (21000 gas at 50 gwei)");
  });

  it("reverted: receipt_status reverted, prose keeps the transfer and fee detail", async () => {
    installStub(() => ({
      tx: stubTx({ hash: REVERTED_TX, blockNumber: "0x193a98b" }),
      receipt: stubReceipt({
        status: "0x0",
        blockNumber: "0x193a98b",
        transactionHash: REVERTED_TX,
        gasUsed: "0x5208",
        effectiveGasPrice: "0xb2d05e00",
      }),
    }));
    const out = await handleTx({ tx_hash: REVERTED_TX, chain: "ethereum" });
    expect(out.status).toBe("reverted");
    expect(out.receipt_status).toBe("reverted");
    const ans = String(out.answer);
    expect(ans).toContain("was reverted in block 26454411");
    expect(ans).toContain("carried 1 ETH");
    expect(ans).toContain("fee was 0.000063 ETH");
  });

  it("pending: value and method from the tx, no receipt-only fields, present-tense prose", async () => {
    installStub(() => ({
      tx: stubTx({
        blockNumber: "0x193a989",
        input: "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000001",
      }),
      receipt: null,
    }));
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("pending");
    expect(out.value_wei).toBe("1000000000000000000");
    expect(out.method_selector).toBe("0xa9059cbb");
    expect(out).not.toHaveProperty("receipt_status");
    expect(out).not.toHaveProperty("gas_used");
    expect(out).not.toHaveProperty("fee_wei");
    expect(String(out.answer)).toContain("carries 1 ETH");
  });

  it("not_found: no enrichment fields", async () => {
    installStub(() => NULL_LEG);
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("not_found");
    expect(out).not.toHaveProperty("value_wei");
    expect(out).not.toHaveProperty("receipt_status");
  });

  it("malformed optional fields are omitted, never a verdict change", async () => {
    installStub(() => ({
      tx: stubTx({ input: "0xzz" }),
      receipt: stubReceipt({ gasUsed: "not-hex", effectiveGasPrice: "0xzz", blockHash: "0xshort" }),
    }));
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
    expect(out.status).toBe("confirmed");
    expect(out).not.toHaveProperty("gas_used");
    expect(out).not.toHaveProperty("fee_wei");
    expect(out).not.toHaveProperty("gas_price_wei");
    expect(out).not.toHaveProperty("block_hash");
    expect(out).not.toHaveProperty("method_selector");
    expect(String(out.answer)).not.toContain("fee was");
  });

  it("OP-stack l1Fee: prose names the L1 data fee with an exact decimal", async () => {
    installStub(() => ({
      tx: stubTx(),
      receipt: stubReceipt({
        l1Fee: "0x7a69", // 31337 wei
        gasUsed: "0x5208",
        effectiveGasPrice: "0xb2d05e00",
      }),
    }));
    const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "base" });
    expect(out.l1_fee_eth).toBe(3.1337e-14);
    expect(String(out.answer)).toContain("The L1 data fee was 0.000000000000031337 ETH.");
  });
});
