import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/** How long to keep looking for a hash target after navigation, in ms.
 *  Route pages are lazy chunks: the target element (e.g. #probe on the
 *  landing page) may mount after the location has already changed, so a
 *  single synchronous lookup would miss it. */
const HASH_TARGET_TIMEOUT_MS = 2000;
const HASH_TARGET_POLL_MS = 50;

/** Scroll-to-hash: React Router navigates with pushState, which never
 *  scrolls to a URL fragment on its own — so footer/CTA links such as
 *  /#probe, /#roadmap and /#manifesto changed the URL but left the page
 *  at scrollY 0 (J2 re-review B1). This component watches the location
 *  hash and scrolls the matching element into view, polling briefly so
 *  a lazily-mounted target is still found. No hash → no-op (route
 *  changes without a fragment keep the current scroll position, as
 *  before). `scroll-behavior: smooth` comes from tokens.css. */
export default function ScrollToHash() {
  const { hash, pathname } = useLocation();

  useEffect(() => {
    if (!hash) return;
    let id: string;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      return;
    }
    if (!id) return;

    let cancelled = false;
    let timer = 0;
    const startedAt = Date.now();
    const tryScroll = () => {
      if (cancelled) return;
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView();
        return;
      }
      if (Date.now() - startedAt < HASH_TARGET_TIMEOUT_MS) {
        timer = window.setTimeout(tryScroll, HASH_TARGET_POLL_MS);
      }
      // Past the timeout with no target (e.g. a stale anchor): give up
      // silently — a dead link must not throw or spin forever.
    };
    tryScroll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [hash, pathname]);

  return null;
}
