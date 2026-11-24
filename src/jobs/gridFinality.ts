// Grid price finality / cache-settlement policy (A9 r2).
//
// This module is imported by the ingester and the handler. It must NOT
// import those files (or src/core/db) — keep the dependency arrow one way.
//
// Sources (read for this revision, 2026-11-21):
//
// CAISO Fifth Replacement FERC Electric Tariff, Section 35, as of
// May 1, 2026 (official tariff PDF):
//   §35.2 Timing of the Price Correction Process:
//     "All prices for each Trading Day shall become subject to the
//     CAISO’s price correction process once the CAISO publishes them
//     on its OASIS … For Day-Ahead Market prices, the price correction
//     process for each Trading Day shall end no later than the end of
//     the third Business Day following the Trading Day to which the
//     Day-Ahead Market applies. For the Real-Time Market prices, …
//     the fifth Business Day following that Trading Day. After these
//     timelines have elapsed, the posted prices are final and used for
//     Settlement purposes unless the CAISO must modify published
//     prices for the reasons specified in Section 35.3."
//   §35.3: "All prices are provisional until the CAISO has completed
//     the price correction process … within the timeframe specified in
//     Section 35.2." After that, CAISO will not modify prices except:
//       §35.3.1 FERC orders (no deadline in the tariff — not tracked
//         here; exceptional legal direction).
//       §35.3.2 processing/publication issues, and only when CAISO
//         identified and logged the need for a correction inside the
//         §35.2 window: 30 Business Days of the Trading Day for
//         isolated EDAM/EIM Entity BAA cases, otherwise 20 Business
//         Days.
//
// CAISO "Business Day" (capitalised — the term §35 uses) is Appendix A
// of the same tariff: "Monday through Friday, excluding federal
// holidays and the day after Thanksgiving Day." Confirmed in the
// ER21-2854 transmittal (8 Sep 2021) and the current Appendix A
// language. This is stricter than the lowercase "business day" used
// in some §11.29 settlement deadlines (BPM for Settlements & Billing
// v30, 26 Jun 2026), where Juneteenth, Columbus Day, and Veterans Day
// remain CAISO operating days. Using the Appendix A definition for
// §35 is both the literal reading and the conservative one (those
// three federal holidays do not count, so the 3rd Business Day can
// fall later).
//
// U.S. federal holidays: 5 U.S.C. §6103. Inauguration Day is
// DC-only and is not applied. Weekend observances follow the standard
// federal rule (Saturday → Friday, Sunday → Monday). A Saturday
// New Year's Day is observed on Friday 31 December of the previous
// calendar year (e.g. 1 Jan 2028 → 31 Dec 2027); that Friday is
// attributed to both years' calendars so a Trading Day in late
// December counts it correctly.
//
// NYISO MST Attachment E §20.3 (effective 30 May 2018, FERC
// ER18-1261-000; language confirmed in the e-tariff text and the
// 2018 redline): the ISO shall correct a timely reserved real-time
// price "not later than … four business days after the operating day
// for which the correction applies". Day-Ahead is two business days
// (this miner ingests NYISO realtime LBMPs only). "Erroneous prices
// not reserved and corrected within these timeframes shall not be
// corrected by the ISO except as directed by the Commission or a
// court of competent jurisdiction." NYISO training (Price Validation,
// Sep 2026) shows the RT deadline as 23:59 of the 4th business day.
// The calendar used here is weekdays excluding U.S. federal holidays
// and the day after Thanksgiving (NYISO's published calendar lists
// Thanksgiving + the Friday after, and Christmas closures; using the
// federal set plus that Friday is conservative). Time zone:
// America/New_York.
//
// Elering does not set prices (Elering FAQ); Estonian/Baltic
// day-ahead and the 15-minute series on the dashboard API come from
// Nord Pool. SDAC area prices are unconfirmed until TSO validation,
// normally ~12:57 CET on the trading day (Nord Pool "Methodology for
// calculating Nordic System Price", effective 30 Sep 2025, §3.1).
// There is no CAISO-style hard Business-Day cap: the same methodology
// (§4.3) leaves post-publication corrections to the Nord Pool EMCO
// CEO. A live example: system prices for delivery 22–24 Oct 2026 were
// corrected and republished on 25 Oct 2026 (Nord Pool operational
// message, 25 Oct 2026 12:11). Conservative rule: treat the price as
// provisional until the end of the 3rd Estonian business day after
// the delivery day (Europe/Tallinn; holidays from the Estonian Public
// Holidays and Days of National Importance Act — official English
// translation, Riigi Teataja, in force from 30.12.2022
// (https://www.riigiteataja.ee/en/akt/527122022003) — §1 (24 Feb)
// and §2 (1 Jan; Good Friday; Easter Sunday; 1 May; Pentecost;
// 23 Jun; 24 Jun; 20 Aug; 24–26 Dec). Days of national importance
// in §3 are not days of rest. Easter Monday is not in the Act and
// is not treated as a holiday here), then keep the cache. The
// dashboard API is a short rolling window (~38–39 15-minute rows,
// ~9–10 hours, documented in gridIngester.ts), so a historical
// re-fetch is not feasible after that window — request-path
// revalidation is CAISO (OASIS historical DAM) and NYISO (dated
// realtime_zone CSVs). Elering historical rows are retained, not
// re-queried; a post-close Elering serve without a post-close
// write is labelled honestly (not verified / 1.0).
//
// Policy, once the market is known:
//   provisional — normal 1-hour TTL + live refresh (CAISO) or 502
//     GRID_CACHE_STALE (cache-only markets). A stale provisional row
//     is never pinned.
//   correction  — the §35.2 / NYISO §20.3 / Elering 3-BD window has
//     closed. The row is kept (no TTL eviction). CAISO and NYISO
//     revalidate at least once after the close (J2 m1 / r3) and
//     CAISO also periodically until the conservative correction-
//     window end (CAISO: 30 Business Days after the Trading Day,
//     the §35.3.2 isolated-BAA cap; NYISO: no extra window beyond
//     the 4 BD, only FERC/court, so periodic checks do not run;
//     Elering: 10 calendar days after the delivery day, covering
//     the observed Oct 2026 1–3 day correction — no live historical
//     path).
//   final — past the correction window. The row is kept with no
//     eviction. If it has never been revalidated after the
//     provisional close, one attempt is still required on a live
//     path (J2 m1). Failed revalidation does not evict or 502 a
//     valid settled row, but it is not labelled verified / 1.0.
//
// The A9 r1 "interval_end + 2 hours, then immutable" rule, and the
// comment that "CAISO DAM [is] immutable once the hour has closed",
// are withdrawn: they do not match §35.2 / §35.3.

export type GridMarketKind = "CAISO" | "NYISO" | "ELERING" | "MISO" | "ERCOT";
export type GridFinalityPhase = "provisional" | "correction" | "final";

export interface Ymd {
  y: number;
  m: number;
  d: number;
}

/** Official GRID intent / conformance reference hour (miner.yaml + A8/A9). */
export const GRID_REFERENCE_INTERVAL = "2026-09-13T14:00:00.000Z";

export const GRID_REFERENCE_CAISO_NODES: readonly string[] = [
  "TH_NP15_GEN-APND",
  "TH_SP15_GEN-APND",
  "TH_ZP26_GEN-APND",
];

/**
 * Hard cap on grid_cache rows (J2 m3 / r3). Eviction order when the
 * table is over the cap: (1) unparseable / non-canonical interval
 * keys, (2) unprotected historical rows (past the correction
 * window), (3) oldest rows still inside a correction window, (4)
 * oldest still-provisional rows. Official GRID reference keys
 * (TH_*_GEN-APND @ 2026-09-13T14:00:00.000Z) are never evicted.
 * Invalid interval keys are never written by saveGridPrice /
 * saveGridPriceBatch; any legacy ones are always evictable.
 */
export const GRID_CACHE_MAX_ROWS = 25_000;

/** Eviction rank used by purgeGridCacheOverflow; higher ranks evict later. */
export const GRID_EVICT_INVALID = 0;
export const GRID_EVICT_FINAL = 1;
export const GRID_EVICT_CORRECTION = 2;
export const GRID_EVICT_PROVISIONAL = 3;
export const GRID_EVICT_REFERENCE = 100;

/** Minimum gap between failed *post-close* revalidation attempts. */
export const GRID_REVALIDATE_COOLDOWN_MS = 60 * 60 * 1000;

/** Periodic revalidation while a CAISO hour is inside the §35.3.2 window. */
export const GRID_REVALIDATE_PERIOD_MS = 12 * 60 * 60 * 1000;

export const CAISO_TIME_ZONE = "America/Los_Angeles";
export const NYISO_TIME_ZONE = "America/New_York";
export const ELERING_TIME_ZONE = "Europe/Tallinn";
// MISO labels its files in EST — fixed UTC-5 year-round, no DST
// (MISO tariff uses Eastern Standard Time for market data even when
// local time is EDT; the IANA "EST" zone is exactly that fixed
// offset).
export const MISO_TIME_ZONE = "EST";
// MISO freshness-retention rule (NOT a tariff citation): the
// day-ahead ExPost file for a delivery day is the operator's
// post-market publication; rows are treated as settled one weekday
// after the delivery day (a plain Mon-Fri rule — no MISO holiday
// calendar is claimed), after which cache age alone is not a reason
// to re-query. There is no separate correction window.
export const MISO_DA_PROVISIONAL_BUSINESS_DAYS = 1;
// ERCOT labels its cdr pages in CPT — Central Prevailing Time, the
// DST-aware America/Chicago zone (CST in winter, CDT in summer).
export const ERCOT_TIME_ZONE = "America/Chicago";
// ERCOT freshness-retention rule (NOT a tariff citation): the dated
// DAM SPP page for a delivery day is the operator's post-market
// publication; rows are treated as settled one weekday after the
// delivery day (a plain Mon-Fri rule — no ERCOT holiday calendar is
// claimed), after which cache age alone is not a reason to re-query.
// There is no separate correction window.
export const ERCOT_DA_PROVISIONAL_BUSINESS_DAYS = 1;

/** DAM §35.2: end of the 3rd Business Day following the Trading Day. */
export const CAISO_DAM_PROVISIONAL_BUSINESS_DAYS = 3;
/**
 * Conservative §35.3.2 cap (isolated EDAM/EIM Entity BAA). The general
 * case is 20 Business Days; we wait the longer 30 so a 20-day
 * publication-issue correction is not frozen early.
 */
export const CAISO_CORRECTION_BUSINESS_DAYS = 30;
/** NYISO MST Att. E §20.3 realtime. */
export const NYISO_RT_PROVISIONAL_BUSINESS_DAYS = 4;
/** Elering / Nord Pool: conservative 3 Estonian business days. */
export const ELERING_PROVISIONAL_BUSINESS_DAYS = 3;
/** Elering / Nord Pool: 10 calendar days after the delivery day. */
export const ELERING_CORRECTION_CALENDAR_DAYS = 10;

export function gridMarketKind(
  market?: string | null,
  windowMin?: number,
): GridMarketKind | null {
  const m = (market ?? "").trim().toUpperCase();
  if (m === "CAISO" || m.startsWith("CAISO ")) return "CAISO";
  if (m === "NYISO") return "NYISO";
  if (m.startsWith("ELERING")) return "ELERING";
  if (m === "MISO" || m.startsWith("MISO ")) return "MISO";
  if (m === "ERCOT" || m.startsWith("ERCOT ")) return "ERCOT";
  if (windowMin === 60) return "CAISO";
  if (windowMin === 5) return "NYISO";
  if (windowMin === 15) return "ELERING";
  return null;
}

export function canonicalizeIntervalIso(intervalStartIso: string): string | null {
  const ms = Date.parse(intervalStartIso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Interval keys that writers may store. Must be ISO-8601 UTC
 * (trailing Z or ±00:00) and must not roll over (2026-02-30 is
 * refused). Loose Date.parse shapes ("foo-0", "invalid_0") and
 * NaN keys are never stored and are always evictable.
 */
const STOREABLE_INTERVAL_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]00:00)$/;

export function isStoreableGridIntervalKey(intervalStart: string): boolean {
  if (typeof intervalStart !== "string" || !STOREABLE_INTERVAL_RE.test(intervalStart)) {
    return false;
  }
  const ms = Date.parse(intervalStart);
  if (Number.isNaN(ms)) return false;
  const y = Number(intervalStart.slice(0, 4));
  const mo = Number(intervalStart.slice(5, 7));
  const d = Number(intervalStart.slice(8, 10));
  const h = Number(intervalStart.slice(11, 13));
  const mi = Number(intervalStart.slice(14, 16));
  const s = Number(intervalStart.slice(17, 19));
  const dt = new Date(ms);
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() + 1 === mo &&
    dt.getUTCDate() === d &&
    dt.getUTCHours() === h &&
    dt.getUTCMinutes() === mi &&
    dt.getUTCSeconds() === s
  );
}

export function isConfiguredGridReference(nodeOrZone: string, intervalStartIso: string): boolean {
  const iso = canonicalizeIntervalIso(intervalStartIso);
  if (!iso || iso !== GRID_REFERENCE_INTERVAL) return false;
  return (GRID_REFERENCE_CAISO_NODES as readonly string[]).includes(nodeOrZone);
}

export function addCalendarDays(ymd: Ymd, days: number): Ymd {
  const utc = Date.UTC(ymd.y, ymd.m - 1, ymd.d + days);
  const dt = new Date(utc);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function ymdKey(ymd: Ymd): string {
  return (
    String(ymd.y) +
    "-" +
    String(ymd.m).padStart(2, "0") +
    "-" +
    String(ymd.d).padStart(2, "0")
  );
}

function weekdayUtc(ymd: Ymd): number {
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay();
}

/** Western Easter Sunday (Anonymous Gregorian computus). */
export function easterSunday(year: number): Ymd {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { y: year, m: month, d: day };
}

function observedFixedHoliday(year: number, month: number, day: number): Ymd {
  const ymd = { y: year, m: month, d: day };
  const dow = weekdayUtc(ymd);
  if (dow === 6) return addCalendarDays(ymd, -1); // Saturday → Friday
  if (dow === 0) return addCalendarDays(ymd, 1); // Sunday → Monday
  return ymd;
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Ymd {
  const first = { y: year, m: month, d: 1 };
  const delta = (weekday - weekdayUtc(first) + 7) % 7;
  return addCalendarDays(first, delta + (n - 1) * 7);
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): Ymd {
  const firstNext = month === 12 ? { y: year + 1, m: 1, d: 1 } : { y: year, m: month + 1, d: 1 };
  const last = addCalendarDays(firstNext, -1);
  const delta = (weekdayUtc(last) - weekday + 7) % 7;
  return addCalendarDays(last, -delta);
}

/**
 * U.S. federal holidays observed on a calendar, plus the day after
 * Thanksgiving (CAISO Appendix A; also a typical NYISO closure).
 */
export function isUsFederalOrDayAfterThanksgiving(ymd: Ymd): boolean {
  const { y, m, d } = ymd;
  const key = ymdKey(ymd);
  if (key === ymdKey(observedFixedHoliday(y, 1, 1))) return true; // New Year's
  // Saturday 1 January is observed on Friday 31 December of the
  // previous year (5 U.S.C. §6103). Check next year's New Year's so
  // that Friday is a holiday in *this* year's calendar too.
  if (key === ymdKey(observedFixedHoliday(y + 1, 1, 1))) return true;
  if (key === ymdKey(nthWeekdayOfMonth(y, 1, 1, 3))) return true; // MLK (3rd Mon Jan)
  if (key === ymdKey(nthWeekdayOfMonth(y, 2, 1, 3))) return true; // Presidents (3rd Mon Feb)
  if (key === ymdKey(lastWeekdayOfMonth(y, 5, 1))) return true; // Memorial (last Mon May)
  if (key === ymdKey(observedFixedHoliday(y, 6, 19))) return true; // Juneteenth
  if (key === ymdKey(observedFixedHoliday(y, 7, 4))) return true; // Independence
  if (key === ymdKey(nthWeekdayOfMonth(y, 9, 1, 1))) return true; // Labor (1st Mon Sep)
  if (key === ymdKey(nthWeekdayOfMonth(y, 10, 1, 2))) return true; // Columbus (2nd Mon Oct)
  if (key === ymdKey(observedFixedHoliday(y, 11, 11))) return true; // Veterans
  const thanksgiving = nthWeekdayOfMonth(y, 11, 4, 4); // 4th Thu Nov
  if (key === ymdKey(thanksgiving)) return true;
  if (key === ymdKey(addCalendarDays(thanksgiving, 1))) return true; // day after
  if (key === ymdKey(observedFixedHoliday(y, 12, 25))) return true; // Christmas
  void d;
  void m;
  return false;
}

/** Estonian public holidays (riigipühad), including movable church days. */
export function isEstonianPublicHoliday(ymd: Ymd): boolean {
  const { y } = ymd;
  const key = ymdKey(ymd);
  if (key === ymdKey({ y, m: 1, d: 1 })) return true;
  if (key === ymdKey({ y, m: 2, d: 24 })) return true;
  const easter = easterSunday(y);
  if (key === ymdKey(addCalendarDays(easter, -2))) return true; // Good Friday
  if (key === ymdKey(easter)) return true; // Easter Sunday (Act §2)
  // Easter Monday is not a public holiday under the Public Holidays
  // and Days of National Importance Act §2 (Good Friday, Easter
  // Sunday, and Pentecost are; Easter Monday is not listed).
  if (key === ymdKey({ y, m: 5, d: 1 })) return true; // Spring Day
  if (key === ymdKey(addCalendarDays(easter, 49))) return true; // Pentecost
  if (key === ymdKey({ y, m: 6, d: 23 })) return true; // Victory Day
  if (key === ymdKey({ y, m: 6, d: 24 })) return true; // Midsummer
  if (key === ymdKey({ y, m: 8, d: 20 })) return true; // Restoration of Independence
  if (key === ymdKey({ y, m: 12, d: 24 })) return true;
  if (key === ymdKey({ y, m: 12, d: 25 })) return true;
  if (key === ymdKey({ y, m: 12, d: 26 })) return true;
  return false;
}

export function isCaisoBusinessDay(ymd: Ymd): boolean {
  const dow = weekdayUtc(ymd);
  if (dow === 0 || dow === 6) return false;
  return !isUsFederalOrDayAfterThanksgiving(ymd);
}

export function isNyisoBusinessDay(ymd: Ymd): boolean {
  return isCaisoBusinessDay(ymd);
}

export function isEleringBusinessDay(ymd: Ymd): boolean {
  const dow = weekdayUtc(ymd);
  if (dow === 0 || dow === 6) return false;
  return !isEstonianPublicHoliday(ymd);
}

export function nthFollowingBusinessDay(
  start: Ymd,
  n: number,
  isBusinessDay: (ymd: Ymd) => boolean,
): Ymd | null {
  if (!Number.isInteger(n) || n <= 0) return null;
  let cur = start;
  let counted = 0;
  // Hard stop: ~2 years of calendar walk is far beyond 30 business days.
  for (let i = 0; i < 800 && counted < n; i++) {
    cur = addCalendarDays(cur, 1);
    if (isBusinessDay(cur)) counted++;
  }
  return counted === n ? cur : null;
}

// Intl construction is expensive. The fixed market zones reuse stateless formatters.
// Bound other callers too so arbitrary zone names cannot grow retained state.
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
function zonedParts(utcMs: number, timeZone: string): { ymd: Ymd; h: number; min: number; s: number } {
  let fmt = zoneFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    if (zoneFormatters.size >= 8) zoneFormatters.delete(zoneFormatters.keys().next().value!);
    zoneFormatters.set(timeZone, fmt);
  }
  const bag: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") bag[p.type] = p.value;
  }
  return {
    ymd: { y: Number(bag.year), m: Number(bag.month), d: Number(bag.day) },
    h: Number(bag.hour),
    min: Number(bag.minute),
    s: Number(bag.second),
  };
}

/**
 * UTC instant of local midnight (00:00:00.000) of y-m-d in `timeZone`.
 * Iterates the UTC↔offset relation so DST transitions are exact.
 */
export function zonedMidnightUtc(ymd: Ymd, timeZone: string): number {
  const asUtc = Date.UTC(ymd.y, ymd.m - 1, ymd.d);
  let t = asUtc;
  for (let i = 0; i < 4; i++) {
    const parts = zonedParts(t, timeZone);
    const localAsUtc = Date.UTC(parts.ymd.y, parts.ymd.m - 1, parts.ymd.d, parts.h, parts.min, parts.s);
    const offset = localAsUtc - t;
    t = asUtc - offset;
  }
  return t;
}

/** Calendar date of `intervalStartMs` in the market's local time zone. */
export function tradingDayYmd(intervalStartMs: number, timeZone: string): Ymd | null {
  if (!Number.isFinite(intervalStartMs)) return null;
  return zonedParts(intervalStartMs, timeZone).ymd;
}

/** End of calendar day `ymd` in TZ = local midnight of the next calendar day. */
export function endOfZonedDayUtc(ymd: Ymd, timeZone: string): number {
  return zonedMidnightUtc(addCalendarDays(ymd, 1), timeZone);
}

function businessDayFn(kind: GridMarketKind): (ymd: Ymd) => boolean {
  if (kind === "CAISO") return isCaisoBusinessDay;
  if (kind === "NYISO") return isNyisoBusinessDay;
  if (kind === "MISO") return isWeekdayBusinessDay;
  // Plain Mon-Fri rule (ERCOT retention rule — no holiday calendar claimed).
  if (kind === "ERCOT") return isWeekdayBusinessDay;
  return isEleringBusinessDay;
}

/** Plain Mon-Fri rule (MISO retention rule — no holiday calendar claimed). */
function isWeekdayBusinessDay(ymd: Ymd): boolean {
  const dow = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay();
  return dow >= 1 && dow <= 5;
}

function timeZoneOf(kind: GridMarketKind): string {
  if (kind === "CAISO") return CAISO_TIME_ZONE;
  if (kind === "NYISO") return NYISO_TIME_ZONE;
  if (kind === "MISO") return MISO_TIME_ZONE;
  if (kind === "ERCOT") return ERCOT_TIME_ZONE;
  return ELERING_TIME_ZONE;
}

function provisionalBusinessDays(kind: GridMarketKind): number {
  if (kind === "CAISO") return CAISO_DAM_PROVISIONAL_BUSINESS_DAYS;
  if (kind === "NYISO") return NYISO_RT_PROVISIONAL_BUSINESS_DAYS;
  if (kind === "MISO") return MISO_DA_PROVISIONAL_BUSINESS_DAYS;
  if (kind === "ERCOT") return ERCOT_DA_PROVISIONAL_BUSINESS_DAYS;
  return ELERING_PROVISIONAL_BUSINESS_DAYS;
}

/**
 * Instant at which the provisional window closes (inclusive start of
 * "settled"): now >= this instant means §35.2 / §20.3 / Elering 3-BD
 * has elapsed. Fail-closed: null if the inputs are unusable.
 */
export function provisionalCloseMs(kind: GridMarketKind, intervalStartMs: number): number | null {
  const tz = timeZoneOf(kind);
  const trading = tradingDayYmd(intervalStartMs, tz);
  if (!trading) return null;
  const nth = nthFollowingBusinessDay(trading, provisionalBusinessDays(kind), businessDayFn(kind));
  if (!nth) return null;
  return endOfZonedDayUtc(nth, tz);
}

/**
 * Instant at which the conservative correction window closes. For
 * NYISO this equals the provisional close (no extra MST window).
 * For Elering, 10 calendar days after the delivery day (end of that
 * local day). For CAISO, end of the 30th Business Day after the
 * Trading Day.
 */
export function correctionCloseMs(kind: GridMarketKind, intervalStartMs: number): number | null {
  const tz = timeZoneOf(kind);
  const trading = tradingDayYmd(intervalStartMs, tz);
  if (!trading) return null;
  if (kind === "NYISO") return provisionalCloseMs(kind, intervalStartMs);
  // ERCOT: like MISO, no separate correction window — close equals the
  // provisional close.
  if (kind === "ERCOT") return provisionalCloseMs(kind, intervalStartMs);
  // MISO: no separate correction window — close equals the
  // provisional close (same shape as NYISO).
  if (kind === "MISO") return provisionalCloseMs(kind, intervalStartMs);
  if (kind === "ELERING") {
    const endDay = addCalendarDays(trading, ELERING_CORRECTION_CALENDAR_DAYS);
    return endOfZonedDayUtc(endDay, tz);
  }
  const nth = nthFollowingBusinessDay(trading, CAISO_CORRECTION_BUSINESS_DAYS, isCaisoBusinessDay);
  if (!nth) return null;
  return endOfZonedDayUtc(nth, tz);
}

export function gridFinalityPhase(
  kind: GridMarketKind,
  intervalStartMs: number,
  nowMs: number,
): GridFinalityPhase | null {
  const prov = provisionalCloseMs(kind, intervalStartMs);
  if (prov === null) return null;
  if (nowMs < prov) return "provisional";
  const corr = correctionCloseMs(kind, intervalStartMs);
  if (corr === null) return null;
  if (nowMs < corr) return "correction";
  return "final";
}

/**
 * True when the official provisional window has closed. A valid cache
 * row for such an interval is not evicted by the 1-hour TTL. This is
 * NOT "the price can never change": CAISO §35.3.2 still allows
 * logged corrections for 20/30 Business Days, which is why the
 * handler revalidates after this instant (see needsGridRevalidation).
 */
export function isPastProvisionalWindow(
  kind: GridMarketKind,
  intervalStartMs: number,
  nowMs: number,
): boolean {
  const close = provisionalCloseMs(kind, intervalStartMs);
  if (close === null) return false;
  return nowMs >= close;
}

/**
 * Whether a still-correctable (or still-provisional) interval should
 * be protected from cache eviction, in addition to configured
 * references.
 */
export function isEvictionProtectedInterval(
  kind: GridMarketKind | null,
  intervalStartIso: string,
  nowMs: number,
): boolean {
  if (isConfiguredGridReference("", intervalStartIso)) {
    // node checked separately — interval alone is the official hour.
    const iso = canonicalizeIntervalIso(intervalStartIso);
    if (iso === GRID_REFERENCE_INTERVAL) {
      // Protected only together with a reference node; this helper is
      // interval-only for the correction window. Fall through.
    }
  }
  if (!kind) return false;
  const startMs = Date.parse(intervalStartIso);
  // Unparseable / non-canonical keys are always evictable (r3): they
  // must never pin the table over the cap.
  if (Number.isNaN(startMs) || !isStoreableGridIntervalKey(intervalStartIso)) return false;
  const corr = correctionCloseMs(kind, startMs);
  if (corr === null) return false;
  return nowMs < corr;
}

/**
 * Eviction rank for one cache row. Official reference keys return
 * GRID_EVICT_REFERENCE and must never be deleted. Invalid keys
 * return GRID_EVICT_INVALID and are evicted first.
 */
export function gridCacheEvictionPriority(
  nodeOrZone: string,
  intervalStartIso: string,
  market: string | null | undefined,
  nowMs: number,
): number {
  if (isConfiguredGridReference(nodeOrZone, intervalStartIso)) return GRID_EVICT_REFERENCE;
  if (!isStoreableGridIntervalKey(intervalStartIso)) return GRID_EVICT_INVALID;
  const startMs = Date.parse(intervalStartIso);
  if (Number.isNaN(startMs)) return GRID_EVICT_INVALID;
  const kind = gridMarketKind(market);
  if (!kind) return GRID_EVICT_FINAL;
  const phase = gridFinalityPhase(kind, startMs, nowMs);
  if (phase === "provisional") return GRID_EVICT_PROVISIONAL;
  if (phase === "correction") return GRID_EVICT_CORRECTION;
  return GRID_EVICT_FINAL;
}

export function isEvictionProtectedRow(
  nodeOrZone: string,
  intervalStartIso: string,
  market: string | null | undefined,
  nowMs: number,
): boolean {
  if (isConfiguredGridReference(nodeOrZone, intervalStartIso)) return true;
  const kind = gridMarketKind(market);
  return isEvictionProtectedInterval(kind, intervalStartIso, nowMs);
}

function parseTs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Pure revalidation predicate (J2 m1 + periodic §35.3.2 checks).
 * `lastSuccessAt` defaults to ingested_at. A success (or ingest)
 * recorded at or after the provisional close already counts as the
 * required post-provisional revalidation.
 *
 * The first request after provisional close MUST revalidate when no
 * successful fetch happened at or after close, regardless of the
 * 1-hour cooldown (r3 / J2 MAJOR). The cooldown applies only to
 * failed revalidation attempts made at or after close, so a write
 * in the last hour of the provisional window cannot skip the
 * mandatory check. Periodic §35.3.2 checks (correction phase only)
 * still honour the cooldown after a recent success or a failed
 * post-close attempt.
 */
export function needsGridRevalidation(args: {
  kind: GridMarketKind;
  intervalStartMs: number;
  nowMs: number;
  ingestedAt: string;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
}): boolean {
  const phase = gridFinalityPhase(args.kind, args.intervalStartMs, args.nowMs);
  if (phase === null || phase === "provisional") return false;
  const close = provisionalCloseMs(args.kind, args.intervalStartMs);
  if (close === null) return false;
  const lastSuccess = parseTs(args.lastSuccessAt) ?? parseTs(args.ingestedAt);
  if (lastSuccess === null) return true;
  const failedAttemptMs = parseTs(args.lastAttemptAt);
  const failedAttemptAfterClose =
    failedAttemptMs !== null && failedAttemptMs >= close ? failedAttemptMs : null;
  const inFailedCooldown =
    failedAttemptAfterClose !== null &&
    args.nowMs - failedAttemptAfterClose < GRID_REVALIDATE_COOLDOWN_MS;

  // Mandatory: at least one successful fetch at or after close.
  // A pre-close success (even seconds before close) does not count,
  // and does not start the cooldown.
  if (lastSuccess < close && args.nowMs >= close) {
    if (inFailedCooldown) return false;
    return true;
  }

  // Periodic checks only while a later official correction is still
  // possible. NYISO's correctionClose == provisionalClose, so this
  // branch does not run after the 4-BD deadline.
  if (phase === "correction" && args.nowMs - lastSuccess >= GRID_REVALIDATE_PERIOD_MS) {
    if (inFailedCooldown) return false;
    const lastAttemptOrSuccess = failedAttemptMs ?? lastSuccess;
    if (args.nowMs - lastAttemptOrSuccess < GRID_REVALIDATE_COOLDOWN_MS) return false;
    return true;
  }
  return false;
}
