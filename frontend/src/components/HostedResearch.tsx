import { useEffect,useRef,useState } from 'react';
import { API_BASE } from '../config';
import { inspectResearchReport,type InspectedResearchReport } from '../lib/researchReport';
interface Job { id:string; state:string; raw:unknown; report:InspectedResearchReport|null }
async function readJson(response:Response):Promise<Record<string,unknown>> {
  if(!response.body) throw new Error('No response');
  const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0,text='';
  try { while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2_000_000)throw new Error('Report exceeds limit');text+=decoder.decode(value,{stream:true});}text+=decoder.decode(); }
  finally { await reader.cancel();reader.releaseLock(); }
  const value:unknown=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid response');return value as Record<string,unknown>;
}
export default function HostedResearch({ inputJson }:{inputJson:string}) {
  const [available,setAvailable]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[job,setJob]=useState<Job|null>(null);
  const requestId=useRef<string|null>(null),controller=useRef<AbortController|null>(null),submitted=useRef(false);
  useEffect(()=>()=>{controller.current?.abort();controller.current=null;},[]);
  async function action(work:(signal:AbortSignal)=>Promise<void>){
    if(controller.current)return;const c=new AbortController();controller.current=c;setBusy(true);setMessage('');const timer=setTimeout(()=>c.abort(),125_000);
    try{await work(c.signal);}
    catch{if(controller.current===c)setMessage(submitted.current?'HOLD: this submission may have reached the payer. Do not create another request to fix it. Recover the same submission below, or keep the job ID for reconciliation. No refund or settlement is assumed.':'Hosted research is unavailable or did not complete its readiness check. Nothing was submitted. You can use the local CLI.');}
    finally{clearTimeout(timer);if(controller.current===c){controller.current=null;setBusy(false);}}
  }
  async function check(signal:AbortSignal){
    const status=await fetch(`${API_BASE}/v1/research/status`,{signal,cache:'no-store',credentials:'same-origin'});if(!status.ok)throw new Error('Unavailable');
    const s=await readJson(status);if(s.enabled!==true||s.network!=='eip155:11155111'||s.call_uusdc!=='10000')throw new Error('Unapproved terms');
    const session=await fetch(`${API_BASE}/v1/research/session`,{signal,cache:'no-store',credentials:'same-origin'});if(!session.ok)throw new Error('Session unavailable');
    const ready=await readJson(session);if(ready.ready!==true||ready.network!=='eip155:11155111'||ready.call_uusdc!=='10000')throw new Error('Unapproved session');
    setAvailable(true);setMessage('Hosted testnet service is available. Checking did not create a paid request.');
  }
  async function readJob(id:string,signal:AbortSignal):Promise<boolean>{
    const response=await fetch(`${API_BASE}/v1/research/jobs/${id}`,{signal,cache:'no-store',credentials:'same-origin'});if(!response.ok)throw new Error('Job unavailable');
    const found=await readJson(response);if(found.job_id!==id||!['reserved','signed','complete','uncertain'].includes(String(found.state)))throw new Error('Invalid job');
    const report=found.state==='complete'?inspectResearchReport(JSON.stringify(found.result)):null;
    setJob({id,state:String(found.state),raw:found.result,report});return found.state==='complete'||found.state==='uncertain';
  }
  async function submit(signal:AbortSignal){
    if(!requestId.current)requestId.current=crypto.randomUUID();
    submitted.current=true;
    const response=await fetch(`${API_BASE}/v1/research/jobs`,{method:'POST',signal,cache:'no-store',credentials:'same-origin',headers:{'Content-Type':'application/json','Idempotency-Key':requestId.current},body:inputJson});
    if(response.status===429){setMessage('HOLD: hosted capacity or the testnet safety budget is reached. This attempt did not start another purchase. Keep this same submission ID if you try again.');return;}
    if(response.status!==202)throw new Error('Submission uncertain');
    const accepted=await readJson(response),id=accepted.job_id;
    if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id)||accepted.network!=='eip155:11155111')throw new Error('Invalid job');
    setJob({id,state:'reserved',raw:null,report:null});
    for(let i=0;i<38;i++){
      if(await readJob(id,signal))return;
      await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new Error('Stopped'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},3000);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
    }
    setMessage('Still awaiting evidence. Monitoring stopped, not the server-side request. Check this same job below. Do not start another purchase to fix it.');
  }
  function download(){if(!job?.raw)return;const url=URL.createObjectURL(new Blob([JSON.stringify(job.raw,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`research-${job.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  const safe=job?.report&&job.report.status!=='HOLD'&&job.report.count!==null&&job.report.checks.every(c=>c.ok);
  return <div className="rp-hosted">
    <div className="rp-eyebrow">OPTIONAL / REAL SPONSORED TESTNET REQUEST</div>
    <h3>Run this exact question without a wallet</h3>
    <p>The operator pays one real $0.01 test-USDC request on Ethereum Sepolia. This is a related-party purchase, not independent adoption or ranked routing. Your browser never receives a signing key. No real money is spent.</p>
    <details className="rp-details"><summary>Safety limits and stored data</summary><p className="rp-muted">One active hosted purchase at a time. Safety limits: 10 submissions per session per minute, 100 per shared network per minute, $100 test USDC per UTC day across the service, and a 1 test-USDC payer reserve. Shared proxies can group visitors. There is no separate per-visitor daily cap. A 512 MB/day stored-output budget can also pause new submissions. The CLI has its own lower cap.</p>
    <p className="rp-muted">Submission creates a server-side job and stores this question, hashed session/network identifiers and paid evidence for reconciliation. A cookie controls access to your report for 24 hours; download the finished report. Stored reconciliation records do not currently auto-expire. Do not put secrets in the question.</p></details>
    {!available&&<button type="button" disabled={busy} onClick={()=>void action(check)}>Check hosted availability</button>}
    {available&&!submitted.current&&<button className="rp-primary" type="button" disabled={busy} onClick={()=>void action(submit)}>Run once, operator pays $0.01 test USDC</button>}
    {submitted.current&&!busy&&job?.state!=='complete'&&job?.state!=='uncertain'&&<button type="button" onClick={()=>void action(job?signal=>readJob(job.id,signal).then(()=>{}):submit)}>{job?'Check this same job':'Recover this same submission'}</button>}
    {busy&&<p role="status">{submitted.current?'Waiting for the real hosted job. No automatic paid retry.':'Checking service and secure session only. No purchase.'}</p>}
    {busy&&<button type="button" onClick={()=>controller.current?.abort()}>Stop waiting</button>}
    <div aria-live="polite">{message&&<p className="rp-muted">{message}</p>}
      {job&&<div className="rp-prepared"><h4>{job.state==='complete'?'Hosted evidence received':job.state==='uncertain'?'HOLD: outcome requires reconciliation':'Real hosted request pending'}</h4>
        <p className="rp-hash">Job ID: {job.id}</p>
        {job.report&&<><p>Server-reported result: {safe?job.report.status:'HOLD'}. {safe?`${job.report.count} exact-form filings, minimum ${job.report.minimum_count}.`:'No usable count is claimed.'}</p><p>{job.report.reason}</p><p>Delivery: {job.report.delivery}. Pending is not inclusion or settlement. Source checks ran on the server, not independently in this browser.</p><p className="rp-hash">Plan hash: {job.report.plan_hash}</p><details><summary>Inspect server-reported checks</summary><ul className="rp-checks">{job.report.checks.map((c,i)=><li key={i}><span>{c.ok?'REPORTED PASS':'REPORTED FAIL'}</span>{c.name}</li>)}</ul></details><button type="button" onClick={download}>Download real report.json</button></>}
        {job.state==='uncertain'&&<p>No automatic retry or refund. Keep the job ID. A payment may have occurred even if verification did not finish.</p>}
      </div>}
    </div>
  </div>;
}
