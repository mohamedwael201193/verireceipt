// /desk — VeriReceipt Desk workbench (Track 3, Mission 13 + Mission 12).
//
// Zero-login, zero-wallet (sponsored mode): no MetaMask prompt ever — the
// browser sends no signing request and holds no key. Every number on this
// page comes from the Desk backend at run time:
//   GET  /api/desk/stats  -> live payer runway ticker (header)
//   POST /api/desk/run    -> verdict, checks, why, per-call rows, spend
//   GET  /api/desk/ledger -> paginated past CALLS (one row per ranked call)
// A missing/unreachable endpoint is an error state, never a fabricated
// fallback. No placeholder numbers anywhere on this page.
//
// CONTRACT — the real backend shapes (backend/src/desk/routes.ts):
// run requests are FLAT with an UPPERCASE mission ("M13"/"M12"); the run
// response carries run_id, verdict, checks[], why[], calls[] (miner_id /
// miner_name / signal_hash / receipt_hash / cost_uusdc / rail /
// fetched_at / signal_url), total_cost_uusdc / total_cost_usd,
// related_party and the verbatim disclosure. There is no per-call status
// or latency, no receipts[] and no spend_usdc anywhere in the contract —
// this page renders only what the backend actually returns.
//
// PATH NOTE: the UI calls same-origin /api/desk/* and the proxy strips
// /api, so the calls land on Render as /desk/* — correct only AFTER the
// coordinator-owned backend remount (/api/desk/* + /api/mcp -> /desk/* +
// /mcp). Until that deploy lands the Desk endpoints are NOT live.
//
// LEDGER CONFIRMATION (no unverified completion claims): the stream
// status becomes "COMPLETE · APPENDED TO LEDGER" ONLY after the ledger
// reload returns a page containing this run_id; otherwise it says the
// run is not yet visible in the ledger. Likewise "FAILED — NO RUN
// RECORDED" is shown ONLY after a post-failure ledger reload proves the
// ledger is unchanged since before the run (same total, same newest row);
// without that proof the status says the recording is unconfirmed.
// A cancel during the post-failure confirmation interrupts only the
// confirmation read — the failure stands ("FAILED · LEDGER
// CONFIRMATION INTERRUPTED — FAILURE STANDS"), never "CANCELLED —
// RUN ABORTED": the run failed at the backend on its own (round 6,
// F1). The settled-branch twin is "COMPLETE · LEDGER CONFIRMATION
// INTERRUPTED — VERDICT AND SPEND STAND".
//
// DELIVERY EPOCH (time-aware, real boundaries — verify piece,
// ~/workspace/verireceipt-desk/verify/src/desk/verify.ts): Telegraph
// epochs are 3-HOUR windows with a :05:41 offset — boundaries at
// 01/04/07/10/13/16/19/22:05:41 UTC (epoch 22 = 04:05:41–07:05:41Z on
// 2026-11-20). The epoch governs DELIVERY blocks (GET /v1/blocks/
// {epoch}/deliveries/<receipt_hash>), NOT signals: a signal response
// carries NO epoch, so the drawer NEVER shows an epoch badge for a
// signal — the devnode signal link is verifiable immediately, and any
// "pending epoch" label on it would be invented. Epoch state is shown
// ONLY where a delivery is being checked, i.e. only for a call that
// carries a receipt_hash, and only as the 3-hour window containing
// that call's fetched_at (close = next :05:41 boundary). No epoch
// NUMBER is ever printed: it is not derivable from a timestamp alone
// (the verify piece discovers it by probing /v1/blocks), and
// settlement can lag an epoch, so a closed window proves neither that
// the receipt is in a block nor that it is absent — the copy says so.
// The old hourly model (epoch closes at the next UTC hour) was wrong
// in both directions (up to ~126 min early, or "Pending" ~54 min
// AFTER the real close) and is gone, with a test proving it.
//
// STREAM LINES are a REPLAY, not a live stream: they are built after the
// single settled response arrives, one line per call that actually
// returned, stamped with that call's real fetched_at — never the render
// time. The header says so.
//
// REUSE (coordinator heads-up — Desk-adjacent files already on main):
// - Presentation is the shared dashboard design system: dashboard.css
//   classes (.card, .preset-btn, .field-input, .stream-box,
//   .verdict-banner, .hl-tbl, .drawer, .backdrop, .badge) and the shared
//   formatters/focus helper from ./dashboard/utils (formatDate,
//   formatUsdPrecise, shortAddr, shortHash, useDrawerFocus). No duplicated vr-* CSS.
// - Scenario fixtures reuse the Mission Desk's verified inputs
//   (./desk/presets.ts): confirmed/reverted tx hashes, CAISO NP15 node.
// - NOT reused, deliberately: dashboard/ReceiptDrawer and
//   dashboard/ReceiptsLedger are built for LiveReceipt (direct-probe
//   GET /v1/* receipts with upstream_url + raw_response_sha256). Desk
//   calls are ranked-escrow calls (signal_hash, cost_uusdc, miner) with
//   no upstream URL and no sha256 — forcing them into LiveReceipt would
//   mean inventing those fields. The Desk drawer below is the same shell
//   (.drawer/.drawer-head/.drawer-body, same focus/Escape/backdrop
//   behaviour) with Desk-proof content: the devnode signal link +
//   the time-aware delivery-epoch window (receipt_hash calls only).
//   landing/DeskStage is likewise direct
//   probes, not the ranked-escrow workbench, so it is not reused here.
//
// Receipt Drawer: every settled call links to the Telegraph devnode
// signal URL (https://devnode.telegraphprotocol.com/engine/v1/signal/<hash>)
// — never a link to
// explorer.telegraphprotocol.com and never a dead 404 link. A call
// with no signal_hash (unbilled refusal) shows that instead of a link.
//
// RECEIPT VERIFICATION (stored bytes only — see the verify piece,
// ~/workspace/verireceipt-desk/verify/frontend/src/lib/auditRehash.ts
// + CONTRACT.md): a receipt is verified ONLY by re-hashing the exact
// raw bytes the miner stored, via GET /receipts/:id/raw. An upstream
// re-fetch can NEVER verify (mutable APIs return fresh bytes; ROUTE /
// GRID hash synthesised JSON while upstream_url points elsewhere), so
// this drawer never offers it and never reports MATCH or MISMATCH from
// one. Until the miner ships /receipts/:id/raw the drawer shows
// UNAVAILABLE — unproven, never a mismatch. Two blockers, both honest:
// (1) the miner endpoint is not shipped (live check 2026-11-20:
// /receipts/:id 404s; the miner stores only the hash, not the raw
// bytes); (2) a Desk call carries a receipt_hash, not a miner receipt
// id (rcpt_…), so there is nothing to address /receipts/:id/raw with —
// that mapping is a backend gap, not something the UI can invent.
//
// FAIL-CLOSED, VISIBLY: the drawer also lists the run's policy checks
// (same data as the Why box) with every HOLD / REJECT / skipped status
// and its backend reason rendered — an omitted evidence field surfaces
// as a named hold/skip, never a silent pass. The parser requires a
// non-empty reason on every check (lib/desk.ts), and the backend
// policies always emit one (policyM13.ts / policyM12.ts) — a
// reason-less check fails the whole response instead of rendering.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RELATED_PARTY_DISCLOSURE,
  getDeskLedger,
  getDeskStats,
  runDeskCheck,
  signalUrl,
  type DeskCall,
  type DeskLedgerPage,
  type DeskRunResponse,
  type DeskStats,
  type DeskVerdict,
} from "../lib/desk";
import { ApiError } from "../lib/api";
import "./dashboard/dashboard.css";
import { formatDate, formatUsdPrecise, shortAddr, shortHash, useDrawerFocus } from "./dashboard/utils";
import { DESK_PRESETS, presetRunRequest, type DeskPreset } from "./desk/presets";

type StatsState =
  | { kind: "loading" }
  | { kind: "ok"; stats: DeskStats }
  | { kind: "error"; message: string };

type LedgerState =
  | { kind: "loading" }
  | { kind: "ok"; page: DeskLedgerPage }
  | { kind: "error"; message: string };

/** Snapshot of the ledger taken before a run, used to prove (or refuse
 *  to claim) that a failed run recorded nothing. */
interface LedgerSnapshot {
  total: number;
  newestId: number | null;
}

function verdictBannerClass(v: DeskVerdict): string {
  if (v === "APPROVE" || v === "MINE") return "v-approve";
  if (v === "REJECT") return "v-reject";
  if (v === "CURTAIL") return "v-curtail";
  return "v-hold";
}

function verdictBadgeClass(v: DeskVerdict): string {
  if (v === "APPROVE" || v === "MINE") return "b-ok";
  if (v === "REJECT") return "b-err";
  if (v === "CURTAIL") return "b-warn";
  return "b-dim";
}

function checkBadgeClass(status: string): string {
  if (status === "pass") return "b-ok";
  if (status === "reject") return "b-err";
  if (status === "hold") return "b-warn";
  return "b-dim";
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "Request failed";
}

function minerLabel(call: DeskCall): string {
  if (call.miner_name) return call.miner_name;
  if (call.miner_id) return call.miner_id;
  return "unrouted";
}

/** Telegraph delivery epochs are 3-hour windows with a :05:41 offset
 *  (verify piece, live 2026-11-20): boundaries at 01/04/07/10/13/16/
 *  19/22:05:41 UTC. Anchor: epoch 22 starts 2026-11-20T04:05:41Z.
 *  Returns the window containing `fetchedAt` — its start and the
 *  instant it closes (the next :05:41 boundary). Null when fetched_at
 *  is unparseable (the parser already rejects those, so this is a
 *  belt-and-braces null, never a guessed state).
 *
 *  This is a DELIVERY window only: it is shown solely for calls that
 *  carry a receipt_hash. A signal carries no epoch — never call this
 *  for a signal, and never print an epoch number from it (the number
 *  is not derivable from a timestamp; the verify piece discovers it
 *  by probing GET /v1/blocks). */
export const DELIVERY_EPOCH_WINDOW_MS = 3 * 60 * 60 * 1000;
export const DELIVERY_EPOCH_ANCHOR_MS = Date.UTC(2026, 10, 20, 4, 5, 41);

export function deliveryEpochWindowMs(
  fetchedAt: string,
): { startMs: number; closesAtMs: number } | null {
  const ms = Date.parse(fetchedAt);
  if (Number.isNaN(ms)) return null;
  const k = Math.floor((ms - DELIVERY_EPOCH_ANCHOR_MS) / DELIVERY_EPOCH_WINDOW_MS);
  const startMs = DELIVERY_EPOCH_ANCHOR_MS + k * DELIVERY_EPOCH_WINDOW_MS;
  return { startMs, closesAtMs: startMs + DELIVERY_EPOCH_WINDOW_MS };
}

export default function Desk() {
  const [presetIdx, setPresetIdx] = useState(0);
  const [inputs, setInputs] = useState<Record<string, string>>(DESK_PRESETS[0].inputs);
  const [stats, setStats] = useState<StatsState>({ kind: "loading" });
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState("READY");
  const [streamLines, setStreamLines] = useState<string[]>([]);
  const [result, setResult] = useState<DeskRunResponse | null>(null);
  const [inspected, setInspected] = useState<DeskCall | null>(null);
  const [ledger, setLedger] = useState<LedgerState>({ kind: "loading" });
  const [ledgerPage, setLedgerPage] = useState(1);
  // Ticking client clock (30s) so the epoch badge flips after the epoch
  // closes without a reload.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const runToken = useRef(0);
  const runAbort = useRef<AbortController | null>(null);
  // Synchronous in-flight flag for the run — the double-run race guard
  // (round 3, F1). `running` is React state, so it is still false in
  // this render's closure while the pre-run ledger snapshot await is
  // pending; a second click in that window used to start a second run
  // and POST /api/desk/run twice, spending escrow twice for one intent.
  // The ref is set synchronously in executeRun BEFORE the snapshot
  // await, so the second click and any preset switch mid-snapshot are
  // no-ops. Cleared in executeRun's finally, never anywhere else.
  const runInFlight = useRef(false);
  const runSettled = useRef(false);
  // Whether the current run FAILED at the backend before any cancel
  // (round 6, F1). Distinct from runSettled: a run that failed did not
  // settle, but it also was NOT aborted — it failed on its own, and a
  // cancel during the post-failure ledger confirmation interrupts only
  // the confirmation READ. Set synchronously in the catch below, before
  // the confirmation await, so the finally can tell a failed-run
  // cancel ("FAILED · LEDGER CONFIRMATION INTERRUPTED — FAILURE
  // STANDS") from a pre-settle cancel ("CANCELLED — RUN ABORTED").
  const runFailed = useRef(false);
  // Whether the current run SETTLED (verdict + spend stand) before any
  // cancel (round 4, F2). Set synchronously at the claim (false) and
  // flipped only once the settled response is stored. The finally below
  // must not report "CANCELLED — RUN ABORTED" for a settled run: a
  // cancel during the post-settle ledger confirmation aborts only the
  // confirmation read, while the verdict and the spent escrow stand.
  const panelRef = useRef<HTMLElement | null>(null);
  useDrawerFocus(inspected !== null, panelRef);

  const preset: DeskPreset = DESK_PRESETS[presetIdx];

  const loadStats = useCallback(async () => {
    try {
      const data = await getDeskStats();
      setStats({ kind: "ok", stats: data });
    } catch (err) {
      setStats({ kind: "error", message: errorMessage(err) });
    }
  }, []);

  const loadLedger = useCallback(async (page: number): Promise<DeskLedgerPage | null> => {
    setLedger({ kind: "loading" });
    try {
      const data = await getDeskLedger(page);
      setLedger({ kind: "ok", page: data });
      return data;
    } catch (err) {
      setLedger({ kind: "error", message: errorMessage(err) });
      return null;
    }
  }, []);

  useEffect(() => {
    void loadStats();
    void loadLedger(1);
  }, [loadStats, loadLedger]);

  // Ticking clock for the time-aware delivery-epoch window.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Unmount cancels the in-flight run.
  useEffect(() => {
    return () => {
      runToken.current += 1;
      runAbort.current?.abort();
      runAbort.current = null;
    };
  }, []);

  // Escape closes the receipt drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setInspected(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function selectPreset(idx: number) {
    // Blocked while a run is in flight — including during the pre-run
    // ledger snapshot await, when `running` state has not flipped yet
    // but runInFlight already has (round 3, F1): a switch there used to
    // land while the run posted the OLD preset's inputs, so the UI
    // showed the NEW preset selected beside the OLD preset's run.
    if (running || runInFlight.current) return;
    setPresetIdx(idx);
    setInputs(DESK_PRESETS[idx].inputs);
    setResult(null);
    setRunError(null);
    setStreamLines([]);
    setStreamState("READY");
    // The drawer inspects a call from the previous run — clear it, or
    // it keeps showing run 1's receipt beside the new (empty) state.
    setInspected(null);
  }

  function cancelRun() {
    runToken.current += 1;
    runAbort.current?.abort();
  }

  async function executeRun() {
    // Claim the run synchronously, BEFORE the pre-run ledger snapshot
    // await below (round 3, F1). The old code awaited the snapshot
    // first and only then called setRunning(true) — while the await was
    // pending `running` was still false, so this guard and
    // selectPreset's guard were both dead: a double-click started two
    // runs and POSTed twice, spending escrow twice for one intent.
    // The ref flips in this tick (state cannot), so the second click
    // and any preset switch mid-snapshot are no-ops; the token check
    // after the snapshot aborts the run if it was cancelled meanwhile.
    if (running || runInFlight.current) return;
    runInFlight.current = true;
    runSettled.current = false;
    runFailed.current = false;
    setRunning(true);
    const token = ++runToken.current;
    const controller = new AbortController();
    runAbort.current = controller;
    // A new run invalidates any open receipt inspection — clear the
    // drawer now, or it keeps showing the previous run's call (and its
    // epoch state) while the checks section vanishes with result.
    setInspected(null);
    // Ledger snapshot before the run: the only way a later "no run
    // recorded" claim can be proven instead of asserted. The
    // post-failure reload is always page 1, so the snapshot MUST be
    // page 1 too — snapshotting whatever page the user had open makes
    // the comparison false whenever they paged past page 1, and the
    // proof can never appear. Reload page 1 first when needed.
    let before: LedgerSnapshot | null = null;
    try {
      if (ledger.kind === "ok" && ledger.page.page === 1) {
        before = { total: ledger.page.total, newestId: ledger.page.runs[0]?.id ?? null };
      } else {
        const page1 = await loadLedger(1);
        setLedgerPage(1);
        if (page1) before = { total: page1.total, newestId: page1.runs[0]?.id ?? null };
      }
      // Cancelled while the snapshot was pending (Cancel button or
      // unmount bumped the token): post nothing — the finally below
      // clears the in-flight flag and reports CANCELLED.
      if (runToken.current !== token) return;
      setRunError(null);
      setResult(null);
      setStreamLines([]);
      setStreamState("RUNNING — RANKED POST /engine/v1/ask…");
      const request = presetRunRequest(preset, inputs);
      const response = await runDeskCheck(request, controller.signal);
      if (runToken.current !== token) return;
      // Summary lines are a REPLAY built from the settled response —
      // one line per ranked call that actually returned, stamped with
      // that call's real fetched_at. Nothing is staged ahead of the
      // reply and no line pretends to be a live timestamp.
      const lines: string[] = [];
      for (const call of response.calls) {
        lines.push(
          `[${call.fetched_at}] ${call.intent} · ${minerLabel(call)} · ${formatUsdPrecise(call.cost_uusdc / 1_000_000)} · ${call.rail}${call.signal_hash ? ` · signal ${shortHash(call.signal_hash)}` : " · no signal_hash"}`,
        );
      }
      setStreamLines(lines);
      setResult(response);
      // The run has SETTLED: the verdict is rendered and the escrow is
      // spent. From here on a cancel can only interrupt the ledger
      // confirmation read below — it cannot un-spend the run, so the
      // finally must never call it aborted (round 4, F2).
      runSettled.current = true;
      setStreamState("COMPLETE · CONFIRMING LEDGER…");
      // A run spends escrow, so the runway and the ledger are re-read.
      void loadStats();
      const page = await loadLedger(1);
      setLedgerPage(1);
      if (runToken.current !== token) return;
      // "Appended to ledger" is claimed ONLY when the reloaded ledger
      // actually contains this run_id.
      if (page && page.runs.some((r) => r.run_id === response.run_id)) {
        setStreamState("COMPLETE · APPENDED TO LEDGER");
      } else if (page) {
        setStreamState("COMPLETE · RUN NOT VISIBLE IN LEDGER YET");
      } else {
        setStreamState("COMPLETE · LEDGER CONFIRMATION PENDING");
      }
    } catch (err) {
      if (runToken.current !== token) return;
      // The run FAILED at the backend on its own (round 6, F1) — mark
      // it before the confirmation await, so a cancel landing during
      // that await is labelled a failed-run cancel, never an abort.
      runFailed.current = true;
      setRunError(errorMessage(err));
      setStreamState("FAILED · CONFIRMING LEDGER…");
      // "No run recorded" is claimed ONLY when a post-failure ledger
      // reload proves the ledger is unchanged since before the run.
      const page = await loadLedger(1);
      setLedgerPage(1);
      if (runToken.current !== token) return;
      if (page && before && page.total === before.total && (page.runs[0]?.id ?? null) === before.newestId) {
        setStreamState("FAILED — NO RUN RECORDED");
      } else if (page) {
        setStreamState("FAILED · RECORDING UNCONFIRMED — LEDGER CHANGED OR NO SNAPSHOT");
      } else {
        setStreamState("FAILED · LEDGER UNREACHABLE — RECORDING UNCONFIRMED");
      }
    } finally {
      runInFlight.current = false;
      setRunning(false);
      // A cancel before the run settled (mid-snapshot, mid-flight)
      // means the run never reached the backend: "CANCELLED — RUN
      // ABORTED" is honest there. A cancel AFTER the run settled means
      // only the ledger confirmation was interrupted — the verdict
      // banner and the spent escrow stand, and claiming the run was
      // aborted beside them would read as "no spend happened" (round
      // 4, F2). A cancel during the post-FAILURE confirmation is
      // neither: the run failed at the backend on its own, so only the
      // confirmation READ was interrupted — the failure stands, and
      // calling it aborted would read as "the user stopped it before
      // it failed" (round 6, F1). Label choice: "FAILURE STANDS"
      // (not "RECORDING UNCONFIRMED") because the error banner beside
      // it already states the backend failure, and the interrupted
      // part is the ledger confirmation, not the failure itself.
      if (runToken.current !== token) {
        setStreamState(
          runSettled.current
            ? "COMPLETE · LEDGER CONFIRMATION INTERRUPTED — VERDICT AND SPEND STAND"
            : runFailed.current
              ? "FAILED · LEDGER CONFIRMATION INTERRUPTED — FAILURE STANDS"
              : "CANCELLED — RUN ABORTED",
        );
      }
      if (runAbort.current === controller) runAbort.current = null;
    }
  }

  const ledgerTotalPages =
    ledger.kind === "ok" && ledger.page.limit > 0
      ? Math.max(1, Math.ceil(ledger.page.total / ledger.page.limit))
      : 1;

  function gotoLedgerPage(page: number) {
    const next = Math.min(Math.max(1, page), ledgerTotalPages);
    setLedgerPage(next);
    void loadLedger(next);
  }

  // Delivery-epoch window for the inspected call: shown ONLY when the
  // call carries a receipt_hash (a delivery exists to check). The
  // signal itself has no epoch and gets no badge at all.
  const inspectedDeliveryWindow =
    inspected !== null && inspected.receipt_hash !== null
      ? deliveryEpochWindowMs(inspected.fetched_at)
      : null;
  const inspectedDeliveryPending =
    inspectedDeliveryWindow !== null && nowMs < inspectedDeliveryWindow.closesAtMs;

  return (
    <div className="vr-dashboard">
      <div className="wrap">
        <section className="view active" aria-label="VeriReceipt Desk">
          <div className="view-head">
            <div>
              <div className="kicker">// track 3 · apps &amp; agents · zero-wallet workbench</div>
              <h1 className="h1-ed">
                VeriReceipt <span className="serif-i">Desk.</span>
              </h1>
              <p style={{ fontSize: 14.5, color: "var(--muted)", maxWidth: 640, lineHeight: 1.6, margin: "10px 0 0" }}>
                One-click Mission 13 allocation gates and Mission 12 dispatch gates, built to buy
                live through Telegraph&apos;s ranked router on Sepolia testnet.{" "}
                <strong style={{ color: "var(--text)" }}>NOT YET LIVE — pending backend deploy.</strong>{" "}
                The Desk endpoints are being remounted and 404 until that deploy lands, so no run
                can be bought from this page today. No login, no wallet, no signing in this
                browser — sponsored escrow would pay once live, and receipts would prove each call.
              </p>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} role="status" aria-label="Escrow runway">
              {stats.kind === "loading" && (
                <span className="badge b-dim">Checking runway…</span>
              )}
              {stats.kind === "ok" && (
                <>
                  {stats.stats.runway_label ? (
                    <span className="badge b-acc">{stats.stats.runway_label}</span>
                  ) : (
                    <span className="badge b-warn">Runway unknown — no payer configured</span>
                  )}
                  <span className="badge b-dim">
                    payer {stats.stats.payer_address ? shortAddr(stats.stats.payer_address) : "not configured"}
                  </span>
                  <span className="badge b-dim">
                    spent today {formatUsdPrecise(stats.stats.spend_today.cost_usd)} · cap {formatUsdPrecise(stats.stats.caps.daily_global_cap_usd)}/day
                  </span>
                </>
              )}
              {stats.kind === "error" && (
                <span className="badge b-err" title={stats.message}>
                  Runway unavailable — /api/desk/stats unreachable
                </span>
              )}
            </div>
          </div>

          <div className="desk-grid">
            {/* LEFT: presets, editable inputs, run */}
            <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <div className="kicker" style={{ marginBottom: 8 }}>// 1-click scenarios · 5 presets</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {DESK_PRESETS.map((p, i) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`preset-btn${i === presetIdx ? " active" : ""}`}
                      onClick={() => selectPreset(i)}
                      disabled={running}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%" }}>
                        <span className="mono" style={{ fontSize: 10, color: "var(--accent)" }}>{p.tag}</span>
                        <span className="badge b-dim">{p.mission === "M13" ? "Mission 13" : "Mission 12"}</span>
                      </div>
                      <div style={{ fontSize: 13.5, fontWeight: 500 }}>{p.title}</div>
                      <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{p.sub}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14, display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
                <div className="kicker" style={{ marginBottom: 0 }}>// request parameters (editable)</div>
                {preset.fields.map((field) => (
                  <div key={field.key}>
                    <label htmlFor={`desk-${field.key}`} className="mono" style={{ display: "block", fontSize: 10.5, color: "var(--muted)", marginBottom: 4 }}>{field.label}</label>
                    <input
                      id={`desk-${field.key}`}
                      type={field.type === "number" ? "number" : "text"}
                      className="field-input"
                      value={inputs[field.key] ?? ""}
                      disabled={running}
                      onChange={(e) => setInputs({ ...inputs, [field.key]: e.target.value })}
                    />
                  </div>
                ))}
              </div>

              <button type="button" className="btn-accent" style={{ width: "100%" }} onClick={executeRun} disabled={running}>
                {running ? "Running ranked checks…" : "Run Live Escrow Check →"}
              </button>
              {running && (
                <button type="button" className="btn-ghost" style={{ width: "100%", justifyContent: "center" }} onClick={cancelRun}>
                  Cancel run
                </button>
              )}
              <p className="note-line" style={{ margin: 0 }}>
                Sponsored mode — the escrow wallet lives server-side. This browser never prompts
                for a wallet and never signs.
              </p>
            </div>

            {/* RIGHT: stream, verdict, why, receipt table */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="stream-box">
                <div className="stream-head">
                  <span>// settled-run summary · replayed from the response · ranked POST /engine/v1/ask</span>
                  <span style={{ color: "var(--accent)" }}>{streamState}</span>
                </div>
                <div className="stream-log">
                  {streamLines.length === 0 ? (
                    <div style={{ color: "#8E8D89" }}>
                      {`// No run yet. Select a scenario and press “Run Live Escrow Check” —\n// summary lines appear here only after the settled response arrives,\n// stamped with each call's real fetched_at.`}
                    </div>
                  ) : (
                    streamLines.map((line, i) => (
                      <div key={i} className="s-line">{line}</div>
                    ))
                  )}
                </div>
              </div>

              {runError && (
                <div className="card" role="alert" style={{ borderColor: "rgba(239,68,68,0.45)", background: "var(--err-soft)", marginBottom: 0 }}>
                  <div className="kicker" style={{ color: "var(--err)" }}>// run failed</div>
                  <div>{runError}</div>
                </div>
              )}

              <div className={`verdict-banner ${result ? verdictBannerClass(result.verdict) : "v-hold"}`}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                    <span className={`badge ${result ? verdictBadgeClass(result.verdict) : "b-dim"}`} style={{ fontSize: 11.5, padding: "3px 10px" }}>
                      {result ? result.verdict : "NO RUN YET"}
                    </span>
                    <span className="mono" style={{ fontSize: 13, fontWeight: 500 }}>
                      {result ? `${result.calls.length} ranked call${result.calls.length === 1 ? "" : "s"}` : "— ranked calls"}
                    </span>
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 500 }}>
                    {result
                      ? result.verdict === "APPROVE"
                        ? "Allocation verified across the ranked checks."
                        : result.verdict === "REJECT"
                          ? "Gate failed — allocation blocked."
                          : result.verdict === "MINE"
                            ? "Dispatch gate open — mine."
                            : result.verdict === "CURTAIL"
                              ? "Dispatch gate closed — curtail."
                              : "Not all checks verified — hold before acting."
                      : "Run a scenario to derive a verdict from live ranked receipts."}
                  </div>
                </div>
                <div className="mono" style={{ textAlign: "right", fontSize: 11.5 }}>
                  <div style={{ color: "var(--text)", fontWeight: 500 }}>
                    {result ? `${formatUsdPrecise(result.total_cost_usd)} Test USDC spent` : "No spend yet"}
                  </div>
                  <div style={{ color: "var(--muted)", fontSize: 10.5 }}>
                    {result
                      ? `${result.calls.filter((c) => c.receipt_hash).length} receipt hash${result.calls.filter((c) => c.receipt_hash).length === 1 ? "" : "es"} · run ${shortHash(result.run_id)}`
                      : "spend is reported by /api/desk/run only"}
                  </div>
                </div>
              </div>

              <div className="card" style={{ padding: "16px 18px", marginBottom: 0 }}>
                <div className="kicker" style={{ marginBottom: 10 }}>// why · explainability · from the live run</div>
                {result ? (
                  <>
                    {result.checks.length > 0 && (
                      <ul style={{ margin: "0 0 12px", paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
                        {result.checks.map((check) => (
                          <li key={check.id} style={{ fontSize: 13, color: "var(--soft)" }}>
                            <span className={`badge ${checkBadgeClass(check.status)}`} style={{ marginRight: 8 }}>{check.status.toUpperCase()}</span>
                            <strong style={{ fontWeight: 500 }}>{check.name}:</strong> {check.reason}
                            {check.detail ? <span style={{ color: "var(--muted)" }}> ({check.detail})</span> : null}
                          </li>
                        ))}
                      </ul>
                    )}
                    {result.why.length === 0 ? (
                      <div style={{ color: "var(--muted)" }}>The run returned no why entries.</div>
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
                        {result.why.map((w, i) => (
                          <li key={i} style={{ fontSize: 13, color: "var(--soft)" }}>{w}</li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <div className="note-line">Why entries appear here after a live run, with reasons taken from the real responses.</div>
                )}
              </div>

              <div className="card" style={{ overflow: "hidden", marginBottom: 0 }}>
                <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--border)", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span className="mono" style={{ fontSize: 11.5, color: "var(--text)", fontWeight: 500 }}>// settled proofs for this run (click row to inspect)</span>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>ranked escrow · no 404 epoch links</span>
                </div>
                <div className="tbl-wrap">
                  <table className="hl-tbl">
                    <thead>
                      <tr>
                        <th>Intent</th>
                        <th>Routed Miner</th>
                        <th>Rail</th>
                        <th>Cost</th>
                        <th>Fetched at</th>
                        <th>Proofs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result === null ? (
                        <tr>
                          <td colSpan={6} className="mono" style={{ textAlign: "center", padding: 28, color: "var(--muted)" }}>
                            No receipts yet — run a live check.
                          </td>
                        </tr>
                      ) : result.calls.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="mono" style={{ textAlign: "center", padding: 28, color: "var(--muted)" }}>
                            The run returned no calls.
                          </td>
                        </tr>
                      ) : (
                        result.calls.map((call, i) => (
                          <tr key={`${call.intent}-${i}`} className="clickable" onClick={() => setInspected(call)}>
                            <td className="mono" style={{ fontSize: 11, fontWeight: 500 }}>{call.intent.replace("_GENERAL", "")}</td>
                            <td className="mono" style={{ fontSize: 11 }}>{minerLabel(call)}</td>
                            <td className="mono" style={{ fontSize: 11 }}>{call.rail}</td>
                            <td className="mono" style={{ fontSize: 11 }}>{formatUsdPrecise(call.cost_uusdc / 1_000_000)}</td>
                            <td className="mono" style={{ fontSize: 11 }}>{formatDate(call.fetched_at)}</td>
                            <td>
                              {call.signal_hash ? (
                                <span className="badge b-dim">{shortHash(call.signal_hash)}</span>
                              ) : (
                                <span className="badge b-warn">no signal_hash · unbilled refusal</span>
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

          {/* ---- Ledger: past calls (one row per ranked call) ---- */}
          <section className="card" aria-label="Desk ledger" style={{ marginTop: 18 }}>
            <div className="kicker">// desk ledger · past calls · newest first</div>
            <h2 style={{ fontSize: 19, fontWeight: 400, letterSpacing: "-.02em", margin: "0 0 6px" }}>Run history</h2>
            {ledger.kind === "loading" && <p style={{ color: "var(--muted)" }}>Loading past runs…</p>}
            {ledger.kind === "error" && (
              <p style={{ color: "var(--muted)" }} role="alert">Ledger unavailable — /api/desk/ledger unreachable ({ledger.message})</p>
            )}
            {ledger.kind === "ok" && ledger.page.runs.length === 0 && (
              <p style={{ color: "var(--muted)" }}>No desk runs yet — run a preset above.</p>
            )}
            {ledger.kind === "ok" && ledger.page.runs.length > 0 && (
              <>
                <div className="tbl-wrap">
                  <table className="hl-tbl">
                    <thead>
                      <tr>
                        <th>Run</th>
                        <th>Mission</th>
                        <th>Intent</th>
                        <th>Miner</th>
                        <th>Cost</th>
                        <th>Verdict</th>
                        <th>Fetched at</th>
                        <th>Verification</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.page.runs.map((run, i) => (
                        <tr key={run.id ?? i}>
                          <td className="mono" style={{ fontSize: 11 }}>{shortHash(run.run_id)}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{run.mission}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{run.intent.replace("_GENERAL", "")}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{run.miner_name ?? run.miner_id ?? "—"}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{formatUsdPrecise(run.cost_usd)}</td>
                          <td><span className="badge b-dim">{run.verdict ?? "—"}</span></td>
                          <td className="mono" style={{ fontSize: 11 }}>{formatDate(run.fetched_at)}</td>
                          <td><span className="badge b-dim">{run.verification_status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}>
                  <button type="button" className="btn-ghost" onClick={() => gotoLedgerPage(ledgerPage - 1)} disabled={ledgerPage <= 1}>
                    ← Prev
                  </button>
                  <span className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>
                    Page {ledger.page.page} of {ledgerTotalPages} · {ledger.page.total} calls
                  </span>
                  <button type="button" className="btn-ghost" onClick={() => gotoLedgerPage(ledgerPage + 1)} disabled={ledgerPage >= ledgerTotalPages}>
                    Next →
                  </button>
                </div>
              </>
            )}
          </section>

          {/* ---- Related-party disclosure (verbatim, blueprint §7.3) ---- */}
          <footer className="card" aria-label="Related-party disclosure" style={{ marginBottom: 0 }}>
            <div className="kicker">// disclosure · sepolia testnet only</div>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: "var(--muted)" }}>{RELATED_PARTY_DISCLOSURE}</p>
          </footer>
        </section>
      </div>

      {/* ---- Receipt drawer (same shell as dashboard/ReceiptDrawer) ---- */}
      <div
        className={`backdrop${inspected !== null ? " open" : ""}`}
        onClick={() => setInspected(null)}
      />
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal={inspected !== null}
        aria-label="Receipt Inspector"
        className={`drawer${inspected !== null ? " open" : ""}`}
      >
        <div className="drawer-head">
          <div>
            <div className="kicker" style={{ marginBottom: 2 }}>// receipt inspector</div>
            <div className="mono" style={{ fontSize: 13, fontWeight: 500 }}>{inspected?.intent ?? ""}</div>
          </div>
          <button type="button" className="btn-ghost" style={{ padding: "4px 10px" }} onClick={() => setInspected(null)} aria-label="Close receipt drawer">✕</button>
        </div>
        <div className="drawer-body">
          {inspected === null ? (
            <div className="live-empty">No receipt selected.</div>
          ) : (
            <>
              <div className="panel mono" style={{ padding: "13px 14px", fontSize: 11.5, display: "flex", flexDirection: "column", gap: 9 }}>
                <div>
                  <div style={{ color: "var(--muted)", fontSize: 10, marginBottom: 2 }}>ROUTED MINER</div>
                  <div style={{ color: "var(--text)", wordBreak: "break-all" }}>
                    {minerLabel(inspected)}
                    {inspected.miner_id && inspected.miner_name ? ` (${inspected.miner_id})` : ""}
                  </div>
                </div>
                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 9 }}>
                  <div style={{ color: "var(--muted)", fontSize: 10, marginBottom: 2 }}>COST · RAIL · FETCHED AT</div>
                  <div style={{ color: "var(--text)" }}>
                    {formatUsdPrecise(inspected.cost_uusdc / 1_000_000)} Test USDC · {inspected.rail} · {formatDate(inspected.fetched_at)}
                  </div>
                </div>
                {inspected.receipt_hash && (
                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: 9 }}>
                    <div style={{ color: "var(--muted)", fontSize: 10, marginBottom: 2 }}>RECEIPT HASH</div>
                    <div style={{ color: "var(--text)", wordBreak: "break-all" }}>{inspected.receipt_hash}</div>
                  </div>
                )}
              </div>
              <div>
                <div className="kicker">// telegraph signal proof</div>
                {inspected.signal_hash ? (
                  <>
                    <a
                      href={signalUrl(inspected.signal_hash)}
                      target="_blank"
                      rel="noreferrer"
                      className="mono"
                      style={{ fontSize: 12, color: "var(--accent)", overflowWrap: "anywhere" }}
                    >
                      {signalUrl(inspected.signal_hash)}
                    </a>
                    <p className="note-line" style={{ marginTop: 10 }}>
                      The devnode link above is the signal proof as returned by the
                      backend — the answer is verifiable immediately at that URL,
                      with no epoch involved: a signal carries no epoch, so no
                      epoch badge is shown for it. This is not a re-hash
                      verification (see receipt verification below).
                    </p>
                  </>
                ) : (
                  <p className="note-line" style={{ margin: 0 }}>
                    No signal_hash — unbilled refusal. Nothing was settled, so there is no
                    signal proof to link.
                  </p>
                )}
              </div>
              {/* Delivery epoch — ONLY for a call that carries a receipt_hash,
                  i.e. only where a delivery is actually being checked.
                  Telegraph epochs are 3-hour windows closing on :05:41 UTC
                  boundaries; the window below is the one containing this
                  call's fetched_at. No epoch number is printed (it is not
                  derivable from a timestamp), and settlement can lag an
                  epoch — so a closed window proves neither that the
                  receipt is in a block nor that it is absent. */}
              {inspected.receipt_hash && inspectedDeliveryWindow !== null && (
                <div>
                  <div className="kicker">// delivery epoch · 3-hour window</div>
                  <div style={{ marginTop: 4 }}>
                    {inspectedDeliveryPending ? (
                      <span className="badge b-warn">Delivery epoch pending</span>
                    ) : (
                      <span className="badge b-dim">Delivery window closed</span>
                    )}
                  </div>
                  <p className="note-line" style={{ marginTop: 10 }}>
                    The 3-hour delivery window containing this call runs{" "}
                    {new Date(inspectedDeliveryWindow.startMs).toISOString()} –{" "}
                    {new Date(inspectedDeliveryWindow.closesAtMs).toISOString()}. The
                    delivery proof for this receipt_hash publishes only once an
                    epoch block finalizes, and settlement can lag an epoch — a
                    closed window does not by itself prove the receipt is (or
                    is not) in a block.
                  </p>
                </div>
              )}
              {/* Run checks, fail-closed and visible: every HOLD / REJECT /
                  skipped check with its backend reason — an omitted evidence
                  field is a named hold/skip here, never a silent pass. */}
              {result !== null && (
                <div>
                  <div className="kicker">// run checks · fail-closed</div>
                  <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
                    {result.checks.map((check) => (
                      <li key={check.id} style={{ fontSize: 12.5, color: "var(--soft)", lineHeight: 1.5 }}>
                        <span className={`badge ${checkBadgeClass(check.status)}`} style={{ marginRight: 8 }}>{check.status.toUpperCase()}</span>
                        <strong style={{ fontWeight: 500 }}>{check.name}:</strong> {check.reason}
                        {check.detail ? <span style={{ color: "var(--muted)" }}> ({check.detail})</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {/* Receipt verification — stored-bytes re-hash ONLY. The miner
                  has not shipped GET /receipts/:id/raw, and a Desk call
                  carries a receipt_hash, not a miner receipt id — so the
                  re-hash is UNAVAILABLE (unproven, never a mismatch) and
                  no upstream re-fetch is offered: a re-fetch hash can
                  never match for mutable APIs or synthesised ROUTE/GRID
                  evidence. That unavailability is ONLY about the
                  stored-bytes re-hash: the backend ALSO ships a
                  signal-verification path — GET /api/desk/verify and the
                  MCP verify_receipt tool, which check a signal_hash
                  against the devnode — but those endpoints are not live
                  until the backend deploys, so this drawer cannot call
                  them today and claims nothing about them. */}
              <div>
                <div className="kicker">// receipt verification · stored-bytes re-hash only</div>
                <div style={{ marginTop: 4 }}>
                  <span className="badge b-warn">UNAVAILABLE — RE-HASH UNPROVEN</span>
                </div>
                <p className="note-line" style={{ marginTop: 10 }}>
                  Re-hash verification means re-hashing the exact raw bytes the miner stored,
                  via GET /receipts/:id/raw, and comparing with the recorded digest. The
                  miner has not shipped that endpoint yet, and this Desk call carries a
                  receipt_hash, not a miner receipt id (rcpt_…), so there is nothing to
                  address it with. No MATCH or MISMATCH is claimed, and no upstream
                  re-fetch is run in its place — a re-fetch of a mutable upstream can
                  never prove a receipt.
                </p>
                <p className="note-line" style={{ marginTop: 10 }}>
                  That is only the stored-bytes re-hash. Separately, the backend ships a
                  signal-verification path — GET /api/desk/verify and the MCP
                  verify_receipt tool — which verify a signal_hash against the Telegraph
                  devnode (the answer half of a receipt, not the payment half). Those
                  endpoints are not live until the backend deploys, so this drawer does
                  not call them today.
                </p>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
