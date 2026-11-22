import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,describe,expect,it,vi } from 'vitest';
import HostedResearch from './HostedResearch';
const input=JSON.stringify({cik:'1318605',year:2024,form:'10-Q',minimum_count:3});
const id='12345678-1234-4234-8234-123456789abc';
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status});
function setup(last:(url:string,opts?:RequestInit)=>Promise<Response>){
 const fetcher=vi.fn(async(url:string,opts?:RequestInit)=>{
  if(url.endsWith('/status'))return json({enabled:true,network:'eip155:11155111',call_uusdc:'10000'});
  if(url.endsWith('/session'))return json({ready:true,network:'eip155:11155111',call_uusdc:'10000'});
  return last(url,opts);
 });vi.stubGlobal('fetch',fetcher);render(<HostedResearch inputJson={input}/>);return fetcher;
}
async function ready(){fireEvent.click(screen.getByRole('button',{name:'Check hosted availability'}));await screen.findByRole('button',{name:/Run once, operator pays/});}
afterEach(()=>{vi.unstubAllGlobals();sessionStorage.clear();});
describe('hosted browser job boundary, test-only HTTP responses and no real purchases',()=>{
 it('does no network work or payment on mount and shows the exact terms',()=>{
  const f=setup(async()=>json({}));expect(f).not.toHaveBeenCalled();expect(screen.getByText(/one real \$0.01 test-USDC/)).toBeInTheDocument();expect(screen.getByText(/related-party purchase/)).toBeInTheDocument();expect(screen.getByText(/hash.*session\/network/)).toBeInTheDocument();expect(screen.queryByRole('button',{name:/Run once/})).not.toBeInTheDocument();
 });
 it('availability checking only uses two read-only endpoints',async()=>{
  const f=setup(async()=>{throw new Error('No paid endpoint allowed');});await ready();expect(f.mock.calls.map(c=>c[0])).toEqual(['/api/v1/research/status','/api/v1/research/session']);
 });
 it('fails closed on disabled service without creating a session or job',async()=>{
  const f=vi.fn(async()=>json({},404));vi.stubGlobal('fetch',f);render(<HostedResearch inputJson={input}/>);fireEvent.click(screen.getByRole('button',{name:'Check hosted availability'}));await screen.findByText(/Nothing was submitted/);expect(f).toHaveBeenCalledOnce();expect(screen.queryByRole('button',{name:/Run once/})).not.toBeInTheDocument();
 });
 it('does not silently retry a POST and preserves its idempotency key on explicit recovery',async()=>{
  const f=setup(async()=>{throw new Error('response lost');});await ready();fireEvent.click(screen.getByRole('button',{name:/Run once/}));await screen.findByText(/may have reached the payer/);
  const recover=screen.getByRole('button',{name:'Recover this same submission'});fireEvent.click(recover);await waitFor(()=>expect(f.mock.calls.filter(c=>c[0].endsWith('/jobs'))).toHaveLength(2));
  const calls=f.mock.calls.filter(c=>c[0].endsWith('/jobs'));expect(calls[0][1]?.body).toBe(input);expect(new Headers(calls[0][1]?.headers).get('Idempotency-Key')).toBe(new Headers(calls[1][1]?.headers).get('Idempotency-Key'));
 });
 it('shows uncertain as HOLD with no count, refund or automatic retry',async()=>{
  const f=setup(async url=>url.endsWith('/jobs')?json({job_id:id,network:'eip155:11155111'},202):json({job_id:id,state:'uncertain',result:null}));await ready();fireEvent.click(screen.getByRole('button',{name:/Run once/}));await screen.findByText('HOLD: outcome requires reconciliation');expect(screen.getByText(/payment may have occurred/)).toBeInTheDocument();expect(f.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);expect(screen.queryByRole('button',{name:/Download/})).not.toBeInTheDocument();
 });
 it('does not turn capacity rejection into another paid request',async()=>{
  const f=setup(async()=>json({code:'BUSY'},429));await ready();fireEvent.click(screen.getByRole('button',{name:/Run once/}));await screen.findByText(/capacity or the testnet safety budget/);expect(f.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);
 });
});

it('recovers the original submission across reload even when the edited question changes',async()=>{
 const f=setup(async()=>{throw new Error('response lost');});await ready();fireEvent.click(screen.getByRole('button',{name:/Run once/}));await screen.findByText(/may have reached the payer/);
 const first=f.mock.calls.find(c=>c[1]?.method==='POST')!;cleanup();render(<HostedResearch inputJson={input.replace('2024','2023')}/>);
 expect(screen.getByText('Original question: CIK 1318605, exact 10-Q, calendar 2024, minimum 3.')).toBeInTheDocument();
 expect(screen.getByText(/prepared question has changed/)).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Recover this same submission'}));await waitFor(()=>expect(f.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(2));
 const last=f.mock.calls.filter(c=>c[1]?.method==='POST')[1];expect(last[1]?.body).toBe(input);expect(new Headers(last[1]?.headers).get('Idempotency-Key')).toBe(new Headers(first[1]?.headers).get('Idempotency-Key'));
});
it('does not POST when durable browser recovery storage is unavailable',async()=>{
 const f=setup(async()=>json({}));await ready();const spy=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('storage blocked');});
 fireEvent.click(screen.getByRole('button',{name:/Run once/}));await screen.findByText(/browser recovery storage is unavailable/);expect(f.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(0);spy.mockRestore();
});

function completedReport(change:Record<string,unknown>={}){
 return {version:'research-run-v1',plan:{version:'research-packet-v1',cik:'1318605',year:2024,form:'10-Q',minimum_count:3,network:'eip155:11155111',...change},
  plan_hash:'a'.repeat(64),result:{status:'SUPPORTED',reason:'Controlled test response, not a real paid run.',observed_count:3,checks:[{name:'test-only source check',ok:true}]},
  verification_checks:[{name:'test-only signal check',ok:true}],delivery:{status:'pending'}};
}
it('shows a completed report only for the original submitted question',async()=>{
 const f=setup(async url=>url.endsWith('/jobs')?json({job_id:id,network:'eip155:11155111'},202):json({job_id:id,state:'complete',result:completedReport()}));
 await ready();fireEvent.click(screen.getByRole('button',{name:/Run once/}));await screen.findByText(/Server-reported result: SUPPORTED/);
 expect(screen.getByText('Original question: CIK 1318605, exact 10-Q, calendar 2024, minimum 3.')).toBeInTheDocument();
 expect(f.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);
});
it.each([{cik:'320193'},{year:2023},{form:'10-K'},{minimum_count:4}])('withholds a different question report without a paid retry %j',async change=>{
 const f=setup(async url=>url.endsWith('/jobs')?json({job_id:id,network:'eip155:11155111'},202):json({job_id:id,state:'complete',result:completedReport(change)}));
 await ready();fireEvent.click(screen.getByRole('button',{name:/Run once/}));await screen.findByText(/may have reached the payer/);
 expect(screen.queryByText(/Server-reported result:/)).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:/Download real report/})).not.toBeInTheDocument();
 expect(f.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);expect(screen.getByRole('button',{name:'Check this same job'})).toBeInTheDocument();
});
it('holds malformed saved input before any recovery POST',async()=>{
 sessionStorage.setItem('vr-hosted-research-recovery-v1',JSON.stringify({requestId:id,input:'{}',jobId:null}));
 const f=setup(async()=>json({}));await screen.findByText(/saved recovery record is unavailable or invalid/);
 expect(screen.queryByRole('button',{name:/Recover this same submission/})).not.toBeInTheDocument();expect(f).not.toHaveBeenCalled();
});
