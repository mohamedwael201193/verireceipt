// Sticky scroll-driven IDE — "Six intents."
//
// The design's IDE showed canned payloads and a self-referential SHA-256
// "verification". This port runs the LIVE API on every tab/mode change:
// metric lines, visuals, and JSON all render the real response (or the
// real 422 error body). Latency is measured client-side around the call.
// No price is shown: the design's $0.01/call was invented (L-09).
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import { formatUsd, formatUsdPrecise } from "../../lib/format";
import type {
  FilingsResponse,
  GridPriceResponse,
  RouteResponse,
  TvlResponse,
  TxResponse,
  ValidatorResponse,
} from "../../lib/types";
import { ReceiptCard } from "../../components/ReceiptCard";
import { INTENTS, PRESETS, TRAP_PRESETS, type IntentKey } from "./data";
import { callLive, type AnyResponse } from "./calls";
import { errorMessage, formatLmp, formatUsdcBaseUnits, hlJSON, shortHash } from "./utils";
import { VerifyBadge } from "./VerifyBadge";
import { endpointForIntent } from "../../lib/verifyReceipt";

interface RunState {
  loading: boolean;
  data: AnyResponse | null;
  error: ApiError | null;
  ms: number | null;
  /** Which tab the data belongs to — the visual/metric must never render
   *  a previous tab's response under the new tab (SecVisual reads
   *  data.filings off a TxResponse and crashes). */
  key: IntentKey | null;
}

function metricFor(key: IntentKey, data: AnyResponse | null, period?: string): string {
  if (!data) return "Querying the live endpoint…";
  switch (key) {
    case "tx": {
      const d = data as TxResponse;
      const quorum = typeof d.receipt.quorum_votes === "string" ? d.receipt.quorum_votes : "";
      return `${d.status} · block ${d.block_number ?? "—"}${quorum ? ` · quorum ${quorum}` : ""}`;
    }
    case "sec": {
      const d = data as FilingsResponse;
      // The count carries its window: "95 filings" is the last-12-months
      // answer, "52" the last-6-months one — the headline used to render
      // the windowless `${count} filings · ${entity}`, the exact string
      // shape of the 2026-11-20 defect (J2 R3 B1). The envelope carries
      // no period, so the tab preset supplies it.
      return `${d.filing_count} filings · ${d.entity}${period ? ` · ${period}` : ""}`;
    }
    case "tvl": {
      const d = data as TvlResponse;
      return `${formatUsd(d.tvl_usd)} total TVL`;
    }
    case "route": {
      const d = data as RouteResponse;
      return `${formatUsdcBaseUnits(d.amount_out)} for 1 ETH${d.block_number ? ` · block ${d.block_number}` : ""}`;
    }
    case "grid": {
      const d = data as GridPriceResponse;
      return `${formatLmp(d.lmp_usd_per_mwh)} · ${d.market}`;
    }
    case "validator": {
      const d = data as ValidatorResponse;
      const gwei = Number(d.effective_balance);
      const eth = Number.isFinite(gwei) ? (gwei / 1e9).toFixed(4) : "—";
      return `validator ${String(d.validator_index)} · ${eth} ETH effective`;
    }
  }
}

function TxVisual({ data }: { data: TxResponse }) {
  return (
    <div className="mono" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 11, flex: 1, justifyContent: "center" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#8F8E8A" }}>
        <span>ARCHIVE RPC QUORUM</span>
        <span style={{ color: "#22C55E" }}>
          {typeof data.receipt.quorum_votes === "string" ? data.receipt.quorum_votes : "receipted"} · #{data.block_number}
        </span>
      </div>
      {[
        ["status", data.status],
        ["from", data.from ?? "—"],
        ["to", data.to ?? "— (contract creation)"],
        ["value", `${data.value_eth ?? 0} ETH`],
      ].map(([k, v]) => (
        <div key={k} style={{ padding: "10px 12px", borderRadius: 7, border: "1px solid rgba(255,255,255,0.09)", background: "#131316" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, gap: 10 }}>
            <span style={{ color: "#8F8E8A" }}>{k}</span>
            <span style={{ overflowWrap: "anywhere", textAlign: "right" }}>{v}</span>
          </div>
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 4, fontSize: 11, color: "#8F8E8A" }}>
        <span style={{ overflowWrap: "anywhere" }}>{typeof data.source === "string" ? data.source : ""}</span>
        <span style={{ color: "#FF5722" }}>sha256: {shortHash(data.receipt.raw_response_sha256)}</span>
      </div>
    </div>
  );
}

function SecVisual({ data, period }: { data: FilingsResponse; period: string }) {
  const top = (Array.isArray(data.filings_detail) ? data.filings_detail : []).slice(0, 3);
  return (
    <div style={{ padding: 18, flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: "100%", background: "#F1EFE9", color: "#141414", borderRadius: 8, padding: "18px 20px", boxShadow: "0 16px 36px rgba(0,0,0,0.45)" }}>
        <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "#66645E", marginBottom: 10 }}>
          <span>SEC EDGAR · {data.entity}</span>
          <span style={{ color: "#FF5722", fontWeight: 600 }}>VERBATIM JSON</span>
        </div>
        <div style={{ fontSize: 18, fontWeight: 500, marginBottom: 12 }}>
          {/* The count is meaningless without its window: "95 filings" is
              the last-12-months answer, "52" the last-6-months one — the
              2026-11-20 landing/dashboard mismatch was exactly this
              (filings J2 minor 1). The envelope carries no period, so the
              tab preset supplies it. */}
          {data.entity} — {data.filing_count} filings · {period}
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }} className="mono">
          {top.map((f) => (
            <span key={f.accession} style={{ padding: "3px 9px", borderRadius: 4, background: "#141414", color: "#F1EFE9", fontSize: 10.5 }}>
              {f.form}
            </span>
          ))}
        </div>
        <div className="mono" style={{ fontSize: 11, borderTop: "1px solid #D5D2C8", paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          {top.map((f) => (
            <div key={f.accession} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <span>
                {f.form} · {f.filing_date}
              </span>
              <span style={{ color: "#15803D" }}>✓</span>
            </div>
          ))}
          {data.urls[0] && (
            <div style={{ color: "#66645E", overflowWrap: "anywhere" }}>{data.urls[0]}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function TvlVisual({ data, scattered }: { data: TvlResponse; scattered: boolean }) {
  return (
    <div id="tvl-dock-stage" className={`tvl-stage${scattered ? " scattered" : ""}`}>
      <div className="tvl-portal-frame">
        <div className="mono" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: "#8F8E8A" }}>
          <span>
            {data.protocol_or_chain} · {formatUsd(data.tvl_usd)} TVL
          </span>
          <span id="tvl-dock-lbl" style={{ color: "#FF5722" }}>
            {scattered ? "scattered chain payloads" : "docked · receipted portal"}
          </span>
        </div>
        <div className="tvl-cards-grid">
          <div className="tvl-chip">
            <span>{data.protocol_or_chain}.json</span>
            <span style={{ color: "#22C55E" }}>{formatUsd(data.tvl_usd)}</span>
          </div>
          <div className="tvl-chip">
            <span>chain.tvl</span>
            <span style={{ color: "#FF5722" }}>{formatUsd(data.chain_tvl_usd)}</span>
          </div>
          <div className="tvl-chip">
            <span>as_of</span>
            <span>{data.as_of.slice(0, 10)}</span>
          </div>
          <div className="tvl-chip">
            <span>raw-sha256.sig</span>
            <span style={{ color: "#FF5722" }}>{shortHash(data.receipt.raw_response_sha256)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function RouteVisual({ data }: { data: RouteResponse }) {
  return (
    <div className="mono" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 9, flex: 1, justifyContent: "center" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#8F8E8A" }}>
        <span>SELL 1 ETH → USDC{data.block_number ? ` · BLOCK #${data.block_number}` : ""}</span>
        <span style={{ color: "#FF5722" }}>{formatUsdcBaseUnits(data.amount_out)}</span>
      </div>
      <div style={{ padding: "9px 13px", borderRadius: 7, border: "1px solid #FF5722", background: "rgba(255,87,34,0.13)", display: "flex", justifyContent: "space-between", fontSize: 11.5 }}>
        <span>{data.winning_venue ?? "Best route"} ★</span>
        <span style={{ color: "#FF5722" }}>{data.amount_out.toLocaleString("en-US")}</span>
      </div>
      <div style={{ fontSize: 11, color: "#8F8E8A", lineHeight: 1.6 }}>
        {typeof data.answer === "string" ? data.answer : ""}
        <br />
        Only the winning venue is returned by the live endpoint — per-pool
        quotes are not exposed, so no other pool rows are shown.
      </div>
    </div>
  );
}

function GridVisual({ data }: { data: GridPriceResponse }) {
  return (
    <div className="mono" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12, flex: 1, justifyContent: "center" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#8F8E8A" }}>
        <span>WHOLESALE LMP · LIVE CACHE ROW</span>
        <span style={{ color: "#22C55E" }}>live grid response</span>
      </div>
      <div style={{ padding: 13, borderRadius: 8, border: "1px solid #FF5722", background: "rgba(255,87,34,0.12)" }}>
        <div style={{ fontSize: 10, color: "#8F8E8A" }}>
          {data.market} · {data.node_or_zone}
        </div>
        <div style={{ fontSize: 21, marginTop: 4, color: "#FF5722" }}>{formatUsdPrecise(data.lmp_usd_per_mwh)}</div>
        <div style={{ fontSize: 10, color: "#8F8E8A" }}>USD / MWh · {data.interval_start}</div>
      </div>
      <div style={{ fontSize: 11, color: "#8F8E8A", lineHeight: 1.6 }}>
        Currency: {data.currency}. One live tile — the endpoint returns a
        single node/interval, so no other zone tiles are shown.
      </div>
    </div>
  );
}

function ValidatorVisual({ data }: { data: ValidatorResponse }) {
  const gwei = Number(data.effective_balance);
  const eth = Number.isFinite(gwei) ? (gwei / 1e9).toFixed(4) : "—";
  return (
    <div className="mono" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12, flex: 1, justifyContent: "center" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#8F8E8A" }}>
        <span>BEACON EFFECTIVE BALANCE · 2-OF-N QUORUM</span>
        <span style={{ color: "#22C55E" }}>{data.status ?? "live"}</span>
      </div>
      <div style={{ padding: 13, borderRadius: 8, border: "1px solid #FF5722", background: "rgba(255,87,34,0.12)" }}>
        <div style={{ fontSize: 10, color: "#8F8E8A" }}>validator_index {String(data.validator_index)}</div>
        <div style={{ fontSize: 21, marginTop: 4, color: "#FF5722" }}>{eth} ETH</div>
        <div style={{ fontSize: 10, color: "#8F8E8A" }}>{Number.isFinite(gwei) ? `${gwei.toLocaleString("en-US")} gwei` : "—"}</div>
      </div>
    </div>
  );
}

export function IntentIde() {
  const [idx, setIdx] = useState(0);
  const [is422, setIs422] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [animPaused, setAnimPaused] = useState(false);
  const [scattered, setScattered] = useState(false);
  const [run, setRun] = useState<RunState>({ loading: true, data: null, error: null, ms: null, key: null });
  // Re-run epoch: the mode buttons ("Run 200 OK" / "Test 422 trap") only
  // set state and bump this — the effect below is the SINGLE dispatch
  // path. Calling runIntent from the onClick as well double-fired a live
  // call on every mode switch (the click ran one call, then setIs422
  // re-fired the effect for a second).
  const [runNonce, setRunNonce] = useState(0);
  const reqRef = useRef(0);
  const manualLockUntil = useRef(0);
  const trackRef = useRef<HTMLElement>(null);
  const idxRef = useRef(0);
  idxRef.current = idx;

  const meta = INTENTS[idx];
  // Only the current tab's response may render: between a tab switch
  // and the new run resolving, run.data still holds the previous tab's
  // response (and run.key says which tab it belongs to).
  const dataForTab = run.data && run.key === meta.key ? run.data : null;

  const runIntent = useCallback(async (key: IntentKey, trap: boolean) => {
    const id = ++reqRef.current;
    // Clear stale data: the visual is keyed on the tab, so rendering the
    // new tab with the previous tab's response crashes (e.g. SecVisual
    // reads data.filings off a TxResponse). A new run has no data yet —
    // the loading pane shows until it resolves.
    setRun((r) => ({ ...r, loading: true, data: null, error: null, key: null }));
    const t0 = performance.now();
    try {
      const data = await callLive(key, trap ? TRAP_PRESETS[key] : PRESETS[key]);
      if (reqRef.current !== id) return;
      setRun({ loading: false, data, error: null, ms: Math.round(performance.now() - t0), key });
    } catch (err) {
      if (reqRef.current !== id) return;
      setRun({
        loading: false,
        data: null,
        error: err instanceof ApiError ? err : new ApiError(errorMessage(err), 0),
        ms: Math.round(performance.now() - t0),
        key: null,
      });
    }
  }, []);

  // Single dispatch path: tab/mode/scroll/keyboard changes only set state;
  // this effect issues exactly one live call per change (runNonce covers
  // re-runs in the same mode, where idx/is422 do not change).
  useEffect(() => {
    runIntent(meta.key, is422);
  }, [idx, is422, meta.key, runNonce, runIntent]);

  // TVL scatter/dock cycle (decorative; only on the TVL tab, JSON hidden).
  useEffect(() => {
    const t = setInterval(() => {
      if (animPaused || idx !== 2 || showJson) return;
      setScattered((s) => !s);
    }, 2600);
    return () => clearInterval(t);
  }, [animPaused, idx, showJson]);

  // Scroll-driven tab switching (desktop only, 2.6s manual lock).
  useEffect(() => {
    function onScroll() {
      if (window.innerWidth < 1024 || performance.now() < manualLockUntil.current) return;
      const track = trackRef.current;
      if (!track) return;
      const r = track.getBoundingClientRect();
      const scrollable = track.offsetHeight - window.innerHeight;
      if (scrollable <= 60) return;
      if (r.top > 84 || r.bottom < window.innerHeight * 0.6) return;
      const progress = Math.max(0, Math.min(0.999, (-r.top + 84) / scrollable));
      const target = Math.min(INTENTS.length - 1, Math.floor(progress * INTENTS.length));
      if (target !== idxRef.current) {
        setIs422(false);
        setShowJson(false);
        setIdx(target);
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Arrow-key switching while the IDE section is in view.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target && (e.target as HTMLElement).tagName === "INPUT") return;
      if (e.target && (e.target as HTMLElement).tagName === "SELECT") return;
      const track = trackRef.current;
      if (!track) return;
      const r = track.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.5 && r.bottom > window.innerHeight * 0.3) {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          manualLockUntil.current = performance.now() + 2600;
          setIs422(false);
          setIdx((cur) =>
            e.key === "ArrowRight" ? (cur + 1) % INTENTS.length : (cur + INTENTS.length - 1) % INTENTS.length,
          );
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function switchTab(i: number) {
    manualLockUntil.current = performance.now() + 2600;
    setIs422(false);
    setShowJson(false);
    setIdx(i);
  }

  const statusText = run.loading
    ? "… querying live endpoint"
    : run.error
      ? `${run.error.status || "ERR"} · ${run.ms ?? "—"} ms`
      : `200 OK · ${run.ms ?? "—"} ms`;
  const statusColor = run.loading ? "var(--muted)" : run.error ? "var(--warn)" : "var(--ok)";

  const jsonBody: unknown = run.error
    ? { error: run.error.message, code: run.error.code ?? null, status: run.error.status }
    : dataForTab;

  // The badge verifies the DISPLAYED run: dataForTab is already tied
  // to this tab (run.key === meta.key), so the tab's own key is the
  // run's intent.
  const badgeEndpoint = endpointForIntent(meta.key);

  return (
    <section id="intents" className="ide-scroll-track" ref={trackRef}>
      <div className="ide-sticky">
        <div className="sec-top-row reveal" style={{ marginBottom: 24 }}>
          <div>
            <div className="kicker">// live intents</div>
            <h2 className="sec-h2">
              Six <span className="it">intents.</span>
            </h2>
          </div>
          <div className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>// one file per intent</div>
        </div>

        <div className="code-shell">
          <div id="ide-tabbar" className="ide-tabbar" role="tablist" aria-label="Intents">
            {INTENTS.map((it, i) => (
              <button
                key={it.key}
                type="button"
                role="tab"
                aria-selected={i === idx}
                className={`ide-tab${i === idx ? " active" : ""}`}
                onClick={() => switchTab(i)}
              >
                <span className="t-dot" />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {it.file}
                  <span className="t-ext">{it.ext}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="ide-body">
            <div id="ide-left-pane" className="ide-pane-l ide-fade">
              <div style={{ display: "flex", flexDirection: "column", gap: 15 }}>
                <div style={{ display: "flex", gap: 14 }}>
                  <span className="ln mono">1</span>
                  <div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginBottom: 5 }}>// result</div>
                    <h3 style={{ fontSize: "clamp(1.35rem,2.2vw,1.8rem)", fontWeight: 300, letterSpacing: "-0.025em", lineHeight: 1.18 }}>
                      {run.error ? "Live refusal — see error" : metricFor(meta.key, dataForTab, meta.key === "sec" ? PRESETS.sec.period : undefined)}
                    </h3>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 14 }}>
                  <span className="ln mono">2</span>
                  <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--soft)" }}>{meta.sub}</div>
                </div>
                <div style={{ display: "flex", gap: 14 }}>
                  <span className="ln mono">3</span>
                  <p style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.6 }}>{meta.desc}</p>
                </div>
                <div style={{ display: "flex", gap: 14 }} className="mono">
                  <span className="ln">4</span>
                  <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", rowGap: 6, fontSize: 11.5, flex: 1 }}>
                    <span style={{ color: "var(--muted)" }}>kind</span>
                    <span>{meta.kind}</span>
                    <span style={{ color: "var(--muted)" }}>upstreams</span>
                    <span style={{ color: "var(--soft)" }}>{meta.upstreams}</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 14 }} className="mono">
                  <span className="ln">5</span>
                  <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", fontSize: 11.5, flex: 1 }}>
                    <span style={{ color: "var(--muted)" }}>schema</span>
                    <span style={{ color: "var(--soft)" }}>{meta.schema}</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 14, paddingTop: 4 }}>
                  <span className="ln mono">6</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <button
                      type="button"
                      className="btn-solid-accent"
                      style={{ padding: "8px 16px", fontSize: 12 }}
                      disabled={run.loading}
                      onClick={() => {
                        setIs422(false);
                        setShowJson(false);
                        setRunNonce((n) => n + 1);
                      }}
                    >
                      Run 200 OK
                    </button>
                    <button
                      type="button"
                      className="btn-pill-ghost mono"
                      style={{ padding: "7px 14px", fontSize: 11.5 }}
                      disabled={run.loading}
                      onClick={() => {
                        setIs422(true);
                        setShowJson(true);
                        setRunNonce((n) => n + 1);
                      }}
                    >
                      Test 422 trap
                    </button>
                  </div>
                </div>
                {run.error && (
                  <div className="mono" style={{ fontSize: 12, color: "var(--warn)", lineHeight: 1.6 }} role="alert">
                    {run.error.status ? `HTTP ${run.error.status}` : "Request failed"} — {errorMessage(run.error)}
                    {/* Only a real 422 is an unbilled refusal (J2 R2 M4):
                        a 500, timeout, or network error rendered this line
                        too, which mislabelled every failure as unbilled. */}
                    {run.error.status === 422 && (
                      <>
                        <br />
                        <span style={{ color: "var(--muted)" }}>Unbilled refusal: the oracle never fabricates missing data.</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="ide-pane-r">
              <div className="mono" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 11.5 }}>
                <span style={{ color: "var(--muted)" }}>// preview</span>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ color: statusColor }}>{statusText}</span>
                  <button
                    type="button"
                    className="btn-pill-ghost mono"
                    style={{ padding: "4px 10px", fontSize: 10.5 }}
                    onClick={() => setShowJson((s) => !s)}
                  >
                    {showJson ? "Visual" : "JSON"}
                  </button>
                </div>
              </div>

              <div id="ide-right-pane" className="ide-app-win ide-fade">
                <div className="ide-app-chrome">
                  <div className="mac-dots">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div id="ide-url" className="ide-url-box">
                    {meta.url}
                  </div>
                  <span className="mono" style={{ fontSize: 10, color: "var(--accent)" }}>
                    RENDER · LIVE
                  </span>
                </div>
                {showJson || run.error || run.loading ? (
                  <div id="ide-json-pane" style={{ flex: 1, padding: "16px 18px", background: "#0A0A0B", overflow: "auto" }}>
                    {run.loading ? (
                      <pre style={{ fontSize: 12, lineHeight: 1.65, color: "#8F8E8A" }}>// querying the live endpoint…</pre>
                    ) : (
                      <pre
                        id="ide-json-pre"
                        style={{ fontSize: 12, lineHeight: 1.65 }}
                        dangerouslySetInnerHTML={{ __html: hlJSON(jsonBody) }}
                      />
                    )}
                  </div>
                ) : (
                  <div id="ide-visual" style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                    {meta.key === "tx" && dataForTab && <TxVisual data={dataForTab as TxResponse} />}
                    {meta.key === "sec" && dataForTab && <SecVisual data={dataForTab as FilingsResponse} period={PRESETS.sec.period} />}
                    {meta.key === "tvl" && dataForTab && <TvlVisual data={dataForTab as TvlResponse} scattered={scattered} />}
                    {meta.key === "route" && dataForTab && <RouteVisual data={dataForTab as RouteResponse} />}
                    {meta.key === "grid" && dataForTab && <GridVisual data={dataForTab as GridPriceResponse} />}
                    {meta.key === "validator" && dataForTab && <ValidatorVisual data={dataForTab as ValidatorResponse} />}
                  </div>
                )}
              </div>

              {dataForTab && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <ReceiptCard receipt={dataForTab.receipt} />
                  {badgeEndpoint && (
                    <VerifyBadge receipt={dataForTab.receipt} endpoint={badgeEndpoint} data={dataForTab} />
                  )}
                </div>
              )}

              <div className="mono" style={{ display: "flex", justifyContent: "flex-end", fontSize: 11, color: "var(--muted)" }}>
                <button type="button" style={{ color: "var(--muted)" }} onClick={() => setAnimPaused((p) => !p)}>
                  {animPaused ? "// resume" : "// pause"}
                </button>
              </div>
            </div>
          </div>

          <div className="ide-status-foot">
            <div>
              <span style={{ color: "var(--text)" }}>main</span> · <span>{meta.file}{meta.ext}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ color: "var(--text)" }}>
                0{idx + 1} / 0{INTENTS.length}
              </span>
              <div style={{ width: 112, height: 2, background: "var(--border-hi)", borderRadius: 99, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${((idx + 1) / INTENTS.length) * 100}%`, background: "var(--accent)", transition: "width 0.3s ease" }} />
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span className="hidden sm:inline">scroll to open the next file</span>
              <button
                type="button"
                style={{ color: "var(--text)" }}
                onClick={() => document.getElementById("guarantees")?.scrollIntoView({ behavior: "smooth" })}
              >
                skip ↘
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
