// Scroll-linked word-by-word manifesto — fixed copy (DESIGN-SPEC §7,
// verbatim). No live data.
import { useEffect, useRef } from "react";
import { MANIFESTO_PARTS } from "./data";

export function Manifesto() {
  const boxRef = useRef<HTMLDivElement>(null);
  const secRef = useRef<HTMLElement>(null);

  useEffect(() => {
    function update() {
      const sec = secRef.current;
      const box = boxRef.current;
      if (!sec || !box) return;
      const words = Array.from(box.querySelectorAll<HTMLElement>(".m-word"));
      if (!words.length) return;
      const r = sec.getBoundingClientRect();
      const vh = window.innerHeight || 800;
      const p = Math.max(0.1, Math.min(1, (vh * 0.85 - r.top) / (r.height + vh * 0.36)));
      const lit = Math.floor(p * words.length);
      for (let i = 0; i < words.length; i++) words[i].classList.toggle("lit", i <= lit);
    }
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  return (
    <section id="manifesto" className="manifesto-sec" ref={secRef}>
      <div className="kicker">// thesis</div>
      <div id="manifesto-box" className="manifesto-copy" ref={boxRef}>
        {MANIFESTO_PARTS.map((w, i) => {
          if (w === "[v*]") {
            return (
              <span key={i} className="m-word">
                <span className="inline-emblem">v*</span>
              </span>
            );
          }
          if (w.startsWith("[U:")) {
            return (
              <span key={i} className="m-word u-accent">
                {w.slice(3, -1)}
              </span>
            );
          }
          if (w.startsWith("[I:")) {
            return (
              <span key={i} className="m-word serif-i">
                {w.slice(3, -1)}
              </span>
            );
          }
          return (
            <span key={i} className="m-word">
              {w}
            </span>
          );
        })}
      </div>
    </section>
  );
}
