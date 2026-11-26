import {afterEach,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {createWiredWeatherHandlers} from '../src/handlers/weatherWired';
import {sha256Hex} from '../src/core/receipt';
const capture=JSON.parse(readFileSync(join(__dirname,'fixtures/weather-history/source-capture.json'),'utf8'));
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();});
it('recorded JFK daily data replays after a 1200ms archive read with exact bytes retained',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(capture.fetched_at));const row=capture.rows.find((r:any)=>r.location==='New York JFK');
 vi.stubGlobal('fetch',async(url:unknown)=>{expect(String(url)).toBe(row.url);await new Promise(r=>setTimeout(r,1200));return new Response(row.raw);});
 const pending=createWiredWeatherHandlers({archiveFallback:false}).past({location:'New York JFK',date:'2026-11-01'});
 await vi.advanceTimersByTimeAsync(1201);const out=await pending;
 expect(out.temp_max_c).toBe(14.4);expect(out.temp_min_c).toBe(5.6);expect(out.precipitation_mm).toBe(0);expect(out.station).toBe('USW00094789');expect(String(out.condition)).toContain('not reported');
 const [receipt,evidence]=vi.mocked(saveReceipt).mock.calls[0];expect(receipt.raw_response_sha256).toBe(sha256Hex(evidence));expect(JSON.parse(JSON.parse(evidence).raw_body).source_raw_body).toBe(row.raw);
});
it.each(['Cairo','London'])('real empty archive for %s returns receipted no-record, not a zero or forecast substitute',async(location)=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(capture.fetched_at));const row=capture.rows.find((r:any)=>r.location===location);const f=vi.fn(async()=>new Response(row.raw));vi.stubGlobal('fetch',f);
 const out=await createWiredWeatherHandlers({archiveFallback:false}).past({location,date:'2026-11-01'});expect(out.verdict).toBe('no_data');expect(out.temp_max_c).toBeNull();expect(f).toHaveBeenCalledTimes(1);expect(JSON.parse(JSON.parse(vi.mocked(saveReceipt).mock.calls[0][1]!).raw_body).source_raw_body).toBe(row.raw);
});
it('archive timeout aborts the request and never emits a late receipt',async()=>{
 vi.useFakeTimers();let signal:AbortSignal|undefined;vi.stubGlobal('fetch',async(_url:unknown,init:RequestInit)=>{signal=init.signal!;return new Promise(()=>{});});
 const pending=createWiredWeatherHandlers({archiveFallback:false}).past({location:'New York JFK',date:'2026-11-01'});const refused=expect(pending).rejects.toMatchObject({code:'APPROVED_SOURCES_UNAVAILABLE'});
 await vi.advanceTimersByTimeAsync(3001);await refused;expect(signal?.aborted).toBe(true);expect(saveReceipt).not.toHaveBeenCalled();
});
