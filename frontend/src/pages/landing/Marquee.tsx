// Code marquee strip — the upstream name list (design list minus ERCOT,
// which has no keyless feed). Names only; no values.
import { useState } from "react";
import { UPSTREAMS } from "./data";

export function Marquee() {
  const [paused, setPaused] = useState(false);

  function makeSet() {
    return UPSTREAMS.map((u) => (
      <span key={u.n}>
        <span className="up-badge">
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={u.ic} />
          </svg>
          <span>{u.n}</span>
        </span>
        <span style={{ color: "var(--dim)", fontFamily: "JetBrains Mono, monospace" }}>·</span>
      </span>
    ));
  }

  return (
    <section className="marquee-sec reveal">
      <div className="code-shell">
        <div className="code-top">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--accent)" }} />
            <span style={{ fontWeight: 500 }}>upstreams.ts</span>
          </div>
          <button
            type="button"
            className="mono"
            style={{ fontSize: 11.5, color: "var(--muted)", textDecoration: "underline", textUnderlineOffset: 4 }}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? "play" : "pause"}
          </button>
        </div>
        <div className="code-lines">
          <div className="c-row">
            <span className="ln">11</span>
            <span style={{ color: "var(--dim)" }}>// authoritative keyless upstreams we verify against</span>
          </div>
          <div className="c-row">
            <span className="ln">12</span>
            <span style={{ flexShrink: 0 }}>
              <span style={{ color: "var(--muted)" }}>const</span> <strong>upstreams</strong>{" "}
              <span style={{ color: "var(--dim)" }}>= [</span>
            </span>
            <div className="marquee-mask">
              <div className={`marquee-track${paused ? " paused" : ""}`}>
                {makeSet()}
                {makeSet()}
              </div>
            </div>
            <span style={{ color: "var(--dim)", flexShrink: 0 }}>];</span>
          </div>
        </div>
      </div>
    </section>
  );
}
