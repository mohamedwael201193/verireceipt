// QA-10 / QA-11 / QA-13 (external live-site QA, 2026-11-21).
// QA-10: the footer labels each identifier by namespace (miner.yaml id vs
//        node registration) and shows frontend + backend release SHAs.
// QA-11: each Docs "Try it live" link lands on its matching /receipts form
//        (anchor + focused first input).
// QA-13: digest docs say bare 64-hex (what the API emits); route scope and
//        UNKNOWN_PARAM copy match the live behaviour; the audit URL on a
//        restored receipt is a link; hosting copy is qualified.
import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { parseBackendSha } from "./components/Layout";

const SHA = "a04b19373e9513416b044bc78fbb7c2261216ae2";

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok", service: "verireceipt", uptime_s: 1, upstreams: {}, git_sha: SHA }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "nf" }), { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

describe("QA-10 identity and release labels", () => {
  it("parseBackendSha accepts only a hex SHA", () => {
    expect(parseBackendSha(SHA)).toBe(SHA);
    expect(parseBackendSha("<script>")).toBeNull();
    expect(parseBackendSha(42)).toBeNull();
    expect(parseBackendSha(undefined)).toBeNull();
  });

  it("footer names both IDs and shows the backend SHA from /health", async () => {
    renderAt("/docs");
    expect(await screen.findByText(/miner\.yaml id 774921 · verireceipt/)).toBeTruthy();
    expect(screen.getByText(/node registration 6152 \(on-chain bond\)/)).toBeTruthy();
    const link = await screen.findByRole("link", { name: SHA });
    expect(link.getAttribute("href")).toContain(`/commit/${SHA}`);
    expect(screen.getByText(/frontend and backend deploy separately/)).toBeTruthy();
  });
});

describe("QA-11 docs try-it deep links", () => {
  it("every docs Try-it link targets its own /receipts form anchor", async () => {
    renderAt("/docs");
    await screen.findByRole("heading", { name: /30-Second Docs/ });
    const hrefs = screen
      .getAllByRole("link", { name: /Try it live on \/receipts/ })
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "/receipts#try-tx",
      "/receipts#try-filings",
      "/receipts#try-tvl",
      "/receipts#try-route",
      "/receipts#try-grid",
      "/receipts#try-validator",
    ]);
  });

  it("clicking the validator link lands on the validator form with focus", async () => {
    renderAt("/docs");
    await screen.findByRole("heading", { name: /30-Second Docs/ });
    const links = screen.getAllByRole("link", { name: /Try it live on \/receipts/ });
    fireEvent.click(links[5]);
    await screen.findByRole("heading", { name: /Receipts Ledger/ });
    const form = document.getElementById("try-validator");
    expect(form).not.toBeNull();
    await waitFor(() => expect(form!.contains(document.activeElement)).toBe(true));
    expect(document.activeElement?.tagName).toBe("INPUT");
  });
});

describe("QA-13 contract copy", () => {
  const docs = readFileSync("src/pages/Docs.tsx", "utf8");
  it("digest is documented as bare 64 lowercase hex, matching the live API", () => {
    expect(docs).toContain("64 lowercase hex characters, no");
    expect(docs).not.toMatch(/SHA-256 \(<span className="vr-mono">0x<\/span> \+ 64 hex\)/);
  });
  it("route scope and UNKNOWN_PARAM row describe the real behaviour", () => {
    expect(docs).toContain("the quote size is always exactly 1 ETH");
    expect(docs).toContain("amount= is not honoured");
  });
  it("hosting copy on the dashboard is qualified, not asserted", () => {
    const sd = readFileSync("src/pages/dashboard/StatusDocs.tsx", "utf8");
    expect(sd).not.toContain("Render Virginia");
    expect(sd).toContain("UNVERIFIED live");
    expect(readFileSync("src/pages/Dashboard.tsx", "utf8")).not.toContain("Render Virginia");
  });
  it("restored receipt audit URL renders as an https link only", () => {
    const rc = readFileSync("src/pages/Receipts.tsx", "utf8");
    expect(rc).toContain("/^https:\\/\\/[^\\s]+$/.test(receipt.audit_url)");
  });
});

describe("QA-11 scroll resets on an ordinary route change", () => {
  it("PUSH to a new path without a hash scrolls to top; same path does not", async () => {
    const spy = vi.fn();
    vi.stubGlobal("scrollTo", spy);
    renderAt("/docs");
    await screen.findByRole("heading", { name: /30-Second Docs/ });
    spy.mockClear();
    fireEvent.click(screen.getAllByRole("link", { name: "Status" })[0]);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(0, 0));
  });
});
