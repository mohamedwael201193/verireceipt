import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

// Vitest runs with cwd = frontend/, so source files are read by relative path.
const readFrontendFile = (rel: string) => readFileSync(rel, "utf8");

const HEALTH_OK = { status: "ok", service: "verireceipt", uptime_s: 123 };

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.setAttribute("data-theme", "dark");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => HEALTH_OK,
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("routes (J1-5): placeholder page content per route", () => {
  it.each([
    ["/receipts", /Receipts/, /Receipts explorer coming from the page worker/],
    ["/benchmarks", /Benchmarks/, /Benchmarks coming from the page worker/],
    ["/status", /Status/, /Status page coming from the page worker/],
    ["/docs", /Docs/, /Docs coming from the page worker/],
  ])("renders %s with its own heading and note", async (path, heading, note) => {
    renderAt(path);
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByText(note)).toBeInTheDocument();
  });
});

describe("footer copy (J1-5)", () => {
  it("shows the tagline, copyright, and sitemap links", async () => {
    renderAt("/");
    expect(
      await screen.findByText(/Zero-LLM Cryptographic Receipt Oracle & Mission 13\/12 Desk\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/© 2026 VeriReceipt · Telegraph Season II/)).toBeInTheDocument();
    expect(screen.getByText(/\/\/ zero llm\. receipt-first\./)).toBeInTheDocument();

    expect(screen.getByRole("link", { name: "Intents" })).toHaveAttribute("href", "/docs");
    expect(screen.getByRole("link", { name: "Guarantees" })).toHaveAttribute("href", "/docs");
    expect(screen.getByRole("link", { name: "Roadmap" })).toHaveAttribute("href", "/#roadmap");
    expect(screen.getByRole("link", { name: "Manifesto" })).toHaveAttribute("href", "/#manifesto");
  });
});

describe("catch-all route (J2 M4)", () => {
  it("renders a real 404 page instead of redirecting home", async () => {
    renderAt("/no-such-page");
    expect(await screen.findByRole("heading", { name: /Page not found/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Home ↑" })).toHaveAttribute("href", "/");
    // The landing heading must NOT appear: no silent redirect happened.
    expect(screen.queryByRole("heading", { name: /Zero-LLM Receipt Oracle/ })).not.toBeInTheDocument();
  });
});

describe("mobile nav (B1): theme toggle stays reachable", () => {
  it("CTA links to the landing probe section with a compact label", async () => {
    renderAt("/");
    const cta = await screen.findByRole("link", { name: "Start a probe" });
    expect(cta).toHaveAttribute("href", "/#probe");
    expect(cta).toHaveTextContent("Start a probe");
    expect(cta).toHaveTextContent("Probe");
    expect(await screen.findByRole("button", { name: /Toggle dark obsidian/i })).toBeInTheDocument();
  });

  it("CSS keeps the toggle reachable: wrap fallback, compact CTA, hidden pill", () => {
    const css = readFrontendFile("src/styles/tokens.css");
    // Fallback: the nav row may wrap instead of clipping (navbar is
    // min-height, not fixed height, so wrapped content is not cut off).
    expect(css).toMatch(/\.navbar\s*\{[^}]*min-height:\s*68px/);
    expect(css).toMatch(/\.nav-inner\s*\{[^}]*flex-wrap:\s*wrap/);
    // Below 860px the CTA collapses to the short "Probe" label.
    expect(css).toMatch(/@media\s*\(max-width:\s*860px\)[\s\S]*?\.cta-label-short\s*\{[^}]*display:\s*inline/);
    // Below 560px the health pill is hidden so wordmark + CTA + toggle fit.
    expect(css).toMatch(/@media\s*\(max-width:\s*560px\)[\s\S]*?\.health-pill\s*\{[^}]*display:\s*none/);
    // Ordering matters: the 560px hide must come AFTER the .health-pill
    // base rule (same specificity — source order decides), otherwise the
    // base display:inline-flex overrides the hide.
    const baseAt = css.indexOf(".health-pill {");
    const hideAt = css.indexOf("@media (max-width: 560px)");
    expect(baseAt).toBeGreaterThan(-1);
    expect(hideAt).toBeGreaterThan(baseAt);
  });

  it("footer breakpoint is the design value 780px (J1-1)", () => {
    const css = readFrontendFile("src/styles/tokens.css");
    expect(css).toMatch(/@media\s*\(max-width:\s*780px\)\s*\{\s*\.foot-cols/);
    expect(css).not.toMatch(/@media\s*\(max-width:\s*860px\)\s*\{\s*\.foot-cols/);
  });
});
