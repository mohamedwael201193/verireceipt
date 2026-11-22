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
async function probeTls(host: string, address: string, budgetMs: number): Promise<Probe> {
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

export async function handleSsl(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
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
  const attempts: Array<{ address: string; error: string }> = [];
  // Two rounds across at most two vetted addresses. Retry transient
  // transport failures once, inside a shared 8s TLS budget (plus <=2s
  // DNS). An invalid certificate is conclusive and is not retried.
  const deadline = Date.now() + 8000;
  const retryAddresses = [...addresses.slice(0, 2), ...addresses.slice(0, 2)];
  for (const { address } of retryAddresses) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    try {
      const result = await probeTls(host, address, Math.min(3000, remainingMs));
      const asOf = new Date().toISOString();
      const evidence = JSON.stringify({ host, port: 443, address, observed_at: asOf, ...result, failed_attempts: attempts,
        trust_scope: "Node installed CA set and hostname check; no explicit revocation or OCSP check" });
      const receipt = makeReceipt(INTENT, `https://${host}/`, evidence, "1 direct TLS peer, not multi-vantage consensus");
      await saveReceipt(receipt, evidence);
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
    } catch (error) {
      attempts.push({ address, error: error instanceof Error ? error.message : String(error) });
    }
  }
  throw upstreamUnavailable("TLS_PROBE_UNAVAILABLE", `no TLS probe for ${host} produced a saved, verifiable certificate receipt`);
}
