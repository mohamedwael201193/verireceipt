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

it('keeps per-call closed state/outcome and effective balance only in process-local metadata',async()=>{
 const {answerDiagnostics,sanitizeAnswerClass}=await import('../src/core/answerClass');
 const a=await handleValidator({validator_index:'0'},{fetchImpl:transport(raw)});
 expect(answerDiagnostics('VALIDATOR_PERFORMANCE_VERIFY_GENERAL',a).answerClass).toEqual({validator_outcome:'verified',validator_state:'finalized',effective_balance:34000000000});
 expect(JSON.stringify(a)).not.toContain('validator_outcome');
 const b=await handleValidator({validator_index:'0'},{fetchImpl:transport(raw)});
 expect(answerDiagnostics('VALIDATOR_PERFORMANCE_VERIFY_GENERAL',a).answerClass?.validator_outcome).toBe('verified');
 expect(answerDiagnostics('VALIDATOR_PERFORMANCE_VERIFY_GENERAL',b).answerClass).toEqual({validator_outcome:'cache_hit',validator_state:'finalized',effective_balance:34000000000});
 const e=await handleValidator({validator_index:'bad'}).catch(e=>e);
 expect(answerDiagnostics('VALIDATOR_PERFORMANCE_VERIFY_GENERAL',e).answerClass).toEqual({validator_outcome:'refused'});
 expect(sanitizeAnswerClass('VALIDATOR_PERFORMANCE_VERIFY_GENERAL',{validator_outcome:'PRIVATE',validator_state:'PRIVATE',effective_balance:-1})).toBeUndefined();
 expect(sanitizeAnswerClass('VALIDATOR_PERFORMANCE_VERIFY_GENERAL',Object.defineProperty({},'effective_balance',{get(){throw Error('PRIVATE');}}))).toBeUndefined();
});

it('completion logging includes latency plus safe validator class, not the index or pubkey',async()=>{
 const {answerDiagnostics}=await import('../src/core/answerClass');const {recordRequestCompletion}=await import('../src/core/requestMetrics');
 const result=await handleValidator({validator_index:'0'},{fetchImpl:transport(raw)});
 const log=vi.spyOn(console,'info').mockImplementation(()=>{});
 try{recordRequestCompletion('/v1/validator',200,2345.67,{query:{validator_index:'PRIVATE'},...answerDiagnostics('VALIDATOR_PERFORMANCE_VERIFY_GENERAL',result)});
 const row=JSON.parse(String(log.mock.calls[0][0]));expect(row.latency_ms).toBe(2345.7);expect(row.answer_class).toEqual({validator_outcome:'verified',validator_state:'finalized',effective_balance:34000000000});expect(JSON.stringify(row)).not.toContain('PRIVATE');}
 finally{log.mockRestore();}
});
