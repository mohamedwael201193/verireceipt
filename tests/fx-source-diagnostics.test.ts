import {resetFxObservationsForTests} from '../src/handlers/fxObservations';
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const dir = mkdtempSync("/tmp/fx-source-logs-"); process.env.SQLITE_PATH = join(dir, "receipts.sqlite");
import { handleFx, handleFxNow } from "../src/handlers/currencyConvert";
afterEach(() => { resetFxObservationsForTests(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); delete process.env.EXCHANGE_RATE_API_KEY; });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function failureLogs(spy: ReturnType<typeof vi.spyOn>): any[] { return spy.mock.calls.map((row: unknown[]) => JSON.parse(String(row[0]))); }
describe("FX source diagnostic logging", () => {
  it("warns structured status/parse/transport reasons without response or error text", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", async (input: unknown) => {
      const u = String(input);
      if (u.includes("frankfurter")) return new Response("private response text", { status: 403 });
      if (u.includes("vatcomply")) return new Response("private invalid JSON");
      if (u.includes("floatrates")) throw new Error("private transport details");
      return new Response("{}");
    });
    await expect(handleFx({ from_currency: "USD", to_currency: "GBP" })).rejects.toMatchObject({ status: 422 });
    const logs = failureLogs(spy);
    expect(logs).toContainEqual(expect.objectContaining({ source: "frankfurter", reason: "http_status", status: 403 }));
    expect(logs).toContainEqual(expect.objectContaining({ source: "vatcomply", reason: "parse_error" }));
    expect(logs).toContainEqual(expect.objectContaining({ source: "floatrates", reason: "transport_error" }));
    expect(JSON.stringify(logs)).not.toMatch(/private|https?:/);
  });
  it("preserves status metadata through the keyed adapter while never logging its key", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.EXCHANGE_RATE_API_KEY = "synthetic-test-key-not-a-secret";
    vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
    await expect(handleFx({ from_currency: "USD", to_currency: "EGP" })).rejects.toMatchObject({ status: 502 });
    expect(failureLogs(spy)).toContainEqual(expect.objectContaining({ source: "exchangerate-api", reason: "http_status", status: 503 }));
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/synthetic-test-key|https?:|latest/);
  });
  it("records the source timeout reason on FX_NOW without changing the refusal", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {}); vi.useFakeTimers();
    vi.stubGlobal("fetch", async (_: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const request = handleFxNow({ currency: "EUR" }); const check = expect(request).rejects.toMatchObject({ code: "FX_SOURCES_DOWN", status: 502 });
    await vi.advanceTimersByTimeAsync(4000); await check;
    expect(failureLogs(spy).filter(row => row.reason === "timeout")).toHaveLength(4);
  });
});
