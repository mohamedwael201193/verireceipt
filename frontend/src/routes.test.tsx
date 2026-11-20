import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("routes (merge): real page content per route", () => {
  it.each([
    ["/receipts", /Receipts Ledger/, /public auditable ledger/],
    ["/benchmarks", /Latency Benchmarks/, /measured round-trips, never simulated/],
    ["/status", /Service Status/, /live probes only/],
    ["/docs", /30-Second Docs/, /as registered in miner\.yaml/],
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

describe("hash scrolling (J2 B1): clicks scroll, not just change the URL", () => {
  let scrollSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy as unknown as typeof Element.prototype.scrollIntoView;
  });

  afterEach(() => {
    // @ts-expect-error jsdom has no scrollIntoView — remove the mock.
    delete Element.prototype.scrollIntoView;
  });

  // The scaffold's placeholder Landing has no sections: the scroll
  // targets come from fixtures standing in for the real landing page
  // (src/test/landing-anchor-ids.json, committed in THIS repo: probe,
  // roadmap, manifesto — the ids of the real landing's Probe,
  // SprintMatrix and Manifesto sections). What this proves is the App
  // wiring — hash navigation reaches ScrollToHash and scrolls the
  // element with that id; the ids themselves are the fixture values,
  // and the browser check measures the real scroll. The fixture must
  // stay in-repo: the old test read the sibling work-landing worktree
  // (../../work-landing/...) and went ENOENT on a clean checkout
  // (J1/J2 R2 B-J1-1).
  const LANDING_IDS = JSON.parse(
    readFrontendFile("src/test/landing-anchor-ids.json"),
  ) as Record<string, string>;

  function renderAppWithLandingSections(initialEntries: string[]) {
    return render(
      <MemoryRouter initialEntries={initialEntries}>
        {Object.values(LANDING_IDS).map((id) => (
          <section key={id} id={id}>
            {id} section
          </section>
        ))}
        <App />
      </MemoryRouter>,
    );
  }

  it.each([
    ["Start a probe", "probe"],
    ["Roadmap", "roadmap"],
    ["Manifesto", "manifesto"],
  ])("clicking %s scrolls the #%s element into view", async (label, id) => {
    renderAppWithLandingSections(["/"]);
    fireEvent.click(await screen.findByRole("link", { name: label }));
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1));
    expect(scrollSpy.mock.instances[0]).toBe(document.getElementById(id));
  });

  it("initial load with a hash scrolls once the route mounts", async () => {
    renderAppWithLandingSections(["/#manifesto"]);
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1));
    expect(scrollSpy.mock.instances[0]).toBe(document.getElementById("manifesto"));
  });

  it("footer anchor targets match the landing fixture ids (J2 B1a)", () => {
    // No sprint-matrix links/ids in app code; this test file asserts
    // their absence (J1 R2 minor 2 — the old "zero sprint-matrix refs"
    // wording was wrong: the test file itself mentions sprint-matrix
    // in these negative assertions).
    expect(LANDING_IDS.probe).toBe("probe");
    expect(LANDING_IDS.roadmap).toBe("roadmap");
    expect(LANDING_IDS.manifesto).toBe("manifesto");
    // And the scaffold links point at those fixture ids, not sprint-matrix.
    const layout = readFrontendFile("src/components/Layout.tsx");
    expect(layout).toContain('to="/#probe"');
    expect(layout).toContain('to="/#roadmap"');
    expect(layout).toContain('to="/#manifesto"');
    expect(layout).not.toContain("sprint-matrix");
    const css = readFrontendFile("src/styles/tokens.css");
    expect(css).not.toContain("sprint-matrix");
    const app = readFrontendFile("src/App.tsx");
    expect(app).toContain("ScrollToHash");
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
