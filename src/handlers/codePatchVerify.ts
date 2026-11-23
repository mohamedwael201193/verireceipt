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
// AGGREGATION DOCTRINE (worst-of, never averaged): any failing run or
// failing/error status => failure; any timed_out => timed_out; any
// still-running or queued check => pending; then cancelled, neutral,
// skipped, and only an all-green set serves success. `passed` is true
// exactly when the aggregate conclusion is success. A commit with no
// checks and no statuses serves neutral with passed=false and says
// there is nothing to verify — never an invented pass.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

const SOURCE_TIMEOUT_MS = 5000;
const UA = "verireceipt-code-patch-verify";

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/vnd.github+json" } });
    if (res.status === 404) throw unprocessable("PATCH_NOT_FOUND", "GitHub has no such repository, commit or pull request");
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      throw upstreamUnavailable("GITHUB_RATE_LIMITED", `GitHub API refused the request (HTTP ${res.status}${remaining === "0" ? ", hourly unauthenticated quota exhausted" : ""}); retry later`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

interface PatchRef { owner: string; repo: string; kind: "commit" | "pr"; ref: string }

const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

export function parsePatchRef(input: string): PatchRef {
  const s = input.trim();
  let m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/commit\/([0-9a-fA-F]{7,40})\/?$/.exec(s);
  if (m) return checked(m[1], m[2], "commit", m[3]);
  m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d{1,10})\/?$/.exec(s);
  if (m) return checked(m[1], m[2], "pr", m[3]);
  m = /^([^/\s]+)\/([^/\s]+)@([^\s#]{1,100})$/.exec(s);
  if (m) return checked(m[1], m[2], "commit", m[3]);
  m = /^([^/\s]+)\/([^/\s]+)#(\d{1,10})$/.exec(s);
  if (m) return checked(m[1], m[2], "pr", m[3]);
  throw badRequest("INVALID_PATCH", "patch must be owner/repo@commit-or-ref, owner/repo#pr-number, or a github.com commit or pull URL");
}
function checked(owner: string, repo: string, kind: "commit" | "pr", ref: string): PatchRef {
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) throw badRequest("INVALID_PATCH", "owner and repository must be GitHub name characters");
  return { owner, repo, kind, ref };
}

type Conclusion = "success" | "failure" | "cancelled" | "skipped" | "neutral" | "timed_out" | "pending";
const PRECEDENCE: Conclusion[] = ["failure", "timed_out", "pending", "cancelled", "neutral", "skipped", "success"];

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
  const ref = parsePatchRef(raw);
  const base = `https://api.github.com/repos/${ref.owner}/${ref.repo}`;
  let sha = ref.ref;
  let prRaw: string | null = null;
  let prUrl: string | null = null;
  if (ref.kind === "pr") {
    const prApi = `${base}/pulls/${ref.ref}`;
    prRaw = await fetchText(prApi).catch((err: unknown) => {
      if (err instanceof Error && "status" in err) throw err;
      throw upstreamUnavailable("GITHUB_UNREACHABLE", `GitHub pull lookup failed: ${err instanceof Error ? err.message : "unknown error"}`);
    });
    const pr = JSON.parse(prRaw) as { head?: { sha?: unknown }; html_url?: unknown };
    if (typeof pr.head?.sha !== "string" || !/^[0-9a-f]{40}$/i.test(pr.head.sha)) {
      throw upstreamUnavailable("GITHUB_BAD_BODY", "pull response has no head SHA");
    }
    sha = pr.head.sha;
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
  const checks = parseCheckRuns(checksRaw);
  const status = parseCommitStatus(statusRaw);
  const conclusion = aggregateConclusions([...checks.conclusions, ...status.conclusions]);
  const passed = conclusion === "success";
  const fetchedAt = new Date().toISOString();
  const pipeline = checks.runs.find((r) => r.url)?.url
    ?? prUrl
    ?? `https://github.com/${ref.owner}/${ref.repo}/commit/${sha}/checks`;
  const checksFound = checks.runs.length + status.contexts.length;
  const evidence = JSON.stringify({ patch: raw.trim(), resolved: { owner: ref.owner, repo: ref.repo, kind: ref.kind, commit: sha },
    as_of: fetchedAt, conclusion, checks_found: checksFound,
    source_policy: "GitHub REST API, unauthenticated keyless (60 requests/hour per caller IP); check runs plus combined commit status, worst-of aggregation",
    raw_bodies: { pull: prRaw, check_runs: checksRaw, commit_status: statusRaw }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, checksUrl, evidence, "GitHub check runs + combined commit status, worst-of conclusion; never averaged");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const runList = [...checks.runs.map((r) => `${r.name}: ${r.status}${r.conclusion ? "/" + r.conclusion : ""}`),
    ...status.contexts.map((c) => `${c.context}: ${c.state}`)].join("; ");
  const answer = checksFound === 0
    ? `${ref.owner}/${ref.repo}@${sha}: no CI check runs and no commit statuses exist — there is nothing to verify. Conclusion: neutral; the patch is NOT verified as passing.`
    : `${ref.owner}/${ref.repo}@${sha}: conclusion ${conclusion.toUpperCase()} (${passed ? "checks passed" : "checks did not pass"}). ` +
      `${checksFound} check(s)/status(es), worst-of aggregation: ${runList}. ` +
      (conclusion === "pending" ? "Some checks are still running; this is the state at fetch time, not a final result. " : "") +
      "Source: GitHub API (check runs + combined commit status).";
  return envelope(INTENT, { conclusion, passed, commit: sha, pipeline }, receipt, {
    answer,
    // "verified" means the SOURCES confirm this answer — a confirmed CI
    // failure is a verified answer too. The conclusion field carries
    // pass/fail; verdict carries source confidence only.
    verdict: "verified",
    confidence: conclusion === "pending" ? 0.7 : 0.9,
    source: `${checksUrl} + ${statusUrl}${prUrl ? ` + ${prUrl}` : ""}; GitHub API unauthenticated; worst-of, never averaged; fetched ${fetchedAt}`,
  });
}
