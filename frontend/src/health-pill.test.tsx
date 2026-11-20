import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Layout from "./components/Layout";

// Health-pill hardening (J2 M1): 10s AbortSignal.timeout, no stacked polls,
// stale responses ignored (sequence number — only the latest check updates
// state). The in-flight guard makes true overlap unreachable through the
// public API, so the sequence guard is defense-in-depth; these tests prove
// the observable halves (timeout + no stacking) and the state transitions.
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

/** Mock fetch whose pending promise rejects when its signal aborts,
 *  like a real fetch. Each call gets a fresh deferred for the Response
 *  and one for its json() body, so tests can hang the body separately
 *  from the response (the in-flight guard only matters while json()
 *  is pending — a 10s-timeout fetch can never overlap the 30s tick). */
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
      const body = { ok: true, json: () => json.promise };
      if (!opts?.signal) return response.promise.then(() => body);
      if (opts.signal.aborted) {
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }
      return new Promise((resolve, reject) => {
        opts.signal!.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
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

describe("health pill hardening (J2 M1)", () => {
  it("passes an AbortSignal and marks down when the miner never answers within 10s", async () => {
    const { fetchMock } = installAbortableFetch();
    renderLayout();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(screen.getByText("checking…")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText("unreachable")).toBeInTheDocument();
  });

  it("never stacks polls: interval ticks while a check is in flight are skipped", async () => {
    const { fetchMock, pending } = installAbortableFetch();
    renderLayout();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The response arrives but its body hangs: the check stays in flight
    // (the 10s abort is a no-op once the fetch promise has settled).
    pending[0].response.resolve({ ok: true });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The body finally arrives: pill goes live, and only then does the
    // next interval tick start a fresh check.
    pending[0].json.resolve({ status: "ok" });
    await flush();
    expect(screen.getByText(/live/)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
