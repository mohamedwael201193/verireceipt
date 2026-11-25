import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const dir = mkdtempSync('/tmp/grid-demo-');
process.env.SQLITE_PATH = join(dir, 'cache.sqlite');
import { saveGridPrice, markGridRevalidateAttempt, closeDb, getDb } from '../src/core/db';
import { handleGridPrice } from '../src/handlers/gridPrice';
import { isConfiguredGridReference } from '../src/jobs/gridFinality';
import { resetCaisoLiveInflightForTests, fetchBuffer } from '../src/jobs/gridIngester';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); resetCaisoLiveInflightForTests(); });
afterAll(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });
it.each(['2026-11-20T05:00:00.000Z', '2026-11-19T00:00:00.000Z'])('fixed demo hour is an NP15-only eviction reference %s', interval => {
 expect(isConfiguredGridReference('TH_NP15_GEN-APND', interval)).toBe(true);
 expect(isConfiguredGridReference('ZONE_J', interval)).toBe(false);
 expect(isConfiguredGridReference('TH_SP15_GEN-APND', interval)).toBe(false);
 expect(isConfiguredGridReference('TH_NP15_GEN-APND', '2026-11-18T00:00:00.000Z')).toBe(false);
});
it('held demo row answers promptly while OASIS is pending, with one refresh and retry throttle after failure', async () => {
 vi.useFakeTimers();
 const interval = '2026-11-20T05:00:00.000Z';
 saveGridPrice('TH_NP15_GEN-APND', interval, 53.65098, 'CAISO', '2026-11-20T07:00:00.000Z', 'https://oasis.caiso.com/oasisapi/SingleZip');
 markGridRevalidateAttempt('TH_NP15_GEN-APND', interval, new Date().toISOString());
 const fetch = vi.fn(async () => new Promise<Response>(() => {})); vi.stubGlobal('fetch', fetch);
 const result = await handleGridPrice({ node_or_zone: 'TH_NP15_GEN-APND', interval_start: interval });
 expect(result.lmp_usd_per_mwh).toBe(53.65098); expect(result.verdict).toBe('unverified');
 expect(result.confidence).toBe(0.5); expect(String(result.answer)).toContain('background revalidation pending');
 expect(fetch).toHaveBeenCalledTimes(1);
 await handleGridPrice({ node_or_zone: 'TH_NP15_GEN-APND', interval_start: interval }); expect(fetch).toHaveBeenCalledTimes(1);
 // The bounded background operation rejects even when fetch ignores abort.
 await vi.advanceTimersByTimeAsync(16000);
 await handleGridPrice({ node_or_zone: 'TH_NP15_GEN-APND', interval_start: interval }); expect(fetch).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(45000);
 await handleGridPrice({ node_or_zone: 'TH_NP15_GEN-APND', interval_start: interval }); expect(fetch).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(16000);
});
it('future-ingested demo rows never receive the cached-observation shortcut', async () => {
 const interval = '2026-11-19T00:00:00.000Z';
 saveGridPrice('TH_NP15_GEN-APND', interval, 1, 'CAISO', '2999-01-01T00:00:00.000Z');
 vi.stubGlobal('fetch', vi.fn(async () => new Response('no rows')));
 await expect(handleGridPrice({ node_or_zone: 'TH_NP15_GEN-APND', interval_start: interval })).rejects.toMatchObject({ code: 'GRID_CACHE_STALE' });
});
it('corrupt demo rows never receive the cached-observation shortcut', async () => {
 const interval = '2026-11-19T00:00:00.000Z';
 getDb().prepare('UPDATE grid_cache SET market = ? WHERE node_or_zone = ? AND interval_start = ?').run('', 'TH_NP15_GEN-APND', interval);
 vi.stubGlobal('fetch', vi.fn(async () => new Response('no rows')));
 await expect(handleGridPrice({ node_or_zone: 'TH_NP15_GEN-APND', interval_start: interval })).rejects.toMatchObject({ code: 'GRID_CACHE_INVALID' });
});
it('OASIS HTTP failure diagnostics contain only closed fields, never body or input text', async () => {
 const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
 vi.stubGlobal('fetch', vi.fn(async () => new Response('private body', { status: 503, headers: { 'content-type': 'text/html; arbitrary text' } })));
 await expect(fetchBuffer('https://oasis.caiso.com/oasisapi/SingleZip')).rejects.toThrow();
 expect(warn.mock.calls).toEqual([[JSON.stringify({ event: 'oasis_fetch_failure', status: 503, body_class: 'html' })]]);
});
