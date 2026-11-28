import {afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const dir=mkdtempSync('/tmp/travel-route-split-');process.env.SQLITE_PATH=join(dir,'receipts.db');
import {handleTravelDisruption,splitTravelRoute} from '../src/handlers/travelDisruption';
import {answerDiagnostics} from '../src/core/answerClass';
import {travelEndpoint} from '../src/data/travelMetros';
// Real FAA NAS status snapshot (same fixture the other travel tests use). The graded input below is the real route_or_flight string
// that returned coverage_unavailable for receipt rcpt_N8ER5GGL685NJYQIEX3UP5D9ZO (2026-11-28).
const nas=readFileSync(join(__dirname,'fixtures/travel-disruption/faa-nas-status-snapshot.xml'),'utf8');
afterAll(()=>rmSync(dir,{recursive:true,force:true}));afterEach(()=>vi.unstubAllGlobals());
const GRADED='7:15 AM Southwest flight from BWI to MCO';
const stub=()=>{const f=vi.fn(async()=>new Response(nas,{status:200}));vi.stubGlobal('fetch',f);return f;};
describe('splitTravelRoute',()=>{
  it('takes the origin after the last whole word from',()=>{
    expect(splitTravelRoute(GRADED)).toEqual({origin:'BWI',destination:'MCO'});
    expect(splitTravelRoute('flight from Baltimore from BWI to MCO')).toEqual({origin:'BWI',destination:'MCO'});
    expect(splitTravelRoute('FROM BWI to MCO')).toEqual({origin:'BWI',destination:'MCO'});
  });
  it('leaves plain routes unchanged',()=>{
    expect(splitTravelRoute('from BWI to MCO')).toEqual({origin:'BWI',destination:'MCO'});
    expect(splitTravelRoute('BWI to MCO')).toEqual({origin:'BWI',destination:'MCO'});
    expect(splitTravelRoute('BWI-MCO')).toEqual({origin:'BWI',destination:'MCO'});
    expect(splitTravelRoute('Fresno to Denver')).toEqual({origin:'Fresno',destination:'Denver'});
    expect(splitTravelRoute('MBTA Red Line')).toBeNull();
  });
  it('the graded origin and destination each resolve to an airport',()=>{
    const r=splitTravelRoute(GRADED)!;
    expect(travelEndpoint(r.origin)).toHaveLength(1);expect(travelEndpoint(r.destination)).toHaveLength(1);
  });
});
describe('travel disruption with leading words before from',()=>{
  it('graded input resolves BWI-MCO and reaches the FAA snapshot path',async()=>{
    const f=stub();const r:any=await handleTravelDisruption({route_or_flight:GRADED});
    expect(f).toHaveBeenCalled();expect(r.reason_code).toBeUndefined();expect(r.route_or_flight).toBe('BWI-MCO');
    expect(r.airport_statuses.map((s:any)=>s.airport)).toEqual(['BWI','MCO']);expect(typeof r.disrupted).toBe('boolean');
    expect(r.verdict).toBe('verified');
  });
  it.each(['from BWI to MCO','BWI to MCO','BWI-MCO'])('%s still resolves BWI-MCO',async(q)=>{
    stub();const r:any=await handleTravelDisruption({route_or_flight:q});expect(r.route_or_flight).toBe('BWI-MCO');
  });
  it.each(['MBTA Red Line','Hogwarts to Narnia','flight from Nowhere to MCO'])('%s stays coverage_unavailable with null disruption',async(q)=>{
    const f=stub();const r:any=await handleTravelDisruption({route_or_flight:q});
    expect(r.reason_code).toBe('coverage_unavailable');expect(r.disrupted).toBeNull();expect(r.verdict).toBe('unverified');expect(f).not.toHaveBeenCalled();
  });
  it('the diagnostic class agrees with the answer: airport_route for the graded input, coverage_unavailable for unresolved text',async()=>{
    stub();const ok:any=await handleTravelDisruption({route_or_flight:GRADED});
    expect(answerDiagnostics('TRAVEL_DISRUPTION_GENERAL',ok).answerClass).toEqual({travel_input_class:'airport_route'});
    const no:any=await handleTravelDisruption({route_or_flight:'flight from Nowhere to MCO'});
    expect(answerDiagnostics('TRAVEL_DISRUPTION_GENERAL',no).answerClass).toEqual({travel_input_class:'coverage_unavailable'});
  });
});
