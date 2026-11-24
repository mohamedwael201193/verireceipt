import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {sha256Hex} from '../src/core/receipt';
import {handleCrossChainState} from '../src/handlers/crossChainState';
const raw=readFileSync(join(__dirname,'fixtures/cross-address/ethereum-zero-code.json'),'utf8');
const reference='0x'+'0'.repeat(40);const query={reference,chains:'ethereum,polygon'};
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
it('exact captured empty code quorum compares code, not account existence, and preserves evidence',async()=>{
 const f=vi.fn(async(_u:unknown,init?:RequestInit)=>{expect(JSON.parse(String(init?.body)).method).toBe('eth_getCode');return new Response(raw);});vi.stubGlobal('fetch',f);
 const out=await handleCrossChainState(query);expect(out.consistent).toBe(true);expect(out.complete).toBe(true);expect(String(out.answer)).toContain('not balance, nonce, ownership');
 const states=out.per_chain as any[];expect(states.every(s=>s.found===null&&s.code_present===false&&s.code==='0x')).toBe(true);
 const[r,e]=vi.mocked(saveReceipt).mock.calls[0];expect(r.raw_response_sha256).toBe(sha256Hex(e));expect(Object.values(JSON.parse(e).raw_bodies).every(x=>x===raw)).toBe(true);
});
it('same nonempty synthetic code agrees; different code disagrees without a bridge claim',async()=>{
 for(const different of [false,true]) {
  vi.stubGlobal('fetch',async(url:unknown)=>new Response(JSON.stringify({result:different&&String(url).includes('polygon')?'0x6001':'0x6000'})));
  const out=await handleCrossChainState(query);expect(out.consistent).toBe(!different);expect(out.complete).toBe(true);expect(String(out.answer)).toContain('bridge verification');
 }
});
it('one unreadable or split chain means unknown, not absence or factual mismatch',async()=>{
 for(const mode of ['error','split','rpc-error']) {
  let n=0;vi.stubGlobal('fetch',async(url:unknown)=>{
   if(String(url).includes('polygon')){if(mode==='error')throw new Error('outage');if(mode==='rpc-error')return new Response(JSON.stringify({error:{code:-1}}));return new Response(JSON.stringify({result:n++===0?'0x6000':'0x6001'}));}
   return new Response(raw);
  });
  const out=await handleCrossChainState(query);expect(out.consistent).toBe(false);expect(out.complete).toBe(false);expect(out.confidence).toBe(0);expect(String(out.answer)).toContain('not a proven state mismatch');expect((out.per_chain as any[])[1].found).toBeNull();
 }
});
it('all unreadable still cannot agree as absent',async()=>{
 vi.stubGlobal('fetch',async()=>{throw new Error('outage');});const out=await handleCrossChainState(query);expect(out.consistent).toBe(false);expect(out.complete).toBe(false);
});
it('tx-mode RPC error objects from every leg are unreadable, not a verified absent quorum',async()=>{
 vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32000,message:'request failed'}})));
 const out=await handleCrossChainState({reference:'0x'+'a'.repeat(64),chains:'ethereum,polygon'});
 expect(out.consistent).toBe(false);expect(out.complete).toBe(false);expect(out.confidence).toBe(0);expect(out.verdict).toBe('unverified');
 expect((out.per_chain as any[]).every(s=>s.found===null&&s.error==='RPC_QUORUM_UNREACHABLE')).toBe(true);
 expect(String(out.answer)).toContain('not a proven state mismatch');
});
