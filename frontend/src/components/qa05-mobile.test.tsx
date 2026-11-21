// QA-05 (external live-site QA, 2026-11-21): below 860px the primary
// links were hidden with no replacement; the Dashboard desk cards were
// ~500px wide in a 390px viewport; the Status table broke labels into
// fragments. jsdom applies no layout, so the menu is tested for
// behaviour and the CSS for the rules that fix the layout (the real
// browser smoke measures the result at 320/390/430/820 px).

import { readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import Layout from "./Layout";

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderShell(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="*" element={<Where />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("QA-05 mobile navigation menu", () => {
  it("opens with all seven destinations and navigates", () => {
    renderShell("/");
    const btn = screen.getByRole("button", { name: "Open menu" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    const nav = screen.getByRole("navigation", { name: "Primary (mobile)" });
    const labels = [...nav.querySelectorAll("a")].map((a) => a.textContent);
    expect(labels).toEqual(["Home", "Dashboard", "Receipts", "Benchmarks", "Status", "Docs", "Research"]);
    expect(screen.getByRole("button", { name: "Close menu" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(nav.querySelectorAll("a")[2]);
    expect(screen.getByTestId("where").textContent).toBe("/receipts");
    // Navigation closes the panel.
    expect(screen.queryByRole("navigation", { name: "Primary (mobile)" })).toBeNull();
  });

  it("Escape closes the panel and returns focus to the button", () => {
    renderShell("/docs");
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(screen.getByRole("navigation", { name: "Primary (mobile)" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("navigation", { name: "Primary (mobile)" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open menu" }));
  });

  it("an outside click closes the panel", () => {
    renderShell("/");
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.mouseDown(screen.getByTestId("where"));
    expect(screen.queryByRole("navigation", { name: "Primary (mobile)" })).toBeNull();
  });
});

describe("QA-05 layout CSS", () => {
  it("the menu button shows exactly where the inline links hide (<= 860px)", () => {
    const css = readFileSync("src/styles/tokens.css", "utf8");
    expect(css).toMatch(/@media \(max-width: 860px\) \{\s*\.nav-links \{\s*display: none;/);
    expect(css).toMatch(/@media \(max-width: 860px\) \{\s*\.nav-menu-btn \{\s*display: inline-flex;/);
  });

  it("dashboard desk grid columns may shrink below content width", () => {
    const css = readFileSync("src/pages/dashboard/dashboard.css", "utf8");
    expect(css).toMatch(/\.desk-grid \{[^}]*grid-template-columns: minmax\(0, 5fr\) minmax\(0, 7fr\)/);
    expect(css).toMatch(/max-width: 1024px\) \{ \.vr-dashboard \.desk-grid \{ grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.vr-dashboard \.desk-grid > \*,\s*\.vr-dashboard \.card \{ min-width: 0;/);
  });

  it("status table scrolls inside its wrapper on phones instead of fragmenting", () => {
    const src = readFileSync("src/pages/Status.tsx", "utf8");
    expect(src).toContain("@media (max-width:760px){.vr-tbl{min-width:720px}}");
    expect(src).toMatch(/\.vr-tbl-wrap\{overflow-x:auto/);
  });
});
