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
  // pc2-xtab-r9: sponsored escrow settlement is not shipped (plate 09);
  // no copy may present it as live. Desk Phase D proves the Desk AGENT's
  // own escrow-paid engine purchases (desk/ledger/purchases.jsonl), not
  // escrow sponsorship of visitor checks, so these bans stay.
  [/server-funded/i, "visitor checks are not escrow-sponsored"],
  [/settle[sd]? (from|via|on) (the )?[^.]*escrow/i, "visitor checks are not escrow-sponsored"],
  [/Sponsored Escrow Mode/i, "visitor checks are not escrow-sponsored"],
  // Desk Phase D: the pre-Phase-D labels are stale where purchases are proven.
  [/not shipped until Desk Phase D/i, "Desk Phase D purchases are proven; label the visitor-sponsorship gap instead"],
  [/escrow-paid runs are UNVERIFIED/i, "Desk Phase D purchases are proven (desk/ledger/purchases.jsonl)"],
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
  it("the Sponsored card keeps visitor escrow sponsorship UNVERIFIED", () => {
    const text = readFileSync(join(ROOT, "pages", "dashboard", "AuthDrawer.tsx"), "utf8");
    expect(text).toContain("UNVERIFIED — not shipped for visitor checks");
  });
});

// Desk Phase D: every claim of escrow-paid Desk purchases must be backed
// by the committed ledger, and the frontend copy of it must not drift.
describe("escrow-purchase claims are backed by the committed ledger", () => {
  const REPO = join(ROOT, "..", "..");
  const ledger = readFileSync(join(REPO, "desk", "ledger", "purchases.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const exported = JSON.parse(readFileSync(join(ROOT, "lib", "deskPurchases.json"), "utf8"));
  it("lib/deskPurchases.json equals desk/ledger/purchases.jsonl record for record", () => {
    expect(exported).toEqual(ledger);
  });
  it("copy that mentions escrow-paid purchases has at least one VERIFIED escrow record behind it", () => {
    const claims = files(ROOT).filter((f) => /escrow-paid/i.test(readFileSync(f, "utf8")));
    expect(claims.length).toBeGreaterThan(0);
    const verified = ledger.filter(
      (r: any) =>
        r.verdict === "VERIFIED" &&
        r.telegraph_receipt.rail === "escrow" &&
        r.checks.every((c: any) => c.ok) &&
        r.raw_sha256_recomputed === r.miner_receipt?.raw_response_sha256,
    );
    expect(verified.length).toBeGreaterThan(0);
  });
});


describe("Desk r4 shared catalogs stay in sync", () => {
  const REPO = join(ROOT, "..", "..");
  const ledgerRows = readFileSync(join(REPO, "desk", "ledger", "purchases.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  function extractArray(src: string, name: string): string[] {
    const m = src.match(new RegExp("export const " + name + " = \\[([\\s\\S]*?)\\] as const"));
    if (!m) throw new Error("missing " + name);
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  }
  function extractObjectLiteral(src: string, name: string): string {
    const start = src.indexOf("export const " + name);
    if (start < 0) throw new Error("missing " + name);
    const brace = src.indexOf("{", start);
    let depth = 0;
    for (let i = brace; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) return src.slice(brace, i + 1);
      }
    }
    throw new Error("unclosed " + name);
  }
  it("EXPECTED_VERIFY_CHECKS is identical in desk/src/verify.ts and frontend deskPurchases.ts", () => {
    const desk = readFileSync(join(REPO, "desk", "src", "verify.ts"), "utf8");
    const fe = readFileSync(join(ROOT, "lib", "deskPurchases.ts"), "utf8");
    expect(extractArray(fe, "EXPECTED_VERIFY_CHECKS")).toEqual(extractArray(desk, "EXPECTED_VERIFY_CHECKS"));
    expect(extractArray(fe, "EXPECTED_VERIFY_CHECKS")).toHaveLength(8);
  });
  it("TASK_CATALOG and VALUE_FIELD_BY_INTENT match desk/src/missions.ts", () => {
    const desk = readFileSync(join(REPO, "desk", "src", "missions.ts"), "utf8");
    const fe = readFileSync(join(ROOT, "lib", "taskCatalog.ts"), "utf8");
    expect(extractObjectLiteral(fe, "TASK_CATALOG")).toBe(extractObjectLiteral(desk, "TASK_CATALOG"));
    expect(extractObjectLiteral(fe, "VALUE_FIELD_BY_INTENT")).toBe(extractObjectLiteral(desk, "VALUE_FIELD_BY_INTENT"));
  });
  it("the committed ledger has unique receipt_hash, signal_hash, nonce, and receipt_id", () => {
    const hashes = ledgerRows.map((r: { telegraph_receipt: { receipt_hash: string } }) => r.telegraph_receipt.receipt_hash);
    const signals = ledgerRows.map((r: { signal_hash: string }) => r.signal_hash);
    const nonces = ledgerRows.map((r: { nonce: string }) => r.nonce);
    const ids = ledgerRows.map((r: { miner_receipt?: { receipt_id?: string } }) => r.miner_receipt?.receipt_id);
    expect(new Set(hashes).size).toBe(ledgerRows.length);
    expect(new Set(signals).size).toBe(ledgerRows.length);
    expect(new Set(nonces).size).toBe(ledgerRows.length);
    expect(new Set(ids).size).toBe(ledgerRows.length);
  });
});
