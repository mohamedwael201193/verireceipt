// pc2-xtab-r7 (J1 residual 2): the escrow tab must send `params` (official
// engine-ask.md request field; `input` is a live HTTP 400) and must follow
// the official escrow-inference.md envelope (telegraph-docs c652c68).
import { describe, expect, it } from "vitest";
import { DOC_SNIPPETS } from "./docs";

describe("escrow docs tab", () => {
  const s = DOC_SNIPPETS.escrow;
  it("posts intent + params, never input", () => {
    expect(s).toContain("JSON.stringify({ intent, params, max_budget_usdc: 40000 })");
    expect(s).not.toMatch(/\{\s*intent,\s*input\b/);
    expect(s).not.toMatch(/"input"\s*:/);
  });
  it("uses the official X-PAYMENT escrow envelope", () => {
    expect(s).toContain('x402Version: 2, scheme: "escrow", network: escrow.network');
    expect(s).toContain("payload: { signature, authorization }");
    expect(s).toContain('"X-PAYMENT": payment');
    expect(s).toContain("to: escrow.payTo");
    expect(s).toContain("from: account.address.toLowerCase()");
    expect(s).toContain("template.match(/Amount:\\s*(\\d+)\\s*uUSDC/)![1]");
  });
  it("the curl tab also posts params", () => {
    expect(DOC_SNIPPETS.curl).toContain('"params":{"protocol":"aave-v3"}');
  });
});
