import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../src/core/storage',()=>({getGridPrice:vi.fn(async()=>null),getGridRange:vi.fn(async()=>({oldest:null,newest:null})),getGridRevalidate:vi.fn(),markGridRevalidateAttempt:vi.fn(),saveGridPrice:vi.fn(),saveReceipt:vi.fn()}));
import {getGridRange,saveReceipt} from '../src/core/storage';
import {handleGridPrice} from '../src/handlers/gridPrice';
import {answerDiagnostics,sanitizeAnswerClass} from '../src/core/answerClass';
const input={node_or_zone:'EE',interval_start:'2026-11-01T12:00:00Z'};
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
it.each([['older','2026-11-02T00:00:00.000Z','2026-11-03T00:00:00.000Z'],['newer','2026-10-01T00:00:00.000Z','2026-10-03T00:00:00.000Z'],['within','2026-10-01T00:00:00.000Z','2026-11-03T00:00:00.000Z'],['empty',null,null]])('closed %s position stays process-local and preserves original502',async(position,oldest,newest)=>{
 vi.mocked(getGridRange).mockResolvedValue({oldest,newest});const error=await handleGridPrice(input).catch(e=>e);
 expect(error.code).toBe('GRID_CACHE_MISS');expect(error.status).toBe(502);expect(answerDiagnostics('GRID_POWER_PRICE_GENERAL',error).answerClass).toEqual({grid_market:'Elering',grid_interval_position:position});expect(JSON.stringify(error)).not.toContain('grid_interval_position');expect(saveReceipt).not.toHaveBeenCalled();
});
it('diagnostic storage failure cannot replace original refusal',async()=>{
 vi.mocked(getGridRange).mockRejectedValueOnce(Error('private database error'));const error=await handleGridPrice(input).catch(e=>e);expect(error.code).toBe('GRID_CACHE_MISS');expect(answerDiagnostics('GRID_POWER_PRICE_GENERAL',error).answerClass).toEqual({grid_market:'Elering',grid_interval_position:'unknown'});
});
it('diagnostic storage hang adds at most100ms before original refusal',async()=>{
 vi.useFakeTimers();vi.mocked(getGridRange).mockImplementationOnce(()=>new Promise(()=>{}));const p=handleGridPrice(input).catch(e=>e);await vi.advanceTimersByTimeAsync(100);expect((await p).code).toBe('GRID_CACHE_MISS');
});
it('arbitrary request-looking values, foreign keys and cross-intent labels cannot enter logs',()=>{
 expect(sanitizeAnswerClass('GRID_POWER_PRICE_GENERAL',{grid_market:'EE-private',grid_interval_position:'2026-11-01',node:'PRIVATE'})).toBeUndefined();expect(sanitizeAnswerClass('GAME_RESULT_GENERAL',{grid_market:'CAISO',grid_interval_position:'older'})).toBeUndefined();
});
it('NYISO paired aliases share range classification without logging either spelling',async()=>{
 vi.mocked(getGridRange).mockImplementation(async node=>node==='ZONE_J'?{oldest:'2026-10-01T00:00:00.000Z',newest:'2026-10-03T00:00:00.000Z'}:{oldest:null,newest:null});
 const error=await handleGridPrice({...input,node_or_zone:'N.Y.C.'}).catch(e=>e);expect(answerDiagnostics('GRID_POWER_PRICE_GENERAL',error).answerClass).toEqual({grid_market:'NYISO',grid_interval_position:'newer'});expect(getGridRange).toHaveBeenCalledWith('ZONE_J');expect(getGridRange).toHaveBeenCalledWith('N.Y.C.');
});
it('unparseable stored range is unknown rather than a guessed direction',async()=>{
 vi.mocked(getGridRange).mockResolvedValue({oldest:'invalid',newest:'invalid'});const error=await handleGridPrice(input).catch(e=>e);expect(answerDiagnostics('GRID_POWER_PRICE_GENERAL',error).answerClass).toEqual({grid_market:'Elering',grid_interval_position:'unknown'});
});
