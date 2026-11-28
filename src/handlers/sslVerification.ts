import{TenMinuteObservation}from'./tenMinuteObservation';
import {queryFallback,firstHostname} from '../core/queryFallback';
// SSL_VERIFICATION_CERT: a real TLS handshake, with the peer's exact DER
// certificate chain in the receipt. Trust means Node's installed CA set,
// current clock and hostname verification, not an OCSP/revocation check.
// Contract: https://devnode.telegraphprotocol.com/engine/v1/intents/SSL_VERIFICATION_CERT
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { domainToASCII } from "node:url";
import { connect, checkServerIdentity, type PeerCertificate } from "node:tls";
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

export const INTENT = "SSL_VERIFICATION_CERT";
const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as Array<[string, number]>) blocked.addSubnet(ip, prefix, "ipv4");

/** Only global IPv4 sockets are opened. No proxy, URL, port override,
 * literal IP or IPv6 fallback. DNS is checked once and the vetted
 * address is pinned into the socket, preventing DNS rebinding. */
export function isPublicTlsAddress(address: string): boolean {
  return isIP(address) === 4 && !blocked.check(address, "ipv4");
}
export function normalizeTlsHost(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || /[\s\/:@?#\\\x00-\x1f]/.test(trimmed) || isIP(trimmed)) {
    throw badRequest("INVALID_HOST", "host must be a public DNS hostname, without URL, IP literal or port");
  }
  const host = domainToASCII(trimmed.replace(/\.$/, "")).toLowerCase();
  const labels = host.split(".");
  if (host.length > 253 || labels.length < 2 || !/^[a-z][a-z0-9-]*[a-z]$/.test(labels.at(-1) ?? "") ||
      labels.some((s) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s))) {
    throw badRequest("INVALID_HOST", "host must be a valid public DNS hostname");
  }
  return host;
}

const INVALID_CERT_CODES = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED", "CERT_REJECTED", "ERR_TLS_CERT_ALTNAME_INVALID", "INVALID_CA", "CERT_SIGNATURE_FAILURE",
  "CERT_REVOKED", "PATH_LENGTH_EXCEEDED", "INVALID_PURPOSE",
]);
export function certificateVerdict(authorized: boolean, authError: string | null, hostnameError: boolean): boolean {
  if (hostnameError) return false;
  if (authorized) return true;
  if (authError && INVALID_CERT_CODES.has(authError)) return false;
  throw upstreamUnavailable("TLS_UNVERIFIABLE", `TLS trust could not be verified (${authError ?? "unknown reason"})`);
}

interface Probe {
  valid: boolean;
  authorization_error: string | null;
  hostname_error: string | null;
  chain_der_base64: string[];
  subject: PeerCertificate["subject"];
  issuer: PeerCertificate["issuer"];
  valid_from: string;
  valid_to: string;
  fingerprint256: string;
  protocol: string | null;
}
async function probeTls(host: string, address: string, budgetMs: number, signal?: AbortSignal): Promise<Probe> {
  return new Promise((resolve, reject) => {
    // Verification remains recorded by Node even though an invalid peer
    // is allowed to finish the handshake so its exact evidence is saved.
    // No HTTP request, credentials or application bytes are sent.
    const socket = connect({ host: address, port: 443, servername: host, rejectUnauthorized: false });
    const timer = setTimeout(() => finish(new Error("TLS probe timed out")), budgetMs);
    let finished = false;
    function finish(error?: Error, value?: Probe): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else if (value) resolve(value);
    }
    socket.once("error", (error) => finish(error));
    if (signal) { if (signal.aborted) finish(new Error("TLS probe aborted")); else signal.addEventListener("abort", () => finish(new Error("TLS probe aborted")), { once: true }); }
    socket.once("secureConnect", () => {
      try {
        const cert = socket.getPeerCertificate(true);
        if (!cert.raw?.length) throw new Error("peer supplied no certificate evidence");
        const hostnameError = checkServerIdentity(host, cert)?.message ?? null;
        const authError = socket.authorizationError ? String(socket.authorizationError) : null;
        const valid = certificateVerdict(socket.authorized, authError, hostnameError !== null);
        const chain: string[] = [];
        const seen = new Set<string>();
        let current = cert;
        for (let i = 0; i < 16 && current.raw?.length; i++) {
          const der = current.raw.toString("base64");
          if (seen.has(der)) break;
          seen.add(der); chain.push(der);
          if (!current.issuerCertificate) break;
          current = current.issuerCertificate;
        }
        finish(undefined, {
          valid, authorization_error: authError, hostname_error: hostnameError,
          chain_der_base64: chain, subject: cert.subject, issuer: cert.issuer,
          valid_from: cert.valid_from, valid_to: cert.valid_to, fingerprint256: cert.fingerprint256,
          protocol: socket.getProtocol(),
        });
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}

export const TLS_ATTEMPT_CAP_MS = 3000;
export const TLS_HEDGE_AFTER_MS = 1200;
export interface HedgeFailure<I> { item: I; error: string }
export type HedgeResult<T, I> = { ok: true; value: T; item: I; failures: Array<HedgeFailure<I>> } | { ok: false; failures: Array<HedgeFailure<I>> };
/** Hedged attempt scheduler. Starts items[0] now. If nothing has completed
 * hedgeAfterMs after the latest start, the next item is started in parallel
 * (at most two in flight). A failure with nothing else in flight starts the
 * next item immediately. The first attempt to resolve wins and the rest are
 * aborted. Every attempt is capped at min(capMs, time left to the shared
 * deadline). An attempt that resolves is final: the caller decides what a
 * conclusive result is by resolving, and retryable failures by rejecting. */
export function runHedged<T, I>(
  items: I[],
  attempt: (item: I, budgetMs: number, signal: AbortSignal, failuresSoFar: () => Array<HedgeFailure<I>>) => Promise<T>,
  opts: { deadline: number; hedgeAfterMs?: number; capMs?: number },
): Promise<HedgeResult<T, I>> {
  const hedgeAfterMs = opts.hedgeAfterMs ?? TLS_HEDGE_AFTER_MS, capMs = opts.capMs ?? TLS_ATTEMPT_CAP_MS;
  return new Promise((resolve) => {
    const failures: Array<HedgeFailure<I>> = [];
    const controllers = new Set<AbortController>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let next = 0, inFlight = 0, done = false;
    const finish = (r: HedgeResult<T, I>): void => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      for (const c of controllers) c.abort();
      resolve(r);
    };
    const launch = (): void => {
      if (done) return;
      const budget = Math.min(capMs, opts.deadline - Date.now());
      if (next >= items.length || budget <= 0) { if (inFlight === 0) finish({ ok: false, failures }); return; }
      const item = items[next++];
      const ctl = new AbortController();
      controllers.add(ctl); inFlight++;
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true; inFlight--; controllers.delete(ctl); clearTimeout(cap); timers.delete(cap); fn();
      };
      const cap = setTimeout(() => { ctl.abort(); settle(() => onFail(item, "TLS probe timed out")); }, budget);
      timers.add(cap);
      let p: Promise<T>;
      try { p = attempt(item, budget, ctl.signal, () => failures.slice()); } catch (e) { p = Promise.reject(e); }
      p.then(
        (value) => settle(() => finish({ ok: true, value, item, failures })),
        (e) => settle(() => onFail(item, e instanceof Error ? e.message : String(e))),
      );
      if (inFlight === 1 && next < items.length) {
        const h = setTimeout(() => { timers.delete(h); if (inFlight === 1) launch(); }, hedgeAfterMs);
        timers.add(h);
      }
    };
    const onFail = (item: I, error: string): void => {
      if (done) return;
      failures.push({ item, error });
      if (inFlight === 0) launch();
    };
    launch();
  });
}

async function loadSsl(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  query=queryFallback(query,"host",firstHostname);
  if (!query.host?.trim()) throw badRequest("MISSING_PARAM", "host is required");
  const host = normalizeTlsHost(query.host);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: LookupAddress[];
  try {
    const resolved = await Promise.race([
      lookup(host, { all: true, family: 4 }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("DNS timed out")), 2000); }),
    ]);
    addresses = resolved;
  } catch {
    throw upstreamUnavailable("TLS_DNS_UNAVAILABLE", `could not resolve a public IPv4 address for ${host}`);
  } finally { if (timer) clearTimeout(timer); }
  if (!addresses.length) throw upstreamUnavailable("TLS_DNS_UNAVAILABLE", "no IPv4 addresses returned");
  if (addresses.some((a) => !isPublicTlsAddress(a.address))) {
    throw badRequest("PRIVATE_HOST", "host resolves to a non-public address; connection refused");
  }
  // Up to two rounds across at most two vetted addresses, hedged: a stalled
  // first attempt is raced by the next address after 1.2s, inside a shared
  // 8s TLS budget (plus <=2s DNS). An invalid certificate is a conclusive
  // result and is not retried; the first attempt with a saved receipt wins.
  const deadline = Date.now() + 8000;
  const retryAddresses = [...addresses.slice(0, 2), ...addresses.slice(0, 2)].map((a) => a.address);
  const outcome = await runHedged(retryAddresses, async (address, budget, signal, failuresSoFar) => {
    const result = await probeTls(host, address, budget, signal);
    const asOf = new Date().toISOString();
    // Evidence lists only the attempts that failed before this one finished.
    const evidence = JSON.stringify({ host, port: 443, address, observed_at: asOf, ...result,
      failed_attempts: failuresSoFar().map((f) => ({ address: f.item, error: f.error })),
      trust_scope: "Node installed CA set and hostname check; no explicit revocation or OCSP check" });
    const receipt = makeReceipt(INTENT, `https://${host}/`, evidence, "1 direct TLS peer, not multi-vantage consensus");
    await saveReceipt(receipt, evidence);
    return { address, result, asOf, receipt };
  }, { deadline });
  if (outcome.ok) {
    const { address, result, asOf, receipt } = outcome.value;
    return envelope(INTENT, { certificate_valid: result.valid, host, as_of: asOf,
      valid_from: result.valid_from, valid_to: result.valid_to, fingerprint_sha256: result.fingerprint256 }, receipt, {
      // The evidence is verified even when the observed certificate
      // is invalid, just as a verified zero balance is still evidence.
      verdict: "verified", confidence: 0.9,
      answer: `${host}: the TLS certificate is ${result.valid ? "valid and trusted" : "not valid and trusted"} ` +
        `under this server's installed CA set and hostname check at ${asOf}. ` +
        `Validity: ${result.valid_from} to ${result.valid_to}. ` +
        (result.valid ? "" : `Reason: ${result.hostname_error ?? result.authorization_error}. `) +
        "This is one direct network observation, not a revocation or multi-vantage check.",
      source: `Direct TLS handshake to ${host}:443 at vetted address ${address}; exact peer DER chain in receipt; no application request sent`,
    });
  }
  throw upstreamUnavailable("TLS_PROBE_UNAVAILABLE", `no TLS probe for ${host} produced a saved, verifiable certificate receipt`);
}

const sslCache=new TenMinuteObservation();
export function resetSslCacheForTests(){sslCache.clear();}
export async function handleSsl(query:Record<string,string|undefined>):Promise<Record<string,unknown>>{
 const filled=queryFallback(query,'host',firstHostname);
 if(!filled.host?.trim())return loadSsl(filled);
 const host=normalizeTlsHost(filled.host);
 return sslCache.get(host,()=>loadSsl({...filled,host}),result=>{
  const now=Date.now(),dates=[Date.parse(String(result.valid_from)),Date.parse(String(result.valid_to))].filter(d=>Number.isFinite(d)&&d>now);
  return dates.length?Math.min(...dates):Infinity;
 });
}
