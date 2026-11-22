// VeriReceipt — per-upstream health registry (A6, 2026-11-20).
//
// WHY THIS EXISTS: /health reported `upstreams: {}` always, so the next
// upstream outage was invisible from the app itself (same observability
// gap the loop-lag sampler closed for in-process stalls). The registry
// records, per upstream SERVICE, the last time that service served an
// answer (`last_ok`) and the last time the intent path that depends on it
// failed at the upstream (`last_err` + short error code). Both are served
// additively on /health from memory only — /health never calls an
// upstream and never touches the DB.
//
// WIRING (no handler edits): the server.ts route wrapper records from the
// handler's own receipt — every handler returns
// `envelope(..., receipt, ...)` with `receipt.upstream_url` naming the
// upstream that served the answer and `receipt.fetched_at` stating when
// it was fetched (live handlers: now; grid cache rows: `row.ingested_at`,
// i.e. when the upstream row was actually fetched). A cache-served grid
// answer therefore records the TRUE upstream fetch time, not the serve
// time. On failure only a 502-class error records `last_err`, for the
// intent's primary service, with the ApiError CODE only — never the
// message (messages can embed upstream URLs, e.g. txLookup
// `RPC HTTP … from ${url}`). 400/422/404 record nothing: a validation
// error never touched an upstream, and a 422 (e.g. beacon 404 →
// VALIDATOR_NOT_FOUND) means the upstream ANSWERED.
//
// KEYS ARE SERVICES, not hosts, so the success path (hostname → service)
// and the error path (intent → primary service) agree:
//   sec-edgar        data.sec.gov
//   defillama        api.llama.fi
//   caiso-oasis      oasis.caiso.com
//   nyiso            mis.nyiso.com
//   elering          dashboard.elering.ee
//   fx-er-api        open.er-api.com (EUR→USD, ingester only)
//   beacon-api       both beacon hosts (lodestar-mainnet.chainsafe.io,
//                    ethereum-beacon-api.publicnode.com)
//   evm-rpc          every CHAIN_RPCS host (*.drpc.org, *.blastapi.io,
//                    rpc.mevblocker.io, mainnet.base.org)
// An unmapped hostname falls back to the hostname itself, so a new RPC
// host still appears instead of vanishing. The ingester's upstreams
// (NYISO / Elering / FX) are in the map but are only recorded when a
// handler path observes them — the ingester itself is another lane's
// file and is NOT wired here.
//
// SAFETY: every public function is fail-open — it catches its own
// errors and never throws into a request path. Node is single-threaded
// and each record is one synchronous Map update, so there is no
// read-modify-write race to guard. Timestamps are ISO strings (or null
// when never observed); the registry starts empty, so a fresh server
// still reports `upstreams: {}`.

export interface UpstreamHealth {
  /** ISO timestamp the upstream last served an answer, null if never. */
  last_ok: string | null;
  /** ISO timestamp the intent path last failed at the upstream, null if never. */
  last_err: string | null;
  /** Short error code of the last upstream failure (ApiError code), null if never. No message, no URL. */
  last_error: string | null;
}

export type UpstreamsSnapshot = Record<string, UpstreamHealth>;

const registry = new Map<string, UpstreamHealth>();

function entry(name: string): UpstreamHealth {
  let st = registry.get(name);
  if (!st) {
    st = { last_ok: null, last_err: null, last_error: null };
    registry.set(name, st);
  }
  return st;
}

/** Exact-host → service overrides. */
const HOST_TO_SERVICE: Record<string, string> = {
  "data.sec.gov": "sec-edgar",
  "api.llama.fi": "defillama",
  "oasis.caiso.com": "caiso-oasis",
  "mis.nyiso.com": "nyiso",
  "dashboard.elering.ee": "elering",
  "open.er-api.com": "fx-er-api",
  "lodestar-mainnet.chainsafe.io": "beacon-api",
  "ethereum-beacon-api.publicnode.com": "beacon-api",
  "rpc.mevblocker.io": "evm-rpc",
  "mainnet.base.org": "evm-rpc",
  "api.worldbank.org": "worldbank",
  "eth.blockscout.com": "blockscout",
  "explorer.optimism.io": "blockscout",
};

/** Hostname suffixes shared by every CHAIN_RPCS host family. */
const RPC_HOST_SUFFIXES = [".drpc.org", ".blastapi.io"];

/**
 * Map an upstream URL (or bare hostname) to its service key. Returns
 * null for an unparseable/empty input — callers treat null as "do not
 * record" rather than inventing a key. Unknown hosts fall back to the
 * hostname itself. Never throws.
 */
export function upstreamNameForUrl(url: string): string | null {
  try {
    if (!url || typeof url !== "string") return null;
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      // Bare hostname (no scheme) — accept it as-is when it looks like one.
      host = url.trim().toLowerCase();
      if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) return null;
    }
    if (!host) return null;
    const exact = HOST_TO_SERVICE[host];
    if (exact) return exact;
    if (RPC_HOST_SUFFIXES.some((sfx) => host.endsWith(sfx))) return "evm-rpc";
    return host;
  } catch {
    return null;
  }
}

/**
 * Record a successful upstream answer for `name` at `at` (ISO string;
 * defaults to now). A caller-supplied timestamp is used verbatim when it
 * parses as a date, so a receipt's `fetched_at` (the true fetch time)
 * is recorded, not the serve time. Never throws.
 */
export function recordUpstreamOk(name: string, at?: string): void {
  try {
    if (!name || typeof name !== "string") return;
    let ts: string;
    if (typeof at === "string" && at) {
      const ms = Date.parse(at);
      ts = Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString();
    } else {
      ts = new Date().toISOString();
    }
    entry(name).last_ok = ts;
  } catch {
    // Fail-open: the registry must never break a request path.
  }
}

/**
 * Record an upstream failure for `name` at now. `errorCode` is the short
 * ApiError code (e.g. "QUORUM_UNREACHABLE") — never a message or URL.
 * Never throws.
 */
export function recordUpstreamError(name: string, errorCode?: string): void {
  try {
    if (!name || typeof name !== "string") return;
    const st = entry(name);
    st.last_err = new Date().toISOString();
    st.last_error =
      typeof errorCode === "string" && errorCode ? errorCode.slice(0, 64) : "UPSTREAM_ERROR";
  } catch {
    // Fail-open: the registry must never break a request path.
  }
}

/**
 * Record a success from a handler receipt: `receipt.upstream_url` names
 * the upstream, `receipt.fetched_at` the fetch time. Silently records
 * nothing when the receipt is missing either field (fail-open). Never
 * throws.
 */
export function recordUpstreamOkFromReceipt(receipt: unknown): void {
  try {
    if (receipt === null || typeof receipt !== "object") return;
    const { upstream_url, fetched_at } = receipt as {
      upstream_url?: unknown;
      fetched_at?: unknown;
    };
    if (typeof upstream_url !== "string" || !upstream_url) return;
    const name = upstreamNameForUrl(upstream_url);
    if (!name) return;
    recordUpstreamOk(name, typeof fetched_at === "string" ? fetched_at : undefined);
  } catch {
    // Fail-open.
  }
}

/** Primary upstream service per intent, for the 502 error path. */
export const INTENT_PRIMARY_UPSTREAM: Record<string, string> = {
  filings: "sec-edgar",
  tvl: "defillama",
  tx: "evm-rpc",
  route: "evm-rpc",
  "grid-price": "caiso-oasis",
  validator: "beacon-api",
  "gas-price": "evm-rpc",
  balance: "evm-rpc",
  "token-supply": "evm-rpc",
  macro: "worldbank",
  "token-holders": "blockscout",
};

/**
 * Refine the grid-price error attribution by zone (A6): the intent's
 * primary service is CAISO, but a NYISO/Elering cache miss is NOT a
 * CAISO failure — blaming caiso-oasis for it would be wrong. Zone
 * spellings follow SUPPORTED_ZONES (src/jobs/gridIngester.ts):
 * Elering EE/FI/LV/LT, NYISO ZONE_A–K + WEST/GENESE/CENTRL/NORTH/
 * "MHK VL"/CAPITL/"HUD VL"/MILLWD/DUNWOD/"N.Y.C."/LONGIL, CAISO
 * TH_NP15/SP15/ZP26_GEN-APND, "CAISO" (system) and the NP15/SP15/
 * ZP26 short names. Anything else
 * (including an unknown zone, which 422s before any upstream is
 * touched and therefore never records) falls back to caiso-oasis.
 * Never throws.
 */
export function primaryUpstreamForGridZone(zone: string | undefined): string {
  try {
    const z = (zone ?? "").trim().toUpperCase();
    if (z === "EE" || z === "FI" || z === "LV" || z === "LT") return "elering";
    if (
      z.startsWith("ZONE_") ||
      z === "WEST" ||
      z === "GENESE" ||
      z === "CENTRL" ||
      z === "NORTH" ||
      z === "MHK VL" ||
      z === "CAPITL" ||
      z === "HUD VL" ||
      z === "MILLWD" ||
      z === "DUNWOD" ||
      z === "N.Y.C." ||
      z === "LONGIL"
    ) {
      return "nyiso";
    }
    return "caiso-oasis";
  } catch {
    return "caiso-oasis";
  }
}

/** Copy of the registry for /health. Empty object when nothing observed. */
export function getUpstreamsSnapshot(): UpstreamsSnapshot {
  const out: UpstreamsSnapshot = {};
  try {
    for (const [name, st] of registry) out[name] = { ...st };
  } catch {
    // Fail-open: return whatever was copied (possibly {}).
  }
  return out;
}

/** Test-only reset: drops all registry state. */
export function resetUpstreamsForTests(): void {
  try {
    registry.clear();
  } catch {
    // Fail-open.
  }
}
