import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('../src/core/storage', () => ({ saveReceipt: vi.fn(async () => {}) }));
import { saveReceipt } from '../src/core/storage';
import { handleValidator, resetValidatorCachesForTests } from '../src/handlers/validator';
const raw = readFileSync('tests/fixtures/validator-finalized-record.json', 'utf8');
// Synthetic transport root only, not claimed as the fixture's acquisition root.
const root = '0x' + 'ac'.repeat(32);
beforeEach(() => { resetValidatorCachesForTests(); vi.clearAllMocks(); });
function transport(body: string): typeof fetch {
 return async input => {
  const url = String(input);
  if (url.endsWith('/root')) return new Response(JSON.stringify({ data: { root }, finalized: true, execution_optimistic: false }));
  if (url.endsWith('/validators/0')) return new Response(body);
  throw new Error('no captured enrichment');
 };
}
describe('effective balance first, no data changes', () => {
 it('replays actual record and persists the exact original bytes', async () => {
  const result = await handleValidator({ validator_index: '0' }, { fetchImpl: transport(raw) });
  expect(result.answer).toMatch(/^Validator 0 effective balance is 34000000000 gwei \(34 ETH\)\./);
  expect(result.answer).toContain('balance 34.302537532 ETH');
  expect(result.answer).toContain('has not been slashed');
  expect(result.answer).toContain('far-future sentinel');
  expect(result.answer).toContain(root);
  expect(result).toMatchObject({ effective_balance: 34000000000, balance: '34302537532', status: 'active_ongoing', confidence: 1, finalized_state_root: root });
  expect(vi.mocked(saveReceipt).mock.calls[0][1]).toBe(raw);
 });
 it.each([['0', '0'], ['1', '0.000000001'], ['2048000000000', '2048']])('keeps effective %s separate from actual balance', async (value, eth) => {
  const body = JSON.parse(raw); body.data.validator.effective_balance = value;
  const result = await handleValidator({ validator_index: '0' }, { fetchImpl: transport(JSON.stringify(body)) });
  expect(result.answer).toMatch(new RegExp(`^Validator 0 effective balance is ${value} gwei`));
  expect(result.answer).toContain(`(${eth} ETH).`);
  expect(result.balance).toBe('34302537532');
  expect(result.effective_balance).toBe(Number(value));
 });
});
