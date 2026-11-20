import { lazy, Suspense, useEffect, useState } from "react";
import type { ComponentType } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ScrollToHash from "./ScrollToHash";

// Hash-scroll behaviour (J2 re-review B1, second half): React Router
// pushState never scrolls to a fragment, so ScrollToHash must do it —
// on initial load with a hash, on hash-change navigation, and after the
// lazy route chunk mounts (the target may not exist yet when the
// location changes). jsdom has no scrollIntoView, so it is mocked and
// the assertions are on the element it was called on.

let scrollSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollSpy = vi.fn();
  Element.prototype.scrollIntoView = scrollSpy as unknown as typeof Element.prototype.scrollIntoView;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // @ts-expect-error jsdom has no scrollIntoView — remove the mock.
  delete Element.prototype.scrollIntoView;
});

function renderWithHash(initialEntries: string[], target: React.ReactNode = null) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <ScrollToHash />
      {target}
    </MemoryRouter>,
  );
}

describe("ScrollToHash (J2 B1)", () => {
  it("scrolls the target into view on initial load with a hash", async () => {
    renderWithHash(["/#probe"], <section id="probe">probe</section>);
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1));
    expect(scrollSpy.mock.instances[0]).toBe(document.getElementById("probe"));
  });

  it("scrolls after the target mounts late (lazy chunk)", async () => {
    function LateTarget() {
      const [mounted, setMounted] = useState(false);
      useEffect(() => {
        const id = window.setTimeout(() => setMounted(true), 300);
        return () => window.clearTimeout(id);
      }, []);
      return mounted ? <section id="probe">probe</section> : null;
    }
    renderWithHash(["/#probe"], <LateTarget />);
    expect(scrollSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(scrollSpy.mock.instances[0]).toBe(document.getElementById("probe"));
  });

  it("scrolls on hash-change navigation via a link", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ScrollToHash />
        <Link to="/#probe">Go to probe</Link>
        <section id="probe">probe</section>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Go to probe" }));
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1));
    expect(scrollSpy.mock.instances[0]).toBe(document.getElementById("probe"));
  });

  it("does nothing without a hash", async () => {
    renderWithHash(["/"], <section id="probe">probe</section>);
    await new Promise((r) => setTimeout(r, 200));
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("scrolls after a slow lazy chunk mounts (2.5s, J2 R2 B-J2-1)", async () => {
    // The old fixed 2s wall gave up here. The watch must be unbounded
    // while the route is still mounting (Suspense fallback present),
    // however slow the chunk is — no raised cap, same failure class.
    const Slow: ComponentType = lazy(
      () =>
        new Promise<{ default: ComponentType }>((resolve) => {
          window.setTimeout(
            () => resolve({ default: () => <section id="probe">probe</section> }),
            2500,
          );
        }),
    );
    render(
      <MemoryRouter initialEntries={["/#probe"]}>
        <ScrollToHash />
        <Suspense fallback={<div className="route-fallback">loading…</div>}>
          <Slow />
        </Suspense>
      </MemoryRouter>,
    );
    expect(scrollSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1), { timeout: 8000 });
    expect(scrollSpy.mock.instances[0]).toBe(document.getElementById("probe"));
  });

  it("gives up silently when the target never appears (stale anchor)", async () => {
    vi.useFakeTimers();
    renderWithHash(["/#ghost"]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("unmount cancels the observer (no leak, J2 R2 B-J2-1)", async () => {
    const disconnectSpy = vi.spyOn(MutationObserver.prototype, "disconnect");
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      const { unmount } = renderWithHash(["/#probe"]);
      unmount();
      expect(disconnectSpy).toHaveBeenCalled();
      // A target appearing after unmount must not be scrolled to.
      const el = document.createElement("section");
      el.id = "probe";
      el.textContent = "probe";
      host.appendChild(el);
      await new Promise((r) => setTimeout(r, 700));
      expect(scrollSpy).not.toHaveBeenCalled();
    } finally {
      document.body.removeChild(host);
      disconnectSpy.mockRestore();
    }
  });

  it("re-scrolls when the same hash is reached on a different route", async () => {
    render(
      <MemoryRouter initialEntries={["/dashboard#probe"]}>
        <ScrollToHash />
        <Routes>
          <Route path="/dashboard" element={<div>dashboard</div>} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
        <Link to="/#probe">Home probe</Link>
        <section id="probe">probe</section>
      </MemoryRouter>,
    );
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1));
    // Same hash, different pathname: the location still changes, so the
    // scroll must run again (pathname is a dependency of the effect).
    fireEvent.click(screen.getByRole("link", { name: "Home probe" }));
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(2));
    expect(scrollSpy.mock.instances[1]).toBe(document.getElementById("probe"));
  });

  it("re-scrolls on a same-hash re-click after scrolling away (J2 R2 M1)", async () => {
    // On /#probe, clicking the navbar CTA /#probe performs no navigation
    // (React Router does not push an identical URL), so the location
    // effect never fires — a native anchor would still re-scroll.
    render(
      <MemoryRouter initialEntries={["/#probe"]}>
        <ScrollToHash />
        <Link to="/#probe">Go to probe</Link>
        <section id="probe">probe</section>
      </MemoryRouter>,
    );
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1));
    // "Scroll away": the next click must scroll again even though the
    // URL does not change.
    scrollSpy.mockClear();
    fireEvent.click(screen.getByRole("link", { name: "Go to probe" }));
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1));
    expect(scrollSpy.mock.instances[0]).toBe(document.getElementById("probe"));
  });
});
