import {it,expect,vi,afterEach} from 'vitest';
import {mkdtempSync} from 'node:fs';
process.env.SQLITE_PATH=mkdtempSync('/tmp/gas-context-')+'/test.sqlite';
import {handleGasPrice} from '../src/handlers/gasPrice';
import {getReceiptEvidence} from '../src/core/storage';
import {sha256Hex} from '../src/core/receipt';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
function stub(mode='good'){
 let idx=0;const urls=new Map<string,number>();
 vi.stubGlobal('fetch',async(url:any,o:any)=>{
  if(String(url).includes('coinbase'))return new Response(JSON.stringify({data:{amount:'2000'}}));
  if(!urls.has(url))urls.set(url,idx++);const i=urls.get(url)!;const r=JSON.parse(o.body);let result:any='0x3b9aca00';
  if(r.method==='eth_getBlockByNumber'){if(mode==='hang')return new Promise<Response>(()=>{});result={number:mode==='splitblock'?'0x'+(16+i).toString(16):'0x10',baseFeePerGas:mode==='splitbase'?'0x'+(100000000+i).toString(16):'0x5f5e100'};}
  if(r.method==='eth_maxPriorityFeePerGas')result=mode==='splittip'?'0x'+(200000000+i).toString(16):'0xbebc200';
  return new Response(JSON.stringify({id:r.id,jsonrpc:'2.0',result}));
 });
}
it('quorum context uses actual independent base and tip reads, hashes exact bodies',async()=>{stub();const out=await handleGasPrice({chain:'ethereum'});expect(out).toMatchObject({gas_price_gwei:1,base_fee_gwei:0.1,priority_fee_gwei:0.2,block_number:16,fee_context_quorum:'3/3 sources agreed'});expect(out.answer).toContain('not a block-bound or future quote');const rc=out.receipt as any;const e=await getReceiptEvidence(rc.receipt_id);expect(sha256Hex(e.evidence!)).toBe(rc.raw_response_sha256);const raw=JSON.parse(Buffer.from(e.evidence!).toString());expect(raw.fee_context).toHaveLength(3);expect(raw.fee_context[0].block).toContain('baseFeePerGas');expect(raw.fee_context[0].priority).toContain('0xbebc200');});
it.each(['splitblock','splitbase','splittip'])('%s cannot claim context from nonagreeing tuple',async mode=>{stub(mode);expect(await handleGasPrice({chain:'ethereum'})).toMatchObject({gas_price_gwei:1,base_fee_gwei:null,priority_fee_gwei:null,block_number:null});});
it.each(['number','baseFeePerGas','priority'])('rejects malformed/non-string/out-of-bound %s without changing healthy gas',async field=>{
 for(const invalid of [null,{},16,'decimal','-0x1',field==='number'?'0xe8d4a51001':'0x'+(100000000000001n).toString(16)]){
  vi.stubGlobal('fetch',async(url:any,o:any)=>{if(String(url).includes('coinbase'))return new Response(JSON.stringify({data:{amount:'2000'}}));const r=JSON.parse(o.body);const block:any={number:'0x10',baseFeePerGas:'0x1'};if(field!=='priority')block[field]=invalid;return new Response(JSON.stringify({id:r.id,result:r.method==='eth_gasPrice'?'0x3b9aca00':r.method==='eth_getBlockByNumber'?block:field==='priority'?invalid:'0x1'}));});
  expect(await handleGasPrice({chain:'ethereum'})).toMatchObject({gas_price_gwei:1,base_fee_gwei:null,priority_fee_gwei:null,block_number:null});
 }
});
it('accepts exact maximum context boundaries',async()=>{vi.stubGlobal('fetch',async(url:any,o:any)=>{if(String(url).includes('coinbase'))return new Response(JSON.stringify({data:{amount:'2000'}}));const r=JSON.parse(o.body);return new Response(JSON.stringify({id:r.id,result:r.method==='eth_gasPrice'?'0x3b9aca00':r.method==='eth_getBlockByNumber'?{number:'0xe8d4a51000',baseFeePerGas:'0x5af3107a4000'}:'0x5af3107a4000'}));});expect(await handleGasPrice({chain:'ethereum'})).toMatchObject({gas_price_gwei:1,block_number:1000000000000,base_fee_gwei:100000,priority_fee_gwei:100000});});
it('optional context ignores abort, but cannot hold healthy core beyond1200ms',async()=>{vi.useFakeTimers();stub('hang');const p=handleGasPrice({chain:'ethereum'});await vi.advanceTimersByTimeAsync(1200);expect(await p).toMatchObject({gas_price_gwei:1,base_fee_gwei:null,priority_fee_gwei:null,block_number:null});});
