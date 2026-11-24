import { badRequest, upstreamUnavailable } from '../core/errors';
import { envelope, makeReceipt } from '../core/receipt';
import { saveReceipt } from '../core/storage';
import { CHAIN_RPCS } from '../config/chains';
import { normalizeChain } from './txLookup';
import { ADDRESS_RE } from './tokenContracts';
/** Exact native-unit text for presentation only; canonical numeric Gwei is unchanged. */
export function metricNativeText(wei: bigint): string {
    const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
    return `${wei / 10n ** 18n}${fraction ? '.' + fraction : ''}`;
}
const IDS: Record<string, string> = { ethereum: '0x1', polygon: '0x89', arbitrum: '0xa4b1' };
interface Leg {
    url: string;
    hash: string;
    balance: string;
    nonce: string;
    raw: string[];
}
async function call(url: string, method: string, params: unknown[], deadline: number): Promise<{
    result: any;
    raw: string;
}> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), Math.max(1, Math.min(1800, deadline - Date.now())));
    try {
        if (Date.now() >= deadline)
            throw new Error('metric deadline');
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), redirect: 'error', signal: abort.signal });
        if (!r.ok)
            throw new Error(`RPC HTTP ${r.status}`);
        const reader = r.body?.getReader();
        if (!reader)
            throw new Error('missing body');
        const parts: Uint8Array[] = [];
        let size = 0;
        try {
            while (true) {
                const p = await reader.read();
                if (p.done)
                    break;
                size += p.value.length;
                if (size > 65536) {
                    await reader.cancel();
                    throw new Error('RPC body limit');
                }
                parts.push(p.value);
            }
        }
        finally {
            reader.releaseLock();
        }
        const raw = Buffer.concat(parts).toString('utf8');
        const j = JSON.parse(raw);
        if (j.jsonrpc !== '2.0' || j.id !== 1 || j.error || !Object.hasOwn(j, 'result'))
            throw new Error('invalid RPC envelope');
        return { result: j.result, raw };
    }
    finally {
        clearTimeout(timer);
    }
}
const qty = (x: unknown): bigint => { if (typeof x !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(x))
    throw new Error('invalid hex quantity'); return BigInt(x); };
export async function handleOnchainMetric(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    const address = query.address?.trim();
    if (!address || !ADDRESS_RE.test(address))
        throw badRequest('INVALID_ADDRESS', 'an explicit EVM address is required');
    const b = query.block?.trim();
    if (!b || !/^\d{1,13}$/.test(b) || BigInt(b) > 1000000000000n)
        throw badRequest('INVALID_BLOCK', 'block must be an integer from 0 to 1000000000000');
    const block = BigInt(b);
    const tag = '0x' + block.toString(16);
    const chain = normalizeChain(query.chain ?? 'ethereum');
    if (!chain || !IDS[chain])
        throw badRequest('UNSUPPORTED_CHAIN', 'supported chains: ethereum, polygon, arbitrum');
    const metric = query.metric ?? 'balance';
    if (!['balance', 'tx_count'].includes(metric))
        throw badRequest('INVALID_METRIC', 'metric must be balance or tx_count');
    const deadline = Date.now() + 9000;
    const legs: Leg[] = [];
    const errors: string[] = [];
    for (const url of CHAIN_RPCS[chain]) {
        try {
            const raw: string[] = [];
            const request = async (m: string, p: unknown[]) => { const x = await call(url, m, p, deadline); raw.push(x.raw); return x.result; };
            if (qty(await request('eth_chainId', [])) !== qty(IDS[chain]))
                throw new Error('wrong chain');
            const finalized = await request('eth_getBlockByNumber', ['finalized', false]);
            if (!finalized || qty(finalized.number) < block)
                throw new Error('block is not finalized');
            const before = await request('eth_getBlockByNumber', [tag, false]);
            if (!before || qty(before.number) !== block || !/^0x[0-9a-fA-F]{64}$/.test(before.hash))
                throw new Error('wrong block identity');
            const balance = qty(await request('eth_getBalance', [address, tag]));
            const nonce = qty(await request('eth_getTransactionCount', [address, tag]));
            const after = await request('eth_getBlockByNumber', [tag, false]);
            if (!after || after.hash?.toLowerCase() !== before.hash.toLowerCase() || qty(after.number) !== block)
                throw new Error('block identity changed');
            if (balance > 10n ** 29n || nonce > 1000000000000n)
                throw new Error('value outside canonical range');
            legs.push({ url, hash: before.hash.toLowerCase(), balance: balance.toString(), nonce: nonce.toString(), raw });
        }
        catch {
            errors.push(url);
        }
        const groups = new Map<string, Leg[]>();
        for (const leg of legs) {
            const k = [leg.hash, leg.balance, leg.nonce].join(':');
            groups.set(k, [...(groups.get(k) ?? []), leg]);
        }
        const wins = [...groups.values()].find(v => v.length >= 2);
        if (!wins)
            continue;
        const w = wins[0];
        const wei = BigInt(w.balance);
        const balanceGwei = Number(wei / 1000000000n) + Number(wei % 1000000000n) / 1e9;
        const count = Number(w.nonce);
        const nativeSymbol = chain === 'polygon' ? 'POL' : 'ETH';
        const balanceSentence = `${address} held exactly ${metricNativeText(wei)} ${nativeSymbol} (${balanceGwei} Gwei) on ${chain} at finalized block ${block}.`;
        const evidence = JSON.stringify({ chain, address: address.toLowerCase(), block: block.toString(), block_hash: w.hash, balance_wei: w.balance, tx_count: w.nonce, sources: legs, unavailable_sources: errors });
        const receipt = makeReceipt('ONCHAIN_METRIC_VERIFY_GENERAL', w.url, evidence, `${wins.length}/${CHAIN_RPCS[chain].length} same finalized block hash, balance and nonce`);
        await saveReceipt(receipt, evidence);
        return envelope('ONCHAIN_METRIC_VERIFY_GENERAL', { address, chain, block: block.toString(), block_hash: w.hash, balance_gwei: balanceGwei, balance_wei: w.balance, tx_count: count, metric }, receipt, { answer: metric === 'balance' ? balanceSentence : `${address} had sent ${count} transactions (nonce) on ${chain} at finalized block ${block}. ${balanceSentence}`, verdict: 'verified', confidence: wins.length === CHAIN_RPCS[chain].length ? 1 : 0.95, source: `Block-pinned RPC agreement; ${w.url}; balance is Gwei, not ETH/POL; nonce is not received transfers.` });
    }
    throw upstreamUnavailable('METRIC_QUORUM_UNAVAILABLE', 'two sources did not agree on the exact finalized block identity, balance and nonce');
}
