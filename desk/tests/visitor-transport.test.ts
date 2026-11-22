import { describe,expect,it,vi } from 'vitest';
import { makeVisitorFetch } from '../src/visitorTransport';
const payer='0x'+'12'.repeat(20), ledger='https://devnode.telegraphprotocol.com/v1/ledger/account/'+payer;
describe('hosted fixed-destination bounded transport, no live network',()=>{
 it.each(['https://outside.invalid/x','http://127.0.0.1/','https://devnode.telegraphprotocol.com/admin','https://verireceipt.onrender.com/receipts/../health','https://devnode.telegraphprotocol.com/engine/v1/signal/../../admin',ledger+'?secret=x',ledger+'#fragment','https://user:pass@devnode.telegraphprotocol.com/v1/ledger/account/'+payer])('refuses unapproved path or destination %s',async url=>{
  const transport=vi.fn();await expect(makeVisitorFetch(new AbortController().signal,payer,transport)(url)).rejects.toThrow();expect(transport).not.toHaveBeenCalled();
 });
 it('forces redirect refusal and carries both deadline and shutdown signals',async()=>{
  const controller=new AbortController(),local=new AbortController();
  const transport=vi.fn(async(_url,opts?:RequestInit)=>{expect(opts?.redirect).toBe('error');expect(opts?.signal?.aborted).toBe(false);return new Response('real transport test bytes');});
  const f=makeVisitorFetch(controller.signal,payer,transport);expect(await(await f(ledger,{signal:local.signal})).text()).toBe('real transport test bytes');
  controller.abort();await expect(f(ledger)).rejects.toThrow();expect(transport).toHaveBeenCalledOnce();
 });
 it('refuses a response over 2MB',async()=>{
  const transport=vi.fn(async()=>new Response('x'.repeat(2_000_001)));
  await expect(makeVisitorFetch(new AbortController().signal,payer,transport)(ledger)).rejects.toThrow('byte budget');
 });
 it('bounds cumulative bytes even when every individual response fits',async()=>{
  const transport=vi.fn(async()=>new Response('x'.repeat(2_000_000))),f=makeVisitorFetch(new AbortController().signal,payer,transport);
  for(let i=0;i<6;i++) await f(ledger);
  await expect(f(ledger)).rejects.toThrow('byte budget');
 });
 it('bounds request count and refuses methods not used by the reviewed runner',async()=>{
  const transport=vi.fn(async()=>new Response('{}')),f=makeVisitorFetch(new AbortController().signal,payer,transport);
  await expect(f(ledger,{method:'POST'})).rejects.toThrow();
  for(let i=0;i<40;i++) await f(ledger);
  await expect(f(ledger)).rejects.toThrow('request count');expect(transport).toHaveBeenCalledTimes(40);
 });
});
