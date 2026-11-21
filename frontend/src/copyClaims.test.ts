// pc2-xtab-r6: unverified marketing / stale claims removed from the copy must
// not come back. Scans every non-test source file under src/ (string content
// and comments alike, except the one Status.tsx comment that documents the
// absence of the claim).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = __dirname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "fixtures" ? [] : files(p);
    return /\.(tsx?|css)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

const BANNED: Array<[RegExp, string]> = [
  [/always-warm/i, "Render plan/warmth is not reported by the API (see /status)"],
  [/zero cold starts?/i, "unverified"],
  [/US-East/, "region is not reported by the API (see /status)"],
  [/LlamaRPC/, "not an upstream: chains.ts dropped it"],
  [/under 25 ?ms/i, "unmeasured latency claim"],
  [/<\s?200 ?ms/i, "unmeasured failover claim"],
  [/in 30 seconds/i, "unmeasured"],
  [/zero charge|zero billing/i, "billing is the node's, not the miner's"],
  [/instant responses/i, "unmeasured"],
  [/\$1\.40/, "stale bond (on-chain is $1.50)"],
  // pc2-xtab-r7 (J1 residual 1 / J2): timeouts are per intent and the
  // miner constructs no CircuitBreaker (the breaker is the node's).
  [/times out at 4\.5 ?s/i, "single-timeout over-claim: timeouts are per intent (see plate08 test)"],
  [/4\.5 ?s abort cap/i, "single-timeout over-claim"],
  [/per-upstream breaker/i, "the miner never constructs CircuitBreaker"],
  [/cron cache/i, "grid is an in-process 5-minute ingester into SQLite, not a cron cache"],
  // J2 Minor 1: quorum size is per chain (polygon / base-sepolia are 2-of-2).
  [/2-of-3 on most chains/i, "state the per-chain quorum"],
  [/"2-of-3 Archive RPC Quorum"/i, "state the per-chain quorum"],
  [/quorum · 2-of-3"/i, "state the per-chain quorum"],
  // J1 residual 2: the Engine Ask request field is `params`; `input` is a 400.
  [/"input"\s*:\s*\{|\{\s*intent,\s*input\b/, "Engine Ask request field is params (engine-ask.md)"],
  // pc2-xtab-r8: the miner serves no MCP endpoint (live 404 on GET and POST,
  // 2026-11-21; server.ts has no MCP route). A real one ships as its own piece.
  [/\/api\/mcp/, "no miner MCP endpoint exists (HTTP 404)"],
  [/Streamable HTTP MCP/i, "no miner MCP endpoint exists"],
  // pc2-xtab-r9: sponsored escrow settlement is not shipped (plate 09,
  // Desk Phase D); no copy may present it as live.
  [/server-funded/i, "sponsored escrow settlement is not shipped (Desk Phase D)"],
  [/settle[sd]? (from|via|on) (the )?[^.]*escrow/i, "sponsored escrow settlement is not shipped (Desk Phase D)"],
  [/Sponsored Escrow Mode/i, "sponsored escrow settlement is not shipped (Desk Phase D)"],
];

describe("frontend copy makes no unverified claims", () => {
  const all = files(ROOT);
  it("scans a real tree", () => {
    expect(all.length).toBeGreaterThan(50);
  });
  for (const [re, why] of BANNED) {
    it(`no ${re} (${why})`, () => {
      const hits = all.flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => [line, i + 1] as const)
          .filter(([line]) => re.test(line))
          .filter(([line]) => !(f.endsWith("pages/Status.tsx") && /No "Always-Warm" claim/.test(line)))
          .map(([, n]) => `${relative(ROOT, f)}:${n}`),
      );
      expect(hits).toEqual([]);
    });
  }
});

// pc2-xtab-r9: repo docs use the same recomputation as the curl tab
// (stored bytes at /receipts/:id/raw), never a live upstream re-fetch.
describe("repo docs recompute receipts from stored bytes", () => {
  const REPO = join(ROOT, "..", "..");
  for (const doc of ["JUDGE.md", "README.md"]) {
    it(`${doc} never hashes a live upstream_url re-fetch`, () => {
      const text = readFileSync(join(REPO, doc), "utf8");
      expect(text).not.toMatch(/curl[^\n]*upstream_url[^\n]*\|\s*sha256sum/);
    });
  }
  it("JUDGE.md uses /receipts/$RECEIPT_ID/raw | sha256sum", () => {
    const text = readFileSync(join(REPO, "JUDGE.md"), "utf8");
    expect(text).toContain('curl -s "$BASE/receipts/$RECEIPT_ID/raw" | sha256sum');
  });
  it("the Sponsored card marks escrow settlement UNVERIFIED until Desk Phase D", () => {
    const text = readFileSync(join(ROOT, "pages", "dashboard", "AuthDrawer.tsx"), "utf8");
    expect(text).toContain("UNVERIFIED — not shipped until Desk Phase D");
  });
});
