import { expect, it, vi, afterEach, afterAll } from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const scratch=mkdtempSync('/tmp/grid-demo-shutdown-');process.env.SQLITE_PATH=join(scratch,'cache.sqlite');
import {closeDb,saveGridPrice as dbSaveGridPrice} from '../src/core/db';
import {buildServer} from '../src/server';
afterAll(()=>{closeDb();rmSync(scratch,{recursive:true,force:true});});
const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), mark: vi.fn(), fetch: vi.fn() }));
vi.mock('../src/core/storage', async importOriginal => ({ ...await importOriginal<object>(), getGridPrice: mocks.get, saveGridPrice: mocks.save, markGridRevalidateAttempt: mocks.mark }));
vi.mock('../src/jobs/gridIngester', async importOriginal => ({ ...await importOriginal<object>(), fetchCaisoDamLmp: mocks.fetch }));
import { handleGridPrice, stopGridDemoRefreshes } from '../src/handlers/gridPrice';
import { gridDemoDeadline } from '../src/jobs/gridDemoDeadline';
const interval = '2026-11-20T05:00:00.000Z';
afterEach(() => { stopGridDemoRefreshes(); vi.useRealTimers(); vi.resetAllMocks(); });
it('pending OASIS fetch that succeeds before the deadline serves the fresh verified price and saves it once', async () => {
 mocks.get.mockResolvedValue({ lmp_usd_per_mwh: 42, market: 'CAISO', ingested_at: '2026-11-20T07:00:00Z', upstream_url: 'https://oasis.caiso.com/oasisapi/SingleZip' });
 mocks.fetch.mockResolvedValue({lmp:99,upstreamUrl:'https://oasis.caiso.com/oasisapi/SingleZip'});
 const r=await handleGridPrice({node_or_zone:'TH_NP15_GEN-APND',interval_start:interval});
 expect(r.lmp_usd_per_mwh).toBe(99); expect(r.verdict).toBe('verified'); expect(mocks.save).toHaveBeenCalledTimes(1);
});
it('caller deadline rejects a longer shared flight without adopting its eventual result', async () => {
 vi.useFakeTimers(); let resolve!: (n:number)=>void;
 const longer = new Promise<number>(r=>{resolve=r;});
 const result = gridDemoDeadline(longer).catch(e=>e.message);
 await vi.advanceTimersByTimeAsync(15000); expect(await result).toBe('grid demo deadline exceeded');
 resolve(99); await vi.advanceTimersByTimeAsync(0); expect(await result).toBe('grid demo deadline exceeded');
});
it('handler applies its own 15s deadline to a longer joined flight: price refused (502), late result never saved', async () => {
 vi.useFakeTimers();
 mocks.get.mockResolvedValue({ lmp_usd_per_mwh: 42, market: 'CAISO', ingested_at: '2026-11-20T07:00:00Z', upstream_url: 'https://oasis.caiso.com/oasisapi/SingleZip' });
 let resolve!: (v: any) => void;
 mocks.fetch.mockReturnValue(new Promise(r => { resolve = r; }));
 const pending=handleGridPrice({node_or_zone:'TH_NP15_GEN-APND',interval_start:interval}).then(()=>'served',e=>e);
 await vi.advanceTimersByTimeAsync(14999); expect(mocks.mark).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1);
 const err:any=await pending; expect(err).toMatchObject({code:'GRID_CACHE_STALE'}); expect(String(err.message)).toContain('not served');
 expect(mocks.mark).toHaveBeenCalledTimes(1);
 expect(mocks.mark).toHaveBeenCalledWith('TH_NP15_GEN-APND',interval,expect.any(String));
 resolve({lmp:99,upstreamUrl:'https://oasis.caiso.com/oasisapi/SingleZip'});
 await vi.advanceTimersByTimeAsync(0); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.mark).toHaveBeenCalledTimes(1);
});
const held = { lmp_usd_per_mwh: 42, market: 'CAISO', ingested_at: '2026-11-20T07:00:00Z', upstream_url: 'https://oasis.caiso.com/oasisapi/SingleZip' };
const oasis = 'https://oasis.caiso.com/oasisapi/SingleZip';
it('two concurrent requests for the same demo hour share one OASIS fetch and both are served verified', async () => {
 let row: any = held; mocks.get.mockImplementation(async () => row);
 mocks.save.mockImplementation(async (_n: string, _i: string, lmp: number, _m: string, at: string, url: string) => { row = { lmp_usd_per_mwh: lmp, market: 'CAISO', ingested_at: at, upstream_url: url }; });
 let resolve!: (v: any) => void; mocks.fetch.mockReturnValue(new Promise(r => { resolve = r; }));
 const a = handleGridPrice({node_or_zone:'TH_NP15_GEN-APND',interval_start:interval}), b = handleGridPrice({node_or_zone:'TH_NP15_GEN-APND',interval_start:interval});
 await new Promise(r => setImmediate(r)); resolve({ lmp: 99, upstreamUrl: oasis });
 const [x, y] = await Promise.all([a, b]);
 expect(String((x.receipt as any).quorum_votes)).toContain('live CAISO OASIS'); expect(String((y.receipt as any).quorum_votes)).toContain('live CAISO OASIS'); expect(x.lmp_usd_per_mwh).toBe(99); expect(y.lmp_usd_per_mwh).toBe(99); expect(x.verdict).toBe('verified'); expect(y.verdict).toBe('verified');
 expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(mocks.save).toHaveBeenCalledTimes(1);
});
it('a hour confirmed by a successful fetch is served verified inside the 60 s window with no new fetch', async () => {
 let row: any = held; mocks.get.mockImplementation(async () => row);
 mocks.save.mockImplementation(async (_n: string, _i: string, lmp: number, _m: string, at: string, url: string) => { row = { lmp_usd_per_mwh: lmp, market: 'CAISO', ingested_at: at, upstream_url: url }; });
 mocks.fetch.mockResolvedValue({ lmp: 99, upstreamUrl: oasis });
 expect((await handleGridPrice({node_or_zone:'TH_NP15_GEN-APND',interval_start:interval})).verdict).toBe('verified');
 const again = await handleGridPrice({node_or_zone:'TH_NP15_GEN-APND',interval_start:interval});
 expect(again.verdict).toBe('verified'); expect(again.lmp_usd_per_mwh).toBe(99); expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
it('failed fetch: a request at +59 s is refused with no fetch, a request at +60 s fetches again; the failure marks the attempt', async () => {
 vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
 mocks.get.mockResolvedValue(held); mocks.fetch.mockRejectedValue(Error('oasis down'));
 await expect(handleGridPrice({node_or_zone:'TH_NP15_GEN-APND',interval_start:interval})).rejects.toMatchObject({ code: 'GRID_CACHE_STALE' });
 expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(mocks.mark).toHaveBeenCalledTimes(1); expect(mocks.save).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(59_000);
 await expect(handleGridPrice({node_or_zone:'TH_NP15_GEN-APND',interval_start:interval})).rejects.toMatchObject({ code: 'GRID_CACHE_STALE' });
 expect(mocks.fetch).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(1_000);
 await expect(handleGridPrice({node_or_zone:'TH_NP15_GEN-APND',interval_start:interval})).rejects.toMatchObject({ code: 'GRID_CACHE_STALE' });
 expect(mocks.fetch).toHaveBeenCalledTimes(2); expect(mocks.mark).toHaveBeenCalledTimes(2);
});

it('a successful live fetch is served verified even when the revalidation ledger still shows an old success (fetchedLive flag)', async () => {
 dbSaveGridPrice('TH_NP15_GEN-APND', interval, 42, 'CAISO', '2026-11-20T07:00:00.000Z', oasis);
 let row: any = held; mocks.get.mockImplementation(async () => row);
 mocks.save.mockImplementation(async (_n: string, _i: string, lmp: number, _m: string, at: string, url: string) => { row = { lmp_usd_per_mwh: lmp, market: 'CAISO', ingested_at: at, upstream_url: url }; });
 mocks.fetch.mockResolvedValue({ lmp: 99, upstreamUrl: oasis });
 const r = await handleGridPrice({node_or_zone:'TH_NP15_GEN-APND',interval_start:interval});
 expect(r.lmp_usd_per_mwh).toBe(99); expect(r.verdict).toBe('verified'); expect(String((r.receipt as any).quorum_votes)).toContain('live CAISO OASIS');
});
it.each([['resolves',true],['rejects',false]])('shutdown while a demo fetch is pending: late fetch that %s never saves or marks, caller gets 502 not a price', async (_n, ok) => {
 mocks.get.mockResolvedValue(held);
 let resolve!: (v: any) => void, reject!: (e: Error) => void;
 mocks.fetch.mockReturnValue(new Promise((res, rej) => { resolve = res; reject = rej; }));
 const pending = handleGridPrice({node_or_zone:'TH_NP15_GEN-APND',interval_start:interval}).then(() => 'served', e => e);
 await new Promise(r => setImmediate(r)); expect(mocks.fetch).toHaveBeenCalledTimes(1);
 stopGridDemoRefreshes();
 if (ok) resolve({ lmp: 99, upstreamUrl: oasis }); else reject(new Error('late failure'));
 const err: any = await pending;
 expect(err).toMatchObject({ code: 'GRID_CACHE_STALE' }); expect(String(err.message)).toContain('not served');
 expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.mark).not.toHaveBeenCalled();
});
