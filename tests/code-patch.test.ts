import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/code-patch-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); resetCodePatchCacheForTests(); });
import { handleCodePatchVerify, parsePatchRef, aggregateConclusions, resetCodePatchCacheForTests } from "../src/handlers/codePatchVerify";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/code-patch", name), "utf8");
// Real GitHub API bodies for mohamedwael201193/verireceipt @ 4f7d00ce, retrieved 2026-11-23.
const SHA = "4f7d00ce271d5bbea8ca112167b857ae7bfaabac";
const checks = fixture("github-check-runs-success.json");
const status = fixture("github-commit-status-success.json");
function stub(opts: { checks?: string | number; status?: string | number; pr?: string }): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    if (u.includes("/pulls/")) {
      if (opts.pr === undefined) return new Response("not found", { status: 404 });
      return new Response(opts.pr, { status: 200 });
    }
    const body = u.includes("check-runs") ? (opts.checks ?? checks) : (opts.status ?? status);
    if (typeof body === "number") return new Response("err", { status: body });
    return new Response(body, { status: 200 });
  });
}
describe("CODE_PATCH_VERIFY_GENERAL", () => {
  it("parses every accepted patch form and rejects the rest", () => {
    expect(parsePatchRef("mohamedwael201193/verireceipt@" + SHA)).toMatchObject({ kind: "commit", ref: SHA });
    expect(parsePatchRef("mohamedwael201193/verireceipt#12")).toMatchObject({ kind: "pr", ref: "12" });
    expect(parsePatchRef("https://github.com/a/b/commit/" + SHA)).toMatchObject({ owner: "a", repo: "b", kind: "commit" });
    expect(parsePatchRef("https://github.com/a/b/pull/12")).toMatchObject({ kind: "pr" });
    for (const bad of ["", "nonsense", "https://evil.example/a/b", "a/b/c@d"]) {
      expect(() => parsePatchRef(bad)).toThrow();
    }
  });
  it("validates before fetching", async () => {
    await expect(handleCodePatchVerify({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    expect(await handleCodePatchVerify({ patch: "nonsense" })).toMatchObject({ conclusion: "neutral", passed: false });
  });
  it("worst-of aggregation is never an average", () => {
    expect(aggregateConclusions(["success", "failure"])).toBe("failure");
    expect(aggregateConclusions(["success", "pending"])).toBe("pending");
    expect(aggregateConclusions(["timed_out", "cancelled"])).toBe("timed_out");
    expect(aggregateConclusions(["skipped", "neutral"])).toBe("neutral");
    expect(aggregateConclusions(["success", "success"])).toBe("success");
    expect(aggregateConclusions([])).toBe("neutral");
  });
  it("a green commit serves success with a receipt over both exact bodies", async () => {
    stub({});
    const result = await handleCodePatchVerify({ patch: "mohamedwael201193/verireceipt@" + SHA });
    expect(result.conclusion).toBe("success");
    expect(result.passed).toBe(true);
    expect(result.commit).toBe(SHA);
    expect(String(result.pipeline)).toContain("github.com");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("CODE_PATCH_VERIFY_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    const body = JSON.parse(stored.evidence.toString("utf8"));
    expect(body.raw_bodies.check_runs).toBe(checks);
    expect(body.raw_bodies.commit_status).toBe(status);
  });
  it("a pull request resolves to its head SHA before checking", async () => {
    const pr = JSON.stringify({ head: { sha: SHA }, html_url: "https://github.com/mohamedwael201193/verireceipt/pull/7" });
    stub({ pr });
    const result = await handleCodePatchVerify({ patch: "mohamedwael201193/verireceipt#7" });
    expect(result.commit).toBe(SHA);
    expect(result.conclusion).toBe("success");
  });
  it("a failing check run serves failure with passed=false, still a verified answer", async () => {
    const edited = JSON.parse(checks);
    edited.check_runs[0].conclusion = "failure";
    stub({ checks: JSON.stringify(edited), status: JSON.stringify({ ...JSON.parse(status), statuses: [] }) });
    const result = await handleCodePatchVerify({ patch: "mohamedwael201193/verireceipt@" + SHA });
    expect(result.conclusion).toBe("failure");
    expect(result.passed).toBe(false);
    expect(result.verdict).toBe("verified");
  });
  it("a running check serves pending at reduced confidence and says it is not final", async () => {
    const edited = JSON.parse(checks);
    edited.check_runs[0].status = "in_progress";
    edited.check_runs[0].conclusion = null;
    stub({ checks: JSON.stringify(edited), status: JSON.stringify({ ...JSON.parse(status), statuses: [] }) });
    const result = await handleCodePatchVerify({ patch: "mohamedwael201193/verireceipt@" + SHA });
    expect(result.conclusion).toBe("pending");
    expect(result.passed).toBe(false);
    expect(result.confidence).toBe(0.7);
    expect(String(result.answer)).toContain("not a final result");
  });
  it("no checks and no statuses is neutral, never an invented pass", async () => {
    stub({ checks: JSON.stringify({ total_count: 0, check_runs: [] }), status: JSON.stringify({ state: "pending", statuses: [], sha: SHA }) });
    const result = await handleCodePatchVerify({ patch: "mohamedwael201193/verireceipt@" + SHA });
    expect(result.conclusion).toBe("neutral");
    expect(result.passed).toBe(false);
    expect(String(result.answer)).toContain("nothing to verify");
  });
  it("an unknown repo or commit is 422, a rate limit is an honest 502", async () => {
    stub({ checks: 404, status: 404 });
    await expect(handleCodePatchVerify({ patch: "mohamedwael201193/verireceipt@" + SHA }))
      .rejects.toMatchObject({ status: 422, code: "PATCH_NOT_FOUND" });
    stub({ checks: 403, status: 403 });
    await expect(handleCodePatchVerify({ patch: "mohamedwael201193/verireceipt@" + SHA }))
      .rejects.toMatchObject({ status: 503, code: "GITHUB_RATE_LIMITED" });
  });
  it("GET /v1/code-patch is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/code-patch" })).toBe(true);
    stub({});
    const res = await app.inject({ method: "GET", url: `/v1/code-patch?patch=mohamedwael201193/verireceipt@${SHA}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().conclusion).toBe("success");
    await app.close();
  });
});


describe("reference resolution and bounded requests", () => {
  it("bare repo resolves actual captured default HEAD with only three calls, then cache reuses bytes", async () => {
    const headRaw = fixture("github-head-resolution.json"); const head = JSON.parse(headRaw).sha;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url); calls.push(u);
      return new Response(u.endsWith("/commits/HEAD") ? headRaw : u.includes("check-runs") ? checks : JSON.stringify({ ...JSON.parse(status), sha: head }));
    });
    const out = await handleCodePatchVerify({ patch: "mohamedwael201193/verireceipt" });
    expect(out.commit).toBe(head); expect(calls).toHaveLength(3);
    expect(calls[1]).toContain(`/commits/${head}/check-runs`);
    expect(out.answer).toContain("default-branch HEAD");
    const again = await handleCodePatchVerify({ patch: "mohamedwael201193/verireceipt" });
    expect(calls).toHaveLength(3); expect(again.passed).toBe(out.passed);
  });
  it("Actions URL resolves captured run head, never treats run ID as a commit", async () => {
    const raw = fixture("github-run-resolution.json"); const run = JSON.parse(raw); const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => { const u = String(url); calls.push(u); return new Response(u.includes("/actions/runs/") ? raw : u.includes("check-runs") ? checks : JSON.stringify({ ...JSON.parse(status), sha: run.head_sha })); });
    const out = await handleCodePatchVerify({ patch: `https://github.com/actions/checkout/actions/runs/${run.id}` });
    expect(out.commit).toBe(run.head_sha); expect(calls).toHaveLength(3);
    expect(calls[1]).toContain(run.head_sha);
  });
  it("free text makes no API calls and never invents a successful patch", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const out = await handleCodePatchVerify({ patch: "please check this diff" });
    expect(out.passed).toBe(false); expect(out.conclusion).toBe("neutral"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("leading answer includes actual failing check names", async () => {
    const bad = JSON.parse(checks); bad.check_runs[0].conclusion = "failure";
    stub({ checks: JSON.stringify(bad) });
    const out = await handleCodePatchVerify({ patch: "mohamedwael201193/verireceipt@" + SHA });
    expect(String(out.answer)).toMatch(/^passed=false; conclusion=failure; failing checks:/);
    expect(out.answer).toContain(bad.check_runs[0].name);
  });
});


it("does not assert success when checks are truncated by the bounded API page", async () => {
  const partial = JSON.parse(checks); partial.total_count = partial.check_runs.length + 1;
  stub({ checks: JSON.stringify(partial) });
  const out = await handleCodePatchVerify({ patch: "mohamedwael201193/verireceipt@" + SHA });
  expect(out.passed).toBe(false); expect(out.conclusion).toBe("pending"); expect(out.answer).toContain("incomplete");
});
it("refreshes source responses after60 seconds rather than serving stale CI forever", async () => {
  const spy = vi.spyOn(Date, "now"); const now = Date.now(); spy.mockReturnValue(now);
  let calls = 0;
  vi.stubGlobal("fetch", async (url: unknown) => { calls++; return new Response(String(url).includes("check-runs") ? checks : status); });
  try {
    await handleCodePatchVerify({ patch: "mohamedwael201193/verireceipt@" + SHA });
    expect(calls).toBe(2); spy.mockReturnValue(now + 60001);
    await handleCodePatchVerify({ patch: "mohamedwael201193/verireceipt@" + SHA });
    expect(calls).toBe(4);
  } finally { spy.mockRestore(); }
});
it("cached CI pass retains original acquisition time in receipt and evidence after59 seconds", async () => {
 const now = Date.now(); const spy = vi.spyOn(Date,"now").mockReturnValue(now);
 const f = vi.fn(async(u:unknown)=>new Response(String(u).includes("check-runs")?checks:status));vi.stubGlobal("fetch",f);
 try {
 const first=await handleCodePatchVerify({patch:"mohamedwael201193/verireceipt@"+SHA});
 spy.mockReturnValue(now+59000);
 const next=await handleCodePatchVerify({patch:"mohamedwael201193/verireceipt@"+SHA});
 const a=first.receipt as {fetched_at:string}; const b=next.receipt as {fetched_at:string;receipt_id:string};
 expect(f).toHaveBeenCalledTimes(2);expect(b.fetched_at).toBe(a.fetched_at);expect(b.fetched_at).toBe(new Date(now).toISOString());
 const stored=await getReceiptEvidence(b.receipt_id); const evidence=JSON.parse(String(stored.evidence));
 expect(evidence.fetched_at).toBe(a.fetched_at);expect(evidence.as_of).toBe(a.fetched_at);
 }finally{spy.mockRestore()}
});
