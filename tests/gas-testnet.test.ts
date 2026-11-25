import {it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {handleGasPrice} from '../src/handlers/gasPrice';
import {CHAIN_RPCS} from '../src/config/chains';
import {saveReceipt} from '../src/core/storage';
const raw=readFileSync('tests/fixtures/gas-testnet/sepolia-0.json','utf8');
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
function replay(chain:string,bodies:string[]=[raw]){const f=vi.fn(async(u:any,o:any)=>{if(!CHAIN_RPCS[chain].includes(String(u)))throw Error('Unexpected non-chain request');const req=JSON.parse(o.body);if(req.method!=='eth_gasPrice')throw Error('optional context unavailable');return new Response(bodies[CHAIN_RPCS[chain].indexOf(String(u))%bodies.length]);});vi.stubGlobal('fetch',f);return f;}
// All-success policy replay; Base uses real Sepolia bytes, not a live Base19wei measurement.
it.each(['sepolia','base-sepolia'])('%s preserves19wei exact decimal, source bytes, and no mainnet USD price',async(chain)=>{const f=replay(chain);const out=await handleGasPrice({chain});expect(out.gas_price_gwei).toBe(0.000000019);expect(out.gas_price_wei).toBe('19');expect(out.transfer_fee_usd).toBeNull();expect(out.transfer_fee_usd_reason).toContain('no mainnet USD valuation');expect(out.answer).toContain('testnet gas price is 19 wei (0.000000019 gwei)');expect(out.answer).toContain('real quorum value');expect((out.receipt as any).gas_token_spot).toBeUndefined();expect(vi.mocked(saveReceipt).mock.calls[0][1]).toBe(raw);expect(f.mock.calls.some(([u])=>String(u).includes('coinbase'))).toBe(false);});
it('mainnet19wei keepsG3 refusal',async()=>{replay('ethereum');await expect(handleGasPrice({chain:'ethereum'})).rejects.toMatchObject({status:502,code:'IMPLAUSIBLE_ZERO'});});
it.each(['sepolia','base-sepolia'])('%s exact zero still refuses synthetic zero fault',async(chain)=>{replay(chain,[JSON.stringify({...JSON.parse(raw),result:'0x0'})]);await expect(handleGasPrice({chain})).rejects.toMatchObject({status:502,code:'IMPLAUSIBLE_ZERO'});});
it('testnet split quorum refuses synthetic disagreement after repoll',async()=>{replay('sepolia',['0x13','0x14','0x15'].map(result=>JSON.stringify({...JSON.parse(raw),result})));await expect(handleGasPrice({chain:'sepolia'})).rejects.toMatchObject({status:502,code:'QUORUM_DISAGREEMENT'});expect(saveReceipt).not.toHaveBeenCalled();});

// Recorded URL-specific outcomes, not the all-success cross-testnet policy replay above.
function recordedReplay(chain: string) {
  const records = JSON.parse(readFileSync('tests/fixtures/gas-testnet/PROVENANCE.json', 'utf8'));
  const f = vi.fn(async (url: any, options: any) => {
    if (JSON.parse(options.body).method !== 'eth_gasPrice') throw Error('optional context unavailable');
    const record = records.find((r: any) => r.chain === chain && r.url === String(url));
    if (!record) throw Error('Unrecorded RPC');
    if (record.error) return new Response(null, { status: 403 });
    return new Response(readFileSync(`tests/fixtures/gas-testnet/${record.file}`, 'utf8'), { status: record.status });
  });
  vi.stubGlobal('fetch', f);
  return f;
}
it('recorded Sepolia two-success403 states actual quorum in answer and receipt, not false unanimity', async () => {
  recordedReplay('sepolia');
  const out = await handleGasPrice({ chain: 'sepolia' });
  expect(out.gas_price_wei).toBe('19');
  expect(out.answer).toContain('2/3 sources agreed');
  expect(out.answer).not.toContain('3/3');
  expect((out.receipt as any).quorum_votes).toBe('2/3 sources agreed');
  expect(JSON.stringify(out.receipt)).not.toContain('3/3');
  expect(vi.mocked(saveReceipt).mock.calls[0][1]).toBe(raw);
});
it('recorded Base one-success403 refuses no-quorum after repoll', async () => {
  const f = recordedReplay('base-sepolia');
  await expect(handleGasPrice({ chain: 'base-sepolia' })).rejects.toMatchObject({status:502,code:'QUORUM_UNREACHABLE'});
  expect(saveReceipt).not.toHaveBeenCalled();
  expect(f).toHaveBeenCalledTimes(CHAIN_RPCS['base-sepolia'].length * 2);
});
