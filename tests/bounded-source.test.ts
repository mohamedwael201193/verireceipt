// Deliberate transport failures are test-only. Production always calls real fixed sources.
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedSourceText } from "../src/core/boundedSource";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const url = "https://dns.google/resolve?name=example.com&type=15";
const options = { timeoutMs: 100, maxBytes: 64 };
describe("bounded source transport", () => {
  it("preserves exact UTF-8 text and refuses redirects", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("é\r\n")); vi.stubGlobal("fetch", fetcher);
    const result = await boundedSourceText(url, options);
    expect(Buffer.from(result.raw).toString("hex")).toBe(Buffer.from("é\r\n").toString("hex"));
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    expect(Number.isFinite(Date.parse(result.fetchedAt))).toBe(true);
  });
  it("counts bytes, not Unicode characters", async () => {
    vi.stubGlobal("fetch", async () => new Response("éé"));
    await expect(boundedSourceText(url, { ...options, maxBytes: 3 })).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
  });
  it("rejects an oversized declared length before reading", async () => {
    vi.stubGlobal("fetch", async () => new Response("x", { headers: { "content-length": "1000" } }));
    await expect(boundedSourceText(url, options)).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
  });
  it("never treats HTTP 500 as source data", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    await expect(boundedSourceText(url, options)).rejects.toMatchObject({ code: "SOURCE_HTTP_ERROR", httpStatus: 500 });
  });
  it("rejects malformed UTF-8 rather than hashing replacement characters", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([0xc3, 0x28])));
    await expect(boundedSourceText(url, options)).rejects.toThrow();
  });
  it("times out even when a fetch implementation ignores AbortSignal", async () => {
    let release!: (value: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { release = resolve; }));
    await expect(boundedSourceText(url, { ...options, timeoutMs: 15 })).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
    release(new Response("{}")); await new Promise(setImmediate);
  });
  it("includes a stalled body in the deadline and cancels its reader", async () => {
    let cancelled = false;
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await expect(boundedSourceText(url, { ...options, timeoutMs: 15 })).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
    await new Promise(setImmediate); expect(cancelled).toBe(true);
  });
  it("caps outstanding reads even while cancellation is ignored", async () => {
    const releases: Array<(value: Response) => void> = [];
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { releases.push(resolve); }));
    const reads = Array.from({ length: 12 }, () => boundedSourceText(url, { ...options, timeoutMs: 15 }));
    const finish = Promise.allSettled(reads);
    const expired = await finish; expect(expired.every((row) => row.status === "rejected")).toBe(true);
    await expect(boundedSourceText(url, options)).rejects.toMatchObject({ code: "SOURCE_BUSY" });
    releases.forEach((release) => release(new Response("{}"))); await new Promise(setImmediate);
    await expect(boundedSourceText(url, options)).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
    releases.at(-1)?.(new Response("{}")); await new Promise(setImmediate);
  });
});
