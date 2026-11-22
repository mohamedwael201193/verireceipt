// Unit boundaries only. Account/signing and paid runner are replaced in this test,
// never in the application bundle, and no key or live purchase is used.
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({ run:vi.fn(),ledger:vi.fn(),account:vi.fn(),normalize:vi.fn() }));
vi.mock('viem/accounts',()=>({privateKeyToAccount:mocks.account}));
vi.mock('../src/secrets.js',()=>({normalizePrivateKey:mocks.normalize}));
vi.mock('../src/researchAgent.js',()=>({runResearch:mocks.run}));
vi.mock('../src/client.js',()=>({readLedgerAccount:mocks.ledger}));
import { assertVisitorConfiguration,executeVisitorResearch } from '../src/visitorRuntime';
const payer='0x'+'12'.repeat(20),input={cik:'1318605',year:2024,form:'10-Q',minimum_count:3};
const options=()=>({spentTodayUusdc:'0',dailyCapUusdc:'100000000',reserveUusdc:'1000000',signal:new AbortController().signal,beforeSign:vi.fn(async()=>{}),recordHeaders:vi.fn(async()=>{}),recordResponse:vi.fn(async()=>{})});
beforeEach(()=>{
 vi.stubEnv('VISITOR_PAYER_PRIVATE_KEY','test-only-not-a-secret');vi.stubEnv('VISITOR_PAYER_ADDRESS',payer);
 mocks.account.mockReturnValue({address:payer,signMessage:vi.fn()});mocks.normalize.mockReturnValue('test-only-not-a-key');mocks.ledger.mockResolvedValue({available:'1010000'});mocks.run.mockReset();mocks.run.mockResolvedValue({version:'test-runner-only'});
});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
describe('hosted runtime boundaries, no key and no payment',()=>{
 it('requires a separately configured hosted payer, not CLI credentials',()=>{vi.stubEnv('VISITOR_PAYER_PRIVATE_KEY','');expect(assertVisitorConfiguration).toThrow('not configured');expect(mocks.account).not.toHaveBeenCalled();});
 it('requires the explicitly expected payer address',()=>{vi.stubEnv('VISITOR_PAYER_ADDRESS','0x'+'34'.repeat(20));expect(assertVisitorConfiguration).toThrow('mismatch');});
 it.each(['1009999','-1','invalid'])('refuses low or malformed ledger availability %s before invoking the runner',async available=>{mocks.ledger.mockResolvedValue({available});await expect(executeVisitorResearch(input,options())).rejects.toThrow('reserve');expect(mocks.run).not.toHaveBeenCalled();});
 it('passes approved bounds and waits for durable before-sign persistence',async()=>{
  mocks.run.mockImplementationOnce(async(_p,_hash,_payer,opts)=>{await opts.beforeSign({reserved_uusdc:'10000',plan_hash:'c'.repeat(64),nonce:'test'});return {version:'test-runner-only'};});
  const opts=options();opts.beforeSign.mockRejectedValueOnce(new Error('commit failed'));
  await expect(executeVisitorResearch(input,opts)).rejects.toThrow('commit failed');
  expect(mocks.run.mock.calls[0][3].dailyCapUusdc).toBe(100000000n);expect(opts.beforeSign).toHaveBeenCalledOnce();
 });
 it('checks cancellation again after reservation commits and before returning to sign',async()=>{
  const opts=options(),controller=new AbortController();opts.signal=controller.signal;opts.beforeSign.mockImplementationOnce(async()=>{controller.abort();});
  mocks.run.mockImplementationOnce(async(_p,_h,_payer,o)=>{await o.beforeSign({reserved_uusdc:'10000'});throw new Error('must not reach signing');});
  await expect(executeVisitorResearch(input,opts)).rejects.not.toThrow('must not reach signing');
 });
 it('passes only response status/body and the public receipt header to private evidence storage',async()=>{
  mocks.run.mockImplementationOnce(async(_p,_h,_payer,o)=>{await o.onRawResponse({status:200,headers:{'x-payment-response':'public receipt','x-payment':'must-not-store'},bodyText:'test body',authorization:{forbidden:true},signedMessage:'must-not-store'});return {};});
  const opts=options();await executeVisitorResearch(input,opts);expect(opts.recordResponse).toHaveBeenCalledWith({status:200,receiptHeader:'public receipt',bodyText:'test body'});
 });
});
