import{it,expect,vi,afterEach}from'vitest';import{readFileSync}from'node:fs';import{join}from'node:path';import{confirmationContext,transactionFlags}from'../src/handlers/txContext';
const rows=JSON.parse(readFileSync(join(__dirname,'fixtures/tx-context/heads.json'),'utf8'));afterEach(()=>vi.unstubAllGlobals());
it('counts blocks after inclusion from actual exact head quorum and preserves evidence',async()=>{
 vi.stubGlobal('fetch',async(u:unknown)=>new Response(rows.find((r:any)=>r.url===u).raw));const h=Number(BigInt(JSON.parse(rows[0].raw).result));const out=await confirmationContext(rows.map((r:any)=>r.url),h-10);expect(out.confirmations).toBe(10);expect(out.confirmation_evidence).toHaveLength(2);
});
it('split or behind head never invents confirmations',async()=>{
 let i=0;vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:i++?'0x11':'0x12'})));expect((await confirmationContext(['a','b'],1)).confirmations).toBeNull();expect((await confirmationContext(['a','b'],100)).confirmations).toBeNull();
});
it('calldata and self-transfer flags have narrow disclosed semantics',()=>{
 expect(transactionFlags({from:'0xABC',to:'0xabc',input:'0xa9059cbb'})).toMatchObject({contract_call:true,self_transfer:true});expect(transactionFlags({from:'a',to:'b',input:'0x'})).toMatchObject({contract_call:false,self_transfer:false});expect(transactionFlags(null)).toMatchObject({contract_call:null,self_transfer:null});
});
