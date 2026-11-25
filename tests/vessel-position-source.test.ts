import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {barentswatchPositionSource,createVesselObservationHandler} from '../src/handlers/vesselPositionSource';
const raw=readFileSync(new URL('./fixtures/vessel-ais/barentswatch-position-20261125.json',import.meta.url),'utf8');
const approval={termsUrl:'https://openwaters.io/api/ais/',checkedAt:'2026-11-25T00:00:00Z',commercialUse:false,redistribution:false,ownerRiskAcceptance:{scope:'testnet-hackathon' as const,sourceReference:'synthetic-test-configuration-not-an-approval',acceptedAt:'2026-11-25T00:00:00Z'}};
const q={vessel:'257635500'};
let cancel:ReturnType<typeof vi.fn>;
function response(lines:string[],status=200,type='text/event-stream'){
 return new Response(new ReadableStream({start(c){for(const line of lines)c.enqueue(new TextEncoder().encode(line));},cancel}),{status,headers:{'content-type':type}});
}
function valid(){return response(['data: {"type":"welcome"}\n\n','data: '+raw.replace(/\n/g,'')+'\n\n']);}
function altered(fn:(e:any)=>void){const e=JSON.parse(raw);fn(e);return response(['data: '+JSON.stringify(e)+'\n\n']);}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-25T01:45:00Z'));vi.clearAllMocks();cancel=vi.fn();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('one-shot SSE uses fixed host exact MMSI, saves one receipted event and closes stream',async()=>{
 const fetcher=vi.fn(async()=>valid());vi.stubGlobal('fetch',fetcher);
 const result=await createVesselObservationHandler(approval)(q);
 expect(result).toMatchObject({vessel:q.vessel,speed_knots:0,observed_at:'2026-11-25T01:44:57.8644366Z',synthesized:true});
 expect(result.answer).toContain('Data delivered by BarentsWatch.');expect(result.answer).toContain('not independently authenticated');
 expect(fetcher.mock.calls[0][0]).toBe('https://ais.openwaters.io/v1/stream?mmsi=257635500&snapshot=1');
 expect((fetcher.mock.calls[0] as any)[1].redirect).toBe('error');expect(cancel).toHaveBeenCalledTimes(1);
 expect(saveReceipt).toHaveBeenCalledTimes(1);const[receipt,evidence]=(vi.mocked(saveReceipt).mock.calls[0] as unknown as [any,string]);
 const stored=JSON.parse(evidence);expect(JSON.parse(stored.raw_body)).toEqual(JSON.parse(raw));expect(stored.observed_at).toBe('2026-11-25T01:44:57.8644366Z');
 expect(receipt.raw_response_sha256).toBe(createHash('sha256').update(evidence).digest('hex'));
 expect(stored.terms).toMatchObject({commercial_use_confirmed:false,redistribution_confirmed:false,owner_terms_risk_accepted:true});
});
it('supports byte/line splits and ignores static frames without taking their cached position',async()=>{
 const s='data: '+JSON.stringify({type:'event',msg_type:'StaticDataReport'})+'\r\n\r\ndata: '+raw.replace(/\n/g,'')+'\r\n\r\n';vi.stubGlobal('fetch',vi.fn(async()=>response([s.slice(0,37),s.slice(37,140),s.slice(140)])));
 expect((await createVesselObservationHandler(approval)(q)).speed_knots).toBe(0);
});
for(const[name,make]of [
 ['identity dissent',()=>altered(e=>e.message.UserID++)],['stale event',()=>altered(e=>e.time='2026-11-25T01:39:59Z')],
 ['source error',()=>response(['data: {"type":"error","error":"unavailable"}\n'])],['body bound',()=>response([': '+ 'x'.repeat(65536)+'\n','data: '+raw.replace(/\n/g,'')+'\n'])],
 ['frame bound',()=>response([...Array.from({length:33},()=> 'data: {"type":"welcome"}\n'),'data: '+raw.replace(/\n/g,'')+'\n'])],
 ['malformed JSON',()=>response(['data: {bad}\n'])],['wrong media type',()=>response(['data: '+raw.replace(/\n/g,'')+'\n'],200,'text/html')],['HTTP failure',()=>response(['data: '+raw.replace(/\n/g,'')+'\n'],503)],
] as const)it('refuses '+name+' without receipt',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>make()));await expect(createVesselObservationHandler(approval)(q)).rejects.toMatchObject({status:502});expect(saveReceipt).not.toHaveBeenCalled();});
it('unsupported query refuses before network',async()=>{const f=vi.fn();vi.stubGlobal('fetch',f);await expect(createVesselObservationHandler(approval)({vessel:'https://invalid.test'})).rejects.toMatchObject({status:400});expect(f).not.toHaveBeenCalled();expect(saveReceipt).not.toHaveBeenCalled();});
it('unapproved caller source remains disabled',async()=>{const f=vi.fn();vi.stubGlobal('fetch',f);await expect(createVesselObservationHandler({...approval,ownerRiskAcceptance:undefined})(q)).rejects.toMatchObject({status:502});expect(f).not.toHaveBeenCalled();});
it('stalled body deadline cancels stream, aborts fetch and never saves late',async()=>{
 let signal:AbortSignal|undefined;vi.stubGlobal('fetch',vi.fn(async(_u,o)=>{signal=o.signal;return response([]);}));
 const p=createVesselObservationHandler(approval)(q);const caught=p.catch(e=>e);await vi.advanceTimersByTimeAsync(2501);expect(await caught).toMatchObject({status:502});expect(signal?.aborted).toBe(true);expect(cancel).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(5000);expect(saveReceipt).not.toHaveBeenCalled();
});
it('fetch ignoring abort still cannot save a late receipt',async()=>{
 vi.stubGlobal('fetch',vi.fn(()=>new Promise(resolve=>setTimeout(()=>resolve(valid()),4000))));const p=createVesselObservationHandler(approval)(q).catch(e=>e);
 await vi.advanceTimersByTimeAsync(2501);expect(await p).toMatchObject({status:502});await vi.advanceTimersByTimeAsync(5000);expect(saveReceipt).not.toHaveBeenCalled();expect(cancel).toHaveBeenCalledTimes(1);
});
it('parent abort is honored even before fetch',async()=>{const f=vi.fn();vi.stubGlobal('fetch',f);const c=new AbortController();c.abort();await expect(barentswatchPositionSource(approval).read(q,c.signal)).rejects.toThrow();expect(f).not.toHaveBeenCalled();});
it('storage failure propagates once without a second source receipt',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>valid()));vi.mocked(saveReceipt).mockRejectedValueOnce(Error('storage failed'));await expect(createVesselObservationHandler(approval)(q)).rejects.toThrow('storage failed');expect(saveReceipt).toHaveBeenCalledTimes(1);});

it('parent abort closes a stalled reader and cannot save',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>response([])));const c=new AbortController();const pending=barentswatchPositionSource(approval).read(q,c.signal).catch(e=>e);await vi.advanceTimersByTimeAsync(1);c.abort();expect(await pending).toBeInstanceOf(Error);expect(cancel).toHaveBeenCalledTimes(1);expect(saveReceipt).not.toHaveBeenCalled();});
it('stream ending without a position refuses',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({start(c){c.close();}}),{headers:{'content-type':'text/event-stream'}})));await expect(createVesselObservationHandler(approval)(q)).rejects.toMatchObject({status:502});expect(saveReceipt).not.toHaveBeenCalled();});
it('irrelevant query URL cannot override the fixed source',async()=>{const f=vi.fn(async()=>valid());vi.stubGlobal('fetch',f);await createVesselObservationHandler(approval)({...q,url:'https://invalid.test'});expect(f.mock.calls[0][0]).toBe('https://ais.openwaters.io/v1/stream?mmsi=257635500&snapshot=1');});

function responseBytes(parts:Uint8Array[]){return new Response(new ReadableStream({start(c){for(const b of parts)c.enqueue(b);},cancel}),{headers:{'content-type':'text/event-stream'}});}
it('invalid UTF8 inside otherwise-valid irrelevant event text refuses rather than replaces',async()=>{
 const e=JSON.parse(raw);e.padding='MARK';const bytes=Buffer.from('data: '+JSON.stringify(e)+'\n');const index=bytes.indexOf('MARK');bytes[index]=0xff;
 vi.stubGlobal('fetch',vi.fn(async()=>responseBytes([bytes])));await expect(createVesselObservationHandler(approval)(q)).rejects.toMatchObject({status:502});expect(saveReceipt).not.toHaveBeenCalled();
});
it('valid multibyte UTF8 may span chunks without replacement',async()=>{
 const e=JSON.parse(raw);e.padding='船';const bytes=Buffer.from('data: '+JSON.stringify(e)+'\n');const index=bytes.indexOf(Buffer.from('船'));
 vi.stubGlobal('fetch',vi.fn(async()=>responseBytes([bytes.subarray(0,index+1),bytes.subarray(index+1,index+2),bytes.subarray(index+2)])));
 const result=await createVesselObservationHandler(approval)(q);expect(result.speed_knots).toBe(0);const evidence=JSON.parse(vi.mocked(saveReceipt).mock.calls[0][1]);expect(JSON.parse(evidence.raw_body).padding).toBe('船');
});
