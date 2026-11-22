import { afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('../src/core/storage', () => ({ saveReceipt: vi.fn(async () => { }) }));
import { handleOnchainMetric } from '../src/handlers/onchainMetric';
const address = '0x' + '0'.repeat(40);
const hash = '0x' + 'a'.repeat(64);
function stub(change?: (host: string, m: string, result: any, n: number) => any) { const counts = new Map<string, number>(); const f = vi.fn(async (u: string, o: any) => { const q = JSON.parse(o.body); const key = u + q.method; const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); let result: any = q.method === 'eth_chainId' ? '0x1' : q.method === 'eth_getBlockByNumber' ? { number: q.params[0] === 'finalized' ? '0x100' : '0x64', hash } : q.method === 'eth_getBalance' ? '0xde0b6b3a7640000' : '0x3'; if (change)
    result = change(u, q.method, result, n); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result })); }); vi.stubGlobal('fetch', f); return f; }
afterEach(() => vi.unstubAllGlobals());
describe('isolated synthetic finalized state checks, no network', () => {
    it('reports native Gwei, exact wei and nonce with evidence', async () => { const f = stub(); const r = await handleOnchainMetric({ address, block: '100' }); expect(r.balance_gwei).toBe(1e9); expect(r.balance_wei).toBe('1000000000000000000'); expect(r.tx_count).toBe(3); expect(r.block_hash).toBe(hash); expect(f).toHaveBeenCalledTimes(12); });
    it('validates before network', async () => { const f = stub(); for (const q of [{ address: 'not-address', block: '100' }, { address, block: '-1' }, { address, block: '100', chain: 'sepolia' }, { address, block: '100', metric: 'received' }])
        await expect(handleOnchainMetric(q)).rejects.toMatchObject({ status: 400 }); expect(f).not.toHaveBeenCalled(); });
    it('requires same hash, balance AND nonce, not just a balance', async () => { let i = 0; const ids = new Map<string, number>(); stub((u, m, r) => { if (!ids.has(u))
        ids.set(u, ++i); return m === 'eth_getTransactionCount' ? '0x' + ids.get(u)!.toString(16) : r; }); await expect(handleOnchainMetric({ address, block: '100' })).rejects.toMatchObject({ code: 'METRIC_QUORUM_UNAVAILABLE' }); });
    it('refuses wrong chain', async () => { stub((_u, m, r) => m === 'eth_chainId' ? '0x89' : r); await expect(handleOnchainMetric({ address, block: '100' })).rejects.toMatchObject({ status: 502 }); });
    it('refuses reorg and unfinalized states', async () => { stub((_u, m, r, n) => m === 'eth_getBlockByNumber' && n === 3 ? { ...r, hash: '0x' + 'b'.repeat(64) } : r); await expect(handleOnchainMetric({ address, block: '100' })).rejects.toMatchObject({ status: 502 }); stub((_u, m, r) => m === 'eth_getBlockByNumber' ? { ...r, number: '0x63' } : r); await expect(handleOnchainMetric({ address, block: '100' })).rejects.toMatchObject({ status: 502 }); });
    it('does not follow a redirect or accept an RPC error as zero', async () => { const f = vi.fn(async (_u: string, o: any) => { expect(o.redirect).toBe('error'); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'offline' } })); }); vi.stubGlobal('fetch', f); await expect(handleOnchainMetric({ address, block: '100' })).rejects.toMatchObject({ status: 502 }); });
});
