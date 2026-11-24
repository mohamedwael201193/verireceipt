import {it,expect,vi,afterEach} from 'vitest';
import {recordRequestArrival,recordRequestCompletion,safeRequestEnums,resetRequestMetricsForTests} from '../src/core/requestMetrics';
afterEach(()=>{vi.restoreAllMocks();resetRequestMetricsForTests();});
it('logs start with fixed intent keys and only canonical route-owned enums',()=>{
 const log=vi.spyOn(console,'info').mockImplementation(()=>{});
 recordRequestArrival('/v1/filings',{entity:'PRIVATE_NAME',period:'last 12 months',form_type:'10-k',PRIVATE_KEY:'PRIVATE_SECRET'});
 expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({event:'request_start',intent:'REGULATORY_FILING_MONITOR_GENERAL',path:'/v1/filings',param_keys:['entity','form_type','period'],input_enums:{form_type:'10-K',period_kind:'relative_months'}});
 expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
 recordRequestCompletion('/v1/filings',422,1,{errorCode:'MULTIPLE_FORM_TYPES'});expect(JSON.parse(log.mock.calls[1][0] as string).error_code).toBe('MULTIPLE_FORM_TYPES');
});
it('never echoes free text values, unknown keys, arbitrary errors or route fields',()=>{
 const log=vi.spyOn(console,'info').mockImplementation(()=>{});
 for(const route of ['/v1/filings','/v1/code-patch','/v1/weather-forecast','/v1/dns','/v1/fx','/v1/balance'])recordRequestArrival(route,{entity:'private@example.com',patch:'private@example.com',location:'private@example.com',chain:'private@example.com',base:'private@example.com',form_type:'private@example.com',period:'private@example.com',record_type:'private@example.com','private@example.com':'secret'});
 expect(JSON.stringify(log.mock.calls)).not.toContain('private@example.com');expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
 expect(safeRequestEnums('/v1/weather-forecast',{chain:'ethereum',form_type:'10-K'})).toEqual({});
});
it('does not execute getters or log unknown routes',()=>{
 const log=vi.spyOn(console,'info').mockImplementation(()=>{});const query=Object.defineProperty({},'form_type',{get(){throw new Error('PRIVATE');}});
 recordRequestArrival('/v1/filings',query);expect(JSON.parse(log.mock.calls[0][0] as string).input_enums).toEqual({});recordRequestArrival('/PRIVATE',query);expect(log).toHaveBeenCalledTimes(1);
});
it('has finite classifications rather than exposing dates or values',()=>{
 expect(safeRequestEnums('/v1/filings',{period:'2026',form:'10-K, 10-Q'})).toEqual({period_kind:'year',form:'other'});
 expect(safeRequestEnums('/v1/filings',{period:'2026-01-01..2026-03-31'})).toEqual({period_kind:'date_range'});
 expect(safeRequestEnums('/v1/balance',{chain:'Ethereum',amount:'1234',address:'secret'})).toEqual({chain:'ethereum'});
});
