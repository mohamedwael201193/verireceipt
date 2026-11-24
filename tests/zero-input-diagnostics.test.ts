import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {handleTravelDisruption} from '../src/handlers/travelDisruption';
import {handleSlaCompliance} from '../src/handlers/slaCompliance';
import {answerDiagnostics,sanitizeAnswerClass} from '../src/core/answerClass';
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
it.each([[undefined,'missing'],['UA123','flight_number'],['UNKNOWN LONG PLACE','unsupported'],['New York','ambiguous_airport'],['x'.repeat(201),'invalid']])('travel refused input has closed class %s',async(value,cls)=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);const error=await handleTravelDisruption({route_or_flight:value}).catch(e=>e);expect(answerDiagnostics('TRAVEL_DISRUPTION_GENERAL',error).answerClass).toEqual({travel_input_class:cls});expect(error.status).toBeGreaterThanOrEqual(400);expect(f).not.toHaveBeenCalled();expect(JSON.stringify(error)).not.toContain('travel_input_class');
});
it.each([['LGA','airport_code'],['LaGuardia','airport_name'],['LGA-JFK','airport_route']])('travel success has class only in process metadata %s',async(value,cls)=>{
 vi.stubGlobal('fetch',async()=>new Response(readFileSync('tests/fixtures/travel-disruption/faa-nas-status-snapshot.xml','utf8')));const out=await handleTravelDisruption({route_or_flight:value});expect(answerDiagnostics('TRAVEL_DISRUPTION_GENERAL',out).answerClass).toEqual({travel_input_class:cls});expect(JSON.stringify(out)).not.toContain('travel_input_class');expect(String(vi.mocked(saveReceipt).mock.calls[0][1])).not.toContain('travel_input_class');
});
it.each([[undefined,'30d','missing','rolling_days'],['unbound-service','last 30 days','unbound','rolling_days'],['https://unknown.invalid','November 2026','url','calendar'],['github','arbitrary','bound','unsupported'],['github',undefined,'bound','missing']])('SLA diagnostics do not equate present-unbound with missing %s',async(service,period,sc,pc)=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);const out=await handleSlaCompliance({service,period}).catch(e=>e);expect(answerDiagnostics('SLA_COMPLIANCE_GENERAL',out).answerClass).toMatchObject({sla_service_input_class:sc,sla_period_input_class:pc});expect(f).not.toHaveBeenCalled();expect(JSON.stringify(out)).not.toContain('sla_service_input_class');if(!service||!period)expect(out.code).toBe('MISSING_PARAM');else expect(out.uptime_pct).toBeNull();
});
it('sanitizer refuses raw-looking values and cross-intent labels',()=>{
 expect(sanitizeAnswerClass('TRAVEL_DISRUPTION_GENERAL',{travel_input_class:'UA123',sla_service_input_class:'bound'})).toBeUndefined();expect(sanitizeAnswerClass('SLA_COMPLIANCE_GENERAL',{sla_service_input_class:'private-service',sla_period_input_class:'2026-11-01'})).toBeUndefined();
});
