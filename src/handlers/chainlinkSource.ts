import type { ObservationSource, SourceApproval } from '../core/observedSources';
import type { PriceQuery, PriceValue } from './financeObservations';
import { parseFeedDecimals, parseFeedDescription, parseChainlinkRound } from './chainlinkPrice';
export interface FeedBinding {
    symbol: string;
    chainId: string;
    proxy: string;
    registryUrl: string;
    maxAgeMs: number;
}
/** Reader must independently validate chain identity, pin one finalized block,
 * verify its hash before/after and return exact raw quorum evidence.
 * The credential-bearing RPC endpoint must never appear in evidenceUrl. */
export interface PinnedFeedRead {
    chainId: string;
    proxy: string;
    blockNumber: string;
    blockHash: string;
    blockTimestamp: string;
    decimalsAbi: string;
    descriptionAbi: string;
    roundAbi: string;
    rawEvidence: string;
    evidenceUrl: string;
    rpcQuorum: number;
}
export type PinnedFeedReader = (binding: FeedBinding, signal: AbortSignal) => Promise<PinnedFeedRead>;
/** Unconfigured provider factory, no registry, RPC or route is enabled here. */
export function chainlinkPriceSource(bindings: readonly FeedBinding[], reader: PinnedFeedReader, approval: SourceApproval): ObservationSource<PriceQuery, PriceValue> {
    return {
        name: 'Chainlink USD finalized proxy state', approval,
        read: async (query, signal) => {
            const matches = bindings.filter(b => b.symbol === query.symbol);
            if (matches.length !== 1)
                throw new Error('no unambiguous reviewed USD feed binding');
            const b = matches[0];
            if (!/^0x[0-9a-fA-F]{40}$/.test(b.proxy) || new URL(b.registryUrl).protocol !== 'https:' || !Number.isFinite(b.maxAgeMs) || b.maxAgeMs <= 0 || b.maxAgeMs > 60000)
                throw new Error('invalid current-price feed binding');
            const r = await reader(b, signal);
            if (signal.aborted)
                throw new Error('source deadline');
            if (r.chainId !== b.chainId || r.proxy.toLowerCase() !== b.proxy.toLowerCase() || !/^0x[0-9a-fA-F]{64}$/.test(r.blockHash) || !/^\d+$/.test(r.blockNumber) || r.rpcQuorum < 2)
                throw new Error('pinned feed identity/quorum mismatch');
            const blockTime = Date.parse(r.blockTimestamp);
            if (!Number.isFinite(blockTime) || Date.now() - blockTime > 5 * 60000 || blockTime > Date.now() + 30000)
                throw new Error('pinned block is stale');
            parseFeedDescription(r.descriptionAbi, query.symbol);
            const decimals = parseFeedDecimals(r.decimalsAbi);
            const round = parseChainlinkRound(r.roundAbi, decimals, b.maxAgeMs);
            if (Date.parse(round.updatedAt) > blockTime + 30000)
                throw new Error('round newer than pinned block');
            const u = new URL(r.evidenceUrl);
            if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
                throw new Error('evidence URL must be credential-free');
            const fetchedAt = new Date().toISOString();
            return { identity: JSON.stringify([query.symbol.toLowerCase()]), sourceUrl: r.evidenceUrl, rawBody: JSON.stringify({ binding: b, block_number: r.blockNumber, block_hash: r.blockHash, block_timestamp: r.blockTimestamp, rpc_quorum: r.rpcQuorum, round, raw_rpc_evidence: r.rawEvidence }), observedAt: round.updatedAt, fetchedAt, value: { symbol: query.symbol, priceUsd: round.priceUsd } };
        }
    };
}
