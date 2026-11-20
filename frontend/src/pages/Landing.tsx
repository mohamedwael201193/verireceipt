// VeriReceipt landing page — "/" route.
//
// Ports the interactive showcase design file faithfully (layout, tokens,
// typography, copy, canvas art, interactions) with one systematic
// change: every number, list, and status comes from a live API call.
// The design file made zero network requests — all of its "live"
// behaviour was simulation over canned data. That simulation is gone:
// try-it forms call the real endpoints, receipts are real ReceiptCards,
// and receipt verification is a real SHA-256 recompute (Verified only
// on match). See landing/data.ts for the full list of corrections.
import { useEffect, useRef } from "react";
import "./landing/landing.css";
import { Hero } from "./landing/Hero";
import { Marquee } from "./landing/Marquee";
import { IntentIde } from "./landing/IntentIde";
import { Guarantees } from "./landing/Guarantees";
import { ReceiptDeck } from "./landing/ReceiptDeck";
import { SprintMatrix } from "./landing/SprintMatrix";
import { DeskStage } from "./landing/DeskStage";
import { Manifesto } from "./landing/Manifesto";
import { Probe } from "./landing/Probe";
import { SiteFooter } from "./landing/SiteFooter";

export default function Landing() {
  const toastRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<number | null>(null);

  // Scroll progress bar, soft cursor follower, scroll reveals, toast bus.
  useEffect(() => {
    const bar = document.getElementById("scroll-bar");
    function onScroll() {
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      if (bar) bar.style.width = `${Math.min(100, Math.max(0, (window.scrollY / max) * 100))}%`;
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    let raf = 0;
    let destroyed = false;
    let removeCursorListeners: (() => void) | null = null;
    const cur = document.getElementById("soft-cursor");
    if (cur && window.matchMedia && window.matchMedia("(pointer: fine)").matches) {
      let mx = -80;
      let my = -80;
      let cx = -80;
      let cy = -80;
      let on = false;
      function onMove(e: MouseEvent) {
        mx = e.clientX;
        my = e.clientY;
        if (!on) {
          on = true;
          cur?.classList.add("on");
        }
        const hov =
          e.target instanceof HTMLElement &&
          e.target.closest &&
          e.target.closest("a,button,input,select,[data-hover]");
        cur?.classList.toggle("grow", Boolean(hov));
      }
      function onLeave() {
        on = false;
        cur?.classList.remove("on");
      }
      window.addEventListener("mousemove", onMove, { passive: true });
      document.addEventListener("mouseleave", onLeave);
      removeCursorListeners = () => {
        window.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseleave", onLeave);
      };
      (function loop() {
        if (destroyed) return;
        cx += (mx - cx) * 0.16;
        cy += (my - cy) * 0.16;
        const r = (cur?.offsetWidth || 26) * 0.5;
        if (cur) cur.style.transform = `translate3d(${cx - r}px,${cy - r}px,0)`;
        raf = requestAnimationFrame(loop);
      })();
    }

    let disconnectReveals: (() => void) | null = null;
    const els = document.querySelectorAll<HTMLElement>(".reveal");
    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("in"));
    } else {
      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((en) => {
            if (en.isIntersecting) {
              en.target.classList.add("in");
              io.unobserve(en.target);
            }
          });
        },
        { threshold: 0.12 },
      );
      els.forEach((el) => io.observe(el));
      disconnectReveals = () => io.disconnect();
    }

    function onToast(e: Event) {
      const el = toastRef.current;
      if (!el) return;
      el.textContent = (e as CustomEvent<string>).detail;
      el.classList.add("show");
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => el.classList.remove("show"), 2200);
    }
    window.addEventListener("vr-toast", onToast);

    return () => {
      destroyed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("vr-toast", onToast);
      removeCursorListeners?.();
      disconnectReveals?.();
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);

  return (
    <>
      <div id="scroll-bar" aria-hidden="true" />
      <div id="soft-cursor" aria-hidden="true" />
      <Hero />
      <main className="container">
        <Marquee />
        <IntentIde />
        <Guarantees />
        <ReceiptDeck />
        <SprintMatrix />
        <DeskStage />
        <Manifesto />
        <Probe />
        <SiteFooter />
      </main>
      <div id="toast" ref={toastRef} role="status" aria-live="polite" />
    </>
  );
}
