import {afterEach,it,expect,vi} from 'vitest';
import {rpcCall} from '../src/core/evmRpc';
afterEach(()=>vi.unstubAllGlobals());
it('parent source deadline cancels the underlying fetch',async()=>{
 let actual:AbortSignal|undefined;
 vi.stubGlobal('fetch',async(_url:unknown,init:RequestInit)=>{actual=init.signal!;return new Promise((_r,reject)=>{actual!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});});
 const parent=new AbortController();const pending=rpcCall('https://rpc.example','eth_chainId',[],parent.signal);
 const refused=expect(pending).rejects.toThrow('aborted');parent.abort();await refused;expect(actual?.aborted).toBe(true);
});
it('calls without parent signal preserve existing successful RPC semantics',async()=>{
 vi.stubGlobal('fetch',async()=>new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}'));
 expect((await rpcCall('https://rpc.example','eth_chainId',[])).result).toBe('0x1');
});
it('already-aborted parent is passed as aborted to fetch',async()=>{
 const parent=new AbortController();parent.abort();
 vi.stubGlobal('fetch',async(_url:unknown,init:RequestInit)=>{expect(init.signal?.aborted).toBe(true);throw new Error('aborted');});
 await expect(rpcCall('https://rpc.example','eth_chainId',[],parent.signal)).rejects.toThrow('aborted');
});
