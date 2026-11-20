import { readFileSync } from "node:fs";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import { SESSION_RECEIPTS_KEY } from "./lib/sessionReceipts";

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

describe("receipts/:id deep link (Gemini 2026-11-20)", () => {
  // The receipts/:id route renders the Receipts page, not NotFound:
  // an id matching a receipt in this browser session opens that entry;
  // any other id shows an honest not-found notice (the API does not
  // serve /receipts/:id in this build — live check 2026-11-20: HTTP
  // 404 — so no backend fetch is attempted).
  it("renders the ledger with an honest not-found notice for an id outside this session", async () => {
    renderAt("/receipts/rcpt_NOT_IN_SESSION");
    expect(await screen.findByRole("heading", { name: /Receipts Ledger/ })).toBeInTheDocument();
    // The id sits in its own <span>, so the notice text is split across
    // nodes — assert on the notice container's full textContent (reached
    // via the unique "Show the full ledger" link; role="status" is not
    // unique — Layout's health pill has it too).
    const notice = screen
      .getByRole("link", { name: "Show the full ledger" })
      .closest("div");
    expect(notice?.textContent).toContain(
      "No receipt rcpt_NOT_IN_SESSION in this browser session",
    );
    expect(screen.queryByRole("heading", { name: /Page not found/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Show the full ledger" })).toHaveAttribute(
      "href",
      "/receipts",
    );
  });

  it("opens the matching ledger entry when the id is in this session", async () => {
    window.localStorage.setItem(
      SESSION_RECEIPTS_KEY,
      JSON.stringify([
        {
          key: "tx-rcpt_deeplink1",
          endpoint: "tx",
          label: "tx 0xafdbc83c…e92902 · ethereum",
          params: "tx_hash=0xafdbc83c485355d90f79fd660bcd12713402aa78922d966657d1005f59e92902&chain=ethereum",
          fetchedAt: "2026-11-20T10:00:00Z",
          receipt: {
            receipt_id: "rcpt_deeplink1",
            upstream_url: "https://example.com/upstream",
            raw_response_sha256: `0x${"a".repeat(64)}`,
            fetched_at: "2026-11-20T10:00:00Z",
          },
          summary: "confirmed · block 26454869",
        },
      ]),
    );
    renderAt("/receipts/rcpt_deeplink1");
    expect(await screen.findByRole("heading", { name: /Receipts Ledger/ })).toBeInTheDocument();
    const notice = screen
      .getByRole("link", { name: "Show the full ledger" })
      .closest("div");
    expect(notice?.textContent).toContain(
      "Showing receipt rcpt_deeplink1 from this browser session",
    );
    const badge = screen.getByText("linked receipt");
    expect(badge).toBeInTheDocument();
    expect(badge.closest("details")).toHaveAttribute("open");
  });

  // Two rows sharing one receipt_id (dedupe is by per-call key, never
  // by id) plus a third row, for the gemini J2 R5 B1 / A-scroll tests.
  function seedDupLedger() {
    window.localStorage.setItem(
      SESSION_RECEIPTS_KEY,
      JSON.stringify([
        {
          key: "tx-rcpt_dup-newer",
          endpoint: "tx",
          label: "tx 0xNEWER… · ethereum",
          params: "tx_hash=0xNEWER&chain=ethereum",
          fetchedAt: "2026-11-20T11:00:00.000Z",
          receipt: {
            receipt_id: "rcpt_DUP",
            upstream_url: "https://example.com/upstream",
            raw_response_sha256: `0x${"a".repeat(64)}`,
            fetched_at: "2026-11-20T11:00:00.000Z",
          },
          summary: "newer duplicate",
        },
        {
          key: "tx-rcpt_dup-older",
          endpoint: "tx",
          label: "tx 0xOLDER… · ethereum",
          params: "tx_hash=0xOLDER&chain=ethereum",
          fetchedAt: "2026-11-20T10:00:00.000Z",
          receipt: {
            receipt_id: "rcpt_DUP",
            upstream_url: "https://example.com/upstream",
            raw_response_sha256: `0x${"b".repeat(64)}`,
            fetched_at: "2026-11-20T10:00:00.000Z",
          },
          summary: "older duplicate",
        },
        {
          key: "tvl-rcpt_other",
          endpoint: "tvl",
          label: "tvl protocol=aave-v3",
          params: "protocol=aave-v3",
          fetchedAt: "2026-11-20T09:00:00.000Z",
          receipt: {
            receipt_id: "rcpt_other",
            upstream_url: "https://example.com/upstream",
            raw_response_sha256: `0x${"c".repeat(64)}`,
            fetched_at: "2026-11-20T09:00:00.000Z",
          },
          summary: "other row",
        },
      ]),
    );
  }

  // jsdom has no scrollIntoView — install a spy so the deep-link
  // effect's call count is observable, and remove it afterwards.
  function installScrollSpy() {
    const scrollSpy = vi.fn();
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
      value: scrollSpy,
      configurable: true,
    });
    return scrollSpy;
  }
  function removeScrollSpy() {
    delete (window.HTMLElement.prototype as unknown as Record<string, unknown>)
      .scrollIntoView;
  }

  it("a user-closed deep-linked row stays closed — and the viewport stays put — when the ledger grows (gemini J2 R5 B1)", async () => {
    // The judge's live repro: close the open deep-linked row, then
    // grow the ledger (storage event — the same setStored path a real
    // try-it append or another tab takes). The old code remounted the
    // list (key={stored.length}) and re-applied open=true, reopening
    // the row and re-firing the scroll effect.
    seedDupLedger();
    const scrollSpy = installScrollSpy();
    try {
      renderAt("/receipts/rcpt_DUP");
      expect(await screen.findByRole("heading", { name: /Receipts Ledger/ })).toBeInTheDocument();
      expect(screen.getAllByText("linked receipt")).toHaveLength(2);
      const details = screen.getAllByText("linked receipt")[0].closest("details")!;
      expect(details).toHaveAttribute("open");
      // One scroll on load, to the first matching row.
      await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1));
      // jsdom does not toggle <details> on summary click — close it
      // by hand and fire the toggle event the browser would fire.
      details.open = false;
      fireEvent(details, new Event("toggle"));
      await waitFor(() => expect(details).not.toHaveAttribute("open"));
      // Grow the ledger 3 → 4 via a storage event.
      const grown = JSON.parse(window.localStorage.getItem(SESSION_RECEIPTS_KEY)!);
      grown.push({
        key: "tvl-rcpt_grown",
        endpoint: "tvl",
        label: "tvl protocol=compound-v3",
        params: "protocol=compound-v3",
        fetchedAt: "2026-11-20T12:00:00.000Z",
        receipt: {
          receipt_id: "rcpt_grown",
          upstream_url: "https://example.com/upstream",
          raw_response_sha256: `0x${"d".repeat(64)}`,
          fetched_at: "2026-11-20T12:00:00.000Z",
        },
        summary: "grown row",
      });
      window.localStorage.setItem(SESSION_RECEIPTS_KEY, JSON.stringify(grown));
      window.dispatchEvent(new StorageEvent("storage", { key: SESSION_RECEIPTS_KEY }));
      await waitFor(() =>
        expect(screen.getByText("4 receipts this session")).toBeInTheDocument(),
      );
      // The remount must NOT reopen the row the user closed, and the
      // scroll must NOT fire again. (The remount creates fresh DOM,
      // so re-query the details element.)
      const detailsAfter = screen.getAllByText("linked receipt")[0].closest("details")!;
      expect(detailsAfter).not.toHaveAttribute("open");
      expect(scrollSpy).toHaveBeenCalledTimes(1);
    } finally {
      removeScrollSpy();
    }
  });

  it("with duplicate receipt_ids the scroll lands on the first match and the notice counts them (gemini J2 R5 A-scroll)", async () => {
    seedDupLedger();
    const scrollSpy = installScrollSpy();
    try {
      renderAt("/receipts/rcpt_DUP");
      expect(await screen.findByRole("heading", { name: /Receipts Ledger/ })).toBeInTheDocument();
      expect(screen.getAllByText("linked receipt")).toHaveLength(2);
      await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1));
      // The scroll target is the FIRST match in DOM order (the newer
      // row) — the old code attached the ref to every matching row, so
      // it ended on the last one.
      const scrolledEl = scrollSpy.mock.instances[0] as unknown as HTMLElement;
      expect(scrolledEl.textContent).toContain("0xNEWER");
      const notice = screen
        .getByRole("link", { name: "Show the full ledger" })
        .closest("div");
      expect(notice?.textContent).toContain("2 matching entries below are open");
    } finally {
      removeScrollSpy();
    }
  });

  it("after Clear, the same id scrolls again and its row opens fresh when the entry returns (gemini J2 R6)", async () => {
    // The round-6 deep-link state (closed keys, scroll-once ref) was
    // reset ONLY on deepLinkId change, so after a Clear the next entry
    // with the same id never scrolled (stale scrolledForRef) and a
    // restored entry with a previously-closed key stayed closed (stale
    // closed set). The entry leaving is the reset signal.
    seedDupLedger();
    const scrollSpy = installScrollSpy();
    try {
      renderAt("/receipts/rcpt_DUP");
      expect(await screen.findByRole("heading", { name: /Receipts Ledger/ })).toBeInTheDocument();
      const details = screen.getAllByText("linked receipt")[0].closest("details")!;
      expect(details).toHaveAttribute("open");
      await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1));

      // Close the row by hand first, so the test also pins the closed
      // set resetting (not just the scroll ref).
      details.open = false;
      fireEvent(details, new Event("toggle"));
      await waitFor(() => expect(details).not.toHaveAttribute("open"));

      // Clear the ledger: the entry leaves, the notice flips to
      // not-found, and both pieces of deep-link state must reset.
      fireEvent.click(screen.getByRole("button", { name: "Clear session ledger" }));
      await waitFor(() => {
        const notice = screen
          .getByRole("link", { name: "Show the full ledger" })
          .closest("div");
        expect(notice?.textContent).toContain(
          "No receipt rcpt_DUP in this browser session",
        );
      });

      // The same entries return (storage event — the same setStored
      // path a real try-it append or another tab takes).
      seedDupLedger();
      window.dispatchEvent(new StorageEvent("storage", { key: SESSION_RECEIPTS_KEY }));
      await waitFor(() =>
        expect(screen.getByText("3 receipts this session")).toBeInTheDocument(),
      );
      // The returned entry scrolls once more, and its row opens fresh
      // — the hand-close from before the Clear does not survive it.
      await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(2));
      const detailsAfter = screen.getAllByText("linked receipt")[0].closest("details")!;
      expect(detailsAfter).toHaveAttribute("open");
    } finally {
      removeScrollSpy();
    }
  });

  it("the notice counts actually-open rows after a close (gemini J2 R6 F2)", async () => {
    // Round 6 made rows closable but left the notice claiming all
    // matches "are open" unconditionally — false the moment the user
    // closes one. The notice must count the rows that are open.
    seedDupLedger();
    renderAt("/receipts/rcpt_DUP");
    expect(await screen.findByRole("heading", { name: /Receipts Ledger/ })).toBeInTheDocument();
    const notice = () =>
      screen.getByRole("link", { name: "Show the full ledger" }).closest("div");
    expect(notice()?.textContent).toContain("2 matching entries below are open");
    // Close one of the two matching rows.
    const first = screen.getAllByText("linked receipt")[0].closest("details")!;
    first.open = false;
    fireEvent(first, new Event("toggle"));
    await waitFor(() => expect(first).not.toHaveAttribute("open"));
    expect(notice()?.textContent).toContain("1 of 2 matching entries below are open");
    // Close the second too.
    const second = screen.getAllByText("linked receipt")[1].closest("details")!;
    second.open = false;
    fireEvent(second, new Event("toggle"));
    await waitFor(() => expect(second).not.toHaveAttribute("open"));
    expect(notice()?.textContent).toContain(
      "all 2 matching entries below are closed — click one to reopen it.",
    );
  });

  it("the notice names a closed single match and flips back on reopen (gemini J2 R6 F2)", async () => {
    // rcpt_other is the single non-duplicate row in the dup seed.
    seedDupLedger();
    renderAt("/receipts/rcpt_other");
    expect(await screen.findByRole("heading", { name: /Receipts Ledger/ })).toBeInTheDocument();
    const notice = () =>
      screen.getByRole("link", { name: "Show the full ledger" }).closest("div");
    expect(notice()?.textContent).toContain("the matching entry below is open.");
    const details = screen.getByText("linked receipt").closest("details")!;
    details.open = false;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(details).not.toHaveAttribute("open"));
    expect(notice()?.textContent).toContain(
      "the matching entry below is closed — click it to reopen it.",
    );
    // Reopen by hand (jsdom does not toggle <details> on summary
    // click): the notice flips back to open.
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(details).toHaveAttribute("open"));
    expect(notice()?.textContent).toContain("the matching entry below is open.");
  });
});

describe("in-app navigation (2026-11-20 click-test): every nav link renders its target, no reload", () => {
  // Regression for the live browser click-test failure: clicking a nav
  // link changed the URL but the previous page's content stayed until a
  // manual reload (4/4 reproductions). Root cause was lazy route chunks
  // fetched same-origin behind the page's own slow /api calls
  // (6-connection limit) while React Router v7 holds the old UI during
  // the startTransition. Routes are static imports now, so each click
  // must render its target immediately. jsdom cannot reproduce the
  // connection starvation itself — the real-browser Playwright run in
  // ~/workspace/verireceipt-frontend/repro/ (nav-test.mjs) is the proof
  // for that — but this test pins the click-through behavior so no
  // future routing change can silently re-break it.
  // 30s budget: under full-suite parallel load on a small VM the six
  // heavy page mounts can exceed vitest's 5s default (flaked once at
  // 10s in the filings J1 full run; passes standalone in <1s).
  it("clicks Home → Dashboard → Receipts → Benchmarks → Status → Docs → Home, each target rendering", async () => {
    renderAt("/");
    expect(await screen.findByRole("heading", { name: /A zero-LLM receipt/ })).toBeInTheDocument();
    const legs: Array<[string, RegExp]> = [
      ["Dashboard", /Dashboard & Proof Hub/],
      ["Receipts", /Receipts Ledger/],
      ["Benchmarks", /Latency Benchmarks/],
      ["Status", /Service Status/],
      ["Docs", /30-Second Docs/],
      ["Home", /A zero-LLM receipt/],
    ];
    for (const [label, heading] of legs) {
      fireEvent.click(screen.getByRole("link", { name: label }));
      expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    }
  }, 30000);

  it("keeps the health pill resolved across navigations (J2 R2 B1)", async () => {
    // Regression: an earlier fix put key={pathname} on a boundary around
    // <Routes>, remounting Layout (and its health pill) on every click —
    // the pill flashed back to "checking…" for 20–60s after each nav.
    // Layout now persists across navs, so the pill keeps its resolved
    // state. The pill is the .health-pill element (the #toast region is
    // also role="status", so the class selector disambiguates).
    //
    // The mocked health fetch resolves after a 2s delay, on purpose:
    // with the round-1 bug the pill remounts on click and reads
    // "checking…" until the delayed fetch resolves — but the shipped
    // instant mock re-resolved it in microseconds, so this test PASSED
    // against the buggy code (J2 R3 B1). The delay + the synchronous
    // assertion right after the click make the test discriminate in both
    // directions (verified against reconstructed round-1 code: FAILS
    // there, PASSES here).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await new Promise((r) => window.setTimeout(r, 2000));
        return { ok: true, status: 200, json: async () => HEALTH_OK };
      }) as unknown as typeof fetch,
    );
    const pill = () => document.querySelector(".health-pill") as HTMLElement;
    renderAt("/");
    await waitFor(() => expect(pill()).toHaveTextContent("live · verireceipt"), {
      timeout: 10000,
    });
    fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    // Synchronously after the click — before any refetch could resolve —
    // the pill must still read "live": a remount would show "checking…".
    expect(pill()).toHaveTextContent("live · verireceipt");
    expect(await screen.findByRole("heading", { name: /Dashboard & Proof Hub/ })).toBeInTheDocument();
    expect(pill()).toHaveTextContent("live · verireceipt");
    fireEvent.click(screen.getByRole("link", { name: "Status" }));
    expect(pill()).toHaveTextContent("live · verireceipt");
    expect(await screen.findByRole("heading", { name: /Service Status/ })).toBeInTheDocument();
    expect(pill()).toHaveTextContent("live · verireceipt");
  });

  it("a page render error keeps the nav usable (J2 R2 B2)", async () => {
    // Regression: the boundary used to wrap <Routes>, so a page error
    // unmounted the nav and footer too. It now wraps only <Outlet/> in
    // Layout — the fallback shows, but the nav stays in the document.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      function Bomb(): never {
        throw new Error("boom in page");
      }
      render(
        <MemoryRouter initialEntries={["/boom"]}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="boom" element={<Bomb />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      );
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.getByText("boom in page")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Home" })).toBeInTheDocument();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("Docs 'Try it live' buttons navigate in-app to /receipts (C3 — no full reload)", async () => {
    // The two "Try it live on /receipts" buttons used to be plain <a
    // href> (full document reload); they are now router <Link>s, so the
    // click renders the ledger in-app with the shell state intact.
    renderAt("/docs");
    expect(await screen.findByRole("heading", { name: /30-Second Docs/ })).toBeInTheDocument();
    const buttons = screen.getAllByRole("link", { name: /Try it live on \/receipts/ });
    expect(buttons.length).toBeGreaterThan(0);
    fireEvent.click(buttons[0]);
    expect(await screen.findByRole("heading", { name: /Receipts Ledger/ })).toBeInTheDocument();
  });

  it("same-component route change does not remount the page (C3 resetKeys)", async () => {
    // The old key={pathname} boundary remounted <Outlet/> on every nav —
    // including /receipts → /receipts/:id, which dropped the page's
    // in-memory state (try-it results, memory-only ledger rows). The
    // resetKeys boundary must NOT remount: a stateful page keeps its
    // state across a pathname change that keeps the same route element.
    // (Proven to fail on the key={pathname} code: the remount resets the
    // counter to 0.)
    function StatefulPage({ label, to, toLabel }: { label: string; to: string; toLabel: string }) {
      const [count, setCount] = useState(0);
      return (
        <div>
          <p>{label}</p>
          <p>count: {count}</p>
          <button type="button" onClick={() => setCount((c) => c + 1)}>
            increment
          </button>
          <Link to={to}>{toLabel}</Link>
        </div>
      );
    }
    render(
      <MemoryRouter initialEntries={["/a"]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="a" element={<StatefulPage label="page A" to="/b" toLabel="go to B" />} />
            <Route path="b" element={<StatefulPage label="page B" to="/a" toLabel="go to A" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("page A")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "increment" }));
    expect(screen.getByText("count: 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "go to B" }));
    expect(await screen.findByText("page B")).toBeInTheDocument();
    expect(screen.getByText("count: 1")).toBeInTheDocument();
  });

  it("navigating away from a failed page clears the fallback (C3 resetKeys, no Retry click)", async () => {
    // Regression for the C3 swap: the old key={pathname} boundary
    // remounted the page on every nav; the new resetKeys={[pathname]}
    // boundary clears the error when the pathname changes, without
    // remounting the page — and the fallback offers Reload page as well
    // as Retry (the stale-chunk recovery).
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      function Bomb(): never {
        throw new Error("boom in page");
      }
      render(
        <MemoryRouter initialEntries={["/boom"]}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="boom" element={<Bomb />} />
              <Route path="dashboard" element={<Dashboard />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      );
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.getByText("boom in page")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Reload page/ })).toBeInTheDocument();
      // Navigate away via the real nav link: the fallback clears and the
      // dashboard renders — no Retry click, no reload.
      fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
      expect(await screen.findByRole("region", { name: "Mission Desk" })).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("boom in page")).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("hash-only navigation clears the fallback (C3 resetKeys includes hash, J2 C3 F2)", async () => {
    // Regression: resetKeys={[pathname]} left the fallback stuck when
    // the only change was the hash — the navbar "Start a probe" CTA
    // (Link to="/#probe") changes neither pathname nor page, so a
    // failed Landing page could never be navigated away from by hash.
    // The Bomb throws while the hash is empty and renders fine once
    // it is "#probe": with hash in resetKeys the click clears the
    // error and the page renders; with pathname-only keys the fallback
    // stays (proven on the revert: "child is fine" never appears).
    // The throw is location-driven, not a one-shot closure flag: a
    // spurious re-render before the click re-throws instead of
    // silently recovering, so the fallback is genuinely present until
    // the hash navigation.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      function BombHash() {
        const { hash } = useLocation();
        if (hash === "") throw new Error("boom without hash");
        return <p>child is fine</p>;
      }
      render(
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<BombHash />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      );
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.getByText("boom without hash")).toBeInTheDocument();
      // The navbar CTA is a real in-app Link to "/#probe": pathname
      // stays "/", only the hash changes.
      fireEvent.click(screen.getByRole("link", { name: "Start a probe" }));
      expect(await screen.findByText("child is fine")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("boom without hash")).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("same-hash re-click of the probe CTA clears the fallback (C3 resetKeys navNonce, J2 C3 F2b / P-C3 B)", async () => {
    // Regression: the hash key clears the fallback when the hash CHANGES
    // (F2 above), but a RE-CLICK of the same CTA while already on
    // /#probe does not navigate at all — React Router no-ops, no
    // location key changes — so the fallback stayed stuck (attack B1:
    // 3/3 repro). Layout's navNonce bumps on same-URL anchor clicks,
    // which IS a resetKey change, so the fallback clears and the page
    // re-renders. The Bomb throws on its first TWO renders while the
    // hash is "#probe" and renders fine from the third: React's
    // concurrent render is discarded and retried after the first throw,
    // so a one-shot flag recovers spuriously on mount (the F2 comment's
    // warning) — the count survives the retry, and the pre-click
    // fallback assertion proves the fallback was genuinely present (a
    // spurious recovery before the click would fail it, not pass
    // vacuously).
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let attempts = 0;
      function BombOnce() {
        const { hash } = useLocation();
        attempts += 1;
        if (hash === "#probe" && attempts <= 2) {
          throw new Error("boom on #probe");
        }
        return <p>child is fine</p>;
      }
      render(
        <MemoryRouter initialEntries={["/#probe"]}>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<BombOnce />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      );
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.getByText("boom on #probe")).toBeInTheDocument();
      // The navbar CTA is a real in-app Link to "/#probe" — the SAME
      // URL as the current location, so this click navigates nowhere.
      fireEvent.click(screen.getByRole("link", { name: "Start a probe" }));
      expect(await screen.findByText("child is fine")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("boom on #probe")).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("landing probe CTAs are router Links, not bare-hash anchors (C3 J2 F3)", async () => {
    // SprintMatrix ("Open Live Probe") and DeskStage ("Run live probe")
    // used to be plain <a href="#probe">: no full reload, but they
    // bypassed React Router (router location went stale after the
    // click) and relied on native scrolling instead of ScrollToHash.
    // They are now <Link to="/#probe"> like Hero's CTA — so no bare
    // "#probe" anchor remains anywhere on the landing page.
    renderAt("/");
    expect(await screen.findByRole("heading", { name: /A zero-LLM receipt/ })).toBeInTheDocument();
    expect(document.querySelectorAll('a[href="#probe"]')).toHaveLength(0);
    const ctas = screen.getAllByRole("link", { name: /Open Live Probe|Run live probe/ });
    expect(ctas.length).toBeGreaterThanOrEqual(2);
    for (const cta of ctas) {
      expect(cta.getAttribute("href")).toBe("/#probe");
    }
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
