// Mission Desk (View 01) — the desk runs REAL live checks.
//
// The preset list is scenario copy (titles/tags/subs); everything else is
// measured at run time: each check calls a live GET /v1/* endpoint, the
// stream log appends a line only when that call settles, and the verdict /
// score / why-cards are derived from the live responses (see presets.ts).
// No canned preview, no staged 402/signing lines, no escrow spend claims:
// direct probes are unbilled and no signing happens in the browser.

import { useEffect, useMemo, useRef, useState } from "react";
import { DESK_PRESETS, type DeskEvaluation, type DeskInputs, type DeskPreset } from "./presets";
import type { LiveReceipt } from "./types";
import { formatMs, isVerified, shortHash, toLiveReceipt } from "./utils";

interface StreamLine {
  time: string;
  tag: string;
  mid: string;
  tail: string;
  color: string;
}

interface MissionDeskProps {
  /** Returns the shared-ledger write outcome (QA-01) so the run toast
   *  only claims rows that were actually saved. */
  onRecord: (receipt: LiveReceipt) => "persisted" | "skipped" | "failed" | void;
  onInspect: (receipt: LiveReceipt) => void;
  showToast: (msg: string) => void;
}

const BUDGETS = [
  { value: 0.01, label: "Fast $0.01" },
  { value: 0.04, label: "Full Desk $0.04" },
  { value: 0.26, label: "Max $0.26" },
];

function verdictClass(v: string): string {
  if (v === "APPROVE") return "v-approve";
  if (v === "REJECT") return "v-reject";
  return "v-hold";
}

function verdictBadge(v: string): string {
  if (v === "APPROVE") return "b-ok";
  if (v === "REJECT") return "b-err";
  return "b-dim";
}

export default function MissionDesk({ onRecord, onInspect, showToast }: MissionDeskProps) {
  const [mission, setMission] = useState<"m13" | "m12">("m13");
  const [presetIdx, setPresetIdx] = useState(0);
  const [inputs, setInputs] = useState<DeskInputs>(DESK_PRESETS[0].inputs);
  const [budget, setBudget] = useState(0.04);
  const [running, setRunning] = useState(false);
  const [streamState, setStreamState] = useState("READY");
  const [lines, setLines] = useState<StreamLine[]>([]);
  const [runReceipts, setRunReceipts] = useState<LiveReceipt[]>([]);
  const [evaluation, setEvaluation] = useState<DeskEvaluation | null>(null);
  const [runTotalMs, setRunTotalMs] = useState<number | null>(null);
  const runToken = useRef(0);
  const runAbort = useRef<AbortController | null>(null);

  // Unmount cancels the in-flight run: the fetch aborts and no
  // onRecord/setState runs afterwards.
  useEffect(() => {
    return () => {
      runToken.current += 1;
      runAbort.current?.abort();
      runAbort.current = null;
    };
  }, []);

  function cancelRun() {
    runToken.current += 1;
    runAbort.current?.abort();
  }

  const preset: DeskPreset = DESK_PRESETS[presetIdx];
  const visiblePresets = useMemo(
    () => DESK_PRESETS.map((p, i) => ({ p, i })).filter(({ p }) => p.mission === mission),
    [mission],
  );

  function selectPreset(idx: number) {
    if (running) return;
    setPresetIdx(idx);
    setMission(DESK_PRESETS[idx].mission);
    setInputs(DESK_PRESETS[idx].inputs);
    setEvaluation(null);
    setRunReceipts([]);
    setLines([]);
    setRunTotalMs(null);
    setStreamState("READY");
  }

  function selectMission(m: "m13" | "m12") {
    if (running) return;
    const idx = DESK_PRESETS.findIndex((p) => p.mission === m);
    if (idx >= 0) selectPreset(idx);
    else setMission(m);
  }

  function appendLine(line: StreamLine) {
    setLines((prev) => [...prev, line]);
  }

  async function executeRun() {
    if (running) return;
    const token = ++runToken.current;
    const controller = new AbortController();
    runAbort.current = controller;
    setRunning(true);
    setEvaluation(null);
    setRunReceipts([]);
    setLines([]);
    setRunTotalMs(null);
    setStreamState("RUNNING — LIVE CALLS…");
    const startedAt = performance.now();
    const checks = preset.buildChecks(inputs);
    const settled: LiveReceipt[] = [];
    let persisted = 0;
    let saveFailed = 0;

    // try/finally: a throwing check must never wedge the UI with the Run
    // button permanently disabled and the stream stuck on RUNNING.
    try {
      for (const check of checks) {
        if (runToken.current !== token) return;
        appendLine({
          time: new Date().toISOString().slice(11, 19),
          tag: "GET",
          mid: check.label,
          tail: `${check.intent} — calling…`,
          color: "#8E8D89",
        });
        const outcome = await check.run(controller.signal);
        if (runToken.current !== token) return;
        const receipt = toLiveReceipt(check.intent, check.query, check.requestUrl, outcome);
        settled.push(receipt);
        const saved = onRecord(receipt);
        if (saved === "persisted") persisted += 1;
        else if (saved === "failed") saveFailed += 1;
        setRunReceipts([...settled]);
        appendLine({
          time: new Date().toISOString().slice(11, 19),
          // "200 OK" needs a receipt, not just a resolved fetch (J2 R3
          // B-J2-1 audit): probe() reports ok:true whenever the fetcher
          // resolves, so a body with no receipt would otherwise stream a
          // green "200 OK" line. The lib throws on refusals, so this is
          // defence-in-depth, not a live path. Keyed on the shared
          // isVerified() predicate (J2 R4 M1), never an ad-hoc check.
          tag: isVerified(receipt) ? "200 OK" : `HTTP ${receipt.status || "—"}`,
          mid: `${check.intent} (${formatMs(outcome.latencyMs)})`,
          tail: outcome.ok
            ? receipt.receipt
              ? `receipt ${shortHash(receipt.receipt.raw_response_sha256)} · unbilled`
              : `no receipt — refused HTTP ${receipt.status} · unbilled`
            : `fail-closed · ${receipt.errorMessage ?? "request failed"} · $0.00`,
          color: isVerified(receipt) ? "#22C55E" : "#F59E0B",
        });
      }

      if (runToken.current !== token) return;
      const totalMs = performance.now() - startedAt;
      setRunTotalMs(totalMs);
      setEvaluation(preset.evaluate(settled.map((receipt, i) => ({ check: checks[i], receipt }))));
      // QA-01: count only what really happened. A refusal has no receipt
      // and is never written to the shared ledger; a storage-refused
      // write is reported, not hidden behind a success message.
      const noReceipt = settled.filter((r) => r.receipt === null).length;
      setStreamState(persisted > 0 ? "COMPLETE · RECEIPTS SAVED TO LEDGER" : "COMPLETE");
      showToast(
        `Desk run settled — ${persisted} receipt(s) saved to the Receipts ledger` +
          (noReceipt > 0 ? ` · ${noReceipt} refusal(s) without a receipt (shown on this page only)` : "") +
          (saveFailed > 0 ? ` · ${saveFailed} NOT saved: browser storage refused the write` : ""),
      );
    } finally {
      // Always reset the running state — including on Cancel, on unmount
      // (a no-op then), and if any check throws. A new run cannot have
      // started while this one was running (the button is disabled), so
      // unconditionally clearing here can never clobber a fresh run.
      setRunning(false);
      if (runToken.current !== token) setStreamState("CANCELLED — RUN ABORTED");
      if (runAbort.current === controller) runAbort.current = null;
    }
  }

  const totalCostLine =
    runTotalMs === null
      ? "$0.00 spent · no run yet"
      : `$0.00 spent · ${formatMs(runTotalMs)} total (direct probes, unbilled)`;

  return (
    <div className="wrap">
      <div className="view-head">
        <div>
          <div className="kicker">// track 3 · apps &amp; agents · zero-wallet workbench</div>
          <h1 className="h1-ed">
            VeriReceipt <span className="serif-i">Mission Desk.</span>
          </h1>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" className={`pill${mission === "m13" ? " active" : ""}`} onClick={() => selectMission("m13")}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--accent)" }} />
            Mission 13 · Asset Management (#201)
          </button>
          <button type="button" className={`pill${mission === "m12" ? " active" : ""}`} onClick={() => selectMission("m12")}>
            Mission 12 · Mining &amp; Power (#200)
          </button>
        </div>
      </div>

      <div className="desk-grid">
        {/* LEFT: presets, editable inputs, budget cap, disclosure */}
        <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <div className="kicker" style={{ marginBottom: 8 }}>// 1-click realistic scenarios</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {visiblePresets.map(({ p, i }) => (
                <button
                  key={p.id}
                  type="button"
                  className={`preset-btn${i === presetIdx ? " active" : ""}`}
                  onClick={() => selectPreset(i)}
                  disabled={running}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%" }}>
                    <span className="mono" style={{ fontSize: 10, color: "var(--accent)" }}>{p.tag}</span>
                    <span className="badge b-dim">live</span>
                  </div>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>{p.title}</div>
                  <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{p.sub}</div>
                </button>
              ))}
            </div>
          </div>

          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14, display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
            <div className="kicker" style={{ marginBottom: 0 }}>// request parameters (editable)</div>
            <div>
              <label htmlFor="in-entity" className="mono" style={{ display: "block", fontSize: 10.5, color: "var(--muted)", marginBottom: 4 }}>Entity / Protocol</label>
              <input id="in-entity" type="text" className="field-input" value={inputs.entity} disabled={running} onChange={(e) => setInputs({ ...inputs, entity: e.target.value })} />
            </div>
            <div>
              <label htmlFor="in-ref" className="mono" style={{ display: "block", fontSize: 10.5, color: "var(--muted)", marginBottom: 4 }}>Tx Hash / ISO Pricing Zone</label>
              <input id="in-ref" type="text" className="field-input" value={inputs.ref} disabled={running} onChange={(e) => setInputs({ ...inputs, ref: e.target.value })} />
            </div>
            <div>
              <label htmlFor="in-scope" className="mono" style={{ display: "block", fontSize: 10.5, color: "var(--muted)", marginBottom: 4 }}>Chain / Period / Interval</label>
              <input id="in-scope" type="text" className="field-input" value={inputs.scope} disabled={running} onChange={(e) => setInputs({ ...inputs, scope: e.target.value })} />
            </div>
          </div>

          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
            <div className="kicker" style={{ marginBottom: 8 }}>// max_budget_usdc ceiling</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
              {BUDGETS.map((b) => (
                <button
                  key={b.value}
                  type="button"
                  className={`pill${budget === b.value ? " active" : ""}`}
                  style={{ justifyContent: "center" }}
                  onClick={() => setBudget(b.value)}
                  disabled={running}
                >
                  {b.label}
                </button>
              ))}
            </div>
            <div className="note-line" style={{ marginTop: 8 }}>
              Budget cap ${budget.toFixed(2)} applies to ranked escrow asks. Direct probes on this page are unbilled — $0.00 spent.
            </div>
          </div>

          <button type="button" className="btn-accent" style={{ width: "100%" }} onClick={executeRun} disabled={running}>
            {running ? (
              <span><span className="spin" /> Running live checks…</span>
            ) : (
              <span>Run Live Checks →</span>
            )}
          </button>
          {running && (
            <button type="button" className="btn-ghost" style={{ width: "100%" }} onClick={cancelRun}>
              Cancel run
            </button>
          )}

          <div className="panel mono" style={{ padding: "12px 13px", fontSize: 11, color: "var(--muted)", lineHeight: 1.58 }}>
            <div style={{ color: "var(--text)", fontWeight: 500, marginBottom: 3 }}>// disclosure · sepolia testnet only</div>
            Desk runs on this page call the miner&apos;s own GET <code style={{ color: "var(--text)" }}>/v1/*</code> endpoints directly
            via the same-origin <code style={{ color: "var(--text)" }}>/api</code> proxy. No wallet, no signing, and no escrow payment
            happens in this browser. Every call targets our own miner (verireceipt, id 774921) and is therefore related-party by
            definition. Escrow-paid Telegraph engine asks (<code style={{ color: "var(--text)" }}>POST /engine/v1/ask</code>, EIP-191
            escrow) are made by the Desk agent, a separate flow — its purchases are under Receipts; the request format is in Status &amp; Docs.
          </div>
        </div>

        {/* RIGHT: live stream, verdict, why, receipt table */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="stream-box">
            <div className="stream-head">
              <span>// live execution stream · GET /v1/* via same-origin /api</span>
              <span style={{ color: "var(--accent)" }}>{streamState}</span>
            </div>
            <div className="stream-log">
              {lines.length === 0 ? (
                <div style={{ color: "#8E8D89" }}>
                  {`// No run yet. Select a scenario and press “Run Live Checks” —\n// stream lines appear here only as real calls settle.`}
                </div>
              ) : (
                lines.map((l, i) => (
                  <div key={i} className="s-line">
                    <span style={{ color: "#6E6D69" }}>[{l.time}]</span>
                    <span style={{ color: l.color, fontWeight: 500 }}>{l.tag}</span>
                    <span style={{ color: "#FF5722" }}>{l.mid}</span>
                    <span style={{ color: "#CECDC8" }}>{l.tail}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className={`verdict-banner ${evaluation ? verdictClass(evaluation.verdict) : "v-hold"}`}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <span className={`badge ${evaluation ? verdictBadge(evaluation.verdict) : "b-dim"}`} style={{ fontSize: 11.5, padding: "3px 10px" }}>
                  {evaluation ? evaluation.verdict : "NO RUN YET"}
                </span>
                <span className="mono" style={{ fontSize: 13, fontWeight: 500 }}>
                  {evaluation ? `Score ${evaluation.score} / 100` : "Score — / 100"}
                </span>
              </div>
              <div style={{ fontSize: 15, fontWeight: 500 }}>
                {evaluation ? evaluation.headline : "Run a scenario to derive a verdict from live receipts."}
              </div>
            </div>
            <div className="mono" style={{ textAlign: "right", fontSize: 11.5 }}>
              <div style={{ color: "var(--text)", fontWeight: 500 }}>{totalCostLine}</div>
              <div style={{ color: "var(--muted)", fontSize: 10.5 }}>budget cap ${budget.toFixed(2)} · direct probes unbilled</div>
            </div>
          </div>

          <div className="card" style={{ padding: "16px 18px" }}>
            <div className="kicker" style={{ marginBottom: 10 }}>// why · deterministic policy evaluation</div>
            {evaluation ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 8 }}>
                {evaluation.why.map((w) => (
                  <div key={w.k} className="panel" style={{ padding: "10px 12px", display: "flex", alignItems: "flex-start", gap: 9 }}>
                    <span className={`badge ${w.ok === "na" ? "b-dim" : w.ok ? "b-ok" : "b-err"}`} style={{ marginTop: 1 }}>{w.ok === "na" ? "N/A" : w.ok ? "PASS" : "GATE"}</span>
                    <div>
                      <div className="mono" style={{ fontSize: 11, fontWeight: 500 }}>{w.k}</div>
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>{w.v}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="note-line">Why-cards appear here after a live run, with values taken from the real responses.</div>
            )}
          </div>

          <div className="card" style={{ overflow: "hidden" }}>
            <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--border)", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--text)", fontWeight: 500 }}>// settled proofs for this run (click row to inspect &amp; verify SHA-256)</span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>live calls · receipts + refusals</span>
            </div>
            <div className="tbl-wrap">
              <table className="hl-tbl">
                <thead>
                  <tr>
                    <th>Intent</th>
                    <th>Routed Miner</th>
                    <th>Rail</th>
                    <th>Status</th>
                    <th>Latency</th>
                    <th>Cost</th>
                    <th>Proofs</th>
                  </tr>
                </thead>
                <tbody>
                  {runReceipts.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="mono" style={{ textAlign: "center", padding: 28, color: "var(--muted)" }}>
                        No receipts yet — run a live check.
                      </td>
                    </tr>
                  ) : (
                    runReceipts.map((r) => (
                      <tr key={r.key} className="clickable" onClick={() => onInspect(r)}>
                        <td className="mono" style={{ fontSize: 11, fontWeight: 500 }}>{r.intent.replace("_GENERAL", "")}</td>
                        <td className="mono" style={{ fontSize: 11 }}>verireceipt</td>
                        <td className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>direct</td>
                        <td><span className={`badge ${isVerified(r) ? "b-ok" : r.status === 0 ? "b-err" : "b-warn"}`}>{r.status === 0 ? "TIMEOUT" : r.status}</span></td>
                        <td className="mono" style={{ fontSize: 11 }}>{formatMs(r.latencyMs)}</td>
                        <td className="mono" style={{ fontSize: 11 }}>unbilled</td>
                        <td>
                          {r.receipt ? (
                            <span className="badge b-dim">{shortHash(r.receipt.raw_response_sha256)}</span>
                          ) : (
                            <span className="badge b-warn">no receipt · {r.status === 0 ? "timeout" : `${r.status} refusal`}</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
