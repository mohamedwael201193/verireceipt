// API_HEALTH_CHECK_GENERAL — GET /v1/api-health?url=<https URL>
//
// Zero-LLM. A single measured HTTPS/HTTP GET against a public target,
// receipted. Answers ONLY what was measured from this server's vantage:
// status code, latency, whether the target answered at all. SSRF
// hardening lives in ssrfGuard.ts (public hosts only, no redirects,
// strict timeout, one check per target per minute).
import { upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { guardPublicHttpUrl, measureGet, dnsProbeFailure, type DnsProbeFailure, type GuardedTarget } from "./ssrfGuard";

const TIMEOUT_MS = 5000;
const UA = "VeriReceipt/2.0 api-health observer (+https://verireceipt.vercel.app)";

export const INTENT = "API_HEALTH_CHECK_GENERAL";

export async function handleApiHealth(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const checkedAt = new Date().toISOString();
  let target:GuardedTarget;let dnsFailure:DnsProbeFailure|undefined;
  try {target=await guardPublicHttpUrl(query.url,"url",true);}
  catch(error){
    dnsFailure=dnsProbeFailure(error);
    if(!dnsFailure)throw error;
    target={url:dnsFailure.url,hostname:dnsFailure.hostname,port:dnsFailure.port,addresses:[]};
  }
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
  return envelope(INTENT, {
    url: target.url,
    healthy,
    reachable,
    http_status: status || null,
    latency_ms: latency >= 0 ? latency : null,
    ...(dnsFailure?{dns_status:dnsFailure.kind,dns_latency_ms:dnsFailure.latency_ms,http_attempted:false}:{}),
  }, receipt, { answer, verdict: "verified", confidence: 0.85,
    source: dnsFailure?`DNS observation from this server at ${checkedAt}; no HTTP attempted`:`measured from this server at ${checkedAt}; single GET, redirects not followed` });
}
