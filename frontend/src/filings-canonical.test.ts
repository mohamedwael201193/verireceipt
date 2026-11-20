import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Vitest runs with cwd = frontend/, so source files are read by relative path.
const read = (rel: string) => readFileSync(rel, "utf8");

/**
 * Filings canonical question (2026-11-20 click-test defect 3): the landing
 * preview said "52 filings · AAPL" while /dashboard and /status said "95
 * filings" for AAPL on the same day. Cause, proven live: the two numbers
 * answer two different questions — "last 6 months" returns 52, "last 12
 * months" returns 95 (entity string AAPL vs Apple makes no difference;
 * both resolve to CIK 0000320193). The canonical question is now
 * AAPL · last 12 months everywhere a fixed filings figure is displayed,
 * so the same question gives the same answer on every page. This test pins
 * that alignment at the source level; the live numbers are re-checked by
 * the Playwright run in ~/workspace/verireceipt-frontend/repro/
 * (nav-test.mjs filings mode) against the real API.
 */
describe("filings canonical question: AAPL · last 12 months everywhere", () => {
  it("no fixed AAPL/Apple filings display still uses 'last 6 months'", () => {
    const files = [
      "src/pages/landing/data.ts",
      "src/pages/dashboard/benchmarks.ts",
      "src/pages/dashboard/presets.ts",
      "src/pages/dashboard/StatusDocs.tsx",
      "src/pages/dashboard/docs.ts",
      "src/pages/dashboard/utils.ts",
      "src/pages/Status.tsx",
      "src/pages/Benchmarks.tsx",
      "src/pages/Receipts.tsx",
      "src/pages/Docs.tsx",
    ];
    for (const f of files) {
      expect(read(f), f).not.toContain("last 6 months");
    }
  });

  it("landing preview, dashboard benchmarks and status/docs all ask AAPL · last 12 months", () => {
    expect(read("src/pages/landing/data.ts")).toContain(
      'sec: { entity: "AAPL", period: "last 12 months" }',
    );
    expect(read("src/pages/dashboard/benchmarks.ts")).toContain(
      'getFilings({ entity: "AAPL", period: "last 12 months" }',
    );
    expect(read("src/pages/dashboard/benchmarks.ts")).toContain("AAPL · last 12 months");
    expect(read("src/pages/Status.tsx")).toContain(
      "getFilings({ entity: 'AAPL', period: 'last 12 months' })",
    );
    expect(read("src/pages/Benchmarks.tsx")).toContain(
      "getFilings({ entity: 'AAPL', period: 'last 12 months' }, signal)",
    );
    expect(read("src/pages/dashboard/StatusDocs.tsx")).toContain(
      'getFilings({ entity: "AAPL", period: "last 12 months" }, signal)',
    );
    // The dashboard's docs panel must ask the same question (filings J2
    // minor 3): pin the canonical curl itself, not just the presence of
    // the string "AAPL" (J2 R3 M2 — the old pin was weaker than claimed).
    expect(read("src/pages/dashboard/docs.ts")).toContain(
      "entity=AAPL&period=last%2012%20months",
    );
    expect(read("src/pages/dashboard/docs.ts")).not.toContain("Apple Inc");
    expect(read("src/pages/Receipts.tsx")).toContain("entity: 'AAPL',");
    // The /receipts try-it defaults must be the canonical question too:
    // AAPL entity AND last-12-months period (filings J2 minor 3).
    expect(read("src/pages/Receipts.tsx")).toContain("period: 'last 12 months',");
    // Counts shown next to a filings figure must carry their window
    // (filings J2 minor 1): the landing visual and the deck summary both
    // render the period beside the count.
    expect(read("src/pages/landing/IntentIde.tsx")).toContain(
      "{data.filing_count} filings · {period}",
    );
    expect(read("src/pages/landing/ReceiptDeck.tsx")).toContain("in ${period}");
    // Every other filings-count template must carry the window too
    // (J2 R3 B1–B3): the IDE headline, the desk stream outcome, and both
    // Mission Desk why-cards — including the m13-sec card that used to
    // render the literal unfinished placeholder "in period".
    expect(read("src/pages/landing/IntentIde.tsx")).toContain(
      "{d.filing_count} filings · ${d.entity}${period ? ` · ${period}` : \"\"}",
    );
    expect(read("src/pages/landing/calls.ts")).toContain(
      "${d.entity} · ${d.filing_count} filings${period ? ` · ${period}` : \"\"}",
    );
    expect(read("src/pages/landing/calls.ts")).not.toContain(
      "return `${d.entity} · ${d.filing_count} filings`;",
    );
    // Both Mission Desk why-cards carry the window parsed from the
    // actual request URL (filingsPeriodOf); the m13-sec card used to
    // render the literal unfinished placeholder "in period".
    expect(read("src/pages/dashboard/presets.ts")).toContain(
      "filings for ${filingsBody.entity}${filingsPeriod ? ` in ${filingsPeriod}` : \"\"}",
    );
    expect(read("src/pages/dashboard/presets.ts")).toContain(
      "function filingsPeriodOf(result: DeskCheckResult | undefined): string {",
    );
    expect(read("src/pages/dashboard/presets.ts")).not.toContain("in period`");
    // The three remaining bare-count strings from round 3 (filings J1
    // R3 M1 / J2 R3 M1) now carry the window too — the status probe
    // detail reads it from the probe's own query string, the
    // dashboard ledger summary from the call's own query string, and
    // the /receipts try-it summary from the form values.
    expect(read("src/pages/Status.tsx")).toContain(
      "${count} filings${entity ? ` · ${entity}` : ''}${period ? ` · ${period}` : ''}",
    );
    expect(read("src/pages/Status.tsx")).toContain(
      "detail: probeDetail(probe.key, data, probe.methodPath),",
    );
    expect(read("src/pages/Status.tsx")).not.toContain(
      "return `${String(d.filing_count ?? '—')} filings`;",
    );
    expect(read("src/pages/dashboard/utils.ts")).toContain(
      "${b.filing_count} filings${entity ? ` · ${entity}` : \"\"}${period ? ` · ${period}` : \"\"}",
    );
    expect(read("src/pages/dashboard/utils.ts")).toContain(
      "summary: summaryFor(endpoint, receipt.body, params),",
    );
    // The human-readable "entity · period" form is parsed as a
    // fallback when the query string carries no `=` pairs (filings
    // J1/J2 R4 M1 — requestUrl unparseable, params = receipt.query).
    expect(read("src/pages/dashboard/utils.ts")).toContain('.split("·")');
    expect(read("src/pages/dashboard/utils.ts")).not.toContain(
      "return `${b.filing_count} filings`;",
    );
    expect(read("src/pages/Receipts.tsx")).toContain(
      "filings · ${values.entity.trim()} · ${values.period.trim()}",
    );
    // Call sites are pinned too (filings J2 R3 M3): the templates above
    // only render the window when the caller passes it — a call-site
    // regression would pass the template pins while rendering
    // windowless.
    expect(read("src/pages/landing/IntentIde.tsx")).toContain(
      'metricFor(meta.key, dataForTab, meta.key === "sec" ? PRESETS.sec.period : undefined)',
    );
    expect(read("src/pages/landing/DeskStage.tsx")).toContain(
      "out: outcomeFor(key, data, params[key]),",
    );
    // The docs example uses the canonical entity string (filings J1 M1).
    expect(read("src/pages/Docs.tsx")).toContain("entity=AAPL&period=last%2012%20months");
    expect(read("src/pages/Docs.tsx")).not.toContain("entity=Apple%20Inc");
  });
});
