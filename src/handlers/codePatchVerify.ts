// CODE_PATCH_VERIFY_GENERAL — GET /v1/code-patch?patch=<owner/repo@ref | owner/repo#pr | GitHub URL>
//
// Zero-LLM. Verifies a patch by reading its real CI results from the
// GitHub API: check runs plus the combined commit status for the exact
// commit (a pull request resolves to its head SHA first). SHA-256
// receipt over the exact upstream response bodies.
//
// Intent contract (https://devnode.telegraphprotocol.com/engine/v1/intents/CODE_PATCH_VERIFY_GENERAL,
// read 2026-11-22): request patch (string — repository and commit, pull
// request or CI run); response conclusion (enum success/failure/
// cancelled/skipped/neutral/timed_out/pending), passed (scored bool),
// commit, pipeline.
//
// SOURCE: GitHub REST API, keyless and unauthenticated (60 req/hour per
// caller IP — named honestly when it bites). Two legs of the same API:
// /check-runs (modern checks) and /status (combined legacy commit
// statuses), because a repo can use either or both. No second provider
// is mixed in: CircleCI/GitLab read different pipelines, so this
// handler verifies GITHUB patches only and says so in its input errors.
//
// AGGREGATION DOCTRINE (blocking-first; skipped/neutral non-blocking alongside success; not a branch-protection verdict): any failing run or
// failing/error status => failure; any timed_out => timed_out; any
// still-running or queued check => pending; then cancelled, neutral,
// skipped. With at least one success and no blocking result, neutral/skipped
// are non-blocking, matching GitHub required-checks semantics. This does
// not inspect branch rules or prove mergeability. `passed` is true
// exactly when the aggregate conclusion is success. A commit with no
// checks and no statuses serves neutral with passed=false and says
// there is nothing to verify — never an invented pass.
import { ApiError, badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { withAnswerClass } from "../core/answerClass";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

const SOURCE_TIMEOUT_MS = 5000;
const UA = "verireceipt-code-patch-verify";

const responseCache = new Map<string, { at: number; raw: string }>();
export function resetCodePatchCacheForTests(): void { responseCache.clear(); }
async function fetchText(url: string): Promise<string> {
  const cached = responseCache.get(url);
  if (cached && Date.now() - cached.at < 60000) return cached.raw;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/vnd.github+json" } });
    if (res.status === 404) throw unprocessable("PATCH_NOT_FOUND", "GitHub has no such repository, commit or pull request");
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      throw new ApiError(503, "GITHUB_RATE_LIMITED", `GitHub API refused the request (HTTP ${res.status}${remaining === "0" ? ", hourly unauthenticated quota exhausted" : ""}); retry later`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    if (responseCache.size >= 128) responseCache.delete(responseCache.keys().next().value!);
    responseCache.set(url, { at: Date.now(), raw });
    return raw;
  } finally {
    clearTimeout(timer);
  }
}

/** Fixed-label class of a `patch` value: shape label and length bucket only.
 *  Never the value or any substring. Labels name the shape the input most
 *  resembles whether or not parsePatchRef accepts it. */
export function patchInputClass(raw: string | undefined): { patch_input_class: string; length_bucket: string } {
  const v = (raw ?? "").trim();
  let patch_input_class: string;
  if (!/[0-9A-Za-z]/.test(v)) patch_input_class = "empty_like";
  else if (/^https?:\/\//i.test(v)) {
    if (/^https?:\/\/github\.com\//i.test(v)) {
      if (/\/commit\//i.test(v)) patch_input_class = "github_url_commit";
      else if (/\/pull\//i.test(v)) patch_input_class = "github_url_pull";
      else if (/\/actions\/runs\//i.test(v)) patch_input_class = "github_url_run";
      else patch_input_class = "github_url_other";
    } else patch_input_class = "other_host_url";
  }
  else if (/^[0-9a-f]{7,40}$/i.test(v)) patch_input_class = "sha_only";
  else if (v.includes("/") && v.includes("@")) patch_input_class = "owner_repo_at";
  else if (v.includes("/") && v.includes("#")) patch_input_class = "owner_repo_hash";
  else if (/^[^/\s@#]+\/[^/\s@#]+\/?$/.test(v)) patch_input_class = "owner_repo_only";
  else if (/^[A-Za-z0-9._-]+$/.test(v)) patch_input_class = "bare_word";
  else patch_input_class = "other";
  return { patch_input_class, length_bucket: v.length <= 16 ? "<=16" : v.length <= 40 ? "17-40" : v.length <= 100 ? "41-100" : ">100" };
}

interface PatchRef { owner: string; repo: string; kind: "commit" | "pr" | "run" | "head"; ref: string }

const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

export function parsePatchRef(input: string): PatchRef {
  const s = input.trim();
  let m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/commit\/([0-9a-fA-F]{7,40})\/?$/.exec(s);
  if (m) return checked(m[1], m[2], "commit", m[3]);
  m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d{1,10})\/?$/.exec(s);
  if (m) return checked(m[1], m[2], "pr", m[3]);
  m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d{1,20})\/?$/.exec(s);
  if (m) return checked(m[1], m[2], "run", m[3]);
  m = /^([^/\s]+)\/([^/\s]+)\/commit\/([0-9a-fA-F]{7,40})$/.exec(s);
  if (m) return checked(m[1], m[2], "commit", m[3]);
  m = /^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([A-Za-z0-9._-]{1,100})\/?$/.exec(s);
  if (m) return checked(m[1], m[2], "head", "HEAD");
  m = /^([^/\s]+)\/([^/\s]+)@([^\s#]{1,100})$/.exec(s);
  if (m) return checked(m[1], m[2], "commit", m[3]);
  m = /^([^/\s]+)\/([^/\s]+)#(\d{1,10})$/.exec(s);
  if (m) return checked(m[1], m[2], "pr", m[3]);
  throw badRequest("INVALID_PATCH", "patch must be owner/repo@commit-or-ref, owner/repo#pr-number, or a github.com commit or pull URL");
}
function checked(owner: string, repo: string, kind: "commit" | "pr" | "run" | "head", ref: string): PatchRef {
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) throw badRequest("INVALID_PATCH", "owner and repository must be GitHub name characters");
  return { owner, repo, kind, ref };
}

type Conclusion = "success" | "failure" | "cancelled" | "skipped" | "neutral" | "timed_out" | "pending";
const PRECEDENCE: Conclusion[] = ["failure", "timed_out", "pending", "cancelled", "success", "neutral", "skipped"];

export function aggregateConclusions(parts: Conclusion[]): Conclusion {
  if (!parts.length) return "neutral";
  for (const c of PRECEDENCE) if (parts.includes(c)) return c;
  return "neutral";
}

export function parseCheckRuns(raw: string): { conclusions: Conclusion[]; runs: { name: string; status: string; conclusion: string | null; url: string | null }[] } {
  const parsed = JSON.parse(raw) as { check_runs?: unknown };
  if (!Array.isArray(parsed.check_runs)) throw upstreamUnavailable("GITHUB_BAD_BODY", "check-runs body has no check_runs array");
  const runs = (parsed.check_runs as Record<string, unknown>[]).map((r) => ({
    name: typeof r.name === "string" ? r.name : "(unnamed check)",
    status: typeof r.status === "string" ? r.status : "unknown",
    conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
    url: typeof r.html_url === "string" ? r.html_url : null,
  }));
  const conclusions: Conclusion[] = runs.map((r) => {
    if (r.status !== "completed") return "pending";
    if (r.conclusion === "success") return "success";
    if (r.conclusion === "failure" || r.conclusion === "startup_failure" || r.conclusion === "action_required") return "failure";
    if (r.conclusion === "timed_out") return "timed_out";
    if (r.conclusion === "cancelled") return "cancelled";
    if (r.conclusion === "skipped") return "skipped";
    return "neutral";
  });
  return { conclusions, runs };
}

export function parseCommitStatus(raw: string): { conclusions: Conclusion[]; state: string; contexts: { context: string; state: string }[] } {
  const parsed = JSON.parse(raw) as { state?: unknown; statuses?: unknown };
  const statuses = Array.isArray(parsed.statuses) ? parsed.statuses as Record<string, unknown>[] : [];
  const conclusions: Conclusion[] = statuses.map((s) => {
    const st = typeof s.state === "string" ? s.state : "";
    if (st === "success") return "success";
    if (st === "failure" || st === "error") return "failure";
    return "pending";
  });
  return { conclusions, state: typeof parsed.state === "string" ? parsed.state : "", contexts: statuses.map((s) => ({ context: typeof s.context === "string" ? s.context : "(unnamed status)", state: typeof s.state === "string" ? s.state : "unknown" })) };
}

export const INTENT = "CODE_PATCH_VERIFY_GENERAL";

export async function handleCodePatchVerify(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const raw = query.patch;
  if (!raw?.trim()) throw badRequest("MISSING_PARAM", "patch is required (owner/repo@commit, owner/repo#pr, or a github.com commit/pull URL)");
  let ref: PatchRef;
  try { ref = parsePatchRef(raw); }
  catch {
    return withAnswerClass({ answer: "passed=false; conclusion=neutral; failing checks: unknown. The input does not resolve to a GitHub repository, commit, pull request or Actions run. No CI result was fetched or verified.", conclusion: "neutral", passed: false, commit: null, pipeline: null, verdict: "unavailable", confidence: 0, receipt: null }, INTENT, patchInputClass(raw));
  }
  const base = `https://api.github.com/repos/${ref.owner}/${ref.repo}`;
  let sha = ref.ref;
  let prRaw: string | null = null;
  let prUrl: string | null = null;
  if (ref.kind !== "commit" || !/^[0-9a-f]{40}$/i.test(ref.ref)) {
    const prApi = ref.kind === "pr" ? `${base}/pulls/${ref.ref}` : ref.kind === "run" ? `${base}/actions/runs/${ref.ref}` : `${base}/commits/${encodeURIComponent(ref.kind === "head" ? "HEAD" : ref.ref)}`;
    prRaw = await fetchText(prApi).catch((err: unknown) => {
      if (err instanceof Error && "status" in err) throw err;
      throw upstreamUnavailable("GITHUB_UNREACHABLE", `GitHub pull lookup failed: ${err instanceof Error ? err.message : "unknown error"}`);
    });
    const pr = JSON.parse(prRaw) as { head?: { sha?: unknown }; head_sha?: unknown; sha?: unknown; html_url?: unknown };
    const resolvedSha = ref.kind === "pr" ? pr.head?.sha : ref.kind === "run" ? pr.head_sha : pr.sha;
    if (typeof resolvedSha !== "string" || !/^[0-9a-f]{40}$/i.test(resolvedSha)) {
      throw upstreamUnavailable("GITHUB_BAD_BODY", "pull response has no head SHA");
    }
    sha = resolvedSha;
    prUrl = typeof pr.html_url === "string" ? pr.html_url : null;
  }
  const checksUrl = `${base}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`;
  const statusUrl = `${base}/commits/${encodeURIComponent(sha)}/status`;
  const [checksRaw, statusRaw] = await Promise.all([
    fetchText(checksUrl).catch((err: unknown) => {
      if (err instanceof Error && "status" in err) throw err;
      throw upstreamUnavailable("GITHUB_UNREACHABLE", `GitHub check-runs lookup failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }),
    fetchText(statusUrl).catch((err: unknown) => {
      if (err instanceof Error && "status" in err) throw err;
      throw upstreamUnavailable("GITHUB_UNREACHABLE", `GitHub commit-status lookup failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }),
  ]);
  const statusSha = JSON.parse(statusRaw)?.sha;
  if (typeof statusSha === "string" && statusSha.toLowerCase() !== sha.toLowerCase()) throw upstreamUnavailable("GITHUB_BAD_BODY", "commit status SHA does not match resolved commit");
  const checks = parseCheckRuns(checksRaw);
  const status = parseCommitStatus(statusRaw);
  const incomplete = Number(JSON.parse(checksRaw)?.total_count ?? checks.runs.length) > checks.runs.length || Number(JSON.parse(statusRaw)?.total_count ?? status.contexts.length) > status.contexts.length;
  const conclusion = aggregateConclusions([...checks.conclusions, ...status.conclusions, ...(incomplete ? ["pending" as Conclusion] : [])]);
  const passed = conclusion === "success";
  const fetchedAt = new Date(Math.min(...[checksUrl, statusUrl].map(u => responseCache.get(u)?.at ?? Date.now()))).toISOString();
  const pipeline = checks.runs.find((r) => r.url)?.url
    ?? prUrl
    ?? `https://github.com/${ref.owner}/${ref.repo}/commit/${sha}/checks`;
  const checksFound = checks.runs.length + status.contexts.length;
  const evidence = JSON.stringify({ patch: raw.trim(), resolved: { owner: ref.owner, repo: ref.repo, kind: ref.kind, commit: sha },
    as_of: fetchedAt, conclusion, checks_found: checksFound,
    source_policy: "GitHub REST API, unauthenticated keyless (60 requests/hour per caller IP); check runs plus combined commit status, blocking-first aggregation; success plus skipped/neutral passes only with at least one success and no failure, timeout, pending or cancelled result; branch protection rules not inspected",
    raw_bodies: { pull: prRaw, check_runs: checksRaw, commit_status: statusRaw }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, checksUrl, evidence, "GitHub check runs + combined commit status, blocking-first conclusion; skipped/neutral non-blocking only alongside success; never averaged");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const runList = [...checks.runs.map((r) => `${r.name}: ${r.status}${r.conclusion ? "/" + r.conclusion : ""}`),
    ...status.contexts.map((c) => `${c.context}: ${c.state}`)].join("; ");
  const answerBody = checksFound === 0
    ? `${ref.owner}/${ref.repo}@${sha}: no CI check runs and no commit statuses exist — there is nothing to verify. Conclusion: neutral; the patch is NOT verified as passing.`
    : `${ref.owner}/${ref.repo}@${sha}: conclusion ${conclusion.toUpperCase()} (${passed ? "checks passed" : "checks did not pass"}). ` +
      `${incomplete ? "Coverage is paginated and incomplete within the three-call budget; no all-green pass is asserted. " : ""}${checksFound} check(s)/status(es), blocking-first aggregation; success plus skipped/neutral passes only with at least one success and no failure, timeout, pending or cancelled result; branch protection rules not inspected: ${runList}. ` +
      (conclusion === "pending" ? "Some checks are still running; this is the state at fetch time, not a final result. " : "") +
      "Source: GitHub API (check runs + combined commit status); responses may be cached for up to60 seconds.";
  return envelope(INTENT, { conclusion, passed, commit: sha, pipeline }, receipt, {
    answer: `passed=${passed}; conclusion=${conclusion}; failing checks: ${[...checks.runs.filter(r => ["failure", "startup_failure", "action_required", "timed_out"].includes(r.conclusion ?? "")).map(r => r.name), ...status.contexts.filter(c => ["failure", "error"].includes(c.state)).map(c => c.context)].join(", ") || "none reported"}. ${ref.kind === "head" ? "Bare repository resolved to default-branch HEAD. " : ""}${answerBody}`,
    // "verified" means the SOURCES confirm this answer — a confirmed CI
    // failure is a verified answer too. The conclusion field carries
    // pass/fail; verdict carries source confidence only.
    verdict: "verified",
    confidence: conclusion === "pending" ? 0.7 : 0.9,
    source: `${checksUrl} + ${statusUrl}${prUrl ? ` + ${prUrl}` : ""}; GitHub API unauthenticated; blocking-first; skipped/neutral non-blocking alongside success; not a branch-protection verdict; fetched ${fetchedAt}`,
  });
}
