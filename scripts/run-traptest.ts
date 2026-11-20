// TrapTest runner — the frozen 12 traps, run against the REAL server over
// REAL HTTP. No mocks, no stubs, no weakened cases.
//
// SOURCE OF TRUTH (followed verbatim):
//   https://github.com/OlsOls4/traptest
//   - traps-frozen-2026-11-06.json (frozen 2026-11-06T13:59:42Z, intent
//     ONCHAIN_TX_LOOKUP_GENERAL, chain base-sepolia; sha256
//     0f84494bc8a6b1773aa74f2f9e3c15b6e7eb42b397c8849bbea3068bd4a1d534
//     per results-live/results-corrected-2026-11-08.json)
//   - results-live/results-corrected-2026-11-08.json (corrected re-score
//     methodology: the shared normaliser maps value_eth (ETH) -> value
//     (wei) and block_number -> block; status/from/to/block/value must all
//     match for a trap to pass)
//
// DIFFERENCE vs the brief's case description (repo wins, per instructions):
// the frozen 12 are ALL on-chain tx lookups on base-sepolia — 2 plain, 2
// token, 2 contract-interaction, 2 reverted, 2 multi-recipient, 2 unknown.
// The repo contains NO wrong-chain, pending-tx, OP-stack-L1-fee, #207/#208/
// #209/#211, future-interval, or invalid-input case in the frozen 12, so
// none is encoded here. Those patterns are not in the source of truth.
//
// SCORING NOTES (auditable, not weakened):
// - status: the handler's `status` field (confirmed/reverted/not_found);
//   `verdict` is only a fallback (it reads "verified" for confirmed txs).
// - value: `value_eth` converted to wei with exact decimal math
//   (mirrors traptest/normalise.py, incl. scientific notation).
// - t03/t04 (token transfers): the frozen file's expected_value is the
//   Transfer-EVENT amount (950000 / 2000000000000000000), which no
//   tx-lookup provider returns in value_eth — the corrected-results file
//   says so explicitly. The true tx value for both is 0 wei (verified
//   live against the Base Sepolia public RPC while writing this script),
//   so those two cases require value_eth == 0 and score status/from/to/
//   block normally. The event amount itself is not scored as value_eth.
// - not_found (t11/t12): HTTP 200 with status "not_found" OR HTTP 404
//   both count as a not-found answer; any invented from/to/block, or a
//   non-zero value, on a not-found answer FAILS the case.
// - Every 200 answer must also carry receipt.raw_response_sha256
//   (64 lowercase hex) — the miner's own contract.
//
// Run: npx tsx scripts/run-traptest.ts   (from the repo root)
// Exit code 0 only on 12/12.

import { buildServer } from "../src/server";

// TEST-ONLY default: lets this local test run start the server without a
// real contact string. NEVER a production value; production must set a
// real SEC_USER_AGENT in the environment (the server refuses to start
// without one when run directly).
process.env.SEC_USER_AGENT ??= "TrapTest/1.0 (test@example.local)";

const PORT = 18123;
const BASE = `http://127.0.0.1:${PORT}`;
const CHAIN = "base-sepolia";
const REQUEST_TIMEOUT_MS = 30_000;

interface TrapCase {
  id: string;
  category: string;
  txHash: string;
  expectedStatus: "confirmed" | "reverted" | "not_found";
  expectedFrom: string | null;
  expectedTo: string | null;
  /** Expected tx value in wei, or null when the trap does not score value. */
  expectedValueWei: string | null;
  /** "tx" = expectedValueWei is the tx value; "transfer-event" = it is the Transfer-event amount (see header). */
  valueBasis: "tx" | "transfer-event";
  expectedBlock: number | null;
}

// The 12 frozen traps, copied verbatim from traps-frozen-2026-11-06.json.
const TRAPS: TrapCase[] = [
  {
    id: "t01-plain-transfer", category: "plain_transfer",
    txHash: "0xd47a090fee50ae43d3af7dcb03eced0be6c98a48b3aa92dc21a8c4d9d784ae96",
    expectedStatus: "confirmed", expectedFrom: "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001",
    expectedTo: "0x4200000000000000000000000000000000000015",
    expectedValueWei: "0", valueBasis: "tx", expectedBlock: 53047427,
  },
  {
    id: "t02-plain-transfer", category: "plain_transfer",
    txHash: "0x2d70ca963eb8763d4704572c62e36a8418d7559e54683ef31c1589d955343687",
    expectedStatus: "confirmed", expectedFrom: "0xb0b8b0e6b5f3e9ecc8a4f1390af2be37dc418ad7",
    expectedTo: "0xb0b8b0e6b5f3e9ecc8a4f1390af2be37dc418ad7",
    expectedValueWei: "1000000000000000", valueBasis: "tx", expectedBlock: 55258439,
  },
  {
    id: "t03-token-transfer", category: "token_transfer",
    txHash: "0x0113bafdf54755989384d25240447e2071e4888da16686d180cc4eacc846b9af",
    expectedStatus: "confirmed", expectedFrom: "0x0af9df1a49fdbf9215dd787a7c17b1eb11a50bd5",
    expectedTo: "0x2736548295851c2181a0a1cdef707b2dd614d047",
    expectedValueWei: "950000", valueBasis: "transfer-event", expectedBlock: 53047427,
  },
  {
    id: "t04-token-transfer", category: "token_transfer",
    txHash: "0x1a0ecef6eb220b00aa875d81c94f8ec843f147ad390ba1b623faef4bd634ae54",
    expectedStatus: "confirmed", expectedFrom: "0x2735bd4edf19957a79deb609d72bf33e59849348",
    expectedTo: "0x82470e66e788867390d16f9ec4169b81915112d8",
    expectedValueWei: "2000000000000000000", valueBasis: "transfer-event", expectedBlock: 55258552,
  },
  {
    id: "t05-contract-interaction", category: "contract_interaction",
    txHash: "0xb65725814254a99ee494130e6f22898fb1bcfe3442e00b1d4fd23ba49774de21",
    expectedStatus: "confirmed", expectedFrom: "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001",
    expectedTo: "0x4200000000000000000000000000000000000015",
    expectedValueWei: null, valueBasis: "tx", expectedBlock: 55258576,
  },
  {
    id: "t06-contract-interaction", category: "contract_interaction",
    txHash: "0x48d8b3c208ee336f69d782e42d26c7d36d276e5a9e707a985ed5e759fcadf4f5",
    expectedStatus: "confirmed", expectedFrom: "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001",
    expectedTo: "0x4200000000000000000000000000000000000030",
    expectedValueWei: null, valueBasis: "tx", expectedBlock: 55258576,
  },
  {
    id: "t07-reverted-tx", category: "reverted_tx",
    txHash: "0x08f6d36438dd60ecfd262d44bbd236abd5538de1a836ed79f903813f038aca48",
    expectedStatus: "reverted", expectedFrom: "0xe49866891ab9b82873663912687c4ef8dc8b0d8f",
    expectedTo: "0x572bf0fc198f0482bf55a789ceddff4f3b61f76b",
    expectedValueWei: null, valueBasis: "tx", expectedBlock: 55258569,
  },
  {
    id: "t08-reverted-tx", category: "reverted_tx",
    txHash: "0xdba37af4b112aa49c61f9153981c57b345f1e24cbc4d0ce29011c5a4e120597b",
    expectedStatus: "reverted", expectedFrom: "0x40dd35389dcf63f45c6069edea658745ab2f6903",
    expectedTo: "0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4",
    expectedValueWei: "10000000000000", valueBasis: "tx", expectedBlock: 55258555,
  },
  {
    id: "t09-multi-recipient-tx", category: "multi_recipient_tx",
    txHash: "0xd06bb83d77449de011264f73066b537be70a272ee643132176442cf25de5d5dc",
    expectedStatus: "confirmed", expectedFrom: "0x0de59ee7b9007d6154a105375f4484058b934205",
    expectedTo: "0x84162e52063504a701cda5e931d2fd174c10648d",
    expectedValueWei: null, valueBasis: "tx", expectedBlock: 55258574,
  },
  {
    id: "t10-multi-recipient-tx", category: "multi_recipient_tx",
    txHash: "0x5bad2aa6ed070cafc628fe5010a3684ac7e3bcf3d2f3a6500709d5f8d49b84a5",
    expectedStatus: "confirmed", expectedFrom: "0x0decd19497beb916b48a63949ada19daac509604",
    expectedTo: "0x84162e52063504a701cda5e931d2fd174c10648d",
    expectedValueWei: null, valueBasis: "tx", expectedBlock: 55258573,
  },
  {
    id: "t11-unknown-tx", category: "unknown_tx",
    txHash: "0xd0b1cc353aa7e1ecbfa3a0ea5ff890d0042210a92720e2aaedcfcc586f9fb90d",
    expectedStatus: "not_found", expectedFrom: null, expectedTo: null,
    expectedValueWei: null, valueBasis: "tx", expectedBlock: null,
  },
  {
    id: "t12-unknown-tx", category: "unknown_tx",
    txHash: "0x6f57ebe49914984c73766affa5f1cd1d5ff5dbb2ec32923f3b3c0dd414013767",
    expectedStatus: "not_found", expectedFrom: null, expectedTo: null,
    expectedValueWei: null, valueBasis: "tx", expectedBlock: null,
  },
];

/**
 * Convert a value_eth amount (number or string, in whole ETH, possibly in
 * scientific notation, possibly a 0x hex wei quantity) to a decimal wei
 * string, using exact string math — never binary floats. Returns null when
 * the input is not a parseable number or is a fractional wei amount.
 * Mirrors traptest/normalise.py's value_eth -> value conversion.
 */
function ethToWei(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  if (/^0x/i.test(s)) {
    try {
      return BigInt(s).toString();
    } catch {
      return null;
    }
  }
  const m = /^([0-9]*\.?[0-9]*)([eE][+-]?[0-9]+)?$/.exec(s);
  if (!m || m[1] === "" || m[1] === ".") return null;
  const mantissa = m[1];
  const exp = m[2] ? parseInt(m[2].slice(1), 10) : 0;
  const [intPart, fracPart = ""] = mantissa.split(".");
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, "") || "0";
  const scale = 18 - fracPart.length + exp;
  if (scale >= 0) {
    return (digits + "0".repeat(scale)).replace(/^0+(?=\d)/, "") || "0";
  }
  // Negative scale: the amount is below 1 wei unless the dropped digits
  // are all zero.
  const cut = digits.length + scale;
  if (cut <= 0) return null;
  const kept = digits.slice(0, cut);
  const dropped = digits.slice(cut);
  if (/[^0]/.test(dropped)) return null;
  return kept.replace(/^0+(?=\d)/, "") || "0";
}

const KNOWN_STATUSES = new Set(["confirmed", "reverted", "pending", "not_found"]);

function isNonEmpty(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

interface CaseResult {
  id: string;
  passed: boolean;
  detail: string;
}

async function runCase(trap: TrapCase): Promise<CaseResult> {
  const url = `${BASE}/v1/tx?tx_hash=${trap.txHash}&chain=${CHAIN}`;
  const failures: string[] = [];
  const notes: string[] = [];
  let status: number;
  let body: Record<string, unknown> = {};
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    status = res.status;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
  } catch (err) {
    return { id: trap.id, passed: false, detail: `request failed: ${String(err)}` };
  }

  // --- not_found traps -------------------------------------------------
  if (trap.expectedStatus === "not_found") {
    if (status === 404) {
      return { id: trap.id, passed: true, detail: "HTTP 404 not-found answer, no invented fields" };
    }
    if (status !== 200) {
      return { id: trap.id, passed: false, detail: `expected 200 not_found or 404, got HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}` };
    }
    const rawStatus = typeof body.status === "string" ? body.status.toLowerCase() : "";
    const verdict = typeof body.verdict === "string" ? body.verdict.toLowerCase() : "";
    const actualStatus = KNOWN_STATUSES.has(rawStatus) ? rawStatus : verdict;
    if (actualStatus !== "not_found") {
      return { id: trap.id, passed: false, detail: `expected status not_found, got ${JSON.stringify(actualStatus)}` };
    }
    if (isNonEmpty(body.from)) failures.push(`invented from=${String(body.from)}`);
    if (isNonEmpty(body.to)) failures.push(`invented to=${String(body.to)}`);
    if (isNonEmpty(body.block_number) || isNonEmpty(body.block)) {
      failures.push(`invented block=${String(body.block_number ?? body.block)}`);
    }
    const wei = ethToWei(body.value_eth ?? body.value);
    if (wei !== null && wei !== "0") failures.push(`invented value=${wei} wei`);
    if (failures.length > 0) {
      return { id: trap.id, passed: false, detail: failures.join("; ") };
    }
    return { id: trap.id, passed: true, detail: "200 not_found, no invented fields" };
  }

  // --- confirmed / reverted traps --------------------------------------
  if (status !== 200) {
    return { id: trap.id, passed: false, detail: `expected HTTP 200, got ${status}: ${JSON.stringify(body).slice(0, 300)}` };
  }
  const rawStatus = typeof body.status === "string" ? body.status.toLowerCase() : "";
  const verdict = typeof body.verdict === "string" ? body.verdict.toLowerCase() : "";
  const actualStatus = KNOWN_STATUSES.has(rawStatus) ? rawStatus : verdict;
  if (actualStatus !== trap.expectedStatus) {
    failures.push(`status: expected ${trap.expectedStatus}, got ${JSON.stringify(actualStatus)}`);
  }
  if (trap.expectedFrom !== null) {
    const from = typeof body.from === "string" ? body.from.toLowerCase() : null;
    if (from !== trap.expectedFrom.toLowerCase()) {
      failures.push(`from: expected ${trap.expectedFrom}, got ${JSON.stringify(body.from)}`);
    }
  }
  if (trap.expectedTo !== null) {
    const to = typeof body.to === "string" ? body.to.toLowerCase() : null;
    if (to !== trap.expectedTo.toLowerCase()) {
      failures.push(`to: expected ${trap.expectedTo}, got ${JSON.stringify(body.to)}`);
    }
  }
  if (trap.expectedBlock !== null) {
    const blockRaw = body.block_number ?? body.block;
    const blockNum = typeof blockRaw === "number" ? blockRaw : parseInt(String(blockRaw ?? ""), 10);
    if (!Number.isFinite(blockNum) || blockNum !== trap.expectedBlock) {
      failures.push(`block: expected ${trap.expectedBlock}, got ${JSON.stringify(blockRaw)}`);
    }
  }
  if (trap.valueBasis === "tx" && trap.expectedValueWei !== null) {
    const wei = ethToWei(body.value_eth ?? body.value);
    if (wei === null) {
      failures.push(`value: unparseable value_eth=${JSON.stringify(body.value_eth ?? body.value)}`);
    } else if (wei !== trap.expectedValueWei) {
      failures.push(`value: expected ${trap.expectedValueWei} wei, got ${wei} wei (value_eth=${JSON.stringify(body.value_eth)})`);
    }
  } else if (trap.valueBasis === "transfer-event") {
    // Frozen expected_value is the Transfer-event amount, not the tx
    // value. The true tx value is 0 wei (live RPC check); require that.
    const wei = ethToWei(body.value_eth ?? body.value);
    if (wei === null) {
      failures.push(`value: unparseable value_eth=${JSON.stringify(body.value_eth ?? body.value)}`);
    } else if (wei !== "0") {
      failures.push(`value: expected tx value 0 wei, got ${wei} wei`);
    } else {
      notes.push(`frozen expected_value ${trap.expectedValueWei} is the Transfer-event amount, not scored as value_eth (tx value is 0 wei)`);
    }
  }

  // Receipt contract: every success answer carries a SHA-256 receipt.
  const receipt = body.receipt as Record<string, unknown> | undefined;
  const sha = typeof receipt?.raw_response_sha256 === "string" ? receipt.raw_response_sha256 : "";
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    failures.push("missing/invalid receipt.raw_response_sha256");
  }

  if (failures.length > 0) {
    return { id: trap.id, passed: false, detail: failures.join("; ") };
  }
  return { id: trap.id, passed: true, detail: notes.length > 0 ? notes.join("; ") : "all scored fields match" };
}

async function main(): Promise<number> {
  const app = buildServer();
  await app.listen({ host: "127.0.0.1", port: PORT });
  console.log(`TrapTest: server listening on 127.0.0.1:${PORT}`);
  console.log(`TrapTest: frozen set traps-frozen-2026-11-06.json, chain=${CHAIN}, ${TRAPS.length} cases`);
  try {
    let passed = 0;
    for (const trap of TRAPS) {
      const result = await runCase(trap);
      if (result.passed) passed += 1;
      console.log(`${result.passed ? "PASS" : "FAIL"} ${result.id} [${trap.category}]: ${result.detail}`);
    }
    console.log(`TrapTest: ${passed}/${TRAPS.length}`);
    return passed === TRAPS.length ? 0 : 1;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error("TrapTest runner error:", err);
    process.exitCode = 1;
  });
