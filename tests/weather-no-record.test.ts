import {it,expect,vi,afterEach} from 'vitest';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {createWiredWeatherHandlers} from '../src/handlers/weatherWired';
import {sha256Hex} from '../src/core/receipt';
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
it('successful bound NOAAemptyarray returns receipted no-record200 with null measures, not worldwide absence',async()=>{
 const raw='[]';const f=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',f);const out=await createWiredWeatherHandlers().past({location:'London',date:'2026-11-01'});
 expect(out.verdict).toBe('no_data');expect(out.confidence).toBe(0);expect(out.data_status).toBe('no_record');expect(out.temp_max_c).toBeNull();expect(out.temp_min_c).toBeNull();expect(out.precipitation_mm).toBeNull();expect(out.condition).toBeNull();expect(out.station).toBe('UKM00003772');expect(out.coverage_scope).toContain('not evidence');expect(out.answer).toContain('no model estimate');
 const [receipt,evidence]=vi.mocked(saveReceipt).mock.calls[0];expect(receipt.raw_response_sha256).toBe(sha256Hex(evidence!));const row=JSON.parse(evidence!);expect(JSON.parse(row.raw_body).source_raw_body).toBe(raw);const url=new URL(row.source_url);expect(url.searchParams.get('stations')).toBe('UKM00003772');expect(url.searchParams.get('startDate')).toBe('2026-11-01');expect(f).toHaveBeenCalledTimes(1);
});
it.each(['null','{}','not json','[{"STATION":"OTHER","DATE":"2026-11-01"}]'])('invalid or mismatched source%s is not an empty-record claim',async raw=>{vi.stubGlobal('fetch',async()=>new Response(raw));await expect(createWiredWeatherHandlers().past({location:'London',date:'2026-11-01'})).rejects.toMatchObject({status:502});expect(saveReceipt).not.toHaveBeenCalled();});
it.each([429,500])('HTTP%s never becomes no-record200',async status=>{vi.stubGlobal('fetch',async()=>new Response('[]',{status}));await expect(createWiredWeatherHandlers().past({location:'London',date:'2026-11-01'})).rejects.toMatchObject({status:502});expect(saveReceipt).not.toHaveBeenCalled();});
it('unknownlocation cannot attribute an unfetched empty NOAAresult',async()=>{const f=vi.fn();vi.stubGlobal('fetch',f);await expect(createWiredWeatherHandlers().past({location:'Atlantis',date:'2026-11-01'})).rejects.toMatchObject({status:502});expect(f).not.toHaveBeenCalled();expect(saveReceipt).not.toHaveBeenCalled();});
it('no-record receipt persistence failure still refuses',async()=>{vi.stubGlobal('fetch',async()=>new Response('[]'));vi.mocked(saveReceipt).mockRejectedValueOnce(Error('disk'));await expect(createWiredWeatherHandlers().past({location:'London',date:'2026-11-01'})).rejects.toThrow('disk');});
