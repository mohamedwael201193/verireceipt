// TRAVEL_DISRUPTION_GENERAL — GET /v1/travel-disruption?route_or_flight=<IATA>
//
// Zero-LLM. US airport-level disruption status from the FAA's NAS
// status feed, with a SHA-256 receipt over the exact upstream body.
//
// Intent contract (read 2026-11-22): request route_or_flight (string);
// scored disrupted bool; off-chain route_or_flight, status,
// delay_minutes, reason.
//
// SOURCE: nasstatus.faa.gov airport-status-information, keyless,
// probed live 2026-11-23. The feed ignores its airport parameter and
// returns the full NAS snapshot, so filtering is local.
//
// HONEST SCOPE: this is AIRPORT-LEVEL FAA NAS status — ground delay
// programs, ground stops, general arrival/departure delays, closures —
// NEVER flight-level tracking; no keyless flight-status source exists.
// Every answer says so, and the receipt discloses the input narrowing
// (route_or_flight accepts a 3-letter FAA/IATA airport code or a name
// from the bundled US airport list, disclosed when resolved).
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { resolveAirportName } from "../data/airportNames";

const SOURCE_TIMEOUT_MS = 8000;
const UA = "VeriReceipt/2.0 travel-disruption observer (+https://verireceipt.vercel.app)";
const NAS_URL = "https://nasstatus.faa.gov/api/airport-status-information";

export const INTENT = "TRAVEL_DISRUPTION_GENERAL";

export interface AirportStatusEntry { kind: string; reason: string; avg: string; max: string; trend: string }

function minutesOf(text: string): number | null {
  let total = 0;
  const h = /(\d+)\s*hours?/.exec(text);
  const m = /(\d+)\s*minutes?/.exec(text);
  if (h) total += Number(h[1]) * 60;
  if (m) total += Number(m[1]);
  return h || m ? total : null;
}

export function parseNasStatus(raw: string, airport: string): { updateTime: string; entries: AirportStatusEntry[] } {
  const updateTime = /<Update_Time>([^<]*)<\/Update_Time>/.exec(raw)?.[1] ?? "";
  const entries: AirportStatusEntry[] = [];
  const arptRe = new RegExp(`<ARPT>${airport}</ARPT>`);
  for (const block of raw.match(/<Ground_Delay>[\s\S]*?<\/Ground_Delay>/g) ?? []) {
    if (!arptRe.test(block)) continue;
    entries.push({ kind: "ground delay program",
      reason: /<Reason>([^<]*)<\/Reason>/.exec(block)?.[1] ?? "",
      avg: /<Avg>([^<]*)<\/Avg>/.exec(block)?.[1] ?? "",
      max: /<Max>([^<]*)<\/Max>/.exec(block)?.[1] ?? "", trend: "" });
  }
  for (const block of raw.match(/<Ground_Stop>[\s\S]*?<\/Ground_Stop>/g) ?? []) {
    if (!arptRe.test(block)) continue;
    entries.push({ kind: "ground stop",
      reason: /<Reason>([^<]*)<\/Reason>/.exec(block)?.[1] ?? "",
      avg: "", max: "", trend: "" });
  }
  for (const block of raw.match(/<Delay>[\s\S]*?<\/Delay>/g) ?? []) {
    if (!arptRe.test(block)) continue;
    entries.push({ kind: "arrival/departure delay",
      reason: /<Reason>([^<]*)<\/Reason>/.exec(block)?.[1] ?? "",
      avg: /<Min>([^<]*)<\/Min>/.exec(block)?.[1] ?? "",
      max: /<Max>([^<]*)<\/Max>/.exec(block)?.[1] ?? "",
      trend: /<Trend>([^<]*)<\/Trend>/.exec(block)?.[1] ?? "" });
  }
  for (const block of raw.match(/<Airport>[\s\S]*?<\/Airport>/g) ?? []) {
    if (!arptRe.test(block)) continue;
    entries.push({ kind: "airport closure",
      reason: (/<Reason>([^<]*)<\/Reason>/.exec(block)?.[1] ?? "").slice(0, 200),
      avg: "", max: "", trend: "" });
  }
  return { updateTime, entries };
}

export async function handleTravelDisruption(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const rawInput = query.route_or_flight?.trim();
  if (!rawInput) throw badRequest("MISSING_PARAM", "route_or_flight is required as a 3-letter airport code, e.g. LGA, or a US airport name");
  let airport = rawInput.toUpperCase();
  let resolvedFrom: { name: string; label: string } | null = null;
  if (!/^[A-Z]{3}$/.test(airport)) {
    // Bundled static US airport list: exact name forms only, ambiguity
    // refused naming the candidates, never a silent first-hit pick.
    const matches = resolveAirportName(rawInput);
    if (matches.length > 1) {
      throw unprocessable("AMBIGUOUS_AIRPORT",
        `"${rawInput}" matches ${matches.length} airports in the bundled list: ${matches.map((m) => `${m.code} (${m.label})`).join("; ")}; pass the 3-letter code or a more specific name`);
    }
    if (matches.length === 1) {
      resolvedFrom = { name: rawInput, label: matches[0].label };
      airport = matches[0].code;
    } else {
      throw badRequest("AIRPORT_CODE_REQUIRED",
        "route_or_flight accepts a 3-letter airport code or a name from the bundled US airport list in this slice: this is FAA airport-level status, not flight tracking, and routes are not covered");
    }
  }
  const fetchedAt = new Date().toISOString();
  let body: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
    try {
      const res = await fetch(`${NAS_URL}?airport=${airport}`, { signal: controller.signal, headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.text();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    throw upstreamUnavailable("FAA_UNREACHABLE", "the FAA NAS status feed could not be reached");
  }
  if (!body.includes("AIRPORT_STATUS_INFORMATION")) {
    throw unprocessable("NO_USABLE_STATUS", "the FAA answer was not a NAS status document; nothing is guessed");
  }
  const { updateTime, entries } = parseNasStatus(body, airport);
  const disrupted = entries.length > 0;
  const delayMinutes = entries.map((e) => minutesOf(e.avg)).filter((v): v is number => v !== null);
  const maxDelay = delayMinutes.length ? Math.max(...delayMinutes) : null;
  const status = disrupted ? entries.map((e) => e.kind).join("; ") : "no active FAA-listed disruption";
  const reason = entries.map((e) => e.reason).filter(Boolean).join("; ");
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ route_or_flight: airport, as_of: asOf, feed_update_time: updateTime, entries,
    name_resolution: resolvedFrom ? { input: resolvedFrom.name, resolved_to: airport, label: resolvedFrom.label, source: "bundled static US airport list (in-repo table, not a live directory)" } : "not used (3-letter code given directly)",
    input_narrowing: "route_or_flight narrowed to a 3-letter airport code: FAA airport-level NAS status only, never flight-level tracking; the feed ignores its airport parameter so filtering is local",
    source_policy: "FAA NAS status snapshot (ground delay programs, ground stops, arrival/departure delays, closures); airport-level only",
    raw_bodies: { nas_status: body }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, NAS_URL, evidence, "FAA NAS status single source; airport-level only, input narrowing disclosed");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const namePrefix = resolvedFrom ? `"${resolvedFrom.name}" resolved to ${airport} (${resolvedFrom.label}) via the bundled airport list. ` : "";
  const answer = disrupted
    ? `${namePrefix}${airport} is DISRUPTED at the airport level: ${status}${reason ? ` (${reason})` : ""}` +
      `${maxDelay !== null ? `, average delay up to ${maxDelay} minutes` : ""}. FAA NAS status as of ${updateTime}. ` +
      `This is airport-level FAA status, not flight-level tracking.`
    : `${namePrefix}${airport}: no active FAA-listed disruption (no ground delay program, ground stop, arrival/departure delay or closure) in the NAS status as of ${updateTime}. ` +
      `This is airport-level FAA status, not flight-level tracking; an unlisted airport or unlisted condition is not claimed normal.`;
  return envelope(INTENT, {
    disrupted,
    route_or_flight: airport,
    status,
    delay_minutes: maxDelay,
    reason: reason || null,
  }, receipt, { answer, verdict: "verified", confidence: 0.9,
    source: `${NAS_URL}; FAA NAS status snapshot, airport-level only; feed updated ${updateTime}; fetched ${fetchedAt}` });
}
