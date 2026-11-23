import{it,expect,vi,afterEach}from'vitest';import{readFileSync}from'node:fs';import{join}from'node:path';import{walletContext}from'../src/handlers/walletContext';
const captures=['blast','drpc'].map(n=>JSON.parse(readFileSync(join(__dirname,`fixtures/wallet-context/${n}.json`),'utf8')));const rpcs=captures.map(r=>r[0].url);const address='0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
afterEach(()=>vi.unstubAllGlobals());
function stub(mutate?:(j:any,req:any,url:string)=>void){const calls:any[]=[];vi.stubGlobal('fetch',async(u:unknown,i:any)=>{const req=JSON.parse(i.body);calls.push(req);const row=captures[rpcs.indexOf(String(u))].find((r:any)=>r.method===req.method);const j=JSON.parse(row.raw);mutate?.(j,req,String(u));return new Response(JSON.stringify(j))});return calls}
it('quorums captured same-block account metadata and preserves delegated-account distinction',async()=>{
 const calls=stub();const r=await walletContext(rpcs,address);expect(r.transaction_count).toBe(5971);expect(r.is_contract).toBe(true);expect(r.account_type).toBe('delegated_account');expect(r.block_number).toBe(parseInt('1940dd6',16));
 expect(calls.filter(c=>c.method!=='eth_getBlockByNumber').every(c=>c.params[1]==='0x1940dd6')).toBe(true);expect(r.context_evidence).toHaveLength(2);
});
it('split nonce or finalized block cannot manufacture an account metadata quorum',async()=>{
 stub((j,req,u)=>{if(u===rpcs[1]&&req.method==='eth_getTransactionCount')j.result='0x1'});expect((await walletContext(rpcs,address)).transaction_count).toBeNull();
 stub((j,req,u)=>{if(u===rpcs[1]&&req.method==='eth_getBlockByNumber')j.result.hash='0x'+'1'.repeat(64)});expect((await walletContext(rpcs,address)).block_number).toBeNull();
});
it('malformed code or source outages produce disclosed optional unknown',async()=>{
 stub((j,req)=>{if(req.method==='eth_getCode')j.result='not-code'});expect((await walletContext(rpcs,address)).is_contract).toBeNull();
 vi.stubGlobal('fetch',async()=>{throw new Error('outage')});expect((await walletContext(rpcs,address)).account_type).toBe('unknown');
});
