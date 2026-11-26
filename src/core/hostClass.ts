import { isIP } from "node:net";
import { validatePublicIp } from "../handlers/ipGeolocation";

export type HostClass = "public_hostname" | "ip" | "private_or_blocked" | "other";
/** Coarse, syntax-only class of the SERVER_UPTIME `host` parameter for diagnostics.
 * No DNS lookup, and the host value, its length and its parts are never returned.
 * "ip" is a public literal address; "private_or_blocked" is a local name or a
 * non-public literal address. A name that only resolves to a blocked address is
 * still "public_hostname" here (classification is by syntax, not by resolution). */
export function hostClassOf(raw: unknown): HostClass {
  try {
    if (typeof raw !== "string" || raw === "" || raw.length > 300) return "other";
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) return "other";
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.username || u.password) return "other";
    const host = u.hostname.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
    if (!host) return "other";
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return "private_or_blocked";
    if (isIP(host)) {
      try { validatePublicIp(host); } catch { return "private_or_blocked"; }
      if (isIP(host) === 6 && (!/^[23]/.test(host) || /^2001:db8:/.test(host) || /^2002:/.test(host) || /^2001:0:/.test(host))) return "private_or_blocked";
      return "ip";
    }
    return "public_hostname";
  } catch { return "other"; }
}
