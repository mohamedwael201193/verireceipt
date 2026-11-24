// URL_SCAN_VERDICT — GET /v1/url-scan?url=<http(s) URL>
//
// Zero-LLM. Answers "is this URL safe to visit, with no phishing or
// malware?" by screening the exact URL and its host against the same
// seven keyless public threat-intelligence blocklists as
// THREAT_INTELLIGENCE_INDICATOR (shared loader and cache — see
// threatIntel.ts for the feed list, truncation floors and fail-closed
// doctrine). The URL itself is NEVER fetched, rendered or executed:
// a bounded public-target header probe is optional evidence only; this
// is blocklist screening, not a live sandbox scan, and the
// answer says so.
//
// Intent contract (read 2026-11-23): request url (string); scored
// safe (bool) — true_when true/yes/safe/clean.
//
// VERDICT DOCTRINE: safe=false the moment any feed lists the URL or
// its host, with every matching feed and raw line receipted. safe=true
// means only "no phishing or malware report for this URL in these 7
// feeds as of their fetch times" — blocklists are not safelists, so
// the answer names that every time. FAIL CLOSED: a degraded feed view
// is a 502, never a partial "safe".
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { probeUrlHeaders } from './urlProbe';
import { loadFeedView, requireBoundedThreatView, degradedThreatDisclosure, matchIndicator, canonicalScreeningHost, type IndicatorMatch } from "./threatIntel";

export const INTENT = "URL_SCAN_VERDICT";

export async function handleUrlScan(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const raw = query.url?.trim();
  if (!raw) throw badRequest("MISSING_PARAM", "url is required: the http(s) URL to screen");
  if (raw.length > 2048) throw badRequest("INVALID_URL", "url is over 2048 characters");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw badRequest("INVALID_URL", "url must be a well-formed absolute URL, e.g. https://example.com/path");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("INVALID_URL", "only http:// and https:// URLs can be screened");
  }
  const host = canonicalScreeningHost(raw);
  if (!host) throw badRequest("INVALID_URL", "url has no host");

  const view = await loadFeedView();
  const { states } = view;
  const fetchedAt = new Date().toISOString();
  // Screen the full URL (OpenPhish exact-URL list + host via domain and
  // wildcard lists) and the bare host (adds the IP lists when the host
  // is a literal address).
  const urlResult = matchIndicator(raw, states);
  const hostResult = matchIndicator(host, states);
  const matches: IndicatorMatch[] = [...urlResult.matches];
  for (const m of hostResult.matches) {
    if (!matches.some((x) => x.feed === m.feed && x.raw === m.raw)) matches.push(m);
  }
  const safe = matches.length === 0;
  requireBoundedThreatView(view, raw, !safe);
  const liveProbe = safe ? await probeUrlHeaders(raw) : {kind:"not attempted",stop:"listed-target-not-contacted",hops:[]};
  const asOf = new Date().toISOString();
  const feedMeta = states.map((s) => ({ feed: s.feed.name, url: s.feed.url, entries: s.lines.length, sha256: s.sha256, published: s.published }));
  const evidence = JSON.stringify({
    url: raw, host, safe, as_of: asOf, unavailable_feeds: view.unavailable, live_probe: liveProbe,
    matches: matches.map((m) => ({ feed: m.feed, matched_entry: m.raw })),
    feeds: feedMeta,
    method: "blocklist screening plus optional bounded header-only public-target observation; page body NOT fetched, rendered or executed",
    honesty: "safe=true means no feed listed this URL or host as of the fetch times; blocklists are not safelists, so absence is not a guarantee of safety",
    fetched_at: fetchedAt,
  });
  const receipt = makeReceipt(INTENT, `${states.length} keyless blocklists`, evidence, "full-list downloads with truncation floors; every matching raw line receipted; page body not fetched; optional header-only probe metadata retained");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const checkedDesc = `${states.length} feeds (${feedMeta.map((f) => `${f.feed}: ${f.entries} entries`).join(", ")})`;
  const answer = safe
    ? `Yes, ${raw} appears safe to visit: no phishing or malware report for this URL or its host ${host} in any of the ${states.length} blocklists checked (${checkedDesc}) as of ${asOf}. ` +
      `This is a blocklist screening, not a guarantee: blocklists are not safelists, page body was not fetched or analysed, and a site with no listing can still be hostile. Header-only observation: ${liveProbe.stop}; it does not change the blocklist-based safe field.`
    : `No, ${raw} is NOT safe to visit: reported by ${matches.map((m) => `${m.feed} ("${m.raw}")`).join("; ")}. ` +
      `Checked against ${checkedDesc}. The URL itself was not fetched or analysed.`;
  return envelope(INTENT, {
    safe,
    live_probe: liveProbe,
    url: raw,
    host,
    matches: matches.map((m) => ({ feed: m.feed, matched_entry: m.raw })),
    feeds_checked: states.length,
    unavailable_feeds: view.unavailable,
    screening_complete: view.unavailable.length === 0,
    summary: safe
      ? `No listing in any of the ${states.length} blocklists checked; blocklist screening only, not a guarantee.`
      : `Listed by ${matches.length} of ${states.length} blocklists checked.`,
  }, receipt, { answer: answer + degradedThreatDisclosure(view), verdict: "verified", confidence: view.unavailable.length ? 0.65 : 0.9,
    source: states.map((s) => `${s.feed.name} ${s.feed.url} (fetched ${s.fetchedAt}, published ${s.published}, sha256 ${s.sha256.slice(0, 12)}…)`).join("; ") });
}
