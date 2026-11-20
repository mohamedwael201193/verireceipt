import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Layout from "./components/Layout";

// Health-pill hardening (J2 M1, re-review M3/M4): 10s AbortSignal.timeout
// on subsequent polls, 60s on the FIRST check (cold Render starts can
// take 25–55s to answer /health), and no stacked polls (a check already
// in flight makes the interval tick a no-op).
//
// Two corrections from the re-review (M4):
// - There is NO sequence guard any more. The in-flight guard plus a
//   timeout shorter than the poll interval make overlap unreachable, so
//   a seq number could never drop a stale response — it was dead code
//   implying a guarantee it cannot provide. These tests prove only the
//   observable behaviour (timeouts + no stacking).
// - The old "headers arrive, body hangs forever, pill stays checking"
//   scenario was a fiction: in a real browser the abort kills the hung
//   body read too, so the pill goes "unreachable" when the timeout
//   fires. The mock below wires the abort to the body as well, and the
//   test asserts the REAL outcome.
//
// Layout is rendered directly (not through the lazy App routes) so the
// mount is synchronous: no Suspense chunk loading under fake timers, and
// the first fetch fires inside act() during render. Route-level wiring
// is covered by App.test.tsx with real timers.

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type HealthJson = { status: string };

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<div>outlet</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/** Mock fetch whose pending promise rejects when its signal aborts, like
 *  a real fetch — including a hung BODY: aborting after the headers have
 *  arrived kills the body stream, so a pending json() rejects too.
 *  Each call gets a fresh deferred for the Response and one for its
 *  json() body, so tests can hang the body separately from the response.
 *  The body is only rejected on abort once json() has actually been
 *  called (otherwise the rejection would be unobserved). */
function installAbortableFetch() {
  type Entry = {
    // Resolving `response` delivers the Response (ok flag); the body is
    // delivered separately by resolving `json`.
    response: ReturnType<typeof deferred<{ ok: boolean }>>;
    json: ReturnType<typeof deferred<HealthJson>>;
  };
  const pending: Entry[] = [];
  const fetchMock = vi.fn().mockImplementation(
    (_url: string, opts?: { signal?: AbortSignal }) => {
      const response = deferred<{ ok: boolean }>();
      const json = deferred<HealthJson>();
      pending.push({ response, json });
      let jsonConsumed = false;
      const body = {
        ok: true,
        json: () => {
          jsonConsumed = true;
          return json.promise;
        },
      };
      if (!opts?.signal) return response.promise.then(() => body);
      if (opts.signal.aborted) {
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }
      return new Promise((resolve, reject) => {
        opts.signal!.addEventListener(
          "abort",
          () => {
            reject(new DOMException("aborted", "AbortError"));
            // Real fetch: aborting after headers kills the body read.
            if (jsonConsumed) json.reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
        response.promise.then(
          (r) => resolve({ ...body, ok: r.ok }),
          reject,
        );
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, pending };
}

/** Flush pending microtasks + React state updates under fake timers. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.setAttribute("data-theme", "dark");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("health pill hardening (J2 M1, re-review M3/M4)", () => {
  it("first check gets a 60s timeout (cold start): still checking at 10s, unreachable at 60s", async () => {
    const { fetchMock } = installAbortableFetch();
    renderLayout();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(screen.getByText("checking…")).toBeInTheDocument();

    // The old flat 10s timeout would have shown "unreachable" here for
    // a live miner still warming up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText("checking…")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50_000);
    });
    expect(screen.getByText("unreachable")).toBeInTheDocument();
  });

  it("subsequent polls abort at 10s: a hung second check goes unreachable fast", async () => {
    const { fetchMock, pending } = installAbortableFetch();
    renderLayout();

    // First check succeeds quickly.
    pending[0].response.resolve({ ok: true });
    pending[0].json.resolve({ status: "ok" });
    await flush();
    expect(screen.getByText(/live/)).toBeInTheDocument();

    // Second check (30s tick) hangs: it must abort at 10s, not 60s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText("unreachable")).toBeInTheDocument();
  });

  it("never stacks polls: interval ticks while the first (60s) check is in flight are skipped", async () => {
    const { fetchMock, pending } = installAbortableFetch();
    renderLayout();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The first check is still in flight at the 30s tick (its timeout
    // is 60s), so the tick must be a no-op — this is the one window in
    // which the in-flight guard is actually reachable.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The check finally succeeds: pill goes live, and the next tick
    // (60s mark, now past the in-flight check) starts a fresh check.
    pending[0].response.resolve({ ok: true });
    pending[0].json.resolve({ status: "ok" });
    await flush();
    expect(screen.getByText(/live/)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a hung body aborts: headers arrive, body hangs, pill goes unreachable at the timeout", async () => {
    const { fetchMock, pending } = installAbortableFetch();
    renderLayout();

    // Headers arrive but the body never does: the 60s first-check abort
    // kills the hung json() read (real-browser behaviour — the old test
    // asserted the pill would stay "checking…" here, which cannot
    // happen). The pill must read "unreachable", not "checking…".
    pending[0].response.resolve({ ok: true });
    await flush();
    expect(screen.getByText("checking…")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByText("unreachable")).toBeInTheDocument();

    // Polling resumes: a later interval tick starts a fresh check. The
    // exact count depends on whether the 60s tick or the 60s abort fires
    // first, so assert resumption, not an exact number.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("unreachable")).toBeInTheDocument();
  });

  it("marks down on a non-ok response", async () => {
    const { pending } = installAbortableFetch();
    renderLayout();

    pending[0].response.resolve({ ok: false });
    pending[0].json.resolve({ status: "error" });
    await flush();
    expect(screen.getByText("unreachable")).toBeInTheDocument();
  });
});
