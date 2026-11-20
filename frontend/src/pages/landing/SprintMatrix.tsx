// Sprint matrix / roadmap — "Built in sprints. Ranked in days."
//
// A dated plan (Nov 20 → Dec 1), kept as static plan copy (DESIGN-SPEC
// §8 A17: no live progress source exists for these gates). Default step
// is day 01 (Nov 20, the current day).
import { useState } from "react";
import { SPRINT_COLUMN_LABELS, SPRINT_STEPS } from "./data";

export function SprintMatrix() {
  const [cur, setCur] = useState(0);
  const [tip, setTip] = useState<{ text: string; left: number } | null>(null);
  const st = SPRINT_STEPS[cur];

  function cellClass(c: number, r: number): string {
    let cls = "scell ";
    if (c === 5 && r === 3) cls += "sc-hot";
    else if (st.cols.includes(c)) cls += "sc-4";
    else if (c < st.cols[0]) cls += r < 3 ? "sc-2" : "sc-1";
    else cls += "sc-0";
    if (st.cols.includes(c) && r === 0) cls += " sc-sel";
    return cls;
  }

  return (
    <section id="roadmap" className="sec-pad">
      <div className="split-5-7" style={{ alignItems: "start" }}>
        <div className="reveal">
          <div className="kicker">// roadmap</div>
          <h2 className="sec-h2" style={{ marginBottom: 16 }}>
            Built in sprints.
            <br />
            <span className="it">Ranked in days.</span>
          </h2>
          <p style={{ fontSize: 14.5, color: "var(--muted)", maxWidth: 390, marginBottom: 28 }}>
            Six milestones across the final 11 days of Telegraph Season II. Register before the Nov 21 freeze, exit
            grace Nov 28, and ship 6 verified submissions by Dec 1.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14 }}>
            <a href="#probe" className="btn-solid-accent" style={{ padding: "11px 22px", fontSize: 13 }}>
              Open Live Probe
            </a>
            <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>// Nov 20 → Dec 1</span>
          </div>
        </div>

        <div>
          <div className="sprint-cols mono" style={{ fontSize: 10.5, color: "var(--muted)", textAlign: "center", marginBottom: 10 }}>
            <span>prep</span>
            <span>freeze</span>
            <span>harden</span>
            <span>desk</span>
            <span>growth</span>
            <span style={{ color: "var(--accent)", fontWeight: 500 }}>ranked</span>
            <span>submit</span>
            <span>judge</span>
          </div>

          <div style={{ position: "relative" }}>
            {tip && (
              <div
                id="sprint-tip"
                className="mono"
                style={{ position: "absolute", top: -34, left: tip.left, maxWidth: `calc(100% - ${tip.left}px)`, background: "var(--paper)", color: "var(--paper-ink)", padding: "4px 10px", borderRadius: 4, fontSize: 11, zIndex: 20, pointerEvents: "none", whiteSpace: "normal", overflowWrap: "break-word", textAlign: "left", boxSizing: "border-box", boxShadow: "0 10px 24px rgba(0,0,0,0.45)" }}
              >
                {tip.text}
              </div>
            )}
            <div
              id="sprint-grid"
              className="sprint-cols"
              onMouseLeave={() => setTip(null)}
            >
              {Array.from({ length: 6 }, (_, r) =>
                Array.from({ length: 8 }, (_, c) => (
                  <button
                    key={`${r}-${c}`}
                    type="button"
                    className={cellClass(c, r)}
                    data-c={c}
                    data-r={r}
                    aria-label={`${SPRINT_COLUMN_LABELS[c]} · gate ${r + 1}/6`}
                    onMouseOver={(e) => {
                      const el = e.currentTarget;
                      const parentWidth = el.parentElement?.offsetWidth ?? 400;
                      // Clamp so at least 120px of the (now wrapping)
                      // tooltip fits; maxWidth above keeps it inside the
                      // container — and the container inside the viewport.
                      setTip({
                        text: `${SPRINT_COLUMN_LABELS[c]} · gate ${r + 1}/6`,
                        left: Math.max(0, Math.min(parentWidth - 120, el.offsetLeft)),
                      });
                    }}
                    onClick={() => setCur([0, 1, 2, 3, 4, 4, 5, 5][c] ?? 0)}
                  />
                )),
              )}
            </div>
          </div>

          <div className="sprint-cols mono" style={{ fontSize: 10, color: "var(--dim)", textAlign: "center", marginTop: 8 }}>
            <span>d1</span>
            <span>d2</span>
            <span>d3-4</span>
            <span>d5-6</span>
            <span>d7-8</span>
            <span>d9</span>
            <span>d10</span>
            <span>d11</span>
          </div>

          <div className="mono" style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border)", fontSize: 12 }}>
            <div style={{ color: "var(--text)", marginBottom: 4 }}>{st.g1}</div>
            <div style={{ color: "var(--muted)" }}>{st.g2}</div>
          </div>

          <div id="sprint-tabs" className="sprint-tabs">
            {SPRINT_STEPS.map((s, i) => (
              <button
                key={s.label}
                type="button"
                className={`sp-tab${i === cur ? " active" : ""}`}
                onClick={() => setCur(i)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
