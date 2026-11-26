// Test-only: no network. host_class is syntax-only and never carries host values.
import { afterEach, expect, it, vi } from "vitest";
import { hostClassOf } from "../src/core/hostClass";
import { recordRequestArrival, recordRequestCompletion, resetRequestMetricsForTests } from "../src/core/requestMetrics";
afterEach(() => { vi.restoreAllMocks(); resetRequestMetricsForTests(); });

it.each([
  ["example.com", "public_hostname"], ["https://Example.com:443/path?x=1", "public_hostname"], ["example.com.", "public_hostname"],
  ["8.8.8.8", "ip"], ["http://1.1.1.1", "ip"], ["[2606:4700:4700::1111]", "ip"],
  ["localhost", "private_or_blocked"], ["a.localhost", "private_or_blocked"], ["localhost.", "private_or_blocked"], ["db.internal.", "private_or_blocked"], ["printer.local.", "private_or_blocked"], ["db.internal", "private_or_blocked"], ["printer.local", "private_or_blocked"],
  ["127.0.0.1", "private_or_blocked"], ["10.0.0.5", "private_or_blocked"], ["169.254.169.254", "private_or_blocked"], ["[::1]", "private_or_blocked"], ["[fe80::1]", "private_or_blocked"], ["[64:ff9b::808:808]", "private_or_blocked"], ["[2002:808:808::1]", "private_or_blocked"], ["[2001:0:4136:e378::1]", "private_or_blocked"],
  ["", "other"], ["ftp://example.com", "other"], ["user:pw@example.com", "other"], ["http://", "other"], ["a".repeat(301), "other"],
])("classifies %s", (raw, cls) => { expect(hostClassOf(raw)).toBe(cls); });
it("non-string input is other", () => { expect(hostClassOf(undefined)).toBe("other"); expect(hostClassOf(42)).toBe("other"); });

function rows(log: ReturnType<typeof vi.spyOn>) {
  return log.mock.calls.map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } }).filter(Boolean);
}
it("start and completion on /v1/server-uptime carry only host_class, never host values", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const q = { host: "SECRETHOST-9.example.com", PRIVATE_KEY: "PRIVATE_VALUE" };
  recordRequestArrival("/v1/server-uptime", q);
  recordRequestCompletion("/v1/server-uptime", 200, 5, { query: q });
  const r = rows(log);
  expect(r.map((x) => x.event)).toEqual(["request_start", "request_complete"]);
  for (const x of r) expect(x.host_class).toBe("public_hostname");
  const text = JSON.stringify(r);
  expect(text).not.toContain("SECRETHOST"); expect(text).not.toContain("PRIVATE_VALUE");
});
it("private literal and missing host classify on both rows", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  recordRequestCompletion("/v1/server-uptime", 200, 1, { query: { host: "192.168.1.1" } });
  recordRequestCompletion("/v1/server-uptime", 400, 1, { query: {}, errorCode: "MISSING_PARAM" });
  const r = rows(log);
  expect(r[0].host_class).toBe("private_or_blocked"); expect(r[1].host_class).toBe("other");
  expect(JSON.stringify(r)).not.toContain("192.168");
});
it("a throwing host getter is never read and classifies as other", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const q = Object.defineProperty({}, "host", { enumerable: true, get() { throw Error("GETTER_RAN"); } });
  recordRequestCompletion("/v1/server-uptime", 200, 1, { query: q });
  expect(rows(log)[0].host_class).toBe("other");
});
it("other routes get no host_class", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  recordRequestCompletion("/v1/dns", 200, 1, { query: { host: "example.com" } });
  recordRequestArrival("/v1/dns", { host: "example.com" });
  for (const x of rows(log)) expect(x).not.toHaveProperty("host_class");
});
it("a throwing host getter on request_start is never read and classifies as other", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const q = Object.defineProperty({}, "host", { enumerable: true, get() { throw Error("GETTER_RAN"); } });
  recordRequestArrival("/v1/server-uptime", q);
  const r = rows(log);
  expect(r).toHaveLength(1);
  expect(r[0]).toMatchObject({ event: "request_start", host_class: "other" });
  expect(JSON.stringify(r)).not.toContain("GETTER_RAN");
});
