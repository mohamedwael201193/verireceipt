import {it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {handleNewsSearch} from '../src/handlers/newsSearch';
import {handleNewsHeadlines} from '../src/handlers/newsHeadlines';
import {resetNewsCircuitForTests} from '../src/handlers/newsSources';
const hn=readFileSync('tests/fixtures/news/hn-algolia-openai-7d.json','utf8');
const bbc=readFileSync('tests/fixtures/news/bbc-world-rss.xml','utf8');
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.mocked(saveReceipt).mockReset();resetNewsCircuitForTests();});
for(const mode of ['search','headlines'] as const){
 const run=()=>mode==='search'?handleNewsSearch({query:'openai'}):handleNewsHeadlines({topic:'technology',window:'24h'});
 it(`${mode} hanging receipt fails at shared source deadline+450ms`,async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-23T01:00:00Z'));vi.stubGlobal('fetch',async(u:any)=>new Response(String(u).includes('algolia')?hn:bbc));vi.mocked(saveReceipt).mockImplementation(()=>new Promise(()=>{}));
 let settled=false;const p=run().catch(e=>{settled=true;return e;});await vi.advanceTimersByTimeAsync(2949);expect(settled).toBe(false);await vi.advanceTimersByTimeAsync(1);expect(settled).toBe(true);expect(await p).toMatchObject({code:'RECEIPT_PERSIST_FAILED'});
 });
 it(`${mode} all-source abort-ignoring fetches end by2500ms, no receipt`,async()=>{
 vi.useFakeTimers();const f=vi.fn(()=>new Promise<Response>(()=>{}));vi.stubGlobal('fetch',f);let done=false;const p=run().catch(e=>{done=true;return e;});await vi.advanceTimersByTimeAsync(2499);expect(done).toBe(false);await vi.advanceTimersByTimeAsync(1);expect(done).toBe(true);expect(await p).toMatchObject({code:'NEWS_INDEXES_UNREACHABLE'});expect(f).toHaveBeenCalledTimes(mode==='search'?4:5);expect(saveReceipt).not.toHaveBeenCalled();
 });
}
