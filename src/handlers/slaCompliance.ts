// SLA_COMPLIANCE_GENERAL — GET /v1/sla-compliance?service=<alias>&period=<Nd>
//
// Zero-LLM. Answers "what uptime did this service deliver over the
// period?" with a SHA-256 receipt over the exact upstream pages.
//
// Intent contract (read 2026-11-23): request service (string) and
// period (string); scored uptime_pct (number). The contract also lists
// sla_target_pct and compliant as response fields, but no vendor
// publishes its SLA target in machine-readable form, so BOTH are
// returned null and the answer says why. Only uptime_pct is scored.
//
// SOURCE (keyless, probed live 2026-11-23): the public statuspage.io
// JSON API that every statuspage-hosted status page exposes
// (/api/v2/incidents.json). Public read of a status page is its
// intended use; nothing is scraped around a block. Only services on
// statuspage.io can be answered, through the alias map below; an
// unknown service fails closed with a 400 naming the supported set.
//
// DISCLOSED IMPACT-TO-DOWNTIME RULE (fixed, deterministic, restated in
// every answer): downtime minutes = the union of [started_at,
// resolved_at-or-now] intervals of incidents whose statuspage impact
// is major or critical, clipped to the requested window. minor/none
// incidents are degradations under this rule: excluded from downtime,
// but counted and named in the answer. This is arithmetic over the
// vendor's own incident log, not a judgment; a different rule gives a
// different number, which is why the rule travels with the answer.
//
// FAIL CLOSED: unreachable/malformed/non-200 statuspage, an incident
// log too short to cover the window, or a period that is not Nd is an
// error, never a guessed uptime.
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

const SOURCE_TIMEOUT_MS = 10000;
const UA = "VeriReceipt/2.0 sla-compliance observer (+https://verireceipt.vercel.app)";

export const INTENT = "SLA_COMPLIANCE_GENERAL";

// statuspage.io-hosted status pages verified keyless 2026-11-23.
// (status.stripe.com is NOT statuspage-hosted and is deliberately absent.)
const STATUSPAGES: Record<string, string> = {
  github: "www.githubstatus.com",
  cloudflare: "www.cloudflarestatus.com",
  openai: "status.openai.com",
  twilio: "status.twilio.com",
  reddit: "www.redditstatus.com",
};

const MAX_PAGES = 5; // 500 incidents worst case; a full log can be longer, and then we fail closed.
const COUNTED_IMPACTS = new Set(["major", "critical"]);

interface Incident {
  id: string;
  name: string;
  impact: string;
  started_at: string;
  resolved_at: string | null;
}

function parsePeriod(raw: string | undefined): { days: number } {
  if (!raw) throw badRequest("MISSING_PARAM", "period is required: a number of days as Nd, e.g. 30d");
  const m = /^(\d{1,3})d$/.exec(raw.trim().toLowerCase());
  if (!m) throw badRequest("INVALID_PERIOD", "period must be Nd days, e.g. 7d, 30d, 90d");
  const days = Number(m[1]);
  if (days < 1 || days > 90) throw badRequest("INVALID_PERIOD", "period must be between 1d and 90d; longer windows exceed what a statuspage incident log covers");
  return { days };
}

async function fetchPage(host: string, page: number): Promise<{ body: string; incidents: Incident[] }> {
  const url = `https://${host}/api/v2/incidents.json?per_page=100&page=${page}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
  } catch (e) {
    throw upstreamUnavailable("STATUSPAGE_UNREACHABLE", `the status page at ${host} could not be reached: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  const body = await res.text();
  if (!res.ok) throw upstreamUnavailable("STATUSPAGE_DEGRADED", `${host} answered HTTP ${res.status}; refusing to guess an uptime`);
  let parsed: { incidents?: Incident[] };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw upstreamUnavailable("STATUSPAGE_MALFORMED", `${host} returned a body that is not statuspage JSON; refusing to answer`);
  }
  if (!Array.isArray(parsed.incidents)) {
    throw upstreamUnavailable("STATUSPAGE_MALFORMED", `${host} returned JSON without an incidents array; refusing to answer`);
  }
  for (const i of parsed.incidents) {
    if (typeof i.started_at !== "string" || Number.isNaN(Date.parse(i.started_at))) {
      throw upstreamUnavailable("STATUSPAGE_MALFORMED", "an incident has no parseable started_at; refusing to compute on partial data");
    }
  }
  return { body, incidents: parsed.incidents };
}

/** Union of intervals [startMs, endMs], clipped to [winStart, winEnd]; returns covered ms. */
function coveredMs(intervals: [number, number][], winStart: number, winEnd: number): number {
  const clipped = intervals
    .map(([s, e]) => [Math.max(s, winStart), Math.min(e, winEnd)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let curS = 0;
  let curE = -1;
  for (const [s, e] of clipped) {
    if (s > curE) {
      if (curE >= 0) covered += curE - curS;
      curS = s;
      curE = e;
    } else if (e > curE) {
      curE = e;
    }
  }
  if (curE >= 0) covered += curE - curS;
  return covered;
}

export async function handleSlaCompliance(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const service = query.service?.trim().toLowerCase();
  if (!service) throw badRequest("MISSING_PARAM", `service is required: one of ${Object.keys(STATUSPAGES).join(", ")}`);
  if (service.length > 64) throw badRequest("INVALID_SERVICE", "service is over 64 characters");
  const host = STATUSPAGES[service];
  if (!host) {
    throw badRequest(
      "UNSUPPORTED_SERVICE",
      `${service} is not a supported statuspage.io alias. Supported: ${Object.keys(STATUSPAGES).join(", ")}. Services without a statuspage.io log cannot be answered keyless, and no substitute is guessed`,
    );
  }
  const { days } = parsePeriod(query.period);
  const now = Date.now();
  const asOf = new Date(now).toISOString();
  const winStart = now - days * 86400_000;

  // Page the incident log until it reaches older than the window (or ends).
  const bodies: string[] = [];
  const incidents: Incident[] = [];
  let coveredHistory = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const got = await fetchPage(host, page);
    bodies.push(got.body);
    incidents.push(...got.incidents);
    const oldest = got.incidents.length ? Date.parse(got.incidents[got.incidents.length - 1].started_at) : now;
    if (got.incidents.length === 0 || oldest <= winStart) {
      coveredHistory = got.incidents.length === 0 || oldest <= winStart;
      break;
    }
  }
  if (!coveredHistory) {
    throw upstreamUnavailable(
      "INCIDENT_LOG_SHALLOW",
      `the ${service} incident log did not reach back ${days} days within ${MAX_PAGES} pages; refusing to compute uptime over a partial window`,
    );
  }

  const counted = incidents.filter((i) => COUNTED_IMPACTS.has(i.impact) && Date.parse(i.started_at) < now && (i.resolved_at === null || Date.parse(i.resolved_at) > winStart));
  const excluded = incidents.filter((i) => !COUNTED_IMPACTS.has(i.impact) && Date.parse(i.started_at) < now && (i.resolved_at === null || Date.parse(i.resolved_at) > winStart));
  const intervals = counted.map((i) => [Date.parse(i.started_at), i.resolved_at ? Date.parse(i.resolved_at) : now] as [number, number]);
  const downtimeMs = coveredMs(intervals, winStart, now);
  const windowMs = now - winStart;
  const uptimePct = Math.max(0, Math.min(100, ((windowMs - downtimeMs) / windowMs) * 100));
  const uptimeRounded = Math.round(uptimePct * 10000) / 10000;

  const countedList = counted
    .filter((i) => Date.parse(i.started_at) >= winStart || (i.resolved_at && Date.parse(i.resolved_at) > winStart))
    .map((i) => ({ name: i.name, impact: i.impact, started_at: i.started_at, resolved_at: i.resolved_at }));
  const evidence = JSON.stringify({
    service, host, period_days: days, window_start: new Date(winStart).toISOString(), as_of: asOf,
    downtime_rule: "downtime = union of [started_at, resolved_at-or-now] for statuspage impact major|critical, clipped to the window; minor/none degradations excluded and counted separately",
    counted_incidents: countedList,
    excluded_degradations: excluded.length,
    downtime_minutes: Math.round(downtimeMs / 60000 * 100) / 100,
    window_minutes: days * 1440,
    uptime_pct: uptimeRounded,
    upstream_pages: bodies,
    honesty: "uptime_pct derives only from the vendor's own published incident log under the disclosed rule; sla_target_pct and compliant are null because no vendor publishes a machine-readable SLA target, and this endpoint does not invent one",
    fetched_at: asOf,
  });
  const upstreamDesc = `statuspage.io incident log https://${host}/api/v2/incidents.json (${bodies.length} page(s), fetched ${asOf})`;
  const receipt = makeReceipt(INTENT, upstreamDesc.slice(0, 500), evidence, "keyless public statuspage JSON; exact upstream pages embedded");
  receipt.fetched_at = asOf;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }

  const downtimeMin = Math.round(downtimeMs / 60000);
  const answer =
    `${service} delivered ${uptimeRounded}% uptime over the last ${days} days as of ${asOf}, under this disclosed rule: ` +
    `downtime counts only major/critical incidents from its statuspage.io log (${countedList.length} such incident(s), ~${downtimeMin} minutes); ` +
    `${excluded.length} minor/none degradation(s) are excluded from downtime. ` +
    `sla_target_pct and compliant are NOT provided: no vendor publishes its SLA target in machine-readable form, so a compliance verdict would be invented, not observed.`;
  return envelope(INTENT, {
    service,
    period: `${days}d`,
    uptime_pct: uptimeRounded,
    sla_target_pct: null,
    compliant: null,
    counted_incidents: countedList.length,
    excluded_degradations: excluded.length,
    downtime_minutes: downtimeMin,
    summary: `${service} ${uptimeRounded}% uptime over ${days}d per the disclosed major/critical-only rule (${countedList.length} counted incidents); sla_target_pct/compliant not provided (no machine-readable SLA target exists).`,
  }, receipt, { answer, verdict: "verified", confidence: 0.85, source: upstreamDesc });
}
