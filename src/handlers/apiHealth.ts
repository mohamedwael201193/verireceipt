// API_HEALTH_CHECK_GENERAL — GET /v1/api-health?url=<https URL>
//
// Zero-LLM. A single measured HTTPS/HTTP GET against a public target,
// receipted. Answers ONLY what was measured from this server's vantage:
// status code, latency, whether the target answered at all. SSRF
// hardening lives in ssrfGuard.ts (public hosts only, no redirects,
// strict timeout, one check per target per minute).
import {diagnosticErrorCode} from '../core/requestMetrics';
import { upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt, sha256Hex } from "../core/receipt";
import { saveReceipt, getReceiptEvidence } from "../core/storage";
import { guardPublicHttpUrl, measureGet, dnsProbeFailure, type DnsProbeFailure, type GuardedTarget } from "./ssrfGuard";

const TIMEOUT_MS = 5000;
const UA = "VeriReceipt/2.0 api-health observer (+https://verireceipt.vercel.app)";

export const INTENT = "API_HEALTH_CHECK_GENERAL";

interface CachedHealth {at:number;value:Record<string,unknown>}
const checks=new Map<string,CachedHealth>();
const hostStarts=new Map<string,number[]>();
export function resetHealthReuseForTests():void{checks.clear();hostStarts.clear();}
async function reuseHealth(row:CachedHealth,requested:string):Promise<Record<string,unknown>|null>{
 const age=Date.now()-row.at;if(age<0||age>=60000)return null;
 const receipt=row.value.receipt as {receipt_id:string;raw_response_sha256:string};
 let stored;try{stored=await getReceiptEvidence(receipt.receipt_id);}catch{return null;}
 if(!stored.found||!stored.evidence||stored.sha256!==receipt.raw_response_sha256||sha256Hex(stored.evidence)!==receipt.raw_response_sha256||Date.now()-row.at>=60000||Date.now()<row.at||checks.get(String(row.value.url))!==row)return null;
 const same=requested===row.value.url;
 return {...row.value,requested_url:requested,reused_measurement:true,reuse_age_seconds:Math.floor((Date.now()-row.at)/1000),reuse_scope:same?'same exact URL; not a new check':'prior URL on same host/port; requested path was NOT checked',answer:`Reused measurement from ${Math.floor((Date.now()-row.at)/1000)} seconds ago, same receipt, not a new check. ${same?'Same exact URL.':'Different requested path was NOT checked; measured URL is '+String(row.value.url)+'.'} `+String(row.value.answer)};
}
export async function handleApiHealth(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const checkedAt = new Date().toISOString();
  let target:GuardedTarget;let dnsFailure:DnsProbeFailure|undefined;
  try {target=await guardPublicHttpUrl(query.url,"url",true,true);}
  catch(error){
    dnsFailure=dnsProbeFailure(error);
    if(!dnsFailure){let host:string|null=null;try{host=new URL(/^https?:\/\//i.test(query.url??'')?query.url!:'https://'+query.url).hostname;}catch{}
      console.info(JSON.stringify({event:'api_health_refused',host,code:error&&typeof error==='object'&&'code'in error?diagnosticErrorCode(error.code):'OTHER_ERROR'}));throw error;}
    target={url:dnsFailure.url,hostname:dnsFailure.hostname,port:dnsFailure.port,addresses:[]};
  }
  const now=Date.now(),hostKey=target.hostname+':'+target.port;
  for(const [key,row]of checks)if(now-row.at>=60000)checks.delete(key);
  for(const [key,times]of hostStarts){const recent=times.filter(t=>now-t>=0&&now-t<60000);if(recent.length)hostStarts.set(key,recent);else hostStarts.delete(key);}
  const exact=checks.get(target.url);if(exact){const reused=await reuseHealth(exact,target.url);if(reused)return reused;}
  const starts=hostStarts.get(hostKey)??[];
  if(starts.length>=4||hostStarts.size>=1024&&!hostStarts.has(hostKey)){
    const prior=[...checks.values()].filter(r=>{try{const u=new URL(String(r.value.url));return u.hostname.replace(/\.+$/,'')===target.hostname&&Number(u.port||(u.protocol==='https:'?443:80))===target.port;}catch{return false;}}).sort((a,b)=>b.at-a.at)[0];
    if(prior){const reused=await reuseHealth(prior,target.url);if(reused)return reused;}
    throw upstreamUnavailable('PROBE_BUDGET','host check budget reached and no retrievable measurement is available');
  }
  hostStarts.set(hostKey,[...starts,Date.now()]);
  let status = 0; let latency = -1; let reachable = false; let errorClass = "";
  if(dnsFailure)errorClass='dns-'+dnsFailure.kind;
  else try {
    const m = await measureGet(target, TIMEOUT_MS, UA);
    status = m.status; latency = m.latency_ms; reachable = true;
  } catch (e) {
    reachable = false;
    errorClass = e instanceof Error && e.name === "AbortError" ? "timeout" : "connect-failure";
  }
  const healthy = reachable && status < 400;
  const evidence = JSON.stringify({ url: target.url, checked_at: checkedAt,
    resolved_addresses: target.addresses, port: target.port,
    ...(dnsFailure?{dns_observation:{kind:dnsFailure.kind,latency_ms:dnsFailure.latency_ms,http_attempted:false}}:{}),
    measured: { reachable, http_status: status || null, latency_ms: latency >= 0 ? latency : null, error: errorClass || null },
    vantage: dnsFailure?'single failed DNS resolution from this server; no HTTP attempted; not a global-availability or historical claim':'single measured GET from this server; redirects never followed; not a global-availability or historical claim',
    raw_bodies: {}, fetched_at: checkedAt });
  const receipt = makeReceipt(INTENT, target.url, evidence, dnsFailure?'single failed DNS resolution from server vantage; no HTTP attempted':'single measured GET from server vantage; SSRF-guarded public targets only');
  receipt.fetched_at = checkedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const answer = dnsFailure
    ? `${target.url} is not reachable from this server at ${checkedAt}: DNS ${dnsFailure.kind.replace(/_/g,' ')} after ${dnsFailure.latency_ms} ms. No HTTP connection was attempted; HTTP status and latency are unmeasured. This is one DNS observation from one vantage, not proof the service is down everywhere.`
    : reachable
    ? `${target.url} answered HTTP ${status} in ${latency} ms — ${healthy ? "healthy" : "reachable but unhealthy (status >= 400)"}, measured once from this server at ${checkedAt}. Redirects were not followed. This is one measurement from one vantage, not a global-availability or historical claim.`
    : `${target.url} did not answer within ${TIMEOUT_MS / 1000}s (${errorClass}), measured once from this server at ${checkedAt}. This is one measurement from one vantage; the target may be reachable from elsewhere.`;
  const result=envelope(INTENT, {
    url: target.url,
    healthy,
    reachable,
    http_status: status || null,
    latency_ms: latency >= 0 ? latency : null,
    ...(dnsFailure?{dns_status:dnsFailure.kind,dns_latency_ms:dnsFailure.latency_ms,http_attempted:false}:{}),
  }, receipt, { answer, verdict: "verified", confidence: 0.85,
    source: dnsFailure?`DNS observation from this server at ${checkedAt}; no HTTP attempted`:`measured from this server at ${checkedAt}; single GET, redirects not followed` });
  if(checks.size>=1024)checks.delete(checks.keys().next().value!);
  checks.set(target.url,{at:Date.parse(checkedAt),value:result});
  return result;
}
