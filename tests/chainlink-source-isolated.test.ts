import { it, expect } from 'vitest';
import { chainlinkPriceSource, type PinnedFeedRead } from '../src/handlers/chainlinkSource';
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const abi = (xs: bigint[]) => '0x' + xs.map(word).join('');
const b = { symbol: 'BTC', chainId: '1', proxy: '0x' + '1'.repeat(40), registryUrl: 'https://example.org/registry', maxAgeMs: 60000 };
const approval = { termsUrl: 'https://example.org/terms', checkedAt: '2026-11-22T00:00:00Z', commercialUse: true as const, redistribution: true as const };
function sample(): PinnedFeedRead { const t = BigInt(Math.floor(Date.now() / 1000)); const text = Buffer.from('BTC / USD'); return { chainId: '1', proxy: b.proxy, blockNumber: '100', blockHash: '0x' + 'a'.repeat(64), blockTimestamp: new Date(Number(t) * 1000).toISOString(), decimalsAbi: abi([8n]), descriptionAbi: abi([32n, BigInt(text.length)]) + text.toString('hex').padEnd(64, '0'), roundAbi: abi([10n, 1230000000000n, t - 30n, t - 10n, 10n]), rawEvidence: 'synthetic quorum bytes', evidenceUrl: 'https://example.org/feed', rpcQuorum: 2 }; }
it('binds finalized round metadata to exact asset and raw evidence', async () => { const s = chainlinkPriceSource([b], async () => sample(), approval); const r = await s.read({ symbol: 'BTC' }, new AbortController().signal); expect(r.value.priceUsd).toBe(12300); expect(r.rawBody).toContain('synthetic quorum bytes'); });
it('refuses wrong chain/proxy, low quorum, stale block and credential-bearing URL', async () => { for (const patch of [{ chainId: '2' }, { proxy: '0x' + '2'.repeat(40) }, { rpcQuorum: 1 }, { blockTimestamp: '2000-01-01T00:00:00Z' }, { evidenceUrl: 'https://example.org/feed?key=synthetic' }]) {
    const s = chainlinkPriceSource([b], async () => ({ ...sample(), ...patch }), approval);
    await expect(s.read({ symbol: 'BTC' }, new AbortController().signal)).rejects.toThrow();
} });
it('does not silently choose another feed or long-heartbeat stale current quote', async () => { let calls = 0; const s = chainlinkPriceSource([{ ...b, maxAgeMs: 3600000 }], async () => { calls++; return sample(); }, approval); await expect(s.read({ symbol: 'BTC' }, new AbortController().signal)).rejects.toThrow(); expect(calls).toBe(0); await expect(s.read({ symbol: 'ETH' }, new AbortController().signal)).rejects.toThrow(); });
