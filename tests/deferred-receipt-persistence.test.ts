import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const scratch = vi.hoisted(() => {
  const path = `/tmp/deferred-persistence-${process.pid}-${Date.now()}.sqlite`;
  process.env.SQLITE_PATH = path;
  delete process.env.DATABASE_URL;
  return path;
});
vi.mock("../src/core/storage", async original => {
  const actual = await original<typeof import("../src/core/storage")>();
  return { ...actual, saveReceipt: vi.fn(actual.saveReceipt) };
});
import { saveReceipt, getReceiptEvidence, closeStorage } from "../src/core/storage";
import { sha256Hex, type Receipt } from "../src/core/receipt";
import { handleGasPrice } from "../src/handlers/gasPrice";
import { handleMacro, resetMacroCachesForTests } from "../src/handlers/macroEconomic";
import { handleTokenSupply } from "../src/handlers/tokenSupply";
import { handleBalance } from "../src/handlers/walletBalance";
import { buildServer } from "../src/server";

// Original storage-fault controls. Financial/statistical data below are actual
// ordinary public-source captures through our unchanged161dcd62 handlers,
// independently selected and checked against real isolated SQLite evidence.
// No invented measurements, protected inputs, site demo data or live network
// calls in these unit tests. Only storage failure/delay is injected.
const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/deferred-persistence-real-sources.json"), "utf8"));
interface RecordedResponse { url: string; method: string; body: unknown; status: number; raw_text: string; sha256: string }
interface CapturedCase { query: Record<string, string>; expected_fields: Record<string, unknown>; expected_raw_text: string; expected_raw_sha256: string; clock: string }
// The source captures stay unchanged; supply receipts now add an explicit chain-scope label.
const supplyScope = "chain-specific ERC-20 totalSupply, decimals applied; not a global asset or circulating supply";
fixture.scenarios.supply.expected_fields.total_supply_scope = supplyScope;
const supplyEvidence = JSON.parse(fixture.scenarios.supply.expected_raw_text);
supplyEvidence.total_supply_scope = supplyScope;
fixture.scenarios.supply.expected_raw_text = JSON.stringify(supplyEvidence, Object.keys(supplyEvidence).sort());
fixture.scenarios.supply.expected_raw_sha256 = sha256Hex(fixture.scenarios.supply.expected_raw_text);
const responses = fixture.responses as RecordedResponse[];
const key = (url: string, method: string, body: unknown) => JSON.stringify([url, method, body]);
const responseMap = new Map<string, RecordedResponse[]>();
for (const row of responses) {
  if (sha256Hex(row.raw_text) !== row.sha256) throw new Error("Captured source bytes changed");
  const k = key(row.url, row.method, row.body);
  responseMap.set(k, [...(responseMap.get(k) ?? []), row]);
}
let cursors = new Map<string, number>();
const transport: typeof fetch = async (input, init) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const k = key(url, method, body);
  const rows = responseMap.get(k);
  // A native RPC leg without a captured response stays UNKNOWN, never a
  // fabricated vote. All served values/quorum counts must match the real run.
  if (!rows) throw new Error("No recorded source response for offline control");
  const index = cursors.get(k) ?? 0;
  cursors.set(k, index + 1);
  const row = rows[index % rows.length];
  return new Response(row.raw_text, { status: row.status });
};
interface Scenario { name: string; route: string; captured: CapturedCase; handler: (query: Record<string, string | undefined>) => Promise<Record<string, unknown>> }
const cases: Scenario[] = [
  { name: "gas quorum", route: "/v1/gas-price", captured: fixture.scenarios.gas, handler: handleGasPrice },
  { name: "macro latest published", route: "/v1/macro", captured: fixture.scenarios.macro_latest, handler: handleMacro },
  { name: "macro explicit year", route: "/v1/macro", captured: fixture.scenarios.macro_year, handler: handleMacro },
  { name: "token supply quorum", route: "/v1/token-supply", captured: fixture.scenarios.supply, handler: handleTokenSupply },
  { name: "native wallet balance", route: "/v1/balance", captured: fixture.scenarios.balance_native, handler: handleBalance },
  { name: "ERC20 wallet balance", route: "/v1/balance", captured: fixture.scenarios.balance_token, handler: handleBalance },
];
const expected = { status: 502, code: "RECEIPT_PERSIST_FAILED", message: "receipt evidence could not be stored; answer unavailable" };
const call = (item: Scenario) => { cursors = new Map(); return item.handler(item.captured.query); };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.mocked(saveReceipt).mockReset().mockResolvedValue(undefined);
  resetMacroCachesForTests(); cursors = new Map();
  vi.stubGlobal("fetch", transport);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { resetMacroCachesForTests(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(async () => { await closeStorage(); for (const suffix of ["", "-wal", "-shm"]) rmSync(scratch + suffix, { force: true }); });
for (const item of cases) describe(item.name, () => {
  beforeEach(() => vi.setSystemTime(new Date(item.captured.clock)));
  for (const [label, reason] of [
    ["Error", new Error("original-storage-fault-detail")],
    ["timeout", Object.assign(new Error("original-storage-deadline-detail"), { code: "STORAGE_TIMEOUT" })],
    ["untyped rejection", "original-storage-untyped-detail"],
  ] as const) it(`refuses rejected evidence persistence (${label}) before any answer`, async () => {
    vi.mocked(saveReceipt).mockRejectedValueOnce(reason);
    const result = await call(item).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    expect(saveReceipt).toHaveBeenCalledTimes(1);
    expect(result.error).toMatchObject(expected); expect(result.value).toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
  });
  it("keeps the real observed answer and exact SQLite/HTTP evidence bytes", async () => {
    const actual = await vi.importActual<typeof import("../src/core/storage")>("../src/core/storage");
    vi.mocked(saveReceipt).mockImplementationOnce(actual.saveReceipt);
    const result = await call(item);
    const { receipt: returnedReceipt, ...fields } = result;
    // checked_at is this execution clock, not the original SQLite elapsed time.
    expect(fields).toEqual({ ...item.captured.expected_fields, checked_at: item.captured.clock });
    expect(saveReceipt).toHaveBeenCalledTimes(1);
    const [receipt, raw] = vi.mocked(saveReceipt).mock.calls[0];
    expect(returnedReceipt).toEqual(receipt); expect(raw).toBe(item.captured.expected_raw_text);
    expect(receipt.raw_response_sha256).toBe(item.captured.expected_raw_sha256);
    const evidence = await getReceiptEvidence(receipt.receipt_id);
    expect(evidence.found).toBe(true); expect(evidence.evidence?.toString("utf8")).toBe(raw);
    expect(evidence.sha256).toBe(sha256Hex(raw!));
    const app = buildServer();
    try {
      const meta = await app.inject({ method: "GET", url: `/receipts/${receipt.receipt_id}` });
      expect(meta.statusCode).toBe(200); expect(meta.json()).toMatchObject({ receipt_id: receipt.receipt_id, raw_response_sha256: receipt.raw_response_sha256, evidence_available: true, evidence_status: "ok" });
      const bytes = await app.inject({ method: "GET", url: `/receipts/${receipt.receipt_id}/raw` });
      expect(bytes.statusCode).toBe(200); expect(bytes.body).toBe(raw); expect(bytes.headers["x-raw-sha256"]).toBe(receipt.raw_response_sha256);
    } finally { await app.close(); }
  });
  it("can persist a later healthy request after one failed save", async () => {
    const actual = await vi.importActual<typeof import("../src/core/storage")>("../src/core/storage");
    vi.mocked(saveReceipt).mockRejectedValueOnce(new Error("original-recovery-fault")).mockImplementationOnce(actual.saveReceipt);
    await call(item).catch(() => undefined);
    const result = await call(item);
    expect(saveReceipt).toHaveBeenCalledTimes(2); expect(result.verdict).toBe(item.captured.expected_fields.verdict);
    const receipt = result.receipt as Receipt;
    const evidence = await getReceiptEvidence(receipt.receipt_id);
    expect(evidence.found).toBe(true); expect(evidence.sha256).toBe(item.captured.expected_raw_sha256);
    if (item.route === "/v1/macro") {
      const catalogKey = [...responseMap.keys()].find(k => k.includes("/v2/country?"))!;
      // The second call resets only playback counters, not the native catalog.
      expect(cursors.get(catalogKey)).toBeUndefined();
    }
  });
  it("returns fixed HTTP502 without an answer, receipt or storage detail", async () => {
    vi.mocked(saveReceipt).mockRejectedValue(new Error("original-http-storage-detail"));
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: item.route + "?" + new URLSearchParams(item.captured.query) });
      expect(saveReceipt).toHaveBeenCalledTimes(1); expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: "receipt_persist_failed", code: expected.code, message: expected.message });
      expect(response.body).not.toMatch(/original-http-storage-detail|rcpt_|verified|confidence/);
    } finally { await app.close(); }
  });
  it("withholds success for a pending save and refuses later rejection", async () => {
    let rejectSave!: (reason: Error) => void;
    vi.mocked(saveReceipt).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
    let settled = false;
    const outcome = call(item).then(value => { settled = true; return { value, error: undefined }; }, error => { settled = true; return { value: undefined, error }; });
    await vi.waitFor(() => expect(saveReceipt).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false); rejectSave(new Error("original-deferred-storage-detail"));
    const result = await outcome; expect(result.error).toMatchObject(expected); expect(result.value).toBeUndefined();
  });
});
it("persists the publisher's empty Aruba bytes as disclosed no-data, never a numeric answer", async () => {
  vi.setSystemTime(new Date(fixture.scenarios.macro_latest.clock));
  const id = fixture.provenance.selection.macro_skipped_no_data[0].id;
  const out = await handleMacro({ indicator: "unemployment rate", country: id });
  expect(out).toMatchObject({ rate_pct: null, verdict: "no_data", confidence: 0 });
  expect(out.answer).toContain("no data"); expect(saveReceipt).toHaveBeenCalledTimes(1);
  const [receipt, evidence] = vi.mocked(saveReceipt).mock.calls[0];
  expect(sha256Hex(evidence!)).toBe(receipt.raw_response_sha256);
  vi.mocked(saveReceipt).mockRejectedValueOnce(new Error("private-no-data-storage-error"));
  await expect(handleMacro({ indicator: "unemployment rate", country: id })).rejects.toMatchObject(expected);
});
