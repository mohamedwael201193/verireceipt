// URL_SAFE_GENERAL — GET /v1/url-safe?url=<http(s) URL>
//
// Zero-LLM. Safety verdict for a URL from the same seven keyless public
// threat-intelligence blocklists as THREAT_INTELLIGENCE_INDICATOR and
// URL_SCAN_VERDICT (shared loader and cache — see threatIntel.ts for
// the feed list, truncation floors and fail-closed doctrine). The URL
// itself is NEVER fetched, rendered or executed.
//
// Intent contract (read 2026-11-23): request url (string); verdict
// enum Safe|Suspicious|Malicious|Unknown; scored detections (number of
// engines or databases flagging the URL); judgment class.
//
// VERDICT MAPPING (doctrine): detections = the number of distinct
// blocklist feeds listing the exact URL or its host. detections > 0 ->
// Malicious (these feeds list phishing/malware/C2, so any listing is a
// malicious-class signal; "Suspicious" is reserved for weaker signal
// types these feeds do not carry). detections = 0 -> "Safe" ONLY in
// the contract's enum sense, with the summary naming that blocklist
// absence is not clearance. FAIL CLOSED: a degraded feed view is a
// 502, never a partial verdict.
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { loadFeeds, matchIndicator, type IndicatorMatch } from "./threatIntel";

export const INTENT = "URL_SAFE_GENERAL";

export async function handleUrlSafe(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const raw = query.url?.trim();
  if (!raw) throw badRequest("MISSING_PARAM", "url is required: the http(s) URL to check");
  if (raw.length > 2048) throw badRequest("INVALID_URL", "url is over 2048 characters");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw badRequest("INVALID_URL", "url must be a well-formed absolute URL, e.g. https://example.com/path");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("INVALID_URL", "only http:// and https:// URLs can be checked");
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) throw badRequest("INVALID_URL", "url has no host");

  const states = await loadFeeds();
  const fetchedAt = new Date().toISOString();
  const urlResult = matchIndicator(raw, states);
  const hostResult = matchIndicator(host, states);
  const matches: IndicatorMatch[] = [...urlResult.matches];
  for (const m of hostResult.matches) {
    if (!matches.some((x) => x.feed === m.feed && x.raw === m.raw)) matches.push(m);
  }
  const detections = new Set(matches.map((m) => m.feed)).size;
  const verdict = detections > 0 ? "Malicious" : "Safe";
  const asOf = new Date().toISOString();
  const feedMeta = states.map((s) => ({ feed: s.feed.name, url: s.feed.url, entries: s.lines.length, sha256: s.sha256, published: s.published }));
  const evidence = JSON.stringify({
    url: raw, host, verdict, detections, as_of: asOf,
    matches: matches.map((m) => ({ feed: m.feed, matched_entry: m.raw })),
    feeds: feedMeta,
    method: "blocklist screening of the exact URL and its host; the URL itself was NOT fetched, rendered or executed",
    honesty: "verdict Safe means zero of the checked blocklists flag this URL or host as of their fetch times; blocklists are not safelists, so absence is not clearance",
    fetched_at: fetchedAt,
  });
  const receipt = makeReceipt(INTENT, `${states.length} keyless blocklists`, evidence, "full-list downloads with truncation floors; every matching raw line receipted; the URL was not fetched");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const summary = detections > 0
    ? `${raw}: Malicious — flagged by ${detections} of ${states.length} blocklists (${matches.map((m) => m.feed).join("; ")}).`
    : `${raw}: no flags in any of the ${states.length} blocklists checked as of ${asOf} — verdict Safe in the blocklist sense only; absence is not clearance.`;
  const answer = detections > 0
    ? `Malicious: ${raw} is flagged by ${detections} of ${states.length} blocklists checked: ${matches.map((m) => `${m.feed} ("${m.raw}")`).join("; ")}. The URL itself was not fetched or analysed.`
    : `Safe (blocklist sense): ${raw} has zero flags across ${states.length} blocklists checked (${feedMeta.map((f) => f.feed).join(", ")}) as of ${asOf}. ` +
      `This is a blocklist screening, not a guarantee: blocklists are not safelists, and the URL itself was not fetched or analysed.`;
  // The contract's `verdict` field nests under url_check: the shared
  // envelope reserves the top-level `verdict` for the verification status.
  // miner.yaml maps the schema field at path url_check.verdict (the yaml
  // standard's output path is a dot path into the answer).
  return envelope(INTENT, {
    url: raw,
    url_check: { verdict },
    detections,
    summary,
    matches: matches.map((m) => ({ feed: m.feed, matched_entry: m.raw })),
    feeds_checked: states.length,
  }, receipt, { answer, verdict: "verified", confidence: 0.9,
    source: states.map((s) => `${s.feed.name} ${s.feed.url} (fetched ${s.fetchedAt}, published ${s.published}, sha256 ${s.sha256.slice(0, 12)}…)`).join("; ") });
}
