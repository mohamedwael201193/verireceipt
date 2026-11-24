import { describe, it, expect, vi, afterEach } from 'vitest';
import { PublicBodyCache, StartBudget, readPublicBody } from '../src/core/publicSource';
afterEach(() => vi.unstubAllGlobals());
describe('public transport bounds', () => {
 it('enforces a rolling start ceiling including exact boundary', () => {
  let now=0; const b=new StartBudget(5,30_001,()=>now);
  expect(Array.from({length:6},()=>b.take())).toEqual([true,true,true,true,true,false]);
  now=30_000;expect(b.take()).toBe(false);now=30_001;expect(b.take()).toBe(true);
 });
 it('coalesces one key and preserves original fetch time; TTL and LRU are bounded', async()=>{
  let now=0,calls=0;const c=new PublicBodyCache(2,10,()=>now);
  const load=async()=>({url:'u',raw:String(++calls),fetchedAt:'original'});
  const [a,b]=await Promise.all([c.get('a',load),c.get('a',load)]);expect(calls).toBe(1);expect(a).toEqual(b);
  a.raw='mutated';expect((await c.get('a',load)).raw).toBe('1');
  await c.get('b',load);await c.get('c',load);await c.get('a',load);expect(calls).toBe(4);
  now=10;await c.get('a',load);expect(calls).toBe(5);
 });
 it('does not cache rejection or permit unbounded pending keys', async()=>{
  const c=new PublicBodyCache(1,10);let release!:(x:any)=>void;
  const waiting=c.get('a',()=>new Promise(r=>release=r));await Promise.resolve();
  await expect(c.get('b',async()=>({url:'b',raw:'',fetchedAt:''}))).rejects.toThrow('capacity');
  release({url:'a',raw:'a',fetchedAt:'t'});await waiting;
  const d=new PublicBodyCache(1,10);let calls=0;
  await expect(d.get('x',async()=>{calls++;throw new Error('failed')})).rejects.toThrow();
  await expect(d.get('x',async()=>{calls++;throw new Error('failed')})).rejects.toThrow();expect(calls).toBe(2);
 });
 it('refuses declared and streamed oversize bodies, and never follows redirects', async()=>{
  let options:any;vi.stubGlobal('fetch',async(_u:any,o:any)=>{options=o;return new Response('abcdef',{headers:{'content-length':'6'}})});
  await expect(readPublicBody('https://example.org',5)).rejects.toThrow('limit');expect(options.redirect).toBe('error');
  vi.stubGlobal('fetch',async()=>new Response('abcdef'));await expect(readPublicBody('https://example.org',5)).rejects.toThrow('limit');
 });
 it('refuses 403 and429 without a retry',async()=>{
  for(const status of [403,429]){const fetch=vi.fn(async()=>new Response('',{status}));vi.stubGlobal('fetch',fetch);await expect(readPublicBody('https://example.org')).rejects.toThrow(`HTTP ${status}`);expect(fetch).toHaveBeenCalledTimes(1)}
 });
});
