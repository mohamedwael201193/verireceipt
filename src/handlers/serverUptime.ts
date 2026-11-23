// SERVER_UPTIME_MONITOR_GENERAL — GET /v1/server-uptime?host=<hostname>
//
// Zero-LLM. A single reachability measurement for a public host,
// receipted. Honest scope, stated in every answer: this is
// point-in-time reachability from this server's vantage, NOT an uptime
// percentage or history — one observation cannot measure uptime.
// SSRF hardening lives in ssrfGuard.ts.
import { upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { guardPublicHttpUrl, measureGet } from "./ssrfGuard";

const TIMEOUT_MS = 5000;
const UA = "VeriReceipt/2.0 server-uptime observer (+https://verireceipt.vercel.app)";

export const INTENT = "SERVER_UPTIME_MONITOR_GENERAL";

export async function handleServerUptime(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const target = await guardPublicHttpUrl(query.host, "host");
  const checkedAt = new Date().toISOString();
  let status = 0; let latency = -1; let reachableNow = false; let errorClass = "";
  try {
    const m = await measureGet(target.url, TIMEOUT_MS, UA);
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
