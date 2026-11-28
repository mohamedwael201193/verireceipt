import {afterEach,beforeEach,expect,it,vi} from 'vitest';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {recordRequestCompletion,diagnosticErrorCode} from '../src/core/requestMetrics';
import {refusalParamClass,REFUSAL_INTENTS,forecastLocationClass,forecastWindowClass,txShapeClass,txLengthBucket,metricClass,blockClass,periodShape} from '../src/core/refusalClass';
import {handleWeatherForecast} from '../src/handlers/weatherForecast';
import {resetForecastSourcesForTests} from '../src/handlers/forecastSourceCache';
import {resetMetBudgetForTests} from '../src/handlers/metForecast';
let lines:string[];
beforeEach(()=>{lines=[];vi.spyOn(console,'info').mockImplementation((m:unknown)=>{lines.push(String(m));});resetForecastSourcesForTests();resetMetBudgetForTests();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
const parsed=()=>lines.map(l=>JSON.parse(l));
const stages=()=>parsed().filter(o=>o.event==='weather_stage_failure');

it('registers the four routes',()=>{
 expect(REFUSAL_INTENTS['/v1/weather-forecast']).toBe('WEATHER_FORECAST_GENERAL');
 expect(REFUSAL_INTENTS['/v1/transaction-risk']).toBe('TRANSACTION_RISK_GENERAL');
 expect(REFUSAL_INTENTS['/v1/onchain-metric']).toBe('ONCHAIN_METRIC_VERIFY_GENERAL');
 expect(REFUSAL_INTENTS['/v1/filings']).toBe('REGULATORY_FILING_MONITOR_GENERAL');
});
it.each(['FORECAST_MALFORMED','FORECAST_WINDOW_UNCOVERED','GEOCODER_MALFORMED','INVALID_WINDOW','PLACE_NOT_FOUND','UPSTREAM_UNREACHABLE','INVALID_TRANSACTION','SANCTIONS_UNAVAILABLE','TX_NOT_FOUND','TX_RECEIPT_BLOCK_MISMATCH','INVALID_BLOCK','INVALID_METRIC','METRIC_QUORUM_UNAVAILABLE','CIK_CONFLICT','FORM_PHRASE_AMBIGUOUS','INVALID_ENTITY','MAX_PARAM_SIZE','PERIOD_TOO_BROAD','RECEIPT_STORE_FAILED','SEC_DOCUMENT_TOO_LARGE','SEC_TIMEOUT','SEC_USER_AGENT_MISSING','UNSUPPORTED_FORM_PARAM'])('diagnosticErrorCode keeps %s',c=>{expect(diagnosticErrorCode(c)).toBe(c);});
it('diagnosticErrorCode still collapses unknown codes',()=>{expect(diagnosticErrorCode('SECRET_THING')).toBe('OTHER_ERROR');});

it('weather labels',()=>{
 expect(forecastLocationClass('38.2,-79')).toBe('latlon');
 expect(forecastLocationClass('Cairo')).toBe('ascii_place');
 expect(forecastLocationClass('القاهرة')).toBe('non_ascii');
 expect(forecastLocationClass('x'.repeat(300))).toBe('long');
 expect(forecastLocationClass(undefined)).toBe('absent');
 for(const [v,c] of [[undefined,'absent'],['','absent'],['1','1-24'],['24','1-24'],['25','25-72'],['72','25-72'],['73','73-240'],['240','73-240'],['241','invalid'],['0','invalid'],['abc','invalid'],['-5','invalid']] as const)expect(forecastWindowClass(v)).toBe(c);
});
it('transaction labels',()=>{
 expect(txShapeClass('0x'+'a'.repeat(64))).toBe('hash_0x64');
 expect(txShapeClass('0x'+'a'.repeat(40))).toBe('hash_other');
 expect(txShapeClass('0xzz')).toBe('hash_other');
 expect(txShapeClass('Large transfer from an exchange to a new wallet')).toBe('description');
 expect(txShapeClass('x'.repeat(300))).toBe('long');
 expect(txLengthBucket('0x'+'a'.repeat(64))).toBe('17-66');
 expect(txLengthBucket('')).toBe('0');expect(txLengthBucket('x'.repeat(500))).toBe('>256');
});
it('onchain labels',()=>{
 expect(metricClass('balance')).toBe('balance');expect(metricClass('nonce')).toBe('other');expect(metricClass(undefined)).toBe('absent');
 expect(blockClass('19000000')).toBe('numeric');expect(blockClass('latest')).toBe('other');expect(blockClass(undefined)).toBe('absent');
});
it.each([['2024','year4'],['Q3 2024','quarter_like'],['2024 Q3','quarter_like'],['FY2023','fiscal_like'],['fiscal year 2023','fiscal_like'],['last 6 months','relative_months'],['6 months','relative_months'],['2023-2024','range'],['2023 to 2024','range'],['March 2024','month_name'],['Jan 2023','month_name'],['whatever the latest is','other'],['','other']])('periodShape(%s)=%s',(v,c)=>{expect(periodShape(v)).toBe(c);});

it('refusalParamClass branches',()=>{
 expect(refusalParamClass('/v1/weather-forecast','PLACE_NOT_FOUND',{location:'Zzyzx',window_hours:'48'})).toEqual({location_class:'ascii_place',window_class:'25-72'});
 expect(refusalParamClass('/v1/transaction-risk','TX_NOT_FOUND',{transaction:'0x'+'b'.repeat(64)})).toEqual({tx_shape:'hash_0x64',length_bucket:'17-66'});
 expect(refusalParamClass('/v1/onchain-metric','UNSUPPORTED_CHAIN',{chain:'ethereum',metric:'balance',block:'12'})).toEqual({chain_class:'ethereum',metric_class:'balance',block_class:'numeric',has_free_text_query:false});
 expect(refusalParamClass('/v1/onchain-metric','UNSUPPORTED_CHAIN',{chain:'Weirdchain'})).toMatchObject({chain_class:'other',metric_class:'absent',block_class:'absent'});
 expect(refusalParamClass('/v1/onchain-metric','INVALID_ADDRESS',{chain:'base'})).toMatchObject({chain_class:'base'});
 expect(refusalParamClass('/v1/onchain-metric','RPC_CONFIG',{chain:'base'})).toBeNull();
 expect(refusalParamClass('/v1/filings','INVALID_PERIOD',{period:'Q3 2024',form_type:'10-K'})).toEqual({period_shape:'quarter_like',has_form_type:true});
 expect(refusalParamClass('/v1/filings','PERIOD_TOO_BROAD',{period:'2023-2024'})).toEqual({period_shape:'range',has_form_type:false});
 expect(refusalParamClass('/v1/filings','ENTITY_NOT_FOUND',{period:'2024'})).toBeNull();
});
it('no log line contains the raw input',()=>{
 const secrets=['Zq-Secret-Town','0xdeadbeefcafe1234deadbeefcafe1234deadbeefcafe1234deadbeefcafe1234','Wire-Secret-Sentence-77','Chain-Secret-9','Period-Secret-55'];
 recordRequestCompletion('/v1/weather-forecast',502,5,{query:{location:secrets[0],window_hours:'9999'},errorCode:'UPSTREAM_UNREACHABLE',rawErrorCode:'UPSTREAM_UNREACHABLE'});
 recordRequestCompletion('/v1/transaction-risk',422,5,{query:{transaction:secrets[1]},errorCode:'TX_NOT_FOUND',rawErrorCode:'TX_NOT_FOUND'});
 recordRequestCompletion('/v1/transaction-risk',422,5,{query:{transaction:secrets[2]},errorCode:'OTHER_ERROR'});
 recordRequestCompletion('/v1/onchain-metric',400,5,{query:{chain:secrets[3],metric:'x-metric-secret',block:'blk-secret'},errorCode:'UNSUPPORTED_CHAIN',rawErrorCode:'UNSUPPORTED_CHAIN'});
 recordRequestCompletion('/v1/filings',400,5,{query:{entity:'Entity-Secret',period:secrets[4],form_type:'10-K'},errorCode:'INVALID_PERIOD',rawErrorCode:'INVALID_PERIOD'});
 const all=lines.join('\n');
 for(const bad of [...secrets,'x-metric-secret','blk-secret','Entity-Secret','deadbeef','Secret'])expect(all).not.toContain(bad);
 const r=parsed().filter(o=>o.event==='refusal_param_class');
 expect(r).toHaveLength(5);
 expect(r[0]).toMatchObject({intent:'WEATHER_FORECAST_GENERAL',error_code:'UPSTREAM_UNREACHABLE',status:'502',location_class:'ascii_place',window_class:'invalid'});
 expect(r[3]).toMatchObject({intent:'ONCHAIN_METRIC_VERIFY_GENERAL',chain_class:'other',metric_class:'other',block_class:'other'});
 expect(r[4]).toMatchObject({intent:'REGULATORY_FILING_MONITOR_GENERAL',period_shape:'other',has_form_type:true});
});

it('stage failure: geocoder 429 is logged once with a closed class and the client error is unchanged',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:429})));
 await expect(handleWeatherForecast({location:'Zzyzx-Secret'})).rejects.toMatchObject({status:502,code:'UPSTREAM_UNREACHABLE'});
 expect(stages()).toEqual([{event:'weather_stage_failure',stage:'geocoder',http_class:'429'}]);
 expect(lines.join('\n')).not.toContain('Secret');
},15000);
it('stage failure: forecast 404 then fallback both labelled; response stays UPSTREAM_UNREACHABLE',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:404})));
 await expect(handleWeatherForecast({location:'38.2,-79'})).rejects.toMatchObject({status:502,code:'UPSTREAM_UNREACHABLE'});
 const s=stages();
 expect(s[0]).toEqual({event:'weather_stage_failure',stage:'forecast',http_class:'4xx'});
 expect(s.slice(1).every(o=>o.stage==='fallback'&&['4xx','5xx','timeout','parse','429','none'].includes(o.http_class))).toBe(true);
 expect(s.length).toBeGreaterThanOrEqual(2);
});
it('stage failure: unparseable forecast body logs forecast/parse and keeps FORECAST_MALFORMED',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('<html>not json</html>',{status:200})));
 await expect(handleWeatherForecast({location:'38.2,-79'})).rejects.toMatchObject({status:502,code:'FORECAST_MALFORMED'});
 expect(stages()).toEqual([{event:'weather_stage_failure',stage:'forecast',http_class:'parse'}]);
});
