import {afterAll,afterEach,describe,expect,it,vi} from 'vitest';import {readFileSync,mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';
const dir=mkdtempSync('/tmp/gas-chain-default-');process.env.SQLITE_PATH=join(dir,'receipts.sqlite');
import {handleGasPrice} from '../src/handlers/gasPrice';import {getReceiptEvidence} from '../src/core/storage';import {sha256Hex} from '../src/core/receipt';
const fixture=(n:string)=>readFileSync(join(__dirname,'fixtures/gas-chain-default',n+'.json'),'utf8');
afterAll(()=>rmSync(dir,{recursive:true,force:true}));afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
function stub(){vi.stubGlobal('fetch',vi.fn(async(input:unknown)=>{const u=String(input);return new Response(fixture(u.includes('coinbase')?'coinbase-eth-spot':u.includes('blastapi')?'blast-eth_gasPrice':u.includes('drpc')?'drpc-eth_gasPrice':'mev-eth_gasPrice'));}));}
describe('disclosed gas chain fallback backed by captured Ethereum quorum',()=>{
 it.each(['solana','unknown chain','EIP155:999999'])('%s is refused 422 CHAIN_NOT_SERVED, not represented as served',async(chain)=>{stub();await expect(handleGasPrice({chain})).rejects.toMatchObject({status:422,code:'CHAIN_NOT_SERVED'});expect(fetch).not.toHaveBeenCalled();});
 it('empty chain keeps the disclosed ethereum default',async()=>{stub();const r=await handleGasPrice({});expect(r.chain).toBe('ethereum');expect(String(r.answer)).toContain('no chain given; defaulted to ethereum');});
 it.each(['1','eip155:1','Ethereum'])('%s resolves to real Ethereum without fallback',async(chain)=>{stub();const r=await handleGasPrice({chain});expect(r.chain).toBe('ethereum');expect(String(r.answer)).not.toContain('defaulted');});
 it('received chain log is escaped and bounded',async()=>{stub();const spy=vi.spyOn(console,'info').mockImplementation(()=>{});const chain='bad\n'+ 'x'.repeat(200);await handleGasPrice({chain}).catch(()=>undefined);const log=String(spy.mock.calls.find(c=>String(c[0]).includes('gas_chain_request'))![0]);expect(log.split('\n')).toHaveLength(1);expect(JSON.parse(log)).toMatchObject({value:chain.slice(0,80),truncated:true});});
 it('unknown params still400 without any upstream request',async()=>{stub();await expect(handleGasPrice({chain:'ethereum',extra:'x'})).rejects.toMatchObject({status:400,code:'UNKNOWN_PARAM'});expect(fetch).not.toHaveBeenCalled();});
});
