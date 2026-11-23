import { rpcCall, assertHexQty, isRecord } from '../core/evmRpc';
import type { FeedBinding, PinnedFeedRead, PinnedFeedReader } from './chainlinkSource';

/** One RPC leg. rpcUrl may carry credentials and is never published;
 * evidenceUrl is the credential-free public endpoint recorded in receipts. */
export interface PinnedRpcLeg {
    rpcUrl: string;
    evidenceUrl: string;
}
const DECIMALS_SELECTOR = '0x313ce567';
const DESCRIPTION_SELECTOR = '0x7284e416';
const LATEST_ROUND_SELECTOR = '0xfeaf968c';
const HEX_RE = /^0x[0-9a-fA-F]*$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
interface RawCall {
    method: string;
    params: unknown[];
    rawText: string;
}
interface PinnedBlock {
    number: bigint;
    hash: string;
    timestamp: bigint;
}
function parseBlock(result: unknown): PinnedBlock {
    if (!isRecord(result) || typeof result.number !== 'string' || typeof result.hash !== 'string' || typeof result.timestamp !== 'string')
        throw new Error('malformed pinned block');
    assertHexQty(result.number, 'pinned block number');
    assertHexQty(result.timestamp, 'pinned block timestamp');
    if (!HASH_RE.test(result.hash))
        throw new Error('malformed pinned block hash');
    return { number: BigInt(result.number), hash: result.hash, timestamp: BigInt(result.timestamp) };
}
function parseHex(result: unknown, field: string): string {
    if (typeof result !== 'string' || !HEX_RE.test(result) || result.length < 3)
        throw new Error(`malformed ${field}`);
    return result;
}
type LegRead = Omit<PinnedFeedRead, 'rpcQuorum'>;
/** One leg: verify chain identity, pin the finalized block, read the three
 * feed ABIs at that exact block, then re-read the same block number and
 * require the identical hash, proving the pin did not move during the
 * reads. Any deviation throws; the leg is then simply lost. */
async function readLeg(binding: FeedBinding, leg: PinnedRpcLeg, signal: AbortSignal): Promise<LegRead> {
    const raw: RawCall[] = [];
    const live = () => { if (signal.aborted)
        throw new Error('source deadline'); };
    const call = async (method: string, params: unknown[]): Promise<unknown> => {
        live();
        const { result, rawText } = await rpcCall(leg.rpcUrl, method, params);
        raw.push({ method, params, rawText });
        return result;
    };
    const chainHex = parseHex(await call('eth_chainId', []), 'chain id');
    if (BigInt(chainHex).toString() !== binding.chainId)
        throw new Error('leg chain identity mismatch');
    const pinned = parseBlock(await call('eth_getBlockByNumber', ['finalized', false]));
    const tag = '0x' + pinned.number.toString(16);
    const decimalsAbi = parseHex(await call('eth_call', [{ to: binding.proxy, data: DECIMALS_SELECTOR }, tag]), 'decimals');
    const descriptionAbi = parseHex(await call('eth_call', [{ to: binding.proxy, data: DESCRIPTION_SELECTOR }, tag]), 'description');
    const roundAbi = parseHex(await call('eth_call', [{ to: binding.proxy, data: LATEST_ROUND_SELECTOR }, tag]), 'round');
    const after = parseBlock(await call('eth_getBlockByNumber', [tag, false]));
    if (after.number !== pinned.number || after.hash !== pinned.hash)
        throw new Error('pinned block changed during read');
    return { chainId: binding.chainId, proxy: binding.proxy, blockNumber: pinned.number.toString(), blockHash: pinned.hash, blockTimestamp: new Date(Number(pinned.timestamp) * 1000).toISOString(), decimalsAbi, descriptionAbi, roundAbi, rawEvidence: JSON.stringify(raw), evidenceUrl: leg.evidenceUrl };
}
function samePin(a: LegRead, b: LegRead): boolean {
    return a.chainId === b.chainId && a.proxy.toLowerCase() === b.proxy.toLowerCase() && a.blockNumber === b.blockNumber && a.blockHash === b.blockHash && a.decimalsAbi === b.decimalsAbi && a.descriptionAbi === b.descriptionAbi && a.roundAbi === b.roundAbi;
}
/** Real pinned feed reader. Legs run sequentially (the measured reliable
 * shape, see evmRpc.ts), the first pin with two agreeing legs wins, no
 * averaging; disagreement or fewer than two good legs fails closed.
 * Unconfigured factory: no leg, feed or route is enabled by this file. */
export function createPinnedFeedReader(legs: readonly PinnedRpcLeg[]): PinnedFeedReader {
    if (legs.length < 2)
        throw new Error('pinned feed reader needs at least two legs');
    for (const l of legs) {
        const rpc = new URL(l.rpcUrl);
        if (rpc.protocol !== 'https:')
            throw new Error('RPC leg must be https');
        const ev = new URL(l.evidenceUrl);
        if (ev.protocol !== 'https:' || ev.username || ev.password || ev.search || ev.hash)
            throw new Error('evidence URL must be credential-free');
    }
    return async (binding, signal) => {
        const successes: LegRead[] = [];
        const errors: string[] = [];
        for (const leg of legs) {
            if (signal.aborted)
                throw new Error('source deadline');
            try {
                successes.push(await readLeg(binding, leg, signal));
            }
            catch (e) {
                errors.push(String(e).split(leg.rpcUrl).join('<rpc>'));
            }
            const winner = successes.find(s => successes.filter(o => samePin(s, o)).length >= 2);
            if (winner)
                return { ...winner, rpcQuorum: successes.filter(o => samePin(winner, o)).length };
        }
        throw new Error(`pinned feed quorum unreachable (${successes.length}/${legs.length} legs pinned, ${errors.length} errored)`);
    };
}
