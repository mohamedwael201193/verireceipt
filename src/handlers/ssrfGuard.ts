// SSRF guard for the outbound-check intents (API_HEALTH_CHECK_GENERAL,
// SERVER_UPTIME_MONITOR_GENERAL), hardened per the maintainer ruling
// 2026-11-23: public hosts only, private/loopback/link-local/metadata
// ranges blocked, redirects never followed, strict timeouts, a
// per-target rate limit, and answers only about what was measured from
// this server's vantage.
//
// DNS REBINDING: every hostname is resolved first and EVERY returned
// address must be public, so a name that mixes a public and a private
// address is refused outright. A narrow TOCTOU window remains (the
// resolver answer could change between our check and the connect);
// it is documented here honestly and narrowed by the short timeout,
// the redirect refusal, and the port restriction (80/443 only).
import { lookup } from "node:dns/promises";
import { badRequest, unprocessable } from "../core/errors";
import { validatePublicIp } from "./ipGeolocation";

const RATE_LIMIT_MS = 60_000;
const lastCheck = new Map<string, number>();

// Test hook: deterministic DNS without touching the network.
let lookupFn: typeof lookup = lookup;
export function __setLookupForTests(fn: typeof lookup | null): void {
  lookupFn = fn ?? lookup;
  lastCheck.clear();
}
export function __clearRateLimitsForTests(): void { lastCheck.clear(); }

export interface GuardedTarget { url: string; hostname: string; port: number; addresses: string[] }

export async function guardPublicHttpUrl(raw: string | undefined, param: string): Promise<GuardedTarget> {
  if (!raw) throw badRequest("MISSING_PARAM", `${param} is required`);
  if (raw.length > 300) throw badRequest("URL_TOO_LONG", `${param} must be at most 300 characters`);
  let u: URL;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) {
      throw badRequest("BAD_SCHEME", "only http and https targets are checked");
    }
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch (e) {
    if (e && typeof e === "object" && "status" in e) throw e;
    throw badRequest("BAD_URL", `${param} is not a parseable URL or hostname`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw badRequest("BAD_SCHEME", "only http and https targets are checked");
  if (u.username || u.password) throw badRequest("BAD_URL", "credentials in URLs are never followed");
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (port !== 80 && port !== 443) throw unprocessable("PORT_NOT_CHECKED", "only ports 80 and 443 are checked; internal-service probing is out of scope");
  // Trailing-dot FQDNs (example.com.) are the same host; normalize so
  // the private-name checks and the rate-limit key cannot be bypassed
  // by adding a dot.
  const hostname = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (!hostname || hostname.endsWith(".internal") || hostname.endsWith(".local") || hostname.endsWith(".localhost") || hostname === "localhost") {
    throw unprocessable("PRIVATE_HOST", "local and internal names are never checked");
  }
  // Literal-IP hosts skip DNS but take the same public-range check.
  let addresses: string[];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) {
    addresses = [hostname];
  } else {
    let records: { address: string }[];
    try {
      records = await lookupFn(hostname, { all: true, verbatim: true });
    } catch {
      throw unprocessable("DNS_UNRESOLVABLE", `${hostname} does not resolve; nothing is guessed`);
    }
    addresses = records.map((r) => r.address);
    if (!addresses.length) throw unprocessable("DNS_UNRESOLVABLE", `${hostname} resolved to no addresses`);
  }
  const blocked: string[] = [];
  for (const a of addresses) {
    try {
      validatePublicIp(a);
      if (a.toLowerCase().startsWith("2001:db8")) throw new Error("documentation range");
    } catch {
      blocked.push(a);
    }
  }
  if (blocked.length) {
    throw unprocessable("PRIVATE_HOST",
      `${hostname} resolves to a private, reserved or special-use address; internal targets are never checked`);
  }
  const key = `${hostname}:${port}`;
  const last = lastCheck.get(key);
  if (last !== undefined && Date.now() - last < RATE_LIMIT_MS) {
    throw unprocessable("RATE_LIMITED", `${key} was checked less than ${RATE_LIMIT_MS / 1000}s ago; one check per target per minute`);
  }
  lastCheck.set(key, Date.now());
  return { url: u.toString(), hostname, port, addresses };
}

/** One measured GET, redirects never followed, strict timeout. */
export async function measureGet(url: string, timeoutMs: number, ua: string): Promise<{ status: number; latency_ms: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "manual", headers: { "User-Agent": ua } });
    return { status: res.status, latency_ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}
