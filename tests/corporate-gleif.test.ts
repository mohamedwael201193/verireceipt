import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const scratch=mkdtempSync('/tmp/gleif-test-');process.env.SQLITE_PATH=join(scratch,'receipts.sqlite');
import {handleCorporateRegistry} from '../src/handlers/corporateRegistry';
import {handleGleifRegistry,parseGleif,resetGleifForTests} from '../src/handlers/gleifRegistry';
import {getReceiptEvidence} from '../src/core/storage';
import {sha256Hex} from '../src/core/receipt';
const raw=(key:string)=>readFileSync(join(__dirname,'fixtures/corporate-gleif',key+'.json'),'utf8');
beforeEach(()=>resetGleifForTests());afterEach(()=>{resetGleifForTests();vi.unstubAllGlobals();vi.useRealTimers();});afterAll(()=>rmSync(scratch,{recursive:true,force:true}));
it.each([['tesco','TESCO PLC','United Kingdom','00445790'],['siemens','Siemens Aktiengesellschaft','Germany','HRB 6684']])('replays actual %s legal entity with independent receipt',async(key,company,jurisdiction,registration)=>{
 const body=raw(key);vi.stubGlobal('fetch',async()=>new Response(body));const out=await handleCorporateRegistry({company,jurisdiction});
 const entity=JSON.parse(body).data.find((r:any)=>r.attributes.entity.legalName.name.toUpperCase()===company.toUpperCase()).attributes.entity;
 expect(out.legal_name).toBe(entity.legalName.name);expect(out.registration_id).toBe(entity.registeredAs);expect(out.active).toBe(true);
 expect(out.incorporated).toBe(entity.creationDate.slice(0,10));expect(String(out.answer)).toContain('coverage is incomplete');
 expect(String(out.registered_address)).toContain(entity.legalAddress.city);
 const r=out.receipt as any;const ev=(await getReceiptEvidence(r.receipt_id)).evidence!;expect(sha256Hex(ev)).toBe(r.raw_response_sha256);expect(JSON.parse(ev).raw_body).toBe(body);expect(JSON.parse(ev).terms.licence).toBe('CC0 1.0');
});
it('actual negative capture is unknown, not inactive or nonexistent',async()=>{
 vi.stubGlobal('fetch',async()=>new Response(raw('negative')));const out=await handleGleifRegistry('VeriReceipt nonexistent registry control 20261124','GB');expect(out.lookup_status).toBe('not_found');expect(out.active).toBeNull();expect(out.registration_id).toBeNull();expect(String(out.answer)).toContain('does not prove nonexistence');
});
it('entity status is independent of LEI renewal state; creation is not LEI registration date',()=>{
 const j=JSON.parse(raw('tesco'));j.data[0].attributes.registration.status='LAPSED';expect(parseGleif(JSON.stringify(j),'TESCO PLC','GB')!.entity.status).toBe('ACTIVE');
 j.data[0].attributes.entity.status='INACTIVE';expect(parseGleif(JSON.stringify(j),'TESCO PLC','GB')!.entity.status).toBe('INACTIVE');
 expect(j.data[0].attributes.entity.creationDate).not.toBe(j.data[0].attributes.registration.initialRegistrationDate);
});
it('exact name plus jurisdiction required; duplicates/truncation refuse',()=>{
 const body=raw('tesco');expect(parseGleif(body,'TESCO','GB')).toBeNull();expect(parseGleif(body,'TESCO PLC','DE')).toBeNull();
 const j=JSON.parse(body);j.data.push(j.data[0]);j.meta.pagination.total++;expect(()=>parseGleif(JSON.stringify(j),'TESCO PLC','GB')).toThrowError(expect.objectContaining({code:'AMBIGUOUS_COMPANY'}));
 const partial=JSON.parse(body);partial.meta.pagination.total=200;expect(()=>parseGleif(JSON.stringify(partial),'TESCO PLC','GB')).toThrowError(expect.objectContaining({code:'AMBIGUOUS_COMPANY'}));
});
it('caches and coalesces same-query reads with original source bytes',async()=>{
 const f=vi.fn(async()=>new Response(raw('tesco')));vi.stubGlobal('fetch',f);await Promise.all([handleGleifRegistry('TESCO PLC','GB'),handleGleifRegistry('TESCO PLC','GB')]);await handleGleifRegistry('TESCO PLC','GB');expect(f).toHaveBeenCalledTimes(1);
});
it('paced reads never start less than 1100ms apart',async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-11-24T00:00:00Z');const starts:number[]=[];vi.stubGlobal('fetch',async()=>{starts.push(Date.now());return new Response(raw('negative'));});
 await handleGleifRegistry('Alpha','GB');const p=handleGleifRegistry('Beta','GB');await vi.advanceTimersByTimeAsync(1100);await p;expect(starts[1]-starts[0]).toBeGreaterThanOrEqual(1100);
});
it.each([403,429,500])('source HTTP %s refuses, then stops further reads',async status=>{
 const f=vi.fn(async()=>new Response('',{status}));vi.stubGlobal('fetch',f);await expect(handleGleifRegistry('TESCO PLC','GB')).rejects.toMatchObject({code:'GLEIF_UNAVAILABLE'});await expect(handleGleifRegistry('Other','GB')).rejects.toMatchObject({code:'GLEIF_UNAVAILABLE'});expect(f).toHaveBeenCalledTimes(1);
});
it('hard deadline bounds an unresponsive source',async()=>{
 vi.useFakeTimers();vi.stubGlobal('fetch',()=>new Promise(()=>{}));const p=expect(handleGleifRegistry('TESCO PLC','GB')).rejects.toMatchObject({code:'GLEIF_UNAVAILABLE'});await vi.advanceTimersByTimeAsync(3100);await p;
});

it('absent or invalid creation date stays null, never substituted with LEI date',async()=>{
 const j=JSON.parse(raw('tesco'));j.data[0].attributes.entity.creationDate='1947-02-30T00:00:00Z';vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(j)));const out=await handleGleifRegistry('TESCO PLC','GB');expect(out.incorporated).toBeNull();
});
it('malformed positive source refuses rather than asserting a verified entity',async()=>{
 const j=JSON.parse(raw('tesco'));delete j.data[0].attributes.entity.registeredAs;vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(j)));await expect(handleGleifRegistry('TESCO PLC','GB')).rejects.toMatchObject({code:'GLEIF_UNAVAILABLE'});
});
it('inactive entity is false even with an ISSUED LEI',async()=>{
 const j=JSON.parse(raw('tesco'));j.data[0].attributes.entity.status='INACTIVE';j.data[0].attributes.registration.status='ISSUED';vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(j)));expect((await handleGleifRegistry('TESCO PLC','GB')).active).toBe(false);
});
