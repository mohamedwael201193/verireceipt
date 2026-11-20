// Grid power price ingester — background cache filler for /v1/grid-price.
//
// Supported zones (zone -> market -> source). Verified live 2026-11-20 ~06:06 UTC:
//   EE, FI, LV, LT        -> Elering <zone>  -> Elering dashboard API
//                            https://dashboard.elering.ee/api/nps/price
//                            JSON {success, data:{ee,fi,lv,lt:[{timestamp,price}]}},
//                            37 rows/zone, 15-min intervals, price in EUR/MWh.
//                            Observed 2026-11-20: EE 108.74 EUR/MWh @ 2026-11-19T21:00Z.
//   ZONE_A..ZONE_K plus WEST, GENESE, CENTRL, NORTH, MHK VL, CAPITL, HUD VL,
//   MILLWD, DUNWOD, N.Y.C., LONGIL -> NYISO -> NYISO MIS realtime LBMP CSV
//                            https://mis.nyiso.com/public/csv/realtime/YYYYMMDDrealtime_zone.csv
//                            HTTP 200, text/csv, 5-min intervals, LBMP USD/MWh.
//                            Observed 2026-11-20 file: N.Y.C. 39.92 USD/MWh @ 00:05 EST.
//                            (Directory listing itself is 403; direct dated file works.)
//   TH_NP15_GEN-APND, TH_SP15_GEN-APND, TH_ZP26_GEN-APND -> CAISO -> CAISO OASIS
//                            https://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_LMP
//                            &market_run_id=DAM (https + follow redirects; resultformat
//                            ignored, always a zip with one CSV). Hourly DAM intervals,
//                            LMP_PRC in USD/MWh. Observed 2026-11-20: TH_NP15_GEN-APND
//                            67.57882 USD/MWh @ 2026-11-20T03:00Z.
//   EUR->USD conversion for Elering: https://open.er-api.com/v6/latest/EUR
//                            Verified 2026-11-20: result success, USD rate 1.097999.
//
// SKIPPED — ERCOT: public API returned 404 without a key
// (https://api.ercot.com/api/public-reports/np4-183-cd/dam_stlmnt_pnt_prices)
// and the MIS public download returned an empty reply. Registration-gated;
// no ERCOT zones are supported. HB_NORTH (an ERCOT hub named in the spec
// examples) is therefore UNSUPPORTED_ZONE until a keyless ERCOT feed is found.
//
// Rules: never write a null, zero, or guessed price into the cache. A source
// failure is logged and the other sources still run. No mocks, no LLM.

import { inflateRawSync } from "zlib";
import { saveGridPrice } from "../core/db";

export interface GridZoneInfo {
  market: string;
  source: string;
  url: string;
  /** Settlement window in minutes: NYISO 5, Elering 15, CAISO 60. */
  windowMin: number;
}

export const ELERING_URL = "https://dashboard.elering.ee/api/nps/price";
export const NYISO_BASE_URL = "https://mis.nyiso.com/public/csv/realtime/";
export const CAISO_OASIS_URL = "https://oasis.caiso.com/oasisapi/SingleZip";
export const FX_EUR_USD_URL = "https://open.er-api.com/v6/latest/EUR";

const NYISO_SOURCE = "NYISO MIS realtime LBMP CSV";
const CAISO_SOURCE = "CAISO OASIS PRC_LMP DAM";
const ELERING_SOURCE = "Elering dashboard API";

export const SUPPORTED_ZONES: Record<string, GridZoneInfo> = {
  EE: { market: "Elering EE", source: ELERING_SOURCE, url: ELERING_URL, windowMin: 15 },
  FI: { market: "Elering FI", source: ELERING_SOURCE, url: ELERING_URL, windowMin: 15 },
  LV: { market: "Elering LV", source: ELERING_SOURCE, url: ELERING_URL, windowMin: 15 },
  LT: { market: "Elering LT", source: ELERING_SOURCE, url: ELERING_URL, windowMin: 15 },
  ZONE_A: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  ZONE_B: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  ZONE_C: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  ZONE_D: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  ZONE_E: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  ZONE_F: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  ZONE_G: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  ZONE_H: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  ZONE_I: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  ZONE_J: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  ZONE_K: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  WEST: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  GENESE: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  CENTRL: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  NORTH: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  "MHK VL": { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  CAPITL: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  "HUD VL": { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  MILLWD: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  DUNWOD: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  "N.Y.C.": { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  LONGIL: { market: "NYISO", source: NYISO_SOURCE, url: NYISO_BASE_URL, windowMin: 5 },
  "TH_NP15_GEN-APND": { market: "CAISO", source: CAISO_SOURCE, url: CAISO_OASIS_URL, windowMin: 60 },
  "TH_SP15_GEN-APND": { market: "CAISO", source: CAISO_SOURCE, url: CAISO_OASIS_URL, windowMin: 60 },
  "TH_ZP26_GEN-APND": { market: "CAISO", source: CAISO_SOURCE, url: CAISO_OASIS_URL, windowMin: 60 },
};

/** Feed URL that produced a cached row, keyed by `node|interval_start`. */
const sourceByRow = new Map<string, string>();

export function getGridSource(nodeOrZone: string, intervalStart: string): string | undefined {
  return sourceByRow.get(nodeOrZone + "|" + intervalStart);
}

function recordSource(nodeOrZone: string, intervalStart: string, url: string): void {
  sourceByRow.set(nodeOrZone + "|" + intervalStart, url);
}

const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT = "Mozilla/5.0 (compatible; VeriReceipt/2.0 grid-ingester)";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fetchText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error("HTTP " + res.status + " from " + url);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error("HTTP " + res.status + " from " + url);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** EUR -> USD rate from the keyless exchangerate-api free endpoint. */
async function fetchEurUsd(): Promise<number> {
  const json = JSON.parse(await fetchText(FX_EUR_USD_URL)) as unknown;
  const rate = (json as { rates?: { USD?: unknown } } | null)?.rates?.USD;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error("EUR->USD rate missing from " + FX_EUR_USD_URL);
  }
  return rate;
}

/** Elering Nord Pool day-ahead / intraday prices, EUR/MWh, 15-min intervals. */
async function ingestElering(eurUsd: number): Promise<number> {
  const json = JSON.parse(await fetchText(ELERING_URL)) as unknown;
  const data = (json as { success?: unknown; data?: unknown } | null)?.data;
  if ((json as { success?: unknown } | null)?.success !== true || typeof data !== "object" || data === null) {
    throw new Error("unexpected Elering response shape");
  }
  const zoneKeyToNode: Record<string, string> = { ee: "EE", fi: "FI", lv: "LV", lt: "LT" };
  let count = 0;
  for (const [key, rows] of Object.entries(data as Record<string, unknown>)) {
    const node = zoneKeyToNode[key];
    if (!node || !Array.isArray(rows)) continue;
    for (const row of rows as Array<Record<string, unknown>>) {
      const ts = row?.timestamp;
      const priceEur = row?.price;
      if (typeof ts !== "number" || typeof priceEur !== "number") continue;
      if (!Number.isFinite(priceEur) || priceEur === 0) continue; // never cache null/zero
      const intervalStart = new Date(ts * 1000).toISOString();
      const lmp = priceEur * eurUsd;
      if (!Number.isFinite(lmp) || lmp === 0) continue;
      saveGridPrice(node, intervalStart, lmp, SUPPORTED_ZONES[node].market);
      recordSource(node, intervalStart, ELERING_URL);
      count++;
    }
  }
  if (count === 0) throw new Error("Elering returned no usable price rows");
  return count;
}

/** Offset (ms) of a named IANA zone from UTC at a given UTC instant. */
function tzOffsetMs(timeZone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const v = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
  return asUtc - utcMs;
}

/** "MM/DD/YYYY HH:MM:SS" wall time in America/New_York -> UTC epoch ms. */
function nyWallToUtcMs(wall: string): number | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/.exec(wall.trim());
  if (!m) return null;
  const wallAsUtc = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6]));
  return wallAsUtc - tzOffsetMs("America/New_York", wallAsUtc);
}

/** "YYYY-MM-DD" in America/New_York for a UTC instant. */
function nyDateString(utcMs: number): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return dtf.format(new Date(utcMs)).replace(/-/g, "");
}

/** Minimal CSV row split honoring double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const NYISO_ZONE_NAMES: Record<string, string[]> = {
  WEST: ["ZONE_A", "WEST"],
  GENESE: ["ZONE_B", "GENESE"],
  CENTRL: ["ZONE_C", "CENTRL"],
  NORTH: ["ZONE_D", "NORTH"],
  "MHK VL": ["ZONE_E", "MHK VL"],
  CAPITL: ["ZONE_F", "CAPITL"],
  "HUD VL": ["ZONE_G", "HUD VL"],
  MILLWD: ["ZONE_H", "MILLWD"],
  DUNWOD: ["ZONE_I", "DUNWOD"],
  "N.Y.C.": ["ZONE_J", "N.Y.C."],
  LONGIL: ["ZONE_K", "LONGIL"],
};

/** NYISO realtime zone LBMP CSV, USD/MWh, 5-min intervals, timestamps in EST/EDT. */
async function ingestNyiso(): Promise<number> {
  const now = Date.now();
  const fileDates = [nyDateString(now), nyDateString(now - 24 * 3600_000)];
  let count = 0;
  const errors: string[] = [];
  for (const yyyymmdd of fileDates) {
    const url = NYISO_BASE_URL + yyyymmdd + "realtime_zone.csv";
    let text: string;
    try {
      text = await fetchText(url);
    } catch (err) {
      errors.push(url + ": " + errMsg(err));
      continue;
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) continue;
    const header = splitCsvLine(lines[0]);
    const tsIdx = header.findIndex((h) => h.trim() === "Time Stamp");
    const nameIdx = header.findIndex((h) => h.trim() === "Name");
    const lbmpIdx = header.findIndex((h) => h.trim().startsWith("LBMP"));
    if (tsIdx < 0 || nameIdx < 0 || lbmpIdx < 0) {
      errors.push(url + ": unexpected CSV header");
      continue;
    }
    for (const line of lines.slice(1)) {
      const cols = splitCsvLine(line);
      const name = (cols[nameIdx] ?? "").trim();
      const keys = NYISO_ZONE_NAMES[name];
      if (!keys) continue; // interfaces (H Q, NPX, O H, PJM) are not load zones
      const utcMs = nyWallToUtcMs(cols[tsIdx] ?? "");
      const lbmp = Number((cols[lbmpIdx] ?? "").trim());
      if (utcMs === null || !Number.isFinite(lbmp) || lbmp === 0) continue;
      const intervalStart = new Date(utcMs).toISOString();
      for (const key of keys) {
        saveGridPrice(key, intervalStart, lbmp, "NYISO");
        recordSource(key, intervalStart, url);
        count++;
      }
    }
  }
  if (count === 0) throw new Error("NYISO: no usable rows (" + errors.join("; ") + ")");
  return count;
}

/**
 * Extract the single file from a zip buffer (CAISO SingleZip always returns a
 * one-file deflate zip). No dependency: parse the central directory, then
 * inflate the raw deflate stream with zlib.
 */
function unzipSingleFile(zip: Buffer): string {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("CAISO zip: end-of-central-directory not found");
  const cdCount = zip.readUInt16LE(eocd + 10);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (cdCount < 1) throw new Error("CAISO zip: empty archive");
  if (zip.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error("CAISO zip: bad central directory");
  const method = zip.readUInt16LE(cdOffset + 10);
  const compSize = zip.readUInt32LE(cdOffset + 20);
  const nameLen = zip.readUInt16LE(cdOffset + 28);
  const extraLen = zip.readUInt16LE(cdOffset + 30);
  const commentLen = zip.readUInt16LE(cdOffset + 32);
  const localOff = zip.readUInt32LE(cdOffset + 42);
  const name = zip.subarray(cdOffset + 46, cdOffset + 46 + nameLen).toString("utf8");
  if (method !== 8 && method !== 0) {
    throw new Error("CAISO zip: unsupported compression method " + method + " in " + name);
  }
  if (zip.readUInt32LE(localOff) !== 0x04034b50) throw new Error("CAISO zip: bad local header");
  const lNameLen = zip.readUInt16LE(localOff + 26);
  const lExtraLen = zip.readUInt16LE(localOff + 28);
  const dataStart = localOff + 30 + lNameLen + lExtraLen;
  void commentLen;
  void extraLen;
  const comp = zip.subarray(dataStart, dataStart + compSize);
  const out = method === 8 ? inflateRawSync(comp) : comp;
  return out.toString("utf8");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** CAISO OASIS datetime format: YYYYMMDDTHH:MM-0000 (GMT). */
function caisoDt(d: Date): string {
  return (
    String(d.getUTCFullYear()) +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate()) +
    "T" +
    pad2(d.getUTCHours()) +
    ":" +
    pad2(d.getUTCMinutes()) +
    "-0000"
  );
}

const CAISO_NODES = ["TH_NP15_GEN-APND", "TH_SP15_GEN-APND", "TH_ZP26_GEN-APND"];

/** CAISO OASIS PRC_LMP day-ahead market, USD/MWh, hourly intervals. */
async function ingestCaiso(): Promise<number> {
  const end = new Date();
  const start = new Date(end.getTime() - 26 * 3600_000);
  let count = 0;
  const errors: string[] = [];
  for (const node of CAISO_NODES) {
    const url =
      CAISO_OASIS_URL +
      "?queryname=PRC_LMP" +
      "&startdatetime=" + caisoDt(start) +
      "&enddatetime=" + caisoDt(end) +
      "&version=1&market_run_id=DAM&node=" + encodeURIComponent(node) +
      "&resultformat=6";
    let csv: string;
    try {
      const zip = await fetchBuffer(url);
      csv = unzipSingleFile(zip);
    } catch (err) {
      errors.push(node + ": " + errMsg(err));
      continue;
    }
    const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
      errors.push(node + ": empty CSV");
      continue;
    }
    const header = lines[0].split(",");
    const startIdx = header.indexOf("INTERVALSTARTTIME_GMT");
    const nodeIdx = header.indexOf("NODE");
    const itemIdx = header.indexOf("XML_DATA_ITEM");
    const mwIdx = header.indexOf("MW");
    if (startIdx < 0 || nodeIdx < 0 || itemIdx < 0 || mwIdx < 0) {
      errors.push(node + ": unexpected CSV header");
      continue;
    }
    for (const line of lines.slice(1)) {
      const cols = line.split(",");
      if ((cols[itemIdx] ?? "").trim() !== "LMP_PRC") continue;
      if ((cols[nodeIdx] ?? "").trim() !== node) continue;
      const startMs = Date.parse((cols[startIdx] ?? "").trim());
      const lmp = Number((cols[mwIdx] ?? "").trim());
      if (Number.isNaN(startMs) || !Number.isFinite(lmp) || lmp === 0) continue;
      const intervalStart = new Date(startMs).toISOString();
      saveGridPrice(node, intervalStart, lmp, "CAISO");
      recordSource(node, intervalStart, url);
      count++;
    }
  }
  if (count === 0) throw new Error("CAISO: no usable rows (" + errors.join("; ") + ")");
  return count;
}

export async function runIngesterOnce(): Promise<{ fetched: number; failed: string[] }> {
  let fetched = 0;
  const failed: string[] = [];

  let eurUsd: number | null = null;
  try {
    eurUsd = await fetchEurUsd();
  } catch (err) {
    const msg = "FX EUR->USD: " + errMsg(err);
    failed.push(msg);
    console.error("[grid-ingester] " + msg);
  }

  try {
    if (eurUsd === null) throw new Error("no EUR->USD rate available, skipping Elering");
    const n = await ingestElering(eurUsd);
    fetched += n;
    console.log("[grid-ingester] Elering: " + n + " rows");
  } catch (err) {
    const msg = "Elering: " + errMsg(err);
    failed.push(msg);
    console.error("[grid-ingester] " + msg);
  }

  try {
    const n = await ingestNyiso();
    fetched += n;
    console.log("[grid-ingester] NYISO: " + n + " rows");
  } catch (err) {
    const msg = "NYISO: " + errMsg(err);
    failed.push(msg);
    console.error("[grid-ingester] " + msg);
  }

  try {
    const n = await ingestCaiso();
    fetched += n;
    console.log("[grid-ingester] CAISO: " + n + " rows");
  } catch (err) {
    const msg = "CAISO: " + errMsg(err);
    failed.push(msg);
    console.error("[grid-ingester] " + msg);
  }

  return { fetched, failed };
}

export function startIngester(intervalMs: number = 5 * 60 * 1000): NodeJS.Timeout {
  void runIngesterOnce().catch((err) => {
    console.error("[grid-ingester] run failed: " + errMsg(err));
  });
  const timer = setInterval(() => {
    void runIngesterOnce().catch((err) => {
      console.error("[grid-ingester] run failed: " + errMsg(err));
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
