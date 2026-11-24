import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const scratch = vi.hoisted(() => {
  const path = `/tmp/grid-zone-case-control-${process.pid}-${Date.now()}.sqlite`;
  process.env.SQLITE_PATH = path;
  delete process.env.DATABASE_URL;
  return path;
});
vi.mock("../src/core/storage", async original => {
  const actual = await original<typeof import("../src/core/storage")>();
  return { ...actual, getGridPrice: vi.fn(actual.getGridPrice), saveReceipt: vi.fn(actual.saveReceipt) };
});
import { closeStorage, getGridPrice, getReceiptEvidence, saveGridPrice, saveReceipt } from "../src/core/storage";
import { SUPPORTED_ZONES } from "../src/jobs/gridIngester";
import { handleGridPrice, CAISO_SYSTEM_NODE } from "../src/handlers/gridPrice";
import { buildServer } from "../src/server";
import { sha256Hex, type Receipt } from "../src/core/receipt";

// Original recognition controls derive only from our own public supported map
// and YAML declarations, never submitted questions or historical evaluation
// inputs. A storage-boundary sentinel proves recognition, not price availability.
const STOP = new Error("original-case-control-storage-boundary");
const INTERVAL = "2026-11-22T08:00:00.000Z";
const canonical = Object.keys(SUPPORTED_ZONES);
const mixed = (s: string) => s.toLowerCase().replace(/[a-z]/g, (ch, offset) => offset % 2 ? ch.toUpperCase() : ch);
const noisy = (s: string) => " \t" + mixed(s).replace(/ /g, "\t\u00a0 ") + "\n ";
const aliases: Array<[string, string]> = [];
for (const hub of ["np15", "sp15", "zp26"]) {
  for (const s of [hub, hub + " hub", "caiso " + hub, "caiso-" + hub, "caiso_" + hub, "caiso " + hub + " hub", "th_" + hub, "th_" + hub + "_gen"]) {
    aliases.push([s, "TH_" + hub.toUpperCase() + "_GEN-APND"]);
  }
}
for (const s of ["", "caiso", "caiso system", "caiso-system", "caiso_system", "caiso system hub", "caiso day-ahead", "caiso day ahead", "caiso dam", "caiso da"]) {
  aliases.push([s, CAISO_SYSTEM_NODE]);
}
// "NYISO" moved from rejected to aliases by the reviewed natural-name
// aliases commit (2026-11-23): bare "nyiso" is now answered for the N.Y.C.
// load zone, mirroring bare "caiso" -> the NP15 hub.
for (const [s, target] of [["NYISO", "N.Y.C."]] as Array<[string, string]>) aliases.push([s, target]);
const rejected = [
  "ORIGINAL_ZONE_SCOPE_CONTROL", "ELERING", "PJM", "ZONE_L", "CAISO:NP15", "ZONE-A",
  "EE_EXTRA", "TH_NP15_GEN-APND_EXTRA", "ZONE_A_EXTRA", "__proto__", "constructor", "toString",
  "f\u0131", "we\u017ft", "\u039dP15", "\uff26\uff29", "ZONE_A\u0000", "E\u200bE",
];
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("../src/core/storage")>("../src/core/storage");
  vi.mocked(getGridPrice).mockReset().mockRejectedValue(STOP);
  vi.mocked(saveReceipt).mockReset().mockImplementation(actual.saveReceipt);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-22T09:44:07.228Z"));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled for original case controls")));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(async () => {
  await closeStorage();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(scratch + suffix, { force: true });
});
async function recognized(input: string, expected: string) {
  await expect(handleGridPrice({ node_or_zone: input, interval_start: INTERVAL })).rejects.toBe(STOP);
  expect(getGridPrice).toHaveBeenCalledTimes(1);
  expect(getGridPrice).toHaveBeenCalledWith(expected, INTERVAL);
  expect(saveReceipt).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
}
describe("original exact-map and spelling-boundary controls", () => {
  for (const zone of canonical) {
    it(`preserves canonical identifier ${zone}`, () => recognized(zone, zone));
    it(`recognizes ASCII lowercase ${zone} as the same canonical identifier`, () => recognized(zone.toLowerCase(), zone));
    it(`recognizes mixed ASCII case and existing whitespace normalization for ${zone}`, () => recognized(noisy(zone), zone));
  }
  for (const [s, target] of aliases) it(`preserves declared source alias ${JSON.stringify(s)}`, () => recognized(s, target));
  for (const s of rejected) it(`still refuses exact non-member ${JSON.stringify(s)} before storage`, async () => {
    await expect(handleGridPrice({ node_or_zone: s, interval_start: INTERVAL })).rejects.toMatchObject({ status: 422, code: "UNSUPPORTED_ZONE" });
    expect(getGridPrice).not.toHaveBeenCalled(); expect(saveReceipt).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});

// Real row from our independently chosen ordinary NYISO source read on
// 2026-11-22, unrelated to submitted/scored inputs. Time is pinned to its
// actual capture period. No claim that this is a current price in future runs.
const ROW_INTERVAL = "2026-11-22T08:55:00.000Z";
const ROW_INGESTED = "2026-11-22T09:40:34.326Z";
const ROW_PRICE = 29.24;
const ROW_SOURCE = "https://mis.nyiso.com/public/csv/realtime/20261122realtime_zone.csv";
const ROW_HASH = "71780879aee3491e26a33e3eef2a83d08a57a73768dd4539b12c1c1e04e8b9bf";
async function realRow() {
  const actual = await vi.importActual<typeof import("../src/core/storage")>("../src/core/storage");
  vi.mocked(getGridPrice).mockImplementation(actual.getGridPrice);
  await saveGridPrice("ZONE_A", ROW_INTERVAL, ROW_PRICE, "NYISO", ROW_INGESTED, ROW_SOURCE);
}
describe("canonical receipt identity with an original real source row", () => {
  for (const spelling of ["ZONE_A", "zone_a", " \tZoNe_A \n"]) it(`preserves stored identity/value/hash for ${JSON.stringify(spelling)}`, async () => {
    await realRow();
    const result = await handleGridPrice({ node_or_zone: spelling, interval_start: ROW_INTERVAL });
    expect(result.node_or_zone).toBe("ZONE_A"); expect(result.lmp_usd_per_mwh).toBe(ROW_PRICE);
    expect(result.market).toBe("NYISO"); expect(result.interval_start).toBe(ROW_INTERVAL);
    expect(result.verdict).toBe("verified");
    const receipt = result.receipt as Receipt;
    expect(receipt.raw_response_sha256).toBe(ROW_HASH); expect(receipt.fetched_at).toBe(ROW_INGESTED);
    const ev = await getReceiptEvidence(receipt.receipt_id);
    expect(ev.found).toBe(true); expect(sha256Hex(ev.evidence!)).toBe(ROW_HASH);
    expect(JSON.parse(ev.evidence!.toString("utf8"))).toEqual({ node_or_zone: "ZONE_A", interval_start: ROW_INTERVAL, lmp_usd_per_mwh: ROW_PRICE, market: "NYISO" });
    expect(saveReceipt).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
  it("serves a normalized HTTP request with retrievable exact canonical evidence", async () => {
    await realRow(); const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/grid-price?" + new URLSearchParams({ node_or_zone: " \tzone_a\n", interval_start: ROW_INTERVAL }) });
      expect(response.statusCode).toBe(200); const value = response.json(); expect(value.node_or_zone).toBe("ZONE_A");
      const id = value.receipt.receipt_id;
      const metadata = await app.inject({ method: "GET", url: "/receipts/" + id });
      const raw = await app.inject({ method: "GET", url: "/receipts/" + id + "/raw" });
      expect(metadata.statusCode).toBe(200); expect(metadata.json()).toMatchObject({ receipt_id: id, evidence_available: true, raw_response_sha256: ROW_HASH });
      expect(raw.statusCode).toBe(200); expect(sha256Hex(raw.rawPayload)).toBe(ROW_HASH);
    } finally { await app.close(); }
  });
  it("still refuses a normalized request when its receipt evidence save fails", async () => {
    await realRow(); vi.mocked(saveReceipt).mockRejectedValueOnce(new Error("original-normalized-save-refusal"));
    await expect(handleGridPrice({ node_or_zone: "zone_a", interval_start: ROW_INTERVAL })).rejects.toMatchObject({ status: 502, code: "RECEIPT_PERSIST_FAILED" });
    expect(saveReceipt).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
});
