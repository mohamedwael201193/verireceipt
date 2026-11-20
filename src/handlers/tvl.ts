// TVL_LOOKUP_GENERAL handler.
// Zero-LLM. No mocks/fakes in handler logic. Every answer is derived from a
// live DeFiLlama response and carries a SHA-256 receipt over the raw response.
//
// Quorum note: quorum_votes is "1/1 primary source" — a single authoritative
// source (DeFiLlama, the canonical public TVL registry). There is exactly one
// authoritative TVL source per protocol/chain, so one primary source is the
// whole verification; no multi-source quorum applies here.
//
// Resolution paths (both documented inline at the branch that takes them):
//   - Protocol path: the request names a DeFi protocol (slug, name, or
//     symbol). Reading comes from GET https://api.llama.fi/protocol/{slug}
//     (latest point of its `tvl` history array).
//   - Chain path: the request names a blockchain instead. Reading comes from
//     GET https://api.llama.fi/v2/historicalChainTvl/{chain} (latest point of the
//     returned history), NOT from the /v2/chains entry's `tvl` field, because
//     the history point carries its own timestamp for `as_of` while the
//     /v2/chains field does not.

import { ApiError, badRequest, unprocessable, upstreamUnavailable } from '../core/errors';
import { envelope, makeReceipt } from '../core/receipt';

export const INTENT = 'TVL_LOOKUP_GENERAL';

const PROTOCOLS_URL = 'https://api.llama.fi/protocols';
const CHAINS_URL = 'https://api.llama.fi/v2/chains';
const PROTOCOL_URL = (slug: string): string =>
  `https://api.llama.fi/protocol/${encodeURIComponent(slug)}`;
const HISTORICAL_CHAIN_TVL_URL = (chain: string): string =>
  `https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(chain)}`;

const LISTS_TTL_MS = 24 * 60 * 60 * 1000;
/** Per-request upstream timeout. Anything slower is an outage -> 502. */
const FETCH_TIMEOUT_MS = 4500;

/** Optional transport override — used only by tests to inject fixtures. */
export interface TvlDeps {
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 4500). Tests may raise it; production must not. */
  timeoutMs?: number;
}

interface ProtocolEntry {
  slug: string;
  name: string;
  symbol?: string | null;
  /** Current TVL from the /protocols list (null when the entry has none). */
  tvl?: number | null;
  /** DeFiLlama category (chain placeholders carry category "Chain"). */
  category?: string | null;
}

/**
 * A chain placeholder in the protocols list: DeFiLlama lists some chains as
 * dummy protocol entries (module "dummy.js", category "Chain", tvl null,
 * empty chainTvls — e.g. slug "ethereum"). Such an entry carries no TVL
 * reading, so it must never win a protocol match over the real chain of the
 * same name; it is skipped in protocol matching when that chain exists.
 */
function isChainPlaceholder(p: ProtocolEntry): boolean {
  return p.category === 'Chain' && (p.tvl === null || p.tvl === undefined);
}

interface ChainEntry {
  name: string;
  gecko_id?: string | null;
  tvl?: number;
}

// ---------------------------------------------------------------------------
// Resolution (pure — unit-tested with local fixtures, no network)
// ---------------------------------------------------------------------------

export type TvlTarget =
  | { kind: 'protocol'; slug: string; displayName: string; confidence: number }
  | { kind: 'chain'; chain: string; displayName: string; confidence: number };

/**
 * Resolve a raw `protocol` query value against the DeFiLlama protocols and
 * chains lists. Priority, first hit wins:
 *   1. exact protocol slug match (case-insensitive) -> confidence 1.0
 *   2. exact protocol name or symbol match (case-insensitive) -> 0.9
 *   3. exact chain name or gecko_id match (case-insensitive) -> 1.0
 *   4. protocol slug/name prefix fallback (e.g. "uniswap" -> "uniswap-v3"):
 *      first entry in list order wins (DeFiLlama lists protocols roughly
 *      TVL-descending, so the largest variant wins) -> 0.9
 * Chain-placeholder exception: a protocols-list entry that is a dummy chain
 * placeholder (category "Chain", tvl null — e.g. slug "ethereum") is skipped
 * in steps 1-2 when the same name exactly matches a chain, so "ethereum"
 * resolves as the chain, not as the TVL-less stub. Without this the chain
 * path would be unreachable for every chain that has such a placeholder.
 * Returns null when nothing matches; the caller turns that into a 422.
 * Matching is exact/prefix only — no substring guessing, fail closed.
 */
export function resolveTvlTarget(
  input: string,
  protocols: ProtocolEntry[],
  chains: ChainEntry[],
): TvlTarget | null {
  const normalized = input.trim().toLowerCase();
  if (normalized === '') return null;

  // Exact chain match, computed first so chain placeholders (below) can defer
  // to it — but only returned at step 3, after real protocol matches.
  const chainExact: ChainEntry | null =
    chains.find(
      (c) =>
        (typeof c.name === 'string' && c.name.toLowerCase() === normalized) ||
        (typeof c.gecko_id === 'string' && c.gecko_id.toLowerCase() === normalized),
    ) ?? null;

  for (const p of protocols) {
    if (typeof p.slug === 'string' && p.slug.toLowerCase() === normalized) {
      if (chainExact !== null && isChainPlaceholder(p)) continue;
      return { kind: 'protocol', slug: p.slug, displayName: p.name, confidence: 1.0 };
    }
  }
  for (const p of protocols) {
    if (chainExact !== null && isChainPlaceholder(p)) continue;
    if (typeof p.name === 'string' && p.name.toLowerCase() === normalized) {
      return { kind: 'protocol', slug: p.slug, displayName: p.name, confidence: 0.9 };
    }
    if (typeof p.symbol === 'string' && p.symbol.toLowerCase() === normalized) {
      return { kind: 'protocol', slug: p.slug, displayName: p.name, confidence: 0.9 };
    }
  }
  if (chainExact !== null) {
    return {
      kind: 'chain',
      chain: chainExact.name,
      displayName: chainExact.name,
      confidence: 1.0,
    };
  }
  for (const p of protocols) {
    if (typeof p.slug === 'string' && p.slug.toLowerCase().startsWith(normalized)) {
      return { kind: 'protocol', slug: p.slug, displayName: p.name, confidence: 0.9 };
    }
    if (typeof p.name === 'string' && p.name.toLowerCase().startsWith(normalized)) {
      return { kind: 'protocol', slug: p.slug, displayName: p.name, confidence: 0.9 };
    }
  }
  return null;
}

/**
 * Dominant-chain TVL from a protocol's `currentChainTvls` snapshot: the
 * largest per-chain value, ignoring `*-borrowed` entries (borrowed coins are
 * not locked value). Returns null — never 0 — when no per-chain split
 * applies (missing/empty map, or no positive value).
 */
export function dominantChainTvl(
  currentChainTvls: Record<string, number> | undefined | null,
): number | null {
  if (!currentChainTvls || typeof currentChainTvls !== 'object') return null;
  let best: number | null = null;
  for (const [chain, value] of Object.entries(currentChainTvls)) {
    if (chain.endsWith('-borrowed')) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Upstream payload parsing (pure — unit-tested with local fixtures)
// ---------------------------------------------------------------------------

export interface ProtocolReading {
  tvlUsd: number;
  chainTvlUsd: number | null;
  asOf: string;
}

interface ProtocolPayload {
  tvl?: Array<{ date?: number; totalLiquidityUSD?: number }>;
  currentChainTvls?: Record<string, number>;
}

/**
 * Latest point of a GET /protocol/{slug} payload: the last `tvl` entry with
 * a finite totalLiquidityUSD. Throws a 502 ApiError when the payload has no
 * usable TVL history (malformed upstream response, never a guess).
 */
export function parseProtocolReading(payload: ProtocolPayload): ProtocolReading {
  const history = Array.isArray(payload.tvl) ? payload.tvl : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const point = history[i];
    const tvl = point?.totalLiquidityUSD;
    const date = point?.date;
    if (
      typeof tvl === 'number' &&
      Number.isFinite(tvl) &&
      typeof date === 'number' &&
      Number.isFinite(date)
    ) {
      return {
        tvlUsd: tvl,
        chainTvlUsd: dominantChainTvl(payload.currentChainTvls),
        asOf: new Date(date * 1000).toISOString(),
      };
    }
  }
  throw upstreamUnavailable(
    'DEFILLAMA_BAD_RESPONSE',
    'DeFiLlama protocol response has no usable TVL history',
  );
}

export interface ChainReading {
  tvlUsd: number;
  asOf: string;
}

/**
 * Latest point of a GET /v2/historicalChainTvl/{chain} payload: the last
 * entry with a finite `tvl`. Throws a 502 ApiError when the payload has no
 * usable point (malformed upstream response, never a guess).
 */
export function parseChainReading(
  payload: Array<{ date?: number; tvl?: number }>,
): ChainReading {
  const history = Array.isArray(payload) ? payload : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const point = history[i];
    const tvl = point?.tvl;
    const date = point?.date;
    if (
      typeof tvl === 'number' &&
      Number.isFinite(tvl) &&
      typeof date === 'number' &&
      Number.isFinite(date)
    ) {
      return { tvlUsd: tvl, asOf: new Date(date * 1000).toISOString() };
    }
  }
  throw upstreamUnavailable(
    'DEFILLAMA_BAD_RESPONSE',
    'DeFiLlama historical chain TVL response has no usable point',
  );
}

// ---------------------------------------------------------------------------
// Lists cache (in-memory, 24h TTL; stale cache reused on fetch failure)
// ---------------------------------------------------------------------------

let protocolsCache: { data: ProtocolEntry[]; fetchedAt: number } | null = null;
let chainsCache: { data: ChainEntry[]; fetchedAt: number } | null = null;

/** Test hook: clear the in-memory lists caches. */
export function __clearTvlCachesForTests(): void {
  protocolsCache = null;
  chainsCache = null;
}

/** Test hook: seed the in-memory lists caches (avoids live list fetches). */
export function __seedTvlCachesForTests(
  protocols: ProtocolEntry[],
  chains: ChainEntry[],
): void {
  const now = Date.now();
  protocolsCache = { data: protocols, fetchedAt: now };
  chainsCache = { data: chains, fetchedAt: now };
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchText(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw upstreamUnavailable(
        'DEFILLAMA_UNAVAILABLE',
        `DeFiLlama returned HTTP ${res.status} for ${url}`,
      );
    }
    return await res.text();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const timedOut = controller.signal.aborted;
    throw upstreamUnavailable(
      'DEFILLAMA_UNAVAILABLE',
      timedOut
        ? `DeFiLlama fetch timed out after ${timeoutMs}ms for ${url}`
        : `DeFiLlama fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function loadLists(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ protocols: ProtocolEntry[]; chains: ChainEntry[] }> {
  const now = Date.now();
  const [protocols, chains] = await Promise.all([
    (async (): Promise<ProtocolEntry[]> => {
      if (protocolsCache && now - protocolsCache.fetchedAt < LISTS_TTL_MS) {
        return protocolsCache.data;
      }
      try {
        const raw = await fetchText(PROTOCOLS_URL, fetchImpl, timeoutMs);
        const data = JSON.parse(raw) as ProtocolEntry[];
        if (!Array.isArray(data)) {
          throw upstreamUnavailable(
            'DEFILLAMA_BAD_RESPONSE',
            'DeFiLlama protocols response is not an array',
          );
        }
        protocolsCache = { data, fetchedAt: Date.now() };
        return data;
      } catch (err) {
        // On failure reuse the last cache, even if stale; only fail when
        // there is no cache at all. A 422 verdict ("no match in either
        // list") is only sound if both lists were actually consulted, so a
        // missing protocols list is a 502, not a silent empty list.
        if (protocolsCache) return protocolsCache.data;
        throw err;
      }
    })(),
    (async (): Promise<ChainEntry[]> => {
      if (chainsCache && now - chainsCache.fetchedAt < LISTS_TTL_MS) {
        return chainsCache.data;
      }
      try {
        const raw = await fetchText(CHAINS_URL, fetchImpl, timeoutMs);
        const data = JSON.parse(raw) as ChainEntry[];
        if (!Array.isArray(data)) {
          throw upstreamUnavailable(
            'DEFILLAMA_BAD_RESPONSE',
            'DeFiLlama chains response is not an array',
          );
        }
        chainsCache = { data, fetchedAt: Date.now() };
        return data;
      } catch (err) {
        if (chainsCache) return chainsCache.data;
        throw err;
      }
    })(),
  ]);
  return { protocols, chains };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function formatUsd(value: number): string {
  return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export async function handleTvl(
  query: Record<string, string | undefined>,
  deps: TvlDeps = {},
): Promise<Record<string, unknown>> {
  const fetchImpl: typeof fetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;

  const protocolRaw = query.protocol;
  if (protocolRaw === undefined || protocolRaw.trim() === '') {
    throw badRequest('MISSING_PROTOCOL', 'Query parameter "protocol" is required');
  }
  const protocol = protocolRaw.trim();
  if (protocol.length > 512) {
    throw badRequest(
      'PROTOCOL_TOO_LONG',
      'Query parameter "protocol" must not exceed 512 characters',
    );
  }

  const { protocols, chains } = await loadLists(fetchImpl, timeoutMs);
  const target = resolveTvlTarget(protocol, protocols, chains);
  if (target === null) {
    throw unprocessable(
      'PROTOCOL_NOT_FOUND',
      `No DeFiLlama protocol or chain matches "${protocol}"`,
    );
  }

  // --- Protocol path: reading from GET /protocol/{slug}. ---
  if (target.kind === 'protocol') {
    const upstreamUrl = PROTOCOL_URL(target.slug);
    const rawBody = await fetchText(upstreamUrl, fetchImpl, timeoutMs);
    let payload: ProtocolPayload;
    try {
      payload = JSON.parse(rawBody) as ProtocolPayload;
    } catch {
      throw upstreamUnavailable(
        'DEFILLAMA_BAD_RESPONSE',
        `DeFiLlama protocol response for "${target.slug}" is not valid JSON`,
      );
    }
    const reading = parseProtocolReading(payload);
    const receipt = makeReceipt(INTENT, upstreamUrl, rawBody, '1/1 primary source');
    return envelope(
      INTENT,
      {
        protocol_or_chain: target.slug,
        tvl_usd: reading.tvlUsd,
        chain_tvl_usd: reading.chainTvlUsd,
        as_of: reading.asOf,
      },
      receipt,
      {
        answer: `${target.displayName} has a total value locked of ${formatUsd(reading.tvlUsd)}.`,
        verdict: 'verified',
        confidence: target.confidence,
        source: `DeFiLlama API (${upstreamUrl})`,
      },
    );
  }

  // --- Chain path: the request names a blockchain, not a protocol.
  // Reading comes from GET /v2/historicalChainTvl/{chain} (latest point),
  // not from the /v2/chains entry's `tvl` field, which carries no timestamp.
  // chain_tvl_usd is the TVL on the named chain, which IS the chain TVL. ---
  const upstreamUrl = HISTORICAL_CHAIN_TVL_URL(target.chain);
  const rawBody = await fetchText(upstreamUrl, fetchImpl, timeoutMs);
  let payload: Array<{ date?: number; tvl?: number }>;
  try {
    payload = JSON.parse(rawBody) as Array<{ date?: number; tvl?: number }>;
  } catch {
    throw upstreamUnavailable(
      'DEFILLAMA_BAD_RESPONSE',
      `DeFiLlama historical chain TVL response for "${target.chain}" is not valid JSON`,
    );
  }
  const reading = parseChainReading(payload);
  const receipt = makeReceipt(INTENT, upstreamUrl, rawBody, '1/1 primary source');
  return envelope(
    INTENT,
    {
      protocol_or_chain: target.chain,
      tvl_usd: reading.tvlUsd,
      chain_tvl_usd: reading.tvlUsd,
      as_of: reading.asOf,
    },
    receipt,
    {
      answer: `${target.displayName} has a total value locked of ${formatUsd(reading.tvlUsd)}.`,
      verdict: 'verified',
      confidence: target.confidence,
      source: `DeFiLlama API (${upstreamUrl})`,
    },
  );
}
