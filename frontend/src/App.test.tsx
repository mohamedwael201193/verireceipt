import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const HEALTH_OK = { status: "ok", service: "verireceipt", uptime_s: 123 };

// App itself renders <Routes/>; the <BrowserRouter> lives in main.tsx,
// so tests wrap App in a MemoryRouter instead.
function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
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

describe("App smoke test", () => {
  it("renders the landing route with all nav links", async () => {
    renderApp();
    for (const label of ["Home", "Dashboard", "Receipts", "Benchmarks", "Status", "Docs"]) {
      expect(await screen.findByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(await screen.findByRole("heading", { name: /zero-LLM receipt/i })).toBeInTheDocument();
    expect(
      screen.getByText(/Deterministic intelligence for Telegraph Season II/),
    ).toBeInTheDocument();
  });

  it("shows a live health pill from /api/health", async () => {
    renderApp();
    // Scoped to the pill by class: the real landing also contains the
    // word "live" in its own copy, and its toast region also carries
    // role="status" — so neither a bare /live/i query nor getByRole("status")
    // is unique any more.
    await waitFor(() => {
      const pill = document.querySelector(".health-pill");
      expect(pill).not.toBeNull();
      expect(pill!.textContent).toMatch(/live/i);
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/health", expect.anything());
  });

  it("theme toggle switches theme and persists it in localStorage", async () => {
    renderApp();
    const toggle = await screen.findByRole("button", { name: /Toggle dark obsidian/i });

    fireEvent.click(toggle);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("verireceipt-theme")).toBe("light");

    fireEvent.click(toggle);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem("verireceipt-theme")).toBe("dark");
  });

  it("navigates to the dashboard route", async () => {
    renderApp();
    fireEvent.click(await screen.findByRole("link", { name: "Dashboard" }));
    expect(
      await screen.findByRole("heading", { name: /Dashboard & Proof Hub/ }),
    ).toBeInTheDocument();
  });
});
