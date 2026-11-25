import {withAnswerClass,answerDiagnostics} from '../core/answerClass';
// SLA_COMPLIANCE_GENERAL — GET /v1/sla-compliance?service=<alias>&period=<Nd>
//
// Zero-LLM. Answers "what uptime did this service deliver over the
// period?" with a SHA-256 receipt over the exact upstream pages.
//
// Intent contract (read 2026-11-23): request service (string) and
// period (string); scored uptime_pct (number). The contract also lists
// sla_target_pct and compliant as response fields, but this endpoint
// has not established a machine-readable SLA target, so BOTH are
// returned null and the answer says why. Only uptime_pct is scored.
//
// SOURCE (keyless, probed live 2026-11-23): the public statuspage.io
// JSON API exposed by the verified status pages below
// (/api/v2/incidents.json). Public read of a status page is its
// intended use; nothing is scraped around a block. Only services on
// statuspage.io can be answered, through the alias map below; an
// unknown service returns not_found with null observation fields.
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
// log too short to cover a resolved rolling window is an error. An
// unsupported period returns disclosed unknown nulls, never guessed uptime.
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

import {readSlaBody} from './slaSourceCache';

const SOURCE_TIMEOUT_MS = 10000;
const UA = "VeriReceipt/2.0 sla-compliance observer (+https://verireceipt.vercel.app)";

export const INTENT = "SLA_COMPLIANCE_GENERAL";

// statuspage.io-hosted status pages verified keyless 2026-11-23.
// (status.stripe.com is NOT statuspage-hosted and is deliberately absent.)
export const STATUSPAGES: Readonly<Record<string, string>> = Object.freeze({
  github: "www.githubstatus.com",
  cloudflare: "www.cloudflarestatus.com",
  openai: "status.openai.com",
  twilio: "status.twilio.com",
  reddit: "www.redditstatus.com",
  atlassian: "status.atlassian.com",
  digitalocean: "status.digitalocean.com",
  vercel:"www.vercel-status.com",netlify:"www.netlifystatus.com",discord:"discordstatus.com",
  dropbox:"status.dropbox.com",npm:"status.npmjs.org",figma:"status.figma.com",
  coinbase:"status.coinbase.com",shopify:"www.shopifystatus.com",sentry:"status.sentry.io",
  mongodb:"status.mongodb.com",circleci:"status.circleci.com",snowflake:"status.snowflake.com",
});
export function resolveSlaHost(input:string):string|null{
 const service=input.trim().toLowerCase().replace(/\s+/g,' ');
 const exactHost=Object.values(STATUSPAGES).find(host=>host===service);
 if(exactHost)return exactHost;
 let candidate=service;
 // Strip whole filler words only, not substrings or punctuation near-matches.
 for(let i=0;i<4;i++){
  const prior=candidate;
  candidate=candidate.replace(/\.(com|io)$/,'').replace(/(?:^| )(api|status|inc|service|cloud)$/,'').trim();
  if(candidate===prior)break;
 }
 candidate=candidate.replace(/ /g,'');
 if(Object.hasOwn(STATUSPAGES,candidate))return STATUSPAGES[candidate];
 return /^[a-z0-9][a-z0-9-]{1,60}\.statuspage\.io$/.test(service)?service:null;
}

const MAX_PAGES = 5; // 500 incidents worst case; a full log can be longer, and then we fail closed.
const COUNTED_IMPACTS = new Set(["major", "critical"]);

interface Incident {
  id: string;
  name: string;
  impact: string;
  started_at: string;
  resolved_at: string | null;
}

function parsePeriod(raw: string | undefined): { days: number } | null {
  if (!raw) throw badRequest("MISSING_PARAM", "period is required: a number of days as Nd, e.g. 30d");
  // AUDIT S2: the contract's own example is "last 30 days", so accept the
  // natural phrasings too — "last N days", "past N days", "N days" — all
  // mapping to the same Nd window; bounds and refusals are unchanged.
  const m = /^(?:(?:the\s+)?(?:last|past)\s+)?(\d{1,3})\s*(?:d|days?)$/.exec(raw.trim().toLowerCase());
  if (!m) return null;
  const days = Number(m[1]);
  if (days < 1 || days > 90) return null;
  return { days };
}

// Calendar description only, never an observation window for uptime arithmetic.
export function slaCalendarDays(raw:string|undefined):number|null {
 const match=/^Q([1-4])\s+(\d{4})$/i.exec(raw?.trim()??'');if(!match)return null;
 const year=Number(match[2]);if(year<1000||year>9999)return null;
 const month=(Number(match[1])-1)*3;
 return (Date.UTC(year,month+3,1)-Date.UTC(year,month,1))/86400000;
}

async function fetchPage(host: string, page: number): Promise<{ body: string; fetchedAt:string; incidents: Incident[] }> {
  const url = `https://${host}/api/v2/incidents.json?per_page=100&page=${page}`;
  let got;try{got=await readSlaBody(url,host,UA,SOURCE_TIMEOUT_MS);}catch{throw upstreamUnavailable('STATUSPAGE_UNREACHABLE','statuspage incident source could not be read; no uptime asserted');}
  const body=got.raw;
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
  return { body, fetchedAt:got.fetchedAt, incidents: parsed.incidents };
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

async function handleSlaComplianceInternal(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const service = query.service?.trim().toLowerCase();
  if (!service) throw badRequest("MISSING_PARAM", `service is required: one of ${Object.keys(STATUSPAGES).join(", ")}`);
  if (service.length > 64) throw badRequest("INVALID_SERVICE", "service is over 64 characters");
  const resolvedPeriod = parsePeriod(query.period);
  const days = resolvedPeriod?.days;
  const host=resolveSlaHost(service);
  const aliasName=Object.entries(STATUSPAGES).find(([,h])=>h===host)?.[0]??'none';
  if (!host || days === undefined) {
    const calendarDays=slaCalendarDays(query.period);
    const periodDays=days??calendarDays;
    const at=new Date().toISOString();
    const status=!host?'not_found':'unknown';
    const reason=!host?'No verified statuspage binding; no guessed hostname or external lookup'+(calendarDays!==null?'; calendar period length only, not measured uptime':''):
      'Period is not a supported rolling 1-90 day observation window. No complete calendar-period source window was established; no uptime arithmetic performed'+(calendarDays!==null?'; calendar period length only':'');
    const period=days===undefined?query.period!.trim():`${days}d`;
    const evidence=JSON.stringify({service,period,period_days:periodDays??null,status,source_resolution:reason,checked_at:at});
    const receipt=makeReceipt(INTENT,'local:verified-statuspage-bindings',evidence,'No supported observation window; no uptime observation');receipt.fetched_at=at;
    try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');}
    const answer=`${service}: ${reason}. Uptime, SLA target and compliance are unknown, not zero or fully operational.`;
    return withAnswerClass(envelope(INTENT,{service,period,period_days:periodDays??null,status,uptime_pct:null,sla_target_pct:null,compliant:null,summary:answer},receipt,{answer,verdict:'unverified',confidence:0,source:'Verified statuspage binding list only; no provider observation'}),INTENT,{service_bound:!!host,alias_name:aliasName});
  }
  const summaryUrl=`https://${host}/api/v2/summary.json`;
  let summaryBody:string,summaryFetchedAt:string, summary:any;
  try {
    const got=await readSlaBody(summaryUrl,host,UA,2500);summaryBody=got.raw;summaryFetchedAt=got.fetchedAt;summary=JSON.parse(summaryBody);
    if(!summary.page || typeof summary.page.id!=='string' || !Array.isArray(summary.components))throw new Error('missing page/components');
    const declared=new URL(summary.page.url);if(!['https:','http:'].includes(declared.protocol)||declared.hostname!==host||declared.username||declared.password||declared.port)throw new Error('wrong statuspage identity');
    // Some provider metadata declares http while the actual fetch uses HTTPS.
    declared.protocol='https:';summary.page.url=declared.toString();
  }catch {throw upstreamUnavailable('STATUSPAGE_MALFORMED','verified statuspage summary could not be read or had inconsistent identity');}
  const now = Date.now();
  const asOf = new Date(now).toISOString();
  const winStart = now - days * 86400_000;

  // Page the incident log until it reaches older than the window (or ends).
  const bodies: string[] = [],pageFetchedAt:string[]=[];
  const incidents: Incident[] = [];
  let coveredHistory = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const got = await fetchPage(host, page);
    bodies.push(got.body);pageFetchedAt.push(got.fetchedAt);
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
    service, host, summary_url:summaryUrl, summary_raw_body:summaryBody,summary_fetched_at:summaryFetchedAt,incident_pages_fetched_at:pageFetchedAt, components:summary.components, period_days: days, window_start: new Date(winStart).toISOString(), as_of: asOf,
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
    `${service} has ${uptimeRounded}% incident-log estimated uptime over the last ${days} days as of ${asOf}, under this disclosed rule (source bodies cached up to5minutes): ` +
    `downtime counts only major/critical incidents from its statuspage.io log (${countedList.length} such incident(s), ~${downtimeMin} minutes); ` +
    `${excluded.length} minor/none degradation(s) are excluded from downtime. ` +
    `sla_target_pct and compliant are NOT provided: a machine-readable SLA target was not established by this endpoint, so a compliance verdict would be invented, not observed.`;
  return withAnswerClass(envelope(INTENT, {
    service,
    period: `${days}d`,
    uptime_pct: uptimeRounded,
    status: "found",
    components: summary.components.map((c:any)=>({id:c.id,name:c.name,status:c.status,updated_at:c.updated_at})),
    source_fetched_at:{summary:summaryFetchedAt,incident_pages:pageFetchedAt},
    source_cache_max_age_seconds:300,
    uptime_semantics: "incident-log estimate, not measured availability or component uptime history",
    sla_target_pct: null,
    compliant: null,
    counted_incidents: countedList.length,
    excluded_degradations: excluded.length,
    downtime_minutes: downtimeMin,
    summary: `${service} ${uptimeRounded}% uptime over ${days}d per the disclosed major/critical-only rule (${countedList.length} counted incidents); sla_target_pct/compliant not provided (SLA target not established).`,
  }, receipt, { answer, verdict: "verified", confidence: 0.85, source: upstreamDesc }),INTENT,{service_bound:true,alias_name:aliasName,window_covered:true});
}

export async function handleSlaCompliance(q:Record<string,string|undefined>):Promise<Record<string,unknown>> {
 const service=q.service?.trim().toLowerCase(),period=q.period?.trim();
 const serviceClass=!service?'missing':service.length>64?'invalid':/^https?:\/\//i.test(service)?'url':resolveSlaHost(service)?'bound':'unbound';
 let periodClass='missing';
 if(period){const m=/^(?:(?:the\s+)?(?:last|past)\s+)?(\d{1,3})\s*(?:d|days?)$/i.exec(period);periodClass=m&&Number(m[1])>=1&&Number(m[1])<=90?'rolling_days':/^Q[1-4]\s+\d{4}$|\b(?:january|february|march|april|may|june|july|august|september|october|november|december|month|quarter|year)\b|^\d{4}-\d{2}$/i.test(period)?'calendar':'unsupported';}
 const cls={sla_service_input_class:serviceClass,sla_period_input_class:periodClass};
 try{const out=await handleSlaComplianceInternal(q);return withAnswerClass(out,INTENT,{...answerDiagnostics(INTENT,out).answerClass,...cls});}
 catch(error){if(error!==null&&typeof error==='object')withAnswerClass(error,INTENT,{...answerDiagnostics(INTENT,error).answerClass,...cls});throw error;}
}
