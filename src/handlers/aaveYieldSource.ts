// On-chain Aave v3 supply-rate source (expansion slice, 2026-11-23).
//
// Reads AaveProtocolDataProvider.getReserveData(underlying) at one pinned
// finalized Ethereum block through two agreeing RPC legs - the same pin
// pattern as pinnedFeedReader.ts, copied (not refactored) per repo
// doctrine because the call set and decoding differ. No third-party
// aggregator, no key, no terms risk: the observation is public chain
// state. The answer is the liquidity (supply) rate ONLY; incentive and
// reward programs are excluded and the components string says so.
//
// Primary-source verification (2026-11-23):
//   Pool 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2 and
//   AAVE_PROTOCOL_DATA_PROVIDER 0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD
//     - official aave-address-book, modules/AaveV3Ethereum.json
//   Rate semantics: liquidityRate is a per-second APR in RAY (1e27);
//   deposit APY = (1 + rate/1e27/31536000)^31536000 - 1
//     - aave.com/docs/aave-v3/smart-contracts/view-contracts (tuple order)
//   Selector 0x35ea6a75 = getReserveData(address) - 4byte.directory.

import { rpcCall, assertHexQty, isRecord } from '../core/evmRpc';
import type { ObservationSource, SourceApproval } from '../core/observedSources';
import type { YieldQuery, YieldValue } from './financeObservations';

const GET_RESERVE_DATA_SELECTOR = '0x35ea6a75';
const RAY = 1e27;
const SECONDS_PER_YEAR = 31536000;
const HEX_RE = /^0x[0-9a-fA-F]*$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
/** Flat getReserveData tuple on the v3 PoolDataProvider (12 words):
 * 0 unbacked, 1 accruedToTreasuryScaled, 2 totalAToken, 3 totalStableDebt,
 * 4 totalVariableDebt, 5 liquidityRate, 6 variableBorrowRate,
 * 7 stableBorrowRate, 8 averageStableBorrowRate, 9 liquidityIndex,
 * 10 variableBorrowIndex, 11 lastUpdateTimestamp. */
const WORDS = 12;
const LIQUIDITY_RATE_WORD = 5;
const LAST_UPDATE_WORD = 11;

export interface AaveReserveBinding {
    project: string;
    symbol: string;
    chain: string;
    chainId: string;
    underlying: string;
    dataProvider: string;
    registryUrl: string;
}
export interface AaveRpcLeg {
    /** May carry credentials; never published. */
    rpcUrl: string;
    /** Credential-free public endpoint recorded in receipts. */
    evidenceUrl: string;
}
interface PinnedReserveRead {
    blockNumber: string;
    blockHash: string;
    blockTimestamp: string;
    rawReturn: string;
    rawEvidence: string;
    evidenceUrl: string;
}
function parseBlock(result: unknown): { number: bigint; hash: string; timestamp: bigint } {
    if (!isRecord(result) || typeof result.number !== 'string' || typeof result.hash !== 'string' || typeof result.timestamp !== 'string')
        throw new Error('malformed pinned block');
    assertHexQty(result.number, 'pinned block number');
    assertHexQty(result.timestamp, 'pinned block timestamp');
    if (!HASH_RE.test(result.hash))
        throw new Error('malformed pinned block hash');
    return { number: BigInt(result.number), hash: result.hash, timestamp: BigInt(result.timestamp) };
}
/** One leg: verify chain identity, pin the finalized block, read
 * getReserveData at that exact block, then re-read the block and require
 * the identical hash. Any deviation throws; the leg is simply lost. */
async function readLeg(binding: AaveReserveBinding, leg: AaveRpcLeg, signal: AbortSignal): Promise<PinnedReserveRead> {
    const raw: { method: string; params: unknown[]; rawText: string }[] = [];
    const live = () => { if (signal.aborted)
        throw new Error('source deadline'); };
    const call = async (method: string, params: unknown[]): Promise<unknown> => {
        live();
        const { result, rawText } = await rpcCall(leg.rpcUrl, method, params, signal);
        raw.push({ method, params, rawText });
        return result;
    };
    const chainHex = await call('eth_chainId', []);
    if (typeof chainHex !== 'string' || !HEX_RE.test(chainHex) || BigInt(chainHex).toString() !== binding.chainId)
        throw new Error('leg chain identity mismatch');
    const pinned = parseBlock(await call('eth_getBlockByNumber', ['finalized', false]));
    const tag = '0x' + pinned.number.toString(16);
    const data = GET_RESERVE_DATA_SELECTOR + binding.underlying.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    const rawReturn = await call('eth_call', [{ to: binding.dataProvider, data }, tag]);
    if (typeof rawReturn !== 'string' || !HEX_RE.test(rawReturn) || rawReturn.length !== 2 + WORDS * 64)
        throw new Error('malformed reserve data');
    const after = parseBlock(await call('eth_getBlockByNumber', [tag, false]));
    if (after.number !== pinned.number || after.hash !== pinned.hash)
        throw new Error('pinned block changed during read');
    return { blockNumber: pinned.number.toString(), blockHash: pinned.hash, blockTimestamp: new Date(Number(pinned.timestamp) * 1000).toISOString(), rawReturn, rawEvidence: JSON.stringify(raw), evidenceUrl: leg.evidenceUrl };
}
function word(rawReturn: string, index: number): bigint {
    return BigInt('0x' + rawReturn.slice(2 + index * 64, 2 + (index + 1) * 64));
}
/** Per-second RAY APR -> compounded APY in basis points, Aave's own formula. */
export function liquidityRateRayToApyBps(rateRay: bigint): number {
    if (rateRay < 0n || rateRay > 10n ** 27n)
        throw new Error('liquidity rate outside canonical range');
    const apr = Number(rateRay) / RAY;
    const apy = Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1;
    return Math.round(apy * 10000);
}
/** Unconfigured provider factory: no reserve binding is enabled here. */
export function aaveYieldSource(bindings: readonly AaveReserveBinding[], legs: readonly AaveRpcLeg[], approval: SourceApproval): ObservationSource<YieldQuery, YieldValue> {
    if (legs.length < 2)
        throw new Error('aave yield source needs at least two legs');
    for (const l of legs) {
        if (new URL(l.rpcUrl).protocol !== 'https:' || new URL(l.evidenceUrl).protocol !== 'https:')
            throw new Error('RPC leg must be https');
    }
    return {
        name: 'Aave v3 on-chain reserve liquidity rate', approval,
        read: async (q, signal) => {
            const matches = bindings.filter(b => b.project.toLowerCase() === q.project.toLowerCase() && b.symbol.toUpperCase() === q.symbol.toUpperCase() && b.chain.toLowerCase() === q.chain.toLowerCase());
            if (matches.length !== 1)
                throw new Error('no unambiguous reviewed reserve binding');
            const b = matches[0];
            if (!/^[0-9]+$/.test(b.chainId) || !/^0x[0-9a-fA-F]{40}$/.test(b.underlying) || !/^0x[0-9a-fA-F]{40}$/.test(b.dataProvider) || new URL(b.registryUrl).protocol !== 'https:')
                throw new Error('invalid reviewed reserve binding');
            const reads: PinnedReserveRead[] = [];
            for (const leg of legs) {
                if (signal.aborted)
                    throw new Error('source deadline');
                try {
                    const r = await readLeg(b, leg, signal);
                    if (reads.length && (reads[0].blockNumber !== r.blockNumber || reads[0].blockHash !== r.blockHash || reads[0].rawReturn !== r.rawReturn))
                        continue;
                    reads.push(r);
                    if (reads.length === 2)
                        break;
                }
                catch {
                    // lost leg
                }
            }
            if (reads.length < 2)
                throw new Error('no two-leg pinned quorum');
            const r = reads[0];
            const blockTime = Date.parse(r.blockTimestamp);
            if (!Number.isFinite(blockTime) || Date.now() - blockTime > 45 * 60000 || blockTime > Date.now() + 30000)
                throw new Error('pinned block is stale');
            const rateRay = word(r.rawReturn, LIQUIDITY_RATE_WORD);
            const lastUpdate = Number(word(r.rawReturn, LAST_UPDATE_WORD));
            if (!Number.isFinite(lastUpdate) || lastUpdate * 1000 > blockTime + 30000)
                throw new Error('reserve update newer than pinned block');
            const apyBps = liquidityRateRayToApyBps(rateRay);
            const observedAt = r.blockTimestamp;
            const fetchedAt = new Date().toISOString();
            return {
                identity: JSON.stringify([b.project.toLowerCase(), b.symbol.toLowerCase(), b.chain.toLowerCase()]),
                sourceUrl: r.evidenceUrl,
                rawBody: JSON.stringify({ binding: b, block_number: r.blockNumber, block_hash: r.blockHash, block_timestamp: r.blockTimestamp, rpc_quorum: 2, raw_reserve_data: r.rawReturn, liquidity_rate_ray: rateRay.toString(), last_update_timestamp: lastUpdate, rate_semantics: 'liquidityRate is a per-second APR in RAY (1e27); APY = (1 + rate/1e27/31536000)^31536000 - 1', raw_rpc_evidence: reads.map(read => ({source_url:read.evidenceUrl,raw_body:read.rawEvidence})) }),
                observedAt,
                fetchedAt,
                value: { project: b.project, symbol: b.symbol, chain: b.chain, supplyApyBps: apyBps, components: 'on-chain liquidity (supply) rate only; incentives and rewards excluded' },
            };
        },
    };
}
