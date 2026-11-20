// Desk receipt verification — server side.
//
// A Telegraph ask produces TWO different hashes, and they verify on
// TWO different endpoints. Conflating them is the single easiest way to
// report a false negative, so this module keeps them strictly separate:
//
//   1. SIGNAL — the raw miner answer. The ask response carries
//      `signal_hash` ("the hash the raw miner answer was recorded
//      under"). Verify it at:
//        GET https://devnode.telegraphprotocol.com/engine/v1/signal/<signal_hash>
//      Genuine only when `verification.verified === true` (live shape:
//      { algorithm: "keccak256", commitment: "payload", verified: true }).
//      The signal response carries NO epoch — never invent one for it.
//
//   2. DELIVERY — the payment settlement. A budgeted ask's response
//      carries `fulfillment.payments[]`, one
//      { miner, intent, amount_uusdc, receipt_hash } per paid call.
//      Verify each receipt at:
//        GET https://devnode.telegraphprotocol.com/v1/blocks/{epoch}/deliveries/<receipt_hash>
//      A 200 returns the delivery record plus a Merkle `proof` and the
//      block's `deliveries_root`. A 404 means one of two things, and
//      they are NOT the same:
//        - the epoch has no block yet → the epoch has not closed:
//          status "pending" ("Pending hourly epoch finalization"),
//          never a broken 404 link and never a failed verification.
//        - the epoch HAS a block and the receipt is not in it → a real
//          negative for that epoch ("not_found").
//      Which one applies is decided from EPOCH STATE (a probe of
//      GET /v1/blocks/{epoch}), never from matching the devnode's exact
//      error wording — the wording is the devnode's, not a contract,
//      and an empty 404 body says nothing at all.
//
// Live facts behind this design (verified 2026-11-20 ~18:40 EET):
//   - Epochs are 3-hour windows, not hourly: epoch 22 =
//     2026-11-20T04:05:41Z–07:05:41Z, 23 = 07:05:41–10:05:41Z,
//     24 = 10:05:41–13:05:41Z; latest finalized epoch at check time: 24.
//   - A genuine verified signal's hash does NOT resolve as a delivery:
//     signal 0x58d3… (created 12:06:49Z, verified:true) returns
//     404 "receipt not in this block" on /v1/blocks/24/deliveries/<hash>.
//   - A block receipt_hash does NOT resolve as a signal:
//     0x0486… (epoch 24 delivery) returns {"error":"signal not found"}
//     on /engine/v1/signal/<hash>.
//   - A block receipt_hash DOES verify as a delivery: 200 with proof.
//   So: signal_hash proves the ANSWER, receipt_hash proves the PAYMENT.
//   A Desk receipt is fully verified only when BOTH check out.
//
// CAVEAT — the combined live run was NOT one receipt's proof: the
// signal half and the delivery half above were each verified live on
// 2026-11-20, but on DIFFERENT asks (different signal_hash /
// receipt_hash pairs). verifyReceipt checks one caller-supplied pair,
// and direct inputs are CALLER-PAIRED: the caller asserts the
// signal_hash and receipt_hash belong to the same ask. This module
// never checks that pairing itself (the devnode offers no endpoint
// that binds a signal to a receipt). The MCP ledger path
// (src/desk/mcp.ts) is linkage-safe: it takes both hashes from the
// same ledger row, which is one ask's recorded pair.
//
// END-TO-END LIVE PROOF (2026-11-20 ~18:08 UTC, fixed code): the
// M13-01 TX pair — signal
// 0xd61bc4c6ea837aa3ea32f5c0d052416cf20d520fb4c0fe383b9d34be228c3ecb +
// receipt
// 0xe0e96add6e03832d617fbe28e76e627df23d20a799fe03c37e2b5b1e4c0bff02
// from ONE ask (ledger row M13-01 ONCHAIN_TX_LOOKUP_GENERAL) — verified
// BOTH halves live via verifyReceipt with no epoch: signal verified,
// delivery verified in epoch 25 with an 8-element Merkle proof and
// matching receipt_hash + epoch_id. The M13-02 TX pair (signal
// 0xbe7a02569c12a8f454ff3cbd1d7082c5510234749677a69135a0b44c2b4dc4c1 +
// receipt
// 0x10dbf4c372d2e470b2ec4f6beaa1fb67ce507f9dab7092877db9d65f69f67404)
// verified the same way, also epoch 25. The different-asks caveat
// above describes the ORIGINAL 18:40 run, not these two receipts.
// M13-01 was re-verified live again during round-2 review (same pair,
// same result: verified, epoch 25, 8-element proof, 51.9s).
//
// Epoch discovery for a delivery check with no known epoch: the latest
// finalized epoch is found by probing GET /v1/blocks/{n} (exponential
// probe + binary search), then the receipt is looked up in finalized
// blocks walking down from the latest (settlement can lag one epoch).
// After a fruitless scan the next epoch (latest+1) is probed: no block
// there yet means the receipt may still settle — "pending", never
// "not_found". A fruitless scan of finalized epochs is reported as
// not-found across the scanned range, never by naming one epoch the
// receipt was never expected in.
//
// Deadlines (J2-F7): every devnode call has a per-fetch timeout AND
// the whole verifyReceipt call has an overall deadline (default 120s
// from call time). A fetch implementation that ignores AbortSignal
// cannot hang the call: fetchJson races the fetch AND the res.json()
// body read against a timer that rejects. (Round-2 FIX E: the body
// read used to sit outside the race, so a fetch that resolved but
// whose json() never resolved hung the call past the deadline.
// Caveat: with the real global fetch the timer's controller.abort()
// tears down the body stream, so production is likely saved by abort
// even without the race; the hole needs a signal-ignoring fetch impl
// whose json() also hangs.) Transient failures (HTTP 5xx / timeout /
// network error) surface as status "error", never as "no block" /
// "not_found".
//
// Nothing here trusts a hash the caller asserts: every verdict comes
// only from devnode responses. The fetch implementation is injectable
// so tests can stub the devnode without touching the network.

import { sha256Hex } from "../core/receipt";

export const DEVNODE_BASE = "https://devnode.telegraphprotocol.com";

/**
 * How long a single devnode call may take before it fails closed.
 * 120s: measured 2026-11-20, a plain Node fetch of one signal took
 * ~20s from this environment (curl: ~3–8s) — and the signal endpoint
 * then exceeded a 60s timeout three times in a row (18:51–18:53 EET)
 * before the same hash verified fine minutes later. The devnode is
 * slow and its latency is highly variable (sub-second to >60s); a
 * short timeout turns slow-but-real verifications into false errors.
 * 120s is the fail-closed bound, not a target latency.
 */
export const VERIFY_TIMEOUT_MS = 120_000;

/**
 * Overall deadline for one verifyReceipt call (default). A no-epoch
 * call issues ~19 sequential devnode calls (discovery + scan +
 * latest+1 probe + signal); without an overall deadline each could
 * take up to VERIFY_TIMEOUT_MS, i.e. ~38 minutes for one request.
 * The deadline bounds the whole call: once it passes, pending calls
 * fail closed as "error" instead of starting new ones.
 */
export const VERIFY_DEADLINE_MS = 120_000;

/** How many finalized epochs back a delivery scan walks (settlement lag). */
export const DELIVERY_SCAN_EPOCHS = 8;

export type VerificationStatus =
  | "verified"
  | "partial"
  | "pending"
  | "not_found"
  | "unverified"
  | "error";

export interface SignalCheck {
  verified: boolean;
  signal_hash: string;
  checked_at: string;
  status: VerificationStatus;
  signal_url: string;
  detail: string;
}

export interface DeliveryCheck {
  verified: boolean;
  receipt_hash: string;
  /** Epoch the delivery was found in (null until verified). */
  epoch: number | null;
  checked_at: string;
  status: VerificationStatus;
  /** Delivery URL for the epoch checked (null when no epoch is known). */
  delivery_url: string | null;
  /** Merkle proof from the delivery response (null until verified). */
  proof: string[] | null;
  detail: string;
}

export interface ReceiptVerdict {
  /**
   * True ONLY when the signal AND (when a receipt exists) the delivery
   * both check out. A signal-only receipt is "partial", never verified:
   * the answer is proven, the payment is unchecked.
   */
  verified: boolean;
  signal_hash: string;
  receipt_hash: string | null;
  /** Epoch the delivery was found in (null until the delivery verifies). */
  epoch: number | null;
  checked_at: string;
  status: VerificationStatus;
  signal: SignalCheck;
  /** Null when the ask recorded no receipt_hash — delivery cannot be checked, not failed. */
  delivery: DeliveryCheck | null;
  detail: string;
}

export type FetchFn = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface VerifyDeps {
  fetchFn?: FetchFn;
  now?: () => string;
  /**
   * Absolute deadline (Date.now() ms) for the whole call. verifyReceipt
   * supplies Date.now() + VERIFY_DEADLINE_MS when omitted. A deadline
   * already in the past fails every fetch closed as "error".
   */
  deadline?: number;
}

function defaultFetch(url: string, init?: { signal?: AbortSignal }): Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}> {
  return fetch(url, init) as unknown as Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

export function signalUrl(signalHash: string): string {
  return `${DEVNODE_BASE}/engine/v1/signal/${signalHash}`;
}

export function deliveryUrl(epoch: number, receiptHash: string): string {
  return `${DEVNODE_BASE}/v1/blocks/${epoch}/deliveries/${receiptHash}`;
}

export function blockUrl(epoch: number): string {
  return `${DEVNODE_BASE}/v1/blocks/${epoch}`;
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** A signal/receipt hash is `0x` + 64 hex chars. Anything else is refused, not fetched. */
export function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * True only when the signal response says verification.verified === true
 * AND, when the body carries an identifier field (signal_hash / hash) —
 * at the top level OR nested inside `verification` — that identifier
 * equals the requested hash. A top-level `verified: true` is NOT enough:
 * the binding must live under `verification` (the live shape), and a
 * mismatched identifier fails closed. When no identifier field is
 * present, the request URL itself binds the hash (the endpoint is
 * addressed by it), so nested verified === true suffices.
 *
 * Round-3 S1: a present-but-wrong-typed identifier (e.g. signal_hash:
 * 12345, a number) also fails closed — it is a mismatched identifier,
 * not an absent one. This matches the delivery-side rule (round-2
 * FIX C): a wrong-typed binding field is a mismatch, never ignored.
 */
export function isSignalVerified(body: unknown, signalHash?: string): boolean {
  if (!isRecord(body)) return false;
  const verification = body["verification"];
  if (!isRecord(verification)) return false;
  if (verification["verified"] !== true) return false;
  if (typeof signalHash === "string") {
    for (const field of ["signal_hash", "hash"]) {
      for (const holder of [body, verification]) {
        const claimed = holder[field];
        if (claimed === undefined) continue;
        // Round-3 S1: present but not a string → fail closed.
        if (typeof claimed !== "string") return false;
        if (claimed.toLowerCase() !== signalHash.toLowerCase()) return false;
      }
    }
  }
  return true;
}

async function fetchJson(
  fetchFn: FetchFn,
  url: string,
  deadline?: number,
): Promise<{ status: number; body: unknown }> {
  // Budget for this one call: the per-fetch bound, or whatever is left
  // of the overall deadline, whichever is smaller. A deadline already
  // passed fails closed without fetching.
  let budget = VERIFY_TIMEOUT_MS;
  if (deadline !== undefined) {
    budget = Math.min(budget, deadline - Date.now());
  }
  if (budget <= 0) {
    throw new Error(
      `Verification deadline exceeded before fetching ${url} — the check was not run, not confirmed.`,
    );
  }
  const controller = new AbortController();
  // The race is the backstop for a fetch implementation that ignores
  // AbortSignal: the timer rejects whether or not the fetch aborts,
  // so a hung fetch can never hang this call past `budget`. The SAME
  // race also bounds res.json() below: a fetch that resolves but whose
  // body read never resolves would otherwise hang the call past the
  // deadline (round-2 FIX E / J2-F5).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Error(
    `Devnode fetch timed out after ${budget}ms: ${url} — the check was not run, not confirmed.`,
  );
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, budget);
  });
  try {
    const res = await Promise.race([fetchFn(url, { signal: controller.signal }), timeout]);
    let body: unknown = null;
    try {
      body = await Promise.race([res.json(), timeout]);
    } catch (err) {
      // A deadline expiry during the body read fails closed (rethrow);
      // a genuine parse failure still yields a null body.
      if (err === timeoutError) throw err;
      body = null; // A non-JSON error body is not a verification.
    }
    return { status: res.status, body };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Probe whether an epoch has a block: GET /v1/blocks/{epoch}.
 * 200 → the epoch exists (finalized); 404 → no block yet; anything else
 * (5xx / timeout / network error) → a transient failure, reported as
 * an error — never as "no block". This is the authority for the
 * pending-vs-not_found decision: pending is an epoch-state fact, not
 * a reading of the devnode's error wording.
 */
export async function probeBlock(
  fetchFn: FetchFn,
  epoch: number,
  deadline?: number,
): Promise<{ exists: boolean } | { error: string }> {
  let res: { status: number; body: unknown };
  try {
    res = await fetchJson(fetchFn, blockUrl(epoch), deadline);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "network error" };
  }
  if (res.status === 200) return { exists: true };
  if (res.status === 404) return { exists: false };
  return { error: `block probe returned HTTP ${res.status}` };
}

/**
 * Verify one signal hash against the devnode (the ANSWER check).
 *
 * - signal 404 / {"error":"signal not found"} → "not_found"
 * - signal present but verification.verified !== true → "unverified"
 * - verification.verified === true (bound to this hash) → "verified"
 * - any other HTTP status / network failure / deadline → "error" (fail closed)
 *
 * No delivery lookup happens here: a signal_hash is not a receipt_hash.
 */
export async function verifySignal(
  signalHash: string,
  deps: VerifyDeps = {},
): Promise<SignalCheck> {
  const fetchFn = deps.fetchFn ?? defaultFetch;
  const at = deps.now ? deps.now() : new Date().toISOString();
  const base = {
    signal_hash: signalHash,
    checked_at: at,
    signal_url: signalUrl(signalHash),
  };
  if (!isHash(signalHash)) {
    return {
      ...base,
      verified: false,
      status: "error",
      detail:
        "Refused: signal_hash must be 0x + 64 hex characters. Nothing was fetched.",
    };
  }
  let signal: { status: number; body: unknown };
  try {
    signal = await fetchJson(fetchFn, signalUrl(signalHash), deps.deadline);
  } catch (err) {
    return {
      ...base,
      verified: false,
      status: "error",
      detail: `Signal lookup failed: ${err instanceof Error ? err.message : "network error"} — the signal was not checked, not confirmed.`,
    };
  }
  if (signal.status === 404) {
    return {
      ...base,
      verified: false,
      status: "not_found",
      detail:
        "No such signal on the devnode (HTTP 404 / signal not found). The hash is unknown — it was never settled, or the hash is wrong.",
    };
  }
  if (signal.status < 200 || signal.status >= 300) {
    return {
      ...base,
      verified: false,
      status: "error",
      detail: `Signal lookup returned HTTP ${signal.status} — the signal was not checked, not confirmed.`,
    };
  }
  if (!isSignalVerified(signal.body, signalHash)) {
    return {
      ...base,
      verified: false,
      status: "unverified",
      detail:
        "The devnode returned the signal but verification.verified is not true (or the response does not bind to this hash) — this signal is not verified.",
    };
  }
  return {
    ...base,
    verified: true,
    status: "verified",
    detail:
      "Signal verified on the devnode (verification.verified === true).",
  };
}

function deliveryError(body: unknown): string {
  if (isRecord(body) && typeof body["error"] === "string") return body["error"];
  return "";
}

/**
 * Verify one receipt hash in ONE known epoch (the PAYMENT check).
 *
 * - 200 whose body binds to the requested receipt_hash AND epoch_id AND
 *   carries a non-empty Merkle proof → "verified".
 * - 200 whose body does NOT bind (wrong receipt_hash / epoch_id, or no
 *   usable proof) → "unverified": a 200 that answers a different
 *   question is not a verification. Never verified on status alone.
 * - 404 "receipt not in this block" (explicit) → "not_found": the epoch
 *   IS finalized and the receipt is not in it.
 * - 404 otherwise → the epoch block is probed: block exists →
 *   "not_found"; no block → "pending" (epoch not closed yet). An empty
 *   404 body says nothing, so the detail reports what the probe found,
 *   never a fabricated reason. Probe failure → "error".
 * - any other status / network failure / deadline → "error" (fail closed).
 */
export async function verifyDelivery(
  receiptHash: string,
  epoch: number,
  deps: VerifyDeps = {},
): Promise<DeliveryCheck> {
  const fetchFn = deps.fetchFn ?? defaultFetch;
  const at = deps.now ? deps.now() : new Date().toISOString();
  const url = deliveryUrl(epoch, receiptHash);
  const base = {
    receipt_hash: receiptHash,
    epoch: null as number | null,
    checked_at: at,
    delivery_url: url,
  };
  if (!isHash(receiptHash)) {
    return {
      ...base,
      verified: false,
      status: "error",
      proof: null,
      detail:
        "Refused: receipt_hash must be 0x + 64 hex characters. Nothing was fetched.",
    };
  }
  if (!Number.isInteger(epoch) || epoch < 0) {
    return {
      ...base,
      verified: false,
      status: "error",
      proof: null,
      detail: "Refused: epoch must be a non-negative integer. Nothing was fetched.",
    };
  }
  let delivery: { status: number; body: unknown };
  try {
    delivery = await fetchJson(fetchFn, url, deps.deadline);
  } catch (err) {
    return {
      ...base,
      verified: false,
      status: "error",
      proof: null,
      detail: `Delivery lookup failed: ${err instanceof Error ? err.message : "network error"} — the delivery proof was not checked, not confirmed.`,
    };
  }
  if (delivery.status === 200) {
    const body = delivery.body;
    const proof = isRecord(body) && Array.isArray(body["proof"])
      ? (body["proof"] as unknown[]).filter(
          (p): p is string => typeof p === "string",
        )
      : null;
    const epochId = isRecord(body) ? body["epoch_id"] : undefined;
    const deliveryRecord = isRecord(body) ? body["delivery"] : undefined;
    const deliveryClaimedRaw = isRecord(deliveryRecord)
      ? deliveryRecord["receipt_hash"]
      : undefined;
    const bodyClaimedRaw = isRecord(body) ? body["receipt_hash"] : undefined;
    const mismatch: string[] = [];
    // Round-2 FIX C (J2-F2): a present-but-wrong-typed binding field is
    // a MISMATCH, not an absent field. The old code compared epoch_id
    // only when it was already a number and claimedReceipt only when it
    // was already a string, so a 200 carrying epoch_id "23" (string) or
    // receipt_hash 12345 (number) verified with a detail falsely
    // claiming "receipt_hash and epoch_id match the request". Caveat:
    // observed devnode bodies use numeric epoch_id and string
    // receipt_hash, so this is a latent logic flaw, not a
    // live-exploitable one — but the printed verdict must not be false
    // in these cases.
    // Round-3 F2: EVERY present receipt_hash field must bind to the
    // requested hash — the top-level body.receipt_hash AND the nested
    // delivery.receipt_hash, each checked on its own. The old code
    // preferred delivery.receipt_hash and only validated the field it
    // used, so a 200 whose top-level receipt_hash named a DIFFERENT
    // hash (while the nested one matched) verified with a detail
    // falsely claiming "receipt_hash and epoch_id match the request".
    // A conflict in either direction is unverified, never verified.
    for (const [where, claimedRaw] of [
      ["delivery.receipt_hash", deliveryClaimedRaw],
      ["receipt_hash", bodyClaimedRaw],
    ] as const) {
      if (claimedRaw === undefined) continue;
      if (typeof claimedRaw !== "string") {
        mismatch.push(
          `the returned ${where} is not a string (got ${typeof claimedRaw}) — the response does not bind to the requested ${receiptHash}`,
        );
      } else if (claimedRaw.toLowerCase() !== receiptHash.toLowerCase()) {
        mismatch.push(
          `the returned ${where} ${claimedRaw} is not the requested ${receiptHash}`,
        );
      }
    }
    if (epochId !== undefined && typeof epochId !== "number") {
      mismatch.push(
        `the returned epoch_id is not a number (got ${typeof epochId}: ${String(epochId)}) — the response does not bind to the requested epoch ${epoch}`,
      );
    } else if (typeof epochId === "number" && epochId !== epoch) {
      mismatch.push(`the returned epoch_id ${epochId} is not the requested epoch ${epoch}`);
    }
    if (proof === null || proof.length === 0) {
      mismatch.push("no Merkle proof was returned");
    }
    if (mismatch.length > 0) {
      return {
        ...base,
        verified: false,
        status: "unverified",
        proof: null,
        detail:
          `Delivery lookup returned HTTP 200, but the response does not match the request (${mismatch.join("; ")}) — a 200 that answers a different question is not a verification.`,
      };
    }
    return {
      ...base,
      verified: true,
      status: "verified",
      epoch: typeof epochId === "number" ? epochId : epoch,
      proof,
      detail:
        "Delivery proof published in the epoch block (Merkle proof returned, receipt_hash and epoch_id match the request).",
    };
  }
  if (delivery.status === 404) {
    const errText = deliveryError(delivery.body);
    if (errText.includes("receipt not in this block")) {
      return {
        ...base,
        verified: false,
        status: "not_found",
        proof: null,
        detail:
          `The epoch ${epoch} block is finalized and does not contain this receipt (devnode: "receipt not in this block").`,
      };
    }
    // Any other 404 (including an empty body): decide from epoch state,
    // never from the wording — and never fabricate a reason.
    const probe = await probeBlock(fetchFn, epoch, deps.deadline);
    if ("error" in probe) {
      return {
        ...base,
        verified: false,
        status: "error",
        proof: null,
        detail:
          `Delivery lookup returned 404 with no usable reason, and the epoch-block probe failed (${probe.error}) — the delivery was not checked, not confirmed.`,
      };
    }
    if (!probe.exists) {
      return {
        ...base,
        verified: false,
        status: "pending",
        proof: null,
        detail:
          `Pending epoch finalization: no block is recorded for epoch ${epoch} yet, so the delivery proof is not published.`,
      };
    }
    return {
      ...base,
      verified: false,
      status: "not_found",
      proof: null,
      detail:
        `The epoch ${epoch} block exists (finalized) and does not contain this receipt.`,
    };
  }
  return {
    ...base,
    verified: false,
    status: "error",
    proof: null,
    detail: `Delivery lookup returned HTTP ${delivery.status} — the delivery proof was not checked, not confirmed.`,
  };
}

/**
 * Find the latest finalized epoch by probing GET /v1/blocks/{n}.
 * Exponential probe (1, 2, 4, 8, …) to the first 404, then binary
 * search between the last 200 and the first 404. Returns -1 when even
 * epoch 0 has no block. Caps the probe so a runaway node cannot make
 * this loop forever.
 *
 * THROWS on a transient failure (non-200/non-404 status, timeout,
 * network error): a 500 on one probe must never be read as "no block"
 * and silently return a lower epoch — the caller surfaces it as
 * "error" instead.
 */
export async function findLatestFinalizedEpoch(
  fetchFn: FetchFn,
  deadline?: number,
): Promise<number> {
  const exists = async (epoch: number): Promise<boolean> => {
    const probe = await probeBlock(fetchFn, epoch, deadline);
    if ("error" in probe) {
      throw new Error(
        `Transient devnode failure while probing epoch ${epoch} (${probe.error}) — the latest finalized epoch is unknown, not ${epoch - 1}.`,
      );
    }
    return probe.exists;
  };
  if (!(await exists(0))) return -1;
  let lo = 0;
  let hi = 1;
  while (hi <= 1_000_000) {
    if (await exists(hi)) {
      lo = hi;
      hi *= 2;
    } else {
      break;
    }
  }
  // Binary search: lo exists, hi does not (or hi hit the cap).
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await exists(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

function errorDeliveryCheck(
  receiptHash: string,
  at: string,
  deliveryUrlValue: string | null,
  detail: string,
): DeliveryCheck {
  return {
    verified: false,
    receipt_hash: receiptHash,
    epoch: null,
    checked_at: at,
    status: "error",
    delivery_url: deliveryUrlValue,
    proof: null,
    detail,
  };
}

/**
 * Verify a receipt end-to-end: the signal (answer) AND, when the ask
 * recorded a receipt_hash, the delivery (payment).
 *
 * - signal not verified → the whole verdict is not verified (delivery
 *   is still checked when a receipt_hash is given, so the report shows
 *   both halves honestly).
 * - receipt_hash given + epoch given → that single epoch is checked.
 * - receipt_hash given, no epoch → the latest finalized epoch is
 *   discovered and the receipt is looked up walking down from it
 *   (settlement can lag one epoch). A transient error on one epoch
 *   never ends the scan and never becomes "not_found": the scan
 *   continues, and if nothing verifies the verdict is "error". After
 *   a fruitless scan, epoch latest+1 is probed: no block there yet
 *   means the receipt may still settle — "pending", never "not_found"
 *   naming an epoch the receipt was never expected in.
 * - no receipt_hash → delivery is null: the delivery cannot be
 *   checked. The verdict is "partial" (verified: false) — the answer
 *   is proven, the payment is unchecked, and the receipt is NOT
 *   verified. Signal-only must never read as verified.
 *
 * Input types fail closed: a non-string receipt_hash, an EMPTY-STRING
 * receipt_hash, a non-number epoch, or a non-string signal_hash throws
 * TypeError — a mistyped payment half is never silently discarded.
 * (Round-3 F4: "" used to be coerced to null, yielding status "partial"
 * with the false detail "No receipt_hash was recorded for this ask" —
 * a receipt_hash WAS supplied, it was empty. An empty string is a
 * malformed value, like every other malformed value, and fails closed
 * as an error. The MCP handler and the HTTP route validate first and
 * return errors instead of throwing.)
 *
 * A malformed STRING receipt_hash (e.g. "not-a-hash", "   ", "0x1234")
 * returns an "error" verdict for the delivery half, never "pending":
 * on the epoch-given path verifyDelivery refuses it, and on the
 * no-epoch path it is refused up front, before epoch discovery or
 * the scan (round-4 F1). The old no-epoch path scanned epochs with
 * verifyDelivery, which refused the hash as "error" per epoch; the
 * scan treated every "error" as transient, kept scanning, and the
 * latest+1 probe (no block yet) then reported "pending" — asserting
 * a hash that can never settle in any epoch "may settle". A malformed
 * hash can never settle, so it is an error on every path, and nothing
 * is fetched for the delivery half.
 *
 * The signal_hash / receipt_hash pair is CALLER-PAIRED: this function
 * does not (and cannot, on the devnode API) check that the two hashes
 * belong to the same ask. Pass a pair from one ask's response, or use
 * the MCP ledger path, which pairs them from one ledger row.
 *
 * The whole call is bounded by VERIFY_DEADLINE_MS (default 120s)
 * unless deps.deadline overrides it.
 */
export async function verifyReceipt(
  input: { signal_hash: string; receipt_hash?: string | null; epoch?: number | null },
  deps: VerifyDeps = {},
): Promise<ReceiptVerdict> {
  // Fail closed on mistyped input — never silently drop the payment half.
  if (typeof input.signal_hash !== "string") {
    throw new TypeError(
      "verifyReceipt: signal_hash must be a string (0x + 64 hex characters).",
    );
  }
  if (
    input.receipt_hash !== undefined &&
    input.receipt_hash !== null &&
    typeof input.receipt_hash !== "string"
  ) {
    throw new TypeError(
      "verifyReceipt: receipt_hash must be a string (0x + 64 hex characters) when given — a mistyped payment half is refused, never ignored.",
    );
  }
  // Round-3 F4: an empty-string receipt_hash is a malformed value, not
  // an absent one. It must fail closed here — never be coerced to null
  // and reported as "No receipt_hash was recorded for this ask".
  if (input.receipt_hash === "") {
    throw new TypeError(
      "verifyReceipt: receipt_hash must not be empty — an empty receipt_hash is a malformed payment half, not an absent one.",
    );
  }
  if (
    input.epoch !== undefined &&
    input.epoch !== null &&
    typeof input.epoch !== "number"
  ) {
    throw new TypeError(
      "verifyReceipt: epoch must be a number when given — a mistyped epoch is refused, never ignored.",
    );
  }
  const fetchFn = deps.fetchFn ?? defaultFetch;
  const at = deps.now ? deps.now() : new Date().toISOString();
  const deadline = deps.deadline ?? Date.now() + VERIFY_DEADLINE_MS;
  const childDeps: VerifyDeps = { fetchFn, now: deps.now, deadline };
  const signal = await verifySignal(input.signal_hash, childDeps);

  const receiptHash =
    typeof input.receipt_hash === "string" ? input.receipt_hash : null;

  let delivery: DeliveryCheck | null = null;
  if (receiptHash !== null) {
    // Round-4 F1 (= J1 N1 = J2 F1): a malformed receipt_hash fails
    // closed UP FRONT, before epoch discovery or the scan — on BOTH
    // paths, so they agree. The scan must never see it: verifyDelivery
    // refuses a malformed hash as "error", the scan treats every
    // "error" as transient and keeps scanning, and the latest+1 probe
    // then reports "pending" for a hash that can never settle in any
    // epoch. Nothing is fetched for the delivery half.
    if (!isHash(receiptHash)) {
      delivery = errorDeliveryCheck(
        receiptHash,
        at,
        typeof input.epoch === "number" ? deliveryUrl(input.epoch, receiptHash) : null,
        "Refused: receipt_hash must be 0x + 64 hex characters. Nothing was fetched.",
      );
    } else if (typeof input.epoch === "number") {
      delivery = await verifyDelivery(receiptHash, input.epoch, childDeps);
    } else {
      let latest: number;
      try {
        latest = await findLatestFinalizedEpoch(fetchFn, deadline);
      } catch (err) {
        delivery = errorDeliveryCheck(
          receiptHash,
          at,
          null,
          `Epoch discovery failed: ${err instanceof Error ? err.message : "transient devnode failure"}`,
        );
        latest = -2; // Discovery failed; delivery already set above.
      }
      if (latest === -1) {
        delivery = {
          verified: false,
          receipt_hash: receiptHash,
          epoch: null,
          checked_at: at,
          status: "pending",
          delivery_url: null,
          proof: null,
          detail:
            "No finalized epoch block could be found, so the delivery proof cannot be checked yet — pending.",
        };
      } else if (latest >= 0) {
        let found: DeliveryCheck | null = null;
        let firstError: DeliveryCheck | null = null;
        let firstErrorEpoch: number | null = null;
        const start = latest;
        const stop = Math.max(0, latest - DELIVERY_SCAN_EPOCHS + 1);
        for (let epoch = start; epoch >= stop; epoch--) {
          const check = await verifyDelivery(receiptHash, epoch, childDeps);
          if (check.status === "verified" || check.status === "pending") {
            found = check;
            break;
          }
          if (check.status === "error") {
            // Transient failure on this epoch: remember it, keep
            // scanning — it must never end the scan or become not_found.
            if (firstError === null) {
              firstError = check;
              firstErrorEpoch = epoch;
            }
            continue;
          }
          // "not_found" / "unverified": keep walking down (settlement lag).
        }
        if (found !== null) {
          delivery = found;
        } else {
          // Fruitless scan: probe latest+1. No block there yet means the
          // receipt may still settle in the unfinalized epoch — pending,
          // never a not_found naming a scanned epoch.
          const probe = await probeBlock(fetchFn, latest + 1, deadline);
          if ("error" in probe) {
            delivery =
              firstError ??
              errorDeliveryCheck(
                receiptHash,
                at,
                blockUrl(latest + 1),
                `Epoch ${latest + 1} block probe failed (${probe.error}) — the delivery proof was not checked, not confirmed.`,
              );
          } else if (!probe.exists) {
            delivery = {
              verified: false,
              receipt_hash: receiptHash,
              epoch: null,
              checked_at: at,
              status: "pending",
              delivery_url: deliveryUrl(latest + 1, receiptHash),
              proof: null,
              detail:
                firstError !== null && firstErrorEpoch !== null
                  ? // Round-2 FIX B (J2-F1): the remembered scan error
                    // belongs in the detail. The old text asserted "the
                    // finalized epochs ${start} down to ${stop} were
                    // scanned and do not contain this receipt" — false
                    // when one epoch errored and was never successfully
                    // scanned. Pending still outranks the error (the
                    // receipt may settle in the unfinalized epoch),
                    // but the scan is reported as incomplete, never as
                    // a completed scan of the range.
                    `No block is recorded for epoch ${latest + 1} yet — the epoch has not closed, so a receipt settling there is pending, not absent. The scan was incomplete: epoch ${firstErrorEpoch} returned an error (${firstError.detail}) and was never successfully scanned, so the finalized epochs ${start} down to ${stop} were not all checked — only the epochs that answered are known not to contain this receipt.`
                  : `No block is recorded for epoch ${latest + 1} yet — the epoch has not closed, so a receipt settling there is pending, not absent. The finalized epochs ${start} down to ${stop} were scanned and do not contain this receipt.`,
            };
          } else {
            const next = await verifyDelivery(receiptHash, latest + 1, childDeps);
            if (next.status === "verified" || next.status === "pending") {
              delivery = next;
            } else if (next.status === "error") {
              delivery = firstError ?? next;
            } else {
              delivery =
                firstError ??
                {
                  verified: false,
                  receipt_hash: receiptHash,
                  epoch: null,
                  checked_at: at,
                  status: "not_found",
                  delivery_url: null,
                  proof: null,
                  detail:
                    `Receipt not found in the finalized epochs scanned (epochs ${start} down to ${stop}, plus ${latest + 1}) — the receipt is not in those blocks.`,
                };
            }
          }
          if (delivery === null) {
            // Unreachable in practice (every branch above sets it), but
            // never return a null delivery for a given receipt_hash.
            delivery =
              firstError ??
              {
                verified: false,
                receipt_hash: receiptHash,
                epoch: null,
                checked_at: at,
                status: "not_found",
                delivery_url: null,
                proof: null,
                detail:
                  `Receipt not found in the finalized epochs scanned (epochs ${start} down to ${stop}) — the receipt is not in those blocks.`,
              };
          }
        }
      }
    }
  }

  let verified: boolean;
  let status: VerificationStatus;
  let detail: string;
  if (!signal.verified) {
    verified = false;
    status = signal.status;
    detail = `Signal check: ${signal.detail}`;
  } else if (delivery === null) {
    verified = false;
    status = "partial";
    detail =
      "Signal verified. No receipt_hash was recorded for this ask, so the delivery half was never checked — this receipt is only PARTIALLY verified (answer proven, payment unchecked), not verified.";
  } else if (delivery.verified) {
    verified = true;
    status = "verified";
    detail = "Signal verified and delivery proof published in the epoch block.";
  } else {
    verified = false;
    status = delivery.status;
    detail = `Signal verified. Delivery check: ${delivery.detail}`;
  }

  return {
    verified,
    signal_hash: input.signal_hash,
    receipt_hash: receiptHash,
    epoch: delivery?.epoch ?? null,
    checked_at: at,
    status,
    signal,
    delivery,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Raw-bytes re-hash (the miner-receipt side of verification)
// ---------------------------------------------------------------------------

export interface RehashResult {
  /** True only when SHA-256(raw bytes) equals the recorded digest. */
  match: boolean;
  /** 0x-prefixed lowercase hex SHA-256 of the supplied bytes ("" when the input is unusable). */
  computedSha: string;
  /** The recorded digest, normalised (lowercase, 0x-prefixed; "" when malformed). */
  recordedSha: string;
}

/**
 * Recompute SHA-256 over the EXACT stored raw response bytes and compare
 * with the receipt's recorded `raw_response_sha256`.
 *
 * The bytes must be the miner's stored bytes (served by the audit
 * endpoint — see CONTRACT.md), never a fresh upstream re-fetch: live
 * upstreams return fresh data, so a re-fetch hash legitimately differs
 * from the fetch-time hash and a mismatch there proves nothing about
 * the receipt.
 *
 * Never throws, on ANY input: a malformed recorded digest, a non-string
 * / non-Buffer raw input, and empty bytes all return match:false.
 * Empty bytes NEVER match — not even against sha256(""): a zero-byte
 * body is not a proof of anything.
 */
export function verifyRawBytes(
  raw: unknown,
  recordedSha256: unknown,
): RehashResult {
  const recorded =
    typeof recordedSha256 === "string"
      ? `0x${recordedSha256.trim().toLowerCase().replace(/^0x/, "")}`
      : "";
  const wellFormed = /^0x[0-9a-f]{64}$/.test(recorded);
  if (typeof raw !== "string" && !Buffer.isBuffer(raw)) {
    return { match: false, computedSha: "", recordedSha: recorded };
  }
  const computedSha = sha256Hex(raw);
  const empty = raw.length === 0;
  return {
    match: !empty && wellFormed && computedSha === recorded,
    computedSha,
    recordedSha: recorded,
  };
}
