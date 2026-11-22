// Test-only source observations and clock. No network, payment or live DNS data.
import { describe, expect, it, vi } from "vitest";
import { ResilientSources } from "../src/core/sourceResilience";
import { SourceReadError } from "../src/core/boundedSource";
function setup(overrides: Record<string, number> = {}) {
  let time = 10_000;
  const sources = new ResilientSources({ sourceIds: ["g", "c"], now: () => time, ...overrides });
  const validate = (raw: string) => { if (!raw.startsWith("good:")) throw new Error("invalid bound source"); return true; };
  const success = (raw = "good:a", fetchedAt = new Date(time).toISOString()) => vi.fn(async () => ({ raw, fetchedAt }));
  const failure = () => vi.fn(async () => { throw new SourceReadError("SOURCE_TIMEOUT"); });
  const read = (load: ReturnType<typeof success> | ReturnType<typeof failure>, url = "a", sourceId = "g", check = validate) => sources.read({ sourceId, url, load, validate: check });
  return { sources, read, success, failure, advance: (ms: number) => { time += ms; }, now: () => time };
}
describe("bounded source circuit breaker and last-known-good evidence", () => {
  it("passes exact live bytes and their original observation timestamp", async () => {
    const s = setup(); const load = s.success();
    expect(await s.read(load)).toMatchObject({ raw: "good:a", fetchedAt: new Date(10_000).toISOString(), cacheMode: "live", cacheAgeMs: 0 });
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("falls back only on failure, without refreshing the source time", async () => {
    const s = setup(); await s.read(s.success()); s.advance(100);
    expect(await s.read(s.failure())).toMatchObject({ raw: "good:a", fetchedAt: new Date(10_000).toISOString(), cacheMode: "last_known_good", cacheAgeMs: 100 });
    s.advance(400);
    expect(await s.read(s.failure())).toMatchObject({ fetchedAt: new Date(10_000).toISOString(), cacheAgeMs: 500 });
  });
  it("prefers a new valid live response over a cached one", async () => {
    const s = setup(); await s.read(s.success()); s.advance(10);
    expect(await s.read(s.success("good:new"))).toMatchObject({ raw: "good:new", cacheMode: "live" });
    expect(await s.read(s.failure())).toMatchObject({ raw: "good:new", fetchedAt: new Date(10_010).toISOString() });
  });
  it("never borrows evidence from a different query or provider", async () => {
    const s = setup(); await s.read(s.success());
    await expect(s.read(s.failure(), "b")).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
    await expect(s.read(s.failure(), "a", "c")).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
  });
  it("requires explicit validator acceptance, not a false result", async () => {
    const s = setup(); await expect(s.read(s.success(), "a", "g", () => false)).rejects.toMatchObject({ code: "SOURCE_INVALID_BODY" });
    await expect(s.read(s.failure())).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
  });
  it("does not cache invalid source bodies", async () => {
    const s = setup(); await expect(s.read(s.success("bad"))).rejects.toThrow("invalid bound source");
    await expect(s.read(s.failure())).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
  });
  it.each(["not-a-time", "1970-01-01T00:00:10.001Z", "1969-12-31T23:59:00.000Z"])("refuses invalid/future/too-old observation time %s", async fetchedAt => {
    const s = setup(); await expect(s.read(s.success("good:a", fetchedAt))).rejects.toMatchObject({ code: "SOURCE_INVALID_TIME" });
    await expect(s.read(s.failure())).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
  });
  it("does not serve fallback evidence beyond the explicit 30-second ceiling", async () => {
    const s = setup(); await s.read(s.success()); s.advance(30_001);
    await expect(s.read(s.failure())).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
  });
  it("opens after three consecutive failures, skips network and recovers with a probe", async () => {
    const s = setup(); const fail = s.failure();
    for (let i = 0; i < 3; i++) await expect(s.read(fail)).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
    await expect(s.read(fail)).rejects.toMatchObject({ code: "SOURCE_CIRCUIT_OPEN" }); expect(fail).toHaveBeenCalledTimes(3);
    s.advance(30_000); expect((await s.read(s.success())).cacheMode).toBe("live");
    const probe = s.failure(); expect((await s.read(probe)).cacheMode).toBe("last_known_good"); expect(probe).toHaveBeenCalledTimes(1);
  });
  it("allows only one half-open network probe", async () => {
    const s = setup(); await s.read(s.success());
    for (let i = 0; i < 3; i++) await s.read(s.failure());
    s.advance(30_000);
    let resolve!: (value: { raw: string; fetchedAt: string }) => void;
    const probe = s.read(vi.fn(() => new Promise<{ raw: string; fetchedAt: string }>(r => { resolve = r; })));
    const other = s.failure(); expect((await s.read(other)).cacheMode).toBe("last_known_good"); expect(other).not.toHaveBeenCalled();
    resolve({ raw: "good:recovered", fetchedAt: new Date(s.now()).toISOString() }); expect((await probe).cacheMode).toBe("live");
  });
  it("reopens after a failed half-open probe", async () => {
    const s = setup(); const fail = s.failure();
    for (let i = 0; i < 3; i++) await expect(s.read(fail)).rejects.toBeDefined();
    s.advance(30_000); await expect(s.read(fail)).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
    await expect(s.read(fail)).rejects.toMatchObject({ code: "SOURCE_CIRCUIT_OPEN" }); expect(fail).toHaveBeenCalledTimes(4);
  });
  it("a valid negative observation resets failures too", async () => {
    const s = setup(); const fail = s.failure();
    for (let i = 0; i < 2; i++) await expect(s.read(fail)).rejects.toBeDefined();
    expect((await s.read(s.success("good:DNS-status-3"))).cacheMode).toBe("live");
    for (let i = 0; i < 2; i++) expect((await s.read(fail)).cacheMode).toBe("last_known_good");
    expect(fail).toHaveBeenCalledTimes(4);
  });
  it("HTTP 400 is not provider outage and cannot be hidden by a cache hit", async () => {
    const s = setup(); await s.read(s.success());
    const reject = vi.fn(async () => { throw new SourceReadError("SOURCE_HTTP_ERROR", 400); });
    for (let i = 0; i < 4; i++) await expect(s.read(reject)).rejects.toMatchObject({ httpStatus: 400 });
    expect(reject).toHaveBeenCalledTimes(4); expect((await s.read(s.failure())).cacheMode).toBe("last_known_good");
  });
  it("local capacity pressure can use cache without opening the provider circuit", async () => {
    const s = setup(); await s.read(s.success()); const busy = vi.fn(async () => { throw new SourceReadError("SOURCE_BUSY"); });
    for (let i = 0; i < 4; i++) expect((await s.read(busy)).cacheMode).toBe("last_known_good");
    expect(busy).toHaveBeenCalledTimes(4);
  });
  it("one provider circuit does not block the other provider", async () => {
    const s = setup(); for (let i = 0; i < 3; i++) await expect(s.read(s.failure())).rejects.toBeDefined();
    const other = s.success(); expect((await s.read(other, "a", "c")).cacheMode).toBe("live"); expect(other).toHaveBeenCalledTimes(1);
  });
  it.each([{ maxAgeMs: 30_001 }, { maxEntries: 65 }, { maxBytes: 4 * 1024 * 1024 + 1 }, { failureThreshold: 0 }, { openMs: 30_001 }])("rejects an unsafe configurable bound %j", options => {
    expect(() => new ResilientSources({ sourceIds: ["g"], ...options })).toThrow();
  });
  it.each([{ sourceIds: [] }, { sourceIds: ["g", "g"] }, { sourceIds: ["g\0c"] }, { sourceIds: Array.from({ length: 17 }, (_, i) => "s" + i) }])("rejects an unsafe fixed source registry %j", ({ sourceIds }) => {
    expect(() => new ResilientSources({ sourceIds })).toThrow();
  });
  it("uses bounded LRU eviction instead of unbounded URL retention", async () => {
    const s = setup({ maxEntries: 2 }); await s.read(s.success(), "a"); await s.read(s.success(), "b");
    await s.read(s.failure(), "a"); await s.read(s.success(), "c");
    await expect(s.read(s.failure(), "b")).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
    expect((await s.read(s.failure(), "a")).cacheMode).toBe("last_known_good");
  });
  it("enforces the evidence/key byte budget as well as the entry count", async () => {
    const s = setup({ maxBytes: 18 }); for (const key of ["a", "b", "c"]) await s.read(s.success(), key);
    await expect(s.read(s.failure(), "a")).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
    expect((await s.read(s.failure(), "b")).cacheMode).toBe("last_known_good");
  });
  it("an oversized cache candidate does not evict unrelated useful evidence", async () => {
    const s = setup({ maxBytes: 18 }); await s.read(s.success(), "a"); await s.read(s.success(), "b");
    expect((await s.read(s.success("good:" + "x".repeat(100)), "c")).cacheMode).toBe("live");
    expect((await s.read(s.failure(), "a")).cacheMode).toBe("last_known_good"); expect((await s.read(s.failure(), "b")).cacheMode).toBe("last_known_good");
  });
  it("a newer valid but uncacheable response invalidates an older same-query entry", async () => {
    const s = setup({ maxBytes: 18 }); await s.read(s.success()); await s.read(s.success("good:" + "x".repeat(100)));
    await expect(s.read(s.failure())).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
  });
  it("revalidates cached binding and evicts a rejected cached entry", async () => {
    const s = setup(); await s.read(s.success());
    await expect(s.read(s.failure(), "a", "g", () => { throw new Error("wrong binding"); })).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
    await expect(s.read(s.failure())).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
  });
  it("unconfigured providers are refused before their loader runs", async () => {
    const s = setup(); const load = s.success(); await expect(s.read(load, "a", "unknown")).rejects.toMatchObject({ code: "SOURCE_NOT_CONFIGURED" }); expect(load).not.toHaveBeenCalled();
  });
});

// Original regressions for the independently reproduced review findings.
describe("final freshness snapshot and concurrent cache ordering", () => {
  it("does not serve a fallback that expires during validation", async () => {
    const s = setup(); await s.read(s.success()); s.advance(29_999);
    await expect(s.read(s.failure(), "a", "g", raw => {
      s.advance(2); return raw.startsWith("good:");
    })).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
  });
  it.each(["live", "fallback"] as const)("uses one final clock snapshot for %s age and servedAt", async mode => {
    let ticks = 0;
    const sources = new ResilientSources({ sourceIds: ["g"], now: () => 10_000 + ticks++ });
    const request = { sourceId: "g", url: "a", validate: () => true,
      load: async () => ({ raw: "good:a", fetchedAt: new Date(10_000).toISOString() }) };
    let result = await sources.read(request);
    if (mode === "fallback") result = await sources.read({ ...request,
      load: async () => { throw new SourceReadError("SOURCE_TIMEOUT"); } });
    expect(Date.parse(result.servedAt) - Date.parse(result.fetchedAt)).toBe(result.cacheAgeMs);
  });
  it.each([false, true])("preserves newer same-key evidence when an older completion is oversized=%s", async oversized => {
    const s = setup({ maxBytes: 18 });
    let release!: (value: { raw: string; fetchedAt: string }) => void;
    const pending = new Promise<{ raw: string; fetchedAt: string }>(resolve => { release = resolve; });
    const older = s.read(vi.fn(async () => pending));
    s.advance(10);
    await s.read(s.success("good:new"));
    const raw = oversized ? "good:" + "x".repeat(100) : "good:old";
    release({ raw, fetchedAt: new Date(10_000).toISOString() });
    expect((await older).raw).toBe(raw);
    expect(await s.read(s.failure())).toMatchObject({ raw: "good:new", fetchedAt: new Date(10_010).toISOString() });
  });
});

describe("bounded ordering across overlapping reads", () => {
  it("an uncacheable newer observation prevents an older in-flight body from resurrecting", async () => {
    const s = setup({ maxBytes: 18 });
    let release!: (value: { raw: string; fetchedAt: string }) => void;
    const pending = new Promise<{ raw: string; fetchedAt: string }>(resolve => { release = resolve; });
    const old = s.read(vi.fn(async () => pending));
    s.advance(10);
    await s.read(s.success("good:" + "x".repeat(100)));
    s.advance(10);
    release({ raw: "good:old", fetchedAt: new Date(10_000).toISOString() });
    expect((await old).raw).toBe("good:old");
    await expect(s.read(s.failure())).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
  });
  it("bounds active distinct-key ordering and releases it when reads finish", async () => {
    const s = setup({ maxEntries: 1 });
    let release!: (value: { raw: string; fetchedAt: string }) => void;
    const pending = new Promise<{ raw: string; fetchedAt: string }>(resolve => { release = resolve; });
    const first = s.read(vi.fn(async () => pending), "a");
    const next = s.success("good:b");
    await expect(s.read(next, "b")).rejects.toMatchObject({ code: "SOURCE_BUSY" });
    expect(next).not.toHaveBeenCalled();
    release({ raw: "good:a", fetchedAt: new Date(s.now()).toISOString() });
    await first;
    expect((await s.read(next, "b")).raw).toBe("good:b");
    expect(next).toHaveBeenCalledTimes(1);
  });
  it("caps active ordering key bytes before dispatch and releases them after failure", async () => {
    const s = setup({ maxBytes: 8 });
    let fail!: (reason: unknown) => void;
    const pending = new Promise<{ raw: string; fetchedAt: string }>((_, reject) => { fail = reject; });
    const first = s.read(vi.fn(async () => pending), "a");
    const next = s.success();
    await expect(s.read(next, "aaaaaa")).rejects.toMatchObject({ code: "SOURCE_BUSY" });
    expect(next).not.toHaveBeenCalled();
    fail(new SourceReadError("SOURCE_TIMEOUT"));
    await expect(first).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
    expect((await s.read(next, "aaaaaa")).cacheMode).toBe("live");
    expect(next).toHaveBeenCalledTimes(1);
  });
});
