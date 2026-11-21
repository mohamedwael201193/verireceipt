import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

/** How long the page may stay quiet (no new child nodes anywhere) after
 *  the lazy route chunk has mounted before a missing hash target is
 *  declared genuinely absent and the watch is dropped. The watch is
 *  NOT a wall-clock cap on finding the target: while the route chunk
 *  is still loading (the Suspense fallback `.route-fallback` is in the
 *  document) the watch never gives up, however slow the chunk is.
 *  Only once the chunk has mounted AND the DOM has been quiet for this
 *  long do we stop — so a genuinely nonexistent hash (/#ghost) is
 *  dropped silently instead of spinning forever. The old fixed 2s
 *  wall (J2 R2 B-J2-1) silently killed hash links whenever the chunk
 *  download + parse + React render of the heavy landing exceeded 2s
 *  (repro: 2500ms chunk delay → scrollY 0, no retry, no fallback). */
const HASH_TARGET_SETTLE_MS = 500;
/** How often the settle check runs while waiting for a target. */
const HASH_TARGET_TICK_MS = 100;

type WaitHandle = { cancel: () => void };
const NO_WAIT: WaitHandle = { cancel: () => undefined };

function scrollToId(id: string): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  // Environments without scrollIntoView (jsdom) count as found.
  if (typeof el.scrollIntoView === "function") el.scrollIntoView();
  return true;
}

/** Wait for the element with `id` to exist, then scroll it into view.
 *  Unbounded while the route is still mounting (Suspense fallback
 *  present); once mounted, gives up silently after a short quiet
 *  settle window with no target. Observes childList only — the navbar
 *  UTC clock and health-pill text updates are characterData/attribute
 *  mutations and must not keep the watch alive. Returns a handle whose
 *  cancel() disconnects the observer and clears the timer (call it on
 *  unmount and on hash/route change — no leak). */
function startWaitForTarget(id: string): WaitHandle {
  if (scrollToId(id)) return NO_WAIT;
  let stopped = false;
  let lastMutationAt = Date.now();
  const observer = new MutationObserver(() => {
    lastMutationAt = Date.now();
    if (!stopped && scrollToId(id)) stop();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const tick = window.setInterval(() => {
    if (stopped) return;
    if (scrollToId(id)) {
      stop();
      return;
    }
    // Still mounting (lazy chunk not resolved yet): never give up.
    if (document.querySelector(".route-fallback")) return;
    if (Date.now() - lastMutationAt >= HASH_TARGET_SETTLE_MS) stop();
  }, HASH_TARGET_TICK_MS);
  function stop() {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    window.clearInterval(tick);
  }
  return { cancel: stop };
}

/** Scroll-to-hash: React Router navigates with pushState, which never
 *  scrolls to a URL fragment on its own — so footer/CTA links such as
 *  /#probe, /#roadmap and /#manifesto changed the URL but left the page
 *  at scrollY 0 (J2 re-review B1). This component watches the location
 *  hash and scrolls the matching element into view, waiting (unbounded
 *  while mounting) for a lazily-mounted target. No hash → no-op (route
 *  changes without a fragment keep the current scroll position, as
 *  before). `scroll-behavior: smooth` comes from tokens.css.
 *
 *  Same-hash re-click (J2 R2 minor 1): on /#probe, scrolling away and
 *  clicking the navbar CTA /#probe performs no navigation (React Router
 *  does not push an identical URL, so the [hash, pathname] effect never
 *  fires) — a native anchor would re-scroll. A document click listener
 *  catches in-page hash links whose URL already equals the current
 *  location and re-scrolls the target. */
export default function ScrollToHash() {
  const { hash, pathname } = useLocation();
  const locRef = useRef({ pathname, hash });
  locRef.current = { pathname, hash };
  const activeWaitRef = useRef<WaitHandle>(NO_WAIT);
  // Last location the [hash, pathname] effect started handling, with
  // the time it did so. The click handler below uses it to tell a real
  // navigation (the effect already handled it — never scroll twice)
  // from a same-hash re-click (no navigation — the effect never fires).
  const handledRef = useRef<{ pathname: string; hash: string; at: number } | null>(null);

  // QA-11: an ordinary (PUSH/REPLACE) route change with no hash starts
  // at the top — the old page's scroll offset used to carry over and land
  // visitors near the footer. Back/forward (POP) keeps the browser's
  // own restoration; a hash target is handled by the effect below.
  const navType = useNavigationType();
  const prevPathRef = useRef(pathname);
  useEffect(() => {
    if (prevPathRef.current === pathname) return;
    prevPathRef.current = pathname;
    if (hash || navType === "POP") return;
    try {
      window.scrollTo(0, 0);
    } catch {
      // jsdom / exotic environments without scrollTo: nothing to reset.
    }
  }, [pathname, hash, navType]);

  const startWait = useCallback((id: string) => {
    activeWaitRef.current.cancel();
    activeWaitRef.current = startWaitForTarget(id);
  }, []);

  useEffect(() => {
    if (!hash) return;
    let id: string;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      return;
    }
    if (!id) return;
    handledRef.current = { pathname, hash, at: Date.now() };
    startWait(id);
    return () => {
      activeWaitRef.current.cancel();
      activeWaitRef.current = NO_WAIT;
    };
  }, [hash, pathname, startWait]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const anchor = target?.closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || !href.includes("#")) return;
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      const frag = url.hash.slice(1);
      if (!frag) return;
      // Only a same-page, same-hash re-click is this handler's job.
      // Any other link is a real navigation and the [hash, pathname]
      // effect above handles it — but the rendered location may not
      // have updated yet when this listener runs (React flushes the
      // navigation after the anchor's own handler), so the check runs
      // deferred: by then either the location is still the old one
      // (no navigation is coming — stale locRef means the click did
      // not navigate) or the effect has run for the new location
      // (handledRef is fresh — it already scrolled, never scroll
      // twice). A genuine same-hash re-click performs no navigation
      // at all, so handledRef stays stale and the re-scroll runs.
      const current = locRef.current;
      if (url.pathname !== current.pathname || url.hash !== current.hash) return;
      const clickedAt = Date.now();
      const clicked = { pathname: url.pathname, hash: url.hash };
      let id: string;
      try {
        id = decodeURIComponent(frag);
      } catch {
        return;
      }
      if (!id) return;
      window.setTimeout(() => {
        const h = handledRef.current;
        if (h && h.pathname === clicked.pathname && h.hash === clicked.hash && h.at >= clickedAt) {
          return; // the effect handled a navigation to this URL after the click
        }
        startWait(id);
      }, 0);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [startWait]);

  return null;
}
