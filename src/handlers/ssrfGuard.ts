// Public-target probes pin the TCP destination to a validated DNS result.
// TLS still validates the original hostname. No redirects or ambient
// connection pools are used. Only ports 80 and 443 are allowed.
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { badRequest, unprocessable } from "../core/errors";
import { validatePublicIp } from "./ipGeolocation";

const RATE_LIMIT_MS = 60_000;
const lastCheck = new Map<string, number>();
function publicProbeIp(address: string): void {
  if (!isIP(address)) throw new Error("invalid IP address");
  validatePublicIp(address);
  // Restrict IPv6 to ordinary global unicast. Reject mapped/transition
  // addresses and documentation space instead of risking embedded IPv4.
  if (isIP(address) === 6 && (!/^[23]/i.test(address) || /^2001:db8:/i.test(address) || /^2002:/i.test(address) || /^2001:0:/i.test(address)))
    throw new Error("non-global or transition IPv6 address");
}

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
  const hostname = u.hostname.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        records = await Promise.race([
          lookupFn(hostname, { all: true, verbatim: true }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("DNS deadline")), 2000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    } catch {
      throw unprocessable("DNS_UNRESOLVABLE", `${hostname} does not resolve; nothing is guessed`);
    }
    addresses = records.map((r) => r.address);
    if (!addresses.length) throw unprocessable("DNS_UNRESOLVABLE", `${hostname} resolved to no addresses`);
  }
  const blocked: string[] = [];
  for (const a of addresses) {
    try {
      publicProbeIp(a);
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
  for (const [k, at] of lastCheck) if (Date.now() - at >= RATE_LIMIT_MS) lastCheck.delete(k);
  if (lastCheck.size >= 1024) throw unprocessable("RATE_LIMITED", "probe capacity reached; retry later");
  lastCheck.set(key, Date.now());
  return { url: u.toString(), hostname, port, addresses };
}

/** One measured GET to a validated, pinned address; redirects never followed. */
export async function measureGet(target: GuardedTarget, timeoutMs: number, ua: string): Promise<{ status: number; latency_ms: number }> {
  const started = Date.now();
  const u = new URL(target.url);
  const selected = [...target.addresses].sort((a,b) => isIP(a) - isIP(b))[0];
  if (!selected || !isIP(selected)) throw new Error("missing validated address");
  // Defence in depth for callers constructing a target outside the guard.
  publicProbeIp(selected);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: Error, result?: {status: number; latency_ms: number}) => {
      if (done) return; done = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result!);
    };
    let request: ReturnType<typeof httpRequest> | undefined;
    const timer = setTimeout(() => {
      const error = new Error("probe deadline exceeded"); error.name = "AbortError";
      finish(error); request?.destroy(error);
    }, timeoutMs);
    try {
    request = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, {
      method: "GET", agent: false, autoSelectFamily: false, family: isIP(selected), headers: { "User-Agent": ua },
      lookup: ((_host: string, options: any, callback: any) => {
        const record = { address: selected, family: isIP(selected) };
        // DNS lookup callbacks must be asynchronous, as the native resolver is.
        // A synchronous unreachable-IPv6 callback can throw during TLS setup
        // before request() returns and leave an unowned socket error.
        queueMicrotask(() => {
          if (options?.all) callback(null, [record]); else callback(null, record.address, record.family);
        });
      }) as any,
    }, response => {
      const status = response.statusCode;
      // We measure response headers only. Do not download an unbounded body.
      response.destroy(); request?.destroy();
      if (!status) finish(new Error("missing HTTP status"));
      else finish(undefined, { status, latency_ms: Date.now() - started });
    });
    request.on("error", error => finish(error));
    request.on("socket", socket => socket.on("error", error => finish(error)));
    request.end();
    } catch (error) {
      finish(error instanceof Error ? error : new Error("probe setup failed"));
      request?.destroy();
    }
  });
}
