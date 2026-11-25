import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), fetch: vi.fn() }));
vi.mock('../src/core/storage', () => ({ getGridPrice: mocks.get, saveGridPrice: mocks.save }));
vi.mock('../src/jobs/gridIngester', () => ({ fetchCaisoDamLmp: mocks.fetch }));
import { GRID_DEMO_INTERVALS } from '../src/jobs/gridFinality';
import { warmGridDemos, startGridDemoWarm, stopGridDemoWarm } from '../src/jobs/gridDemoWarm';
const value = { lmp: 42, upstreamUrl: 'https://oasis.caiso.com/oasisapi/SingleZip' };
beforeEach(() => { vi.clearAllMocks(); mocks.get.mockResolvedValue(null); mocks.fetch.mockResolvedValue(value); mocks.save.mockResolvedValue(undefined); });
afterEach(() => { stopGridDemoWarm(); vi.useRealTimers(); vi.restoreAllMocks(); });
it('warms only both missing fixed NP15 keys with an independent bounded fetch', async () => {
 await warmGridDemos();
 expect(mocks.fetch.mock.calls).toEqual(GRID_DEMO_INTERVALS.map(i => ['TH_NP15_GEN-APND', i, 15000]));
 expect(mocks.save).toHaveBeenCalledTimes(2);
 expect(mocks.save.mock.calls[0]).toEqual(['TH_NP15_GEN-APND', GRID_DEMO_INTERVALS[0], 42, 'CAISO', expect.any(String), value.upstreamUrl]);
});
it('keeps valid held observations without replacing them', async () => {
 mocks.get.mockResolvedValue({ market: 'CAISO', lmp_usd_per_mwh: 15, ingested_at: '2026-01-01T00:00:00Z' });
 await warmGridDemos(); expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});
it.each([
 { market: 'CAISO', lmp_usd_per_mwh: NaN, ingested_at: '2026-01-01T00:00:00Z' },
 { market: 'CAISO', lmp_usd_per_mwh: 1, ingested_at: '2999-01-01T00:00:00Z' },
 { market: 'CAISO', lmp_usd_per_mwh: 1, ingested_at: '' },
])('repairs invalid held observation %#', async row => {
 mocks.get.mockResolvedValue(row); await warmGridDemos(); expect(mocks.fetch).toHaveBeenCalledTimes(2);
});
it('continues the other key after a fetch timeout or failure, without fabricated saves', async () => {
 vi.spyOn(console, 'warn').mockImplementation(() => {});
 mocks.fetch.mockRejectedValueOnce(Error('timeout')).mockResolvedValueOnce(null);
 await warmGridDemos(); expect(mocks.fetch).toHaveBeenCalledTimes(2); expect(mocks.save).not.toHaveBeenCalled();
});
it('deduplicates a running warm and suppresses saves after shutdown', async () => {
 let resolve!: (v: typeof value) => void;
 mocks.fetch.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
 const first = warmGridDemos(); await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
 await warmGridDemos(); expect(mocks.get).toHaveBeenCalledTimes(1);
 stopGridDemoWarm(); resolve(value); await first;
 expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
it('startup is immediate, hourly, unrefed, idempotent, and stoppable', async () => {
 vi.useFakeTimers();
 const timer = startGridDemoWarm(); expect(startGridDemoWarm()).toBe(timer); expect(timer.hasRef()).toBe(false);
 await vi.advanceTimersByTimeAsync(0); expect(mocks.fetch).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(3599999); expect(mocks.fetch).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(1); expect(mocks.fetch).toHaveBeenCalledTimes(4);
 stopGridDemoWarm(); await vi.advanceTimersByTimeAsync(3600000); expect(mocks.fetch).toHaveBeenCalledTimes(4);
});
it('does not save after its own deadline when joining a longer source flight', async () => {
 vi.useFakeTimers();
 let resolve!: (v: typeof value) => void;
 mocks.fetch.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
 const work = warmGridDemos();
 await vi.advanceTimersByTimeAsync(15001);
 await work; expect(mocks.fetch).toHaveBeenCalledTimes(2); expect(mocks.save).toHaveBeenCalledTimes(1);
 resolve(value); await vi.advanceTimersByTimeAsync(0); expect(mocks.save).toHaveBeenCalledTimes(1);
});
