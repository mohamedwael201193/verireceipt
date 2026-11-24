// Sprint matrix / roadmap — "Built in sprints. Ranked in days."
//
// A dated plan (Nov 20 → Dec 1), kept as static plan copy (DESIGN-SPEC
// §8 A17: no live progress source exists for these gates). Default step
// is the first planning milestone; this is not live progress.
import { Link } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { SPRINT_COLUMN_LABELS, SPRINT_STEPS } from "./data";

/**
 * Clamp a tooltip's left offset so its right edge never passes the
 * container's right edge — clamped against the MEASURED tooltip width,
 * not an assumed one. The old clamp assumed a ~140px tooltip
 * (parentWidth - 140), but the single-line nowrap tooltip is actually
 * ~310–317px wide at 360px, so columns 1–7 overflowed the viewport
 * (tip right edge up to 521px vs a 361px viewport; the layout viewport
 * itself grew to 514px). With the real width the clamp is
 * left = min(desired, parentWidth - tipWidth), floored at 0; when the
 * tooltip is wider than the container, left 0 + maxWidth 100% lets the
 * ellipsis backstop engage instead of overflowing.
 */
export function clampSprintTipLeft(desiredLeft: number, parentWidth: number, tipWidth: number): number {
  return Math.max(0, Math.min(desiredLeft, parentWidth - tipWidth));
}

export function SprintMatrix() {
  const [cur, setCur] = useState(0);
  const [tip, setTip] = useState<{ text: string; left: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const st = SPRINT_STEPS[cur];

  // Re-clamp against the MEASURED tooltip width once it has painted:
  // the mouseover handler can only guess the width (the tooltip does
  // not exist yet), and the guess was wrong by ~175px. offsetWidth is
  // the real nowrap width (min-content forces the full ~317px even when
  // it overflows the available space), capped by maxWidth 100%.
  useEffect(() => {
    if (!tip || !tipRef.current) return;
    const parentWidth = tipRef.current.parentElement?.offsetWidth ?? 0;
    const tipWidth = tipRef.current.offsetWidth;
    const next = clampSprintTipLeft(tip.left, parentWidth, tipWidth);
    if (next !== tip.left) setTip({ ...tip, left: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tip]);

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
            Our internal build milestones, not contest requirements or live progress. Declared intents do not equal
            submissions. The official Season II deadline is December 1, 2026 at 23:59 UTC.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14 }}>
            <Link to="/#probe" className="btn-solid-accent" style={{ padding: "11px 22px", fontSize: 13 }}>
              Open Live Probe
            </Link>
            <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>// Nov 20 → Dec 1</span>
          </div>
        </div>

        <div>
          <div className="sprint-cols mono" style={{ fontSize: 10.5, color: "var(--muted)", textAlign: "center", marginBottom: 10 }}>
            <span>prep</span>
            <span>register</span>
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
                ref={tipRef}
                className="mono"
                style={{ position: "absolute", top: -34, left: tip.left, maxWidth: "100%", background: "var(--paper)", color: "var(--paper-ink)", padding: "4px 10px", borderRadius: 4, fontSize: 11, zIndex: 20, pointerEvents: "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textAlign: "left", boxSizing: "border-box", boxShadow: "0 10px 24px rgba(0,0,0,0.45)" }}
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
                      // Single-line tooltip (nowrap above): at top -34 it
                      // is ~23px tall, so it sits fully ABOVE the grid
                      // and can never paint over the cells below — the
                      // old wrapping tooltip grew to 77px at 360px and
                      // covered the first row. The left set here is only
                      // PROVISIONAL: the tooltip does not exist yet, so
                      // its real width cannot be measured until it paints
                      // — the effect above re-clamps against the measured
                      // offsetWidth. The provisional bound uses 320px
                      // (just above the longest measured tip, ~317px),
                      // NOT the old ~140px assumption, so even the first
                      // painted frame keeps the right edge inside the
                      // container on all 8 columns.
                      setTip({
                        text: `${SPRINT_COLUMN_LABELS[c]} · gate ${r + 1}/6`,
                        left: Math.max(0, Math.min(parentWidth - 320, el.offsetLeft)),
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
