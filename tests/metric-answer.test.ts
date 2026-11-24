import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('../src/core/storage', () => ({ saveReceipt: vi.fn(async () => {}) }));
import { handleOnchainMetric, metricNativeText } from '../src/handlers/onchainMetric';
import { saveReceipt } from '../src/core/storage';
const fixture = JSON.parse(readFileSync('tests/fixtures/onchain-metric/finalized-evidence.json', 'utf8'));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('exact native units, presentation only', () => {
 it.each([
  [0n, '0'], [1n, '0.000000000000000001'], [10n ** 18n, '1'],
  [14156889212130289945019n, '14156.889212130289945019'],
  [10n ** 29n, '100000000000'],
 ])('formats %s without a float round trip', (wei, text) => expect(metricNativeText(wei)).toBe(text));
 it.each([['ethereum', '0x1', 'ETH'], ['arbitrum', '0xa4b1', 'ETH'], ['polygon', '0x89', 'POL']])('labels %s native units without changing fields', async (chain, chainId, symbol) => {
  vi.stubGlobal('fetch', async (_url: string, options: any) => {
   const q = JSON.parse(options.body);
   const result = q.method === 'eth_chainId' ? chainId : q.method === 'eth_getBlockByNumber' ? { number: '0x64', hash: fixture.block_hash } : q.method === 'eth_getBalance' ? '0x1' : '0x0';
   return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  });
  const result = await handleOnchainMetric({ address: fixture.address, block: '100', chain });
  expect(result.answer).toContain(`held exactly 0.000000000000000001 ${symbol} (1e-9 Gwei)`);
  expect(result.balance_wei).toBe('1');
  expect(result.balance_gwei).toBe(1e-9);
 });
 it.each(['balance', 'tx_count'])('replays unchanged actual evidence for %s', async metric => {
  const counters = new Map<string, number>();
  vi.stubGlobal('fetch', async (url: string) => {
   const source = fixture.sources.find((s: any) => s.url === url);
   if (!source) throw new Error('uncaptured provider');
   const index = counters.get(url) ?? 0; counters.set(url, index + 1);
   return new Response(source.raw[index]);
  });
  const result = await handleOnchainMetric({ address: fixture.address, block: fixture.block, metric });
  expect(result.balance_wei).toBe(fixture.balance_wei);
  expect(result.balance_gwei).toBe(14156889212130.29);
  expect(result.tx_count).toBe(0);
  expect(result.block_hash).toBe(fixture.block_hash);
  expect(result.confidence).toBe(0.95);
  expect(result.answer).toContain('held exactly 14156.889212130289945019 ETH (14156889212130.29 Gwei)');
  expect(result.answer).toContain('at finalized block 26400000');
  if (metric === 'tx_count') expect(result.answer).toBe(`${fixture.address} had sent 0 transactions (nonce) on ethereum at finalized block 26400000. ${fixture.address} held exactly 14156.889212130289945019 ETH (14156889212130.29 Gwei) on ethereum at finalized block 26400000.`);
  const written = vi.mocked(saveReceipt).mock.calls[0][1];
  expect(JSON.parse(written as string)).toEqual(fixture);
 });
});
