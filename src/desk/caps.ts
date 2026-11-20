// VeriReceipt Desk — shared spend caps (caps.ts).
//
// ONE enforcement point for the HTTP route (POST /desk/run) and the MCP
// run_* tools (POST /mcp). Both surfaces buy the same live escrow calls
// from the same payer wallet, so both enforce the same caps with the
// same counters. A cap that exists on only one surface is not a cap.
//
// Caps (blueprint §9.2):
//   - 5 free live checks / IP / day
//   - $2.00 / day global cap (2,000,000 µUSDC), counted from the
//     per-call ledger (see below) plus pending reservations.
//
// How the $2/day cap is counted — and why it can no longer miss spend:
//   deskSpendSinceUtcDay() sums the SQLite desk_runs rows for the day.
//   Every bought call is logged to desk_runs IMMEDIATELY after it is
//   bought (per-call logging in the scenario runners), so a throw
//   mid-run cannot lose bought spend. On top of that, a request
//   RESERVES its expected cost up front (reserveCaps, synchronous,
//   before the first await), and the reservation is released in a
//   finally block once the run's real rows are in the ledger. Two
//   concurrent requests therefore cannot both pass on a still-zero
//   count: the second sees the first's reservation. (Node is
//   single-threaded, so the synchronous check-then-reserve in one tick
//   cannot interleave; no mutex is needed in-process.)
//   Reservation is at the $0.01/call protocol floor (6 calls = $0.06
//   for M13, 2 calls = $0.02 for M12). If a miner ever billed above
//   the floor, the cap could overshoot by the excess — the ledger is
//   authoritative after the fact and the overshoot would be visible
//   there. All calls observed to date billed exactly $0.01.
//
// Client IP — X-Forwarded-For is NEVER read directly:
//   clientIp() returns request.ip only. server.ts sets trustProxy to
//   trust only hop 0 (the immediate socket peer — Render's proxy), so
//   request.ip is the LAST X-Forwarded-For entry, i.e. the address
//   Render appended — NOT the socket peer itself (the socket peer IS
//   Render's proxy). A client-sent XFF entry further left is ignored:
//   with XFF "1.2.3.4, <real-ip>" request.ip is <real-ip>, while
//   trusting everything would resolve it to 1.2.3.4 (the spoof).
//   (Fastify 5 treats trustProxy: <number> as trust-nothing, so the
//   hop count is expressed as the hop === 0 function in server.ts;
//   trustProxy: 1 would leave request.ip as the socket peer for every
//   XFF value and collapse all clients into one shared quota.)
//
// PRODUCTION SAFETY — CONDITIONAL, NOT PROVEN LIVE: the per-IP cap's
// safety rests entirely on Render appending the real client IP as the
// LAST X-Forwarded-For entry. That behaviour is UNVERIFIED live: no
// endpoint echoes request.ip, and no live quota was burned to test it
// (Render's public docs state requests to a Render service include an
// X-Forwarded-For header, but do not document append-last semantics).
// If Render ever stopped appending the real IP last, a spoofed
// single-entry XFF could mint fresh quotas. The backstop is the $2/day
// global cap, counted from the SQLite ledger: even with fresh IPs, at
// most ~33 M13 runs ($0.06 each) can be bought per day. Do not claim a
// proven production bypass that is not proven.
//
// LIMITATION (honest, not durable): the per-IP counters live in
// process memory only. They reset on restart and are not shared
// across instances. The $2/day global cap does NOT have this problem
// — it is counted from the SQLite ledger, which survives restarts.
// Do not claim per-IP durability that does not exist.

import type { FastifyRequest } from "fastify";
import { ApiError } from "../core/errors";
import { deskSpendSinceUtcDay } from "./ledger";

export const FREE_CHECKS_PER_IP_PER_DAY = 5;
export const DAILY_GLOBAL_CAP_UUSDC = 2_000_000; // $2.00 / day
export const COST_PER_CALL_UUSDC = 10_000; // $0.01 per ranked call (protocol floor)
export const M13_CALLS_PER_RUN = 6; // 5 own intents + 1 independent CRYPTO_PRICE_USD
export const M12_CALLS_PER_RUN = 2;
export const M13_RUN_COST_UUSDC = M13_CALLS_PER_RUN * COST_PER_CALL_UUSDC; // $0.06
export const M12_RUN_COST_UUSDC = M12_CALLS_PER_RUN * COST_PER_CALL_UUSDC; // $0.02

interface IpCounter {
  day: string;
  count: number;
}

const ipCounters = new Map<string, IpCounter>();
const pendingSpendByDay = new Map<string, number>();

/** Test seam: clear the in-memory per-IP counters AND pending reservations. */
export function resetDeskCaps(): void {
  ipCounters.clear();
  pendingSpendByDay.clear();
}

/**
 * The client IP is request.ip as resolved by Fastify (trustProxy in
 * server.ts trusts only hop 0 — the immediate socket peer, Render's
 * proxy — so request.ip is the LAST X-Forwarded-For entry, the address
 * Render appended). X-Forwarded-For is client-controlled and is never
 * read here. NOTE: this is only as strong as Render appending the real
 * client IP last — unverified live (see the header comment); the $2/day
 * global cap is the backstop if that assumption ever fails.
 */
export function clientIp(request: FastifyRequest): string {
  return request.ip ?? "unknown";
}

function pendingSpend(day: string): number {
  return pendingSpendByDay.get(day) ?? 0;
}

/**
 * Check both caps and, if they pass, synchronously reserve one check
 * for this IP and the run's expected cost against the global cap.
 * MUST be called before the first await of the request, after input
 * validation (a 400/422 must not consume quota). Returns a handle
 * whose release() must be called in a finally block once the run has
 * finished (success or throw) — the ledger then carries the real rows.
 */
export function reserveCaps(
  ip: string,
  day: string,
  expectedCostUusdc: number,
): { release: () => void } {
  const entry = ipCounters.get(ip);
  const used = entry && entry.day === day ? entry.count : 0;
  if (used >= FREE_CHECKS_PER_IP_PER_DAY) {
    throw new ApiError(
      429,
      "RATE_LIMITED",
      `Free live checks exhausted for this IP today (${FREE_CHECKS_PER_IP_PER_DAY}/day). Try again tomorrow.`,
    );
  }
  const spent = deskSpendSinceUtcDay(day);
  if (spent.cost_uusdc + pendingSpend(day) + expectedCostUusdc > DAILY_GLOBAL_CAP_UUSDC) {
    throw new ApiError(
      429,
      "DAILY_CAP_REACHED",
      `The Desk's $2.00/day global spend cap would be exceeded (${((spent.cost_uusdc + pendingSpend(day)) / 1_000_000).toFixed(2)} USDC spent or reserved today). Try again tomorrow.`,
    );
  }
  // Reserve synchronously, in the same tick as the checks above.
  if (entry && entry.day === day) entry.count += 1;
  else ipCounters.set(ip, { day, count: 1 });
  pendingSpendByDay.set(day, pendingSpend(day) + expectedCostUusdc);
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      pendingSpendByDay.set(day, Math.max(0, pendingSpend(day) - expectedCostUusdc));
    },
  };
}
