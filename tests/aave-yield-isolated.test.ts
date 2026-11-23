import { afterEach, it, expect, vi } from 'vitest';
vi.mock('../src/core/evmRpc', async original => ({ ...await original<typeof import('../src/core/evmRpc')>(), rpcCall: vi.fn() }));
import { rpcCall } from '../src/core/evmRpc';
import { aaveYieldSource, liquidityRateRayToApyBps, type AaveReserveBinding, type AaveRpcLeg } from '../src/handlers/aaveYieldSource';

const approval = { termsUrl: 'https://example.org/terms', checkedAt: '2026-11-23T00:00:00Z', commercialUse: true as const, redistribution: true as const };
const binding: AaveReserveBinding = { project: 'aave-v3', symbol: 'USDC', chain: 'ethereum', chainId: '1', underlying: '0x' + '11'.repeat(20), dataProvider: '0x' + '22'.repeat(20), registryUrl: 'https://assets.aave.com/address-book/releases/latest/modules/AaveV3Ethereum.json' };
const legs: AaveRpcLeg[] = [{ rpcUrl: 'https://rpc-a.example', evidenceUrl: 'https://rpc-a.example' }, { rpcUrl: 'https://rpc-b.example', evidenceUrl: 'https://rpc-b.example' }];
const BLOCK_HASH = '0x' + 'ab'.repeat(32);
function reserveReturn(rateRay: bigint, lastUpdate: number): string {
    const words = Array(12).fill(0n);
    words[5] = rateRay;
    words[11] = BigInt(lastUpdate);
    return '0x' + words.map(w => w.toString(16).padStart(64, '0')).join('');
}
function scriptLeg(urls: readonly string[], opts: { rateRay?: bigint; lastUpdate?: number; blockAgeSec?: number; fail?: boolean; differentReturn?: boolean }) {
    const now = Math.floor(Date.now() / 1000);
    const blockTs = now - (opts.blockAgeSec ?? 120);
    const lastUpdate = opts.lastUpdate ?? blockTs - 60;
    const block = { number: '0x10', hash: BLOCK_HASH, timestamp: '0x' + blockTs.toString(16) };
    (rpcCall as any).mockImplementation(async (u: string, method: string) => {
        if (!urls.includes(u))
            throw new Error('unexpected leg url');
        if (method === 'eth_chainId')
            return { result: '0x1', rawText: '{"result":"0x1"}' };
        if (method === 'eth_getBlockByNumber')
            return { result: block, rawText: '{"result":{}}' };
        if (method === 'eth_call') {
            if (opts.fail)
                throw new Error('leg rpc down');
            return { result: reserveReturn(opts.rateRay ?? 30000000000000000000000000n, opts.differentReturn ? lastUpdate - 5 : lastUpdate), rawText: '{"result":"0x"}' };
        }
        throw new Error('unexpected method ' + method);
    });
}
afterEach(() => vi.clearAllMocks());

it('RAY liquidity rate converts to compounded APY basis points with Aave formula', () => {
    expect(liquidityRateRayToApyBps(0n)).toBe(0);
    expect(Math.abs(liquidityRateRayToApyBps(10000000000000000000000000n) - 100.5)).toBeLessThan(1);
    expect(Math.abs(liquidityRateRayToApyBps(50000000000000000000000000n) - 512.7)).toBeLessThan(1);
    expect(() => liquidityRateRayToApyBps(10n ** 27n + 1n)).toThrow();
    expect(() => liquidityRateRayToApyBps(-1n)).toThrow();
});

it('two agreeing legs yield the on-chain rate with incentives excluded, observed at the reserve update', async () => {
    const now = Math.floor(Date.now() / 1000);
    const blockTs = now - 120;
    const lastUpdate = blockTs - 60;
    scriptLeg(['https://rpc-a.example', 'https://rpc-b.example'], { lastUpdate, blockAgeSec: 120 });
    const src = aaveYieldSource([binding], legs, approval);
    const obs = await src.read({ project: 'aave-v3', symbol: 'USDC', chain: 'ethereum' }, new AbortController().signal);
    expect(obs.value.supplyApyBps).toBe(liquidityRateRayToApyBps(30000000000000000000000000n));
    expect(obs.value.components).toContain('incentives');
    expect(obs.observedAt).toBe(new Date(lastUpdate * 1000).toISOString());
    expect(obs.identity).toBe(JSON.stringify(['aave-v3', 'usdc', 'ethereum']));
    expect(obs.rawBody).toContain('"rpc_quorum":2');
});

it('fewer than two good legs fails closed', async () => {
    const now = Math.floor(Date.now() / 1000);
    const block = { number: '0x10', hash: BLOCK_HASH, timestamp: '0x' + (now - 120).toString(16) };
    (rpcCall as any).mockImplementation(async (u: string, method: string) => {
        if (u === 'https://rpc-b.example')
            throw new Error('second leg down');
        if (method === 'eth_chainId') return { result: '0x1', rawText: '' };
        if (method === 'eth_getBlockByNumber') return { result: block, rawText: '' };
        if (method === 'eth_call') return { result: reserveReturn(30000000000000000000000000n, now - 180), rawText: '' };
        throw new Error('unexpected');
    });
    const src = aaveYieldSource([binding], legs, approval);
    await expect(src.read({ project: 'aave-v3', symbol: 'USDC', chain: 'ethereum' }, new AbortController().signal)).rejects.toThrow('no two-leg pinned quorum');
});

it('disagreeing reserve data across legs is not averaged', async () => {
    const now = Math.floor(Date.now() / 1000);
    const blockTs = now - 120;
    let legCalls = 0;
    (rpcCall as any).mockImplementation(async (u: string, method: string) => {
        if (method === 'eth_chainId') return { result: '0x1', rawText: '' };
        if (method === 'eth_getBlockByNumber') return { result: { number: '0x10', hash: BLOCK_HASH, timestamp: '0x' + blockTs.toString(16) }, rawText: '' };
        if (method === 'eth_call') { legCalls++; return { result: reserveReturn(legCalls === 1 ? 30000000000000000000000000n : 31000000000000000000000000n, blockTs - 60), rawText: '' }; }
        throw new Error('unexpected');
    });
    const src = aaveYieldSource([binding], legs, approval);
    await expect(src.read({ project: 'aave-v3', symbol: 'USDC', chain: 'ethereum' }, new AbortController().signal)).rejects.toThrow('no two-leg pinned quorum');
});

it('a reserve update newer than the pinned block is refused', async () => {
    const now = Math.floor(Date.now() / 1000);
    (rpcCall as any).mockImplementation(async (_u: string, method: string) => {
        if (method === 'eth_chainId') return { result: '0x1', rawText: '' };
        if (method === 'eth_getBlockByNumber') return { result: { number: '0x10', hash: BLOCK_HASH, timestamp: '0x' + (now - 120).toString(16) }, rawText: '' };
        if (method === 'eth_call') return { result: reserveReturn(30000000000000000000000000n, now - 30), rawText: '' };
        throw new Error('unexpected');
    });
    const src = aaveYieldSource([binding], legs, approval);
    await expect(src.read({ project: 'aave-v3', symbol: 'USDC', chain: 'ethereum' }, new AbortController().signal)).rejects.toThrow('newer than pinned block');
});

it('a stale pinned block (1 hour old) is refused', async () => {
    const now = Math.floor(Date.now() / 1000);
    const blockTs = now - 3600;
    const block = { number: '0x10', hash: BLOCK_HASH, timestamp: '0x' + blockTs.toString(16) };
    (rpcCall as any).mockImplementation(async (_u: string, method: string) => {
        if (method === 'eth_chainId') return { result: '0x1', rawText: '' };
        if (method === 'eth_getBlockByNumber') return { result: block, rawText: '' };
        if (method === 'eth_call') return { result: reserveReturn(30000000000000000000000000n, blockTs - 60), rawText: '' };
        throw new Error('unexpected');
    });
    const src = aaveYieldSource([binding], legs, approval);
    await expect(src.read({ project: 'aave-v3', symbol: 'USDC', chain: 'ethereum' }, new AbortController().signal)).rejects.toThrow('pinned block is stale');
});

it('unbound project or symbol throws before any RPC call', async () => {
    const src = aaveYieldSource([binding], legs, approval);
    await expect(src.read({ project: 'compound', symbol: 'USDC', chain: 'ethereum' }, new AbortController().signal)).rejects.toThrow('no unambiguous reviewed reserve binding');
    await expect(src.read({ project: 'aave-v3', symbol: 'WBTC', chain: 'ethereum' }, new AbortController().signal)).rejects.toThrow('no unambiguous reviewed reserve binding');
    expect(rpcCall).not.toHaveBeenCalled();
});
