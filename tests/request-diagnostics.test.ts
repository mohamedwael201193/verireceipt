// Test-only query/error sentinels. No source calls or production data.
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const scratch = mkdtempSync(join(tmpdir(), "vr-request-diagnostics-"));
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
import { recordRequestCompletion, resetRequestMetricsForTests } from "../src/core/requestMetrics";
import { buildServer } from "../src/server";
import { closeStorage } from "../src/core/storage";
afterEach(() => { vi.restoreAllMocks(); resetRequestMetricsForTests(); });
afterAll(async () => { await closeStorage(); rmSync(scratch, { recursive: true, force: true }); });
it("logs a fixed path, known parameter names and an allowed error category, never values or unknown names", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  recordRequestCompletion("/v1/validator", 400, 1.234, { query: { validator_index: "PRIVATE_VALUE", PRIVATE_KEY: "PRIVATE_SECRET" }, errorCode: "UNKNOWN_PARAM" });
  const row = JSON.parse(log.mock.calls[0][0]);
  expect(row).toMatchObject({ event: "request_complete", path: "/v1/validator", intent: "VALIDATOR_PERFORMANCE_VERIFY_GENERAL", param_keys: ["validator_index"], error_code: "UNKNOWN_PARAM", status: "400", latency_ms: 1.2 });
  expect(JSON.stringify(row)).not.toContain("PRIVATE");
});
it("does not inspect query values or emit arbitrary error strings", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const query = Object.defineProperty({}, "validator_index", { enumerable: true, get() { throw new Error("PRIVATE_VALUE_WAS_READ"); } });
  recordRequestCompletion("/v1/validator", 502, 2, { query, errorCode: "PRIVATE_SECRET" });
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ param_keys: ["validator_index"], error_code: "OTHER_ERROR" });
  expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
});
it("uses a uniform null error field for success and omits unknown routes", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  recordRequestCompletion("/v1/tvl", 200, 1);
  recordRequestCompletion("/PRIVATE_PATH", 404, 1, { query: { PRIVATE_KEY: "PRIVATE_VALUE" } });
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ path: "/v1/tvl", param_keys: [], error_code: null });
});
it("wires the actual HTTP validation failure into the bounded completion log", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const app = buildServer();
  try {
    const response = await app.inject({ method: "GET", url: "/v1/validator?validator_index=PRIVATE_VALUE&PRIVATE_KEY=PRIVATE_SECRET" });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ path: "/v1/validator", param_keys: ["validator_index"], error_code: "UNKNOWN_PARAM", status: "400" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
  } finally { await app.close(); }
});
it("wires an actual non-ApiError to INTERNAL without logging its message", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const app = buildServer();
  app.post("/v1/validator", async () => { throw new Error("PRIVATE_SECRET"); });
  try {
    expect((await app.inject({ method: "POST", url: "/v1/validator" })).statusCode).toBe(502);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ error_code: "INTERNAL", status: "502" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
  } finally { await app.close(); }
});
