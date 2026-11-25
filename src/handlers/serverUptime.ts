// SERVER_UPTIME_MONITOR_GENERAL — GET /v1/server-uptime?host=<hostname>
//
// Zero-LLM. A single reachability measurement for a public host,
// receipted. Honest scope, stated in every answer: this is
// point-in-time reachability from this server's vantage, NOT an uptime
// percentage or history — one observation cannot measure uptime.
// SSRF hardening lives in ssrfGuard.ts.
import { ApiError, upstreamUnavailable, unprocessable } from "../core/errors";
import { envelope, makeReceipt, sha256Hex } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { guardPublicHttpUrl, measureGet, dnsProbeFailure } from "./ssrfGuard";

import {confirmNxDomain} from './uptimeDns';
const TIMEOUT_MS = 5000;
const UA = "VeriReceipt/2.0 server-uptime observer (+https://verireceipt.vercel.app)";

export const INTENT = "SERVER_UPTIME_MONITOR_GENERAL";
const refusalAttempts=new Map<string,number>();
export function resetUptimeRefusalsForTests():void {refusalAttempts.clear();}
function reserveRefusal(hash:string):void {
 const now=Date.now();for(const [key,at] of refusalAttempts)if(now-at>=60000)refusalAttempts.delete(key);
 if(refusalAttempts.has(hash)||refusalAttempts.size>=1024)throw unprocessable('RATE_LIMITED','guard decision rate limited; retry after one minute');
 refusalAttempts.set(hash,now);
}

export async function handleServerUptime(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  let target;
  try { target = await guardPublicHttpUrl(query.host, "host",true); }
  catch(error) {
    const allowed = ['PRIVATE_HOST','PORT_NOT_CHECKED','DNS_UNRESOLVABLE'] as const;
    if (!(error instanceof ApiError) || !(allowed as readonly string[]).includes(error.code)) throw error;
    const code=error.code;
    const targetHash=sha256Hex(query.host??'');reserveRefusal(targetHash);
    console.info(JSON.stringify({event:'server_uptime_not_probed',guard_code:code}));
    const checkedAt=new Date().toISOString();
    const dnsFailure=dnsProbeFailure(error);
    const negative=code==='DNS_UNRESOLVABLE'&&dnsFailure&&dnsFailure.kind!=='resolution_timeout'&&!dnsFailure.temporary_failure?await confirmNxDomain(dnsFailure.hostname):null;
    if(negative){
     const answer='The host does not resolve (NXDOMAIN), so it is not reachable. No HTTP measurement was possible or attempted. This is a point-in-time DNS observation, not uptime history.';
     const evidence=JSON.stringify({requested_target_sha256:targetHash,checked_at:checkedAt,reachable_now:false,status:'unreachable',dns_result:'NXDOMAIN',http_attempted:false,resolvers:negative});
     const receipt=makeReceipt(INTENT,negative[0].source,evidence,'two independent DNS resolvers agree NXDOMAIN; no HTTP measurement');
     try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','DNS evidence could not be stored');}
     return envelope(INTENT,{host:dnsFailure!.hostname,reachable_now:false,status:'unreachable',dns_result:'NXDOMAIN',http_status:null,latency_ms:null,http_attempted:false},receipt,{answer,verdict:'verified',confidence:0.9,source:'Two public DNS resolver responses; no target HTTP connection'});
    }
    const reasons:Record<string,string>={PRIVATE_HOST:'The host is local, private, reserved or resolves to a blocked address.',PORT_NOT_CHECKED:'Only HTTP ports 80 and 443 are checked.',DNS_UNRESOLVABLE:'The host did not resolve to usable addresses.'};
    const evidence=JSON.stringify({requested_target_sha256:targetHash,checked_at:checkedAt,http_attempted:false,guard_code:code,reachable_now:null,http_status:null,latency_ms:null,scope:'guard decision only; no uptime or reachability measurement'});
    const receipt=makeReceipt(INTENT,'https://verireceipt.onrender.com/v1/server-uptime',evidence,'local safety guard decision; target not probed');
    try { await saveReceipt(receipt,evidence); } catch { throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','guard decision evidence could not be stored'); }
    return envelope(INTENT,{host:null,reachable_now:null,http_status:null,latency_ms:null,http_attempted:false,guard_code:code},receipt,{
      answer:`Host not probed. ${reasons[code]} No HTTP connection was attempted. Reachability and uptime are unknown; no availability measurement is claimed.`,
      verdict:'unverified',confidence:0,source:'local safety guard decision only; no target connection',
    });
  }
  const checkedAt = new Date().toISOString();
  let status = 0; let latency = -1; let reachableNow = false; let errorClass = "";
  try {
    const m = await measureGet(target, TIMEOUT_MS, UA);
    status = m.status; latency = m.latency_ms; reachableNow = true;
  } catch (e) {
    reachableNow = false;
    errorClass = e instanceof Error && e.name === "AbortError" ? "timeout" : "connect-failure";
  }
  const evidence = JSON.stringify({ host: target.hostname, checked_at: checkedAt,
    resolved_addresses: target.addresses, port: target.port,
    measured: { reachable_now: reachableNow, http_status: status || null, latency_ms: latency >= 0 ? latency : null, error: errorClass || null },
    vantage: "point-in-time reachability from this server; NOT an uptime percentage or history",
    raw_bodies: {}, fetched_at: checkedAt });
  const receipt = makeReceipt(INTENT, target.url, evidence, "single reachability measurement from server vantage; SSRF-guarded public targets only");
  receipt.fetched_at = checkedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const answer = reachableNow
    ? `${target.hostname} (port ${target.port}) is reachable now — HTTP ${status} in ${latency} ms — measured once from this server at ${checkedAt}. Point-in-time reachability only: this is not an uptime percentage or history, and the host may answer differently from other vantages.`
    : `${target.hostname} (port ${target.port}) did not answer within ${TIMEOUT_MS / 1000}s (${errorClass}), measured once from this server at ${checkedAt}. Point-in-time from one vantage: the host may be up and reachable from elsewhere.`;
  return envelope(INTENT, {
    host: target.hostname,
    reachable_now: reachableNow,
    http_status: status || null,
    latency_ms: latency >= 0 ? latency : null,
  }, receipt, { answer, verdict: "verified", confidence: 0.85,
    source: `measured from this server at ${checkedAt}; single probe, redirects not followed` });
}
