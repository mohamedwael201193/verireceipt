import {afterEach, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
vi.mock('../src/core/storage', () => ({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {sha256Hex} from '../src/core/receipt';
import {handleEventOutcome} from '../src/handlers/eventOutcome';
import {electionWinner} from '../src/handlers/eventWikipedia';
const read=(name:string)=>readFileSync(join(__dirname,'fixtures/event-wikipedia',name+'.json'),'utf8');
const title='2020 United States presidential election';
const summary=JSON.parse(read('summary'));
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
function stub() {
 const f=vi.fn(async(url:unknown)=>new Response(String(url).includes('polymarket')?read('polymarket'):String(url).includes('/search/')?read('search'):read('summary')));
 vi.stubGlobal('fetch',f);return f;
}
it('real captured no-match falls back to explicit Wikipedia winner and preserves all bodies and digest',async()=>{
 const f=stub(); const out=await handleEventOutcome({event:title});
 expect(out.winner).toBe('Joe Biden');expect(out.outcome).toBe('yes');expect(out.resolved_at).toBeNull();
 expect(String(out.answer)).toContain('Single-source');expect(String(out.answer)).toContain('CC BY-SA 4.0');expect(f).toHaveBeenCalledTimes(3);
 const [r,e]=vi.mocked(saveReceipt).mock.calls[0];expect(r.raw_response_sha256).toBe(sha256Hex(e));
 const ev=JSON.parse(e);expect(ev.raw_bodies.summary).toBe(read('summary'));expect(ev.raw_bodies.search).toBe(read('search'));expect(ev.raw_bodies.primary).toBe(read('polymarket'));
});
it('supports who-won phrasing without changing named-event meaning',async()=>{
 stub();expect((await handleEventOutcome({event:'Who won the '+title+'?'})).winner).toBe('Joe Biden');
});
it.each(['Did Donald Trump win the '+title+'?','Who won the '+title+' in Texas?','2020 United States presidential election and recount','United States presidential election'])('refuses unsupported conditions or incomplete identity: %s',async(event)=>{
 stub();await expect(handleEventOutcome({event})).rejects.toMatchObject({code:'EVENT_NOT_FOUND'});expect(saveReceipt).not.toHaveBeenCalled();
});
it('refuses missing, negated, prospective or contradictory winner evidence',()=>{
 for(const changed of [
  {...summary,extract:'No outcome has been determined.'},
  {...summary,extract:summary.extract.replace(' defeated ',' did not defeat ')},
  {...summary,extract:summary.extract.replace(' defeated ',' would have defeated ')},
  {...summary,description:'Election of Donald Trump'},
  {...summary,title:'2020 United States presidential election in Texas'},
  {...summary,type:'disambiguation'},
 ])expect(()=>electionWinner(changed,title)).toThrow();
});
it('refuses a generic sports summary with no explicit winner rather than use article title as result',()=>{
 expect(()=>electionWinner({...summary,title:'2022 FIFA World Cup',description:'Association football tournament',extract:'The tournament took place in Qatar.'},'2022 FIFA World Cup')).toThrow();
});
it('rejects duplicate exact search identities and no exact match',async()=>{
 for(const pages of [[{title,key:'x'},{title,key:'y'}],[{title:title+' in Texas',key:'x'}]]) {
  vi.stubGlobal('fetch',async(url:unknown)=>new Response(String(url).includes('polymarket')?read('polymarket'):JSON.stringify({pages})));
  await expect(handleEventOutcome({event:title})).rejects.toMatchObject({code:'EVENT_NOT_FOUND'});
 }
 expect(saveReceipt).not.toHaveBeenCalled();
});
it('refuses future elections and unsupported event families even if a supplied summary looks resolved',()=>{
 for(const name of ['2028 United States presidential election','2026 United States presidential election','2020 fictional election'])expect(()=>electionWinner({...summary,title:name},name)).toThrow();
});
it('persistence failure cannot return a successful fallback',async()=>{
 stub();vi.mocked(saveReceipt).mockRejectedValueOnce(new Error('storage failure'));
 await expect(handleEventOutcome({event:title})).rejects.toMatchObject({code:'RECEIPT_PERSIST_FAILED'});
});
it.each([[2024,'Donald Trump'],[2016,'Donald Trump'],[2012,'Barack Obama']])('recognizes real captured %s election description while requiring the result sentence',async(year,winner)=>{
 const captured=readFileSync(join(__dirname,'fixtures/event-wikipedia','summary-'+year+'.json'),'utf8');
 const j=JSON.parse(captured);expect(electionWinner(j,j.title).winner).toBe(winner);
 expect(()=>electionWinner({...j,extract:'The election was held in the United States.'},j.title)).toThrow();
 vi.stubGlobal('fetch',async(url:unknown)=>new Response(String(url).includes('polymarket')?JSON.stringify({events:[]}):String(url).includes('/search/')?JSON.stringify({pages:[{title:j.title,key:j.title.replace(/ /g,'_')}]}):captured));
 const out=await handleEventOutcome({event:'Who won the '+year+' US presidential election?'});expect(out.winner).toBe(winner);
 expect(JSON.parse(vi.mocked(saveReceipt).mock.calls[0][1]).raw_bodies.summary).toBe(captured);
});
