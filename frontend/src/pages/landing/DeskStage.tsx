// Showcase stage + playlist — Mission 13/12 Desk.
//
// The design's five playlist items were staged setTimeout theatre with
// canned latencies, costs, verdicts, and sequential-pattern fake hashes.
// Each item here is a REAL try-it form (one per endpoint): editable
// params, a live run that streams real rows as each call resolves, a
// verdict derived from the live results, and real ReceiptCards. No
// price is shown (the design's $0.01/call and per-run costs were
// invented), no threshold verdicts are shown (the $65/$85 thresholds
// and ERCOT $118.40 figure were fabricated), and no EIP-191 signing is
// claimed — these are read-only GET checks, no wallet, no signing.
import { useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import type { Receipt } from "../../lib/types";
import { ReceiptCard } from "../../components/ReceiptCard";
import { DESK_PLAYLIST, GRID_NYISO_PRESET, INTENTS, PRESETS, TRAP_PRESETS, type IntentKey } from "./data";
import { callLive, outcomeFor, type AnyResponse } from "./calls";
import { errorMessage, shortHash } from "./utils";

const FIELD_LABELS: Record<string, string> = {
  tx_hash: "tx_hash",
  chain: "chain",
  entity: "entity",
  period: "period",
  protocol: "protocol",
  pair: "pair",
  node_or_zone: "node_or_zone",
  interval_start: "interval_start",
};

// Item 02 defaults to a REAL reverted mainnet tx, so Play demonstrates
// REJECT instead of always CLEAR. Source: the backend's own live test
// (tests/tx.test.ts, "reverted mainnet tx returns status reverted") —
// ethereum block 26454411, status reverted. NOTE: the trap fixtures'
// reverted hashes (scripts/run-traptest.ts t07/t08) are base-sepolia,
// which the live miner rejects as an unsupported chain, so they cannot
// be used as a preset here.
const REVERTED_TX_PRESET = {
  tx_hash: "0x1a1467893eaed124a13164b589f1ed7a70ec203257084a7be27eee8f93bd8ba9",
  chain: "ethereum",
};

function defaultParams(itemIdx: number, key: IntentKey): Record<string, string> {
  if (itemIdx === 1 && key === "tx") return { ...REVERTED_TX_PRESET };
  if (itemIdx === 3 && key === "grid") return { ...GRID_NYISO_PRESET };
  if (itemIdx === 4 && key === "grid") return { ...TRAP_PRESETS.grid };
  return { ...PRESETS[key] };
}

interface StreamRow {
  intent: string;
  ms: number;
  out: string;
  sig: string;
  ok: boolean;
}

interface Verdict {
  label: string;
  cls: string;
  msg: string;
}

/**
 * Stream-row sig for a failed call: it must name the REAL failure. The
 * old code labelled every failure "unbilled (422)", so a 45 s timeout
 * rendered as "Request timed out after 45s (TIMEOUT) · unbilled (422)"
 * — a timeout is not a 422. Only a real 422 is unbilled.
 */
function sigFor(err: ApiError): string {
  if (err.code === "TIMEOUT") return "timeout";
  if (err.code === "NETWORK_ERROR") return "network";
  if (err.status === 422) return "unbilled (422)";
  if (err.status) return `HTTP ${err.status}`;
  return "failed";
}

export function DeskStage() {
  const [cur, setCur] = useState(0);
  const [phase, setPhase] = useState<"cover" | "running" | "done">("cover");
  const [params, setParams] = useState<Record<string, Record<string, string>>>(() =>
    Object.fromEntries(
      DESK_PLAYLIST[0].calls.map((k) => [k, defaultParams(0, k)]),
    ),
  );
  const [rows, setRows] = useState<StreamRow[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const runRef = useRef(0);

  const item = DESK_PLAYLIST[cur];

  function selectItem(i: number) {
    runRef.current += 1;
    setCur(i);
    setPhase("cover");
    setRows([]);
    setReceipts([]);
    setVerdict(null);
    setParams(Object.fromEntries(DESK_PLAYLIST[i].calls.map((k) => [k, defaultParams(i, k)])));
  }

  function setParam(key: IntentKey, field: string, value: string) {
    setParams((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
  }

  function deriveVerdict(itemIdx: number, outcomes: { key: IntentKey; data: AnyResponse | null; error: ApiError | null }[]): Verdict {
    if (itemIdx === 0) {
      const [tx, sec, tvl, route] = outcomes;
      const txOk = tx.data && (tx.data as { status?: string }).status === "confirmed";
      const secOk = sec.data && ((sec.data as { filing_count?: number }).filing_count ?? 0) > 0;
      const tvlOk = tvl.data && ((tvl.data as { tvl_usd?: number }).tvl_usd ?? 0) > 0;
      const routeOk = route.data && ((route.data as { amount_out?: number }).amount_out ?? 0) > 0;
      if (txOk && secOk && tvlOk && routeOk) {
        // Honest wording: the four live responses arrived with receipts,
        // but no SHA-256 recompute is performed here — "verified" would
        // overstate what this stage checks.
        return { label: "APPROVE", cls: "b-ok", msg: "All 4 live responses received with receipts · allocation approved" };
      }
      const failed = outcomes
        .filter((o) => !o.data)
        .map((o) => o.key)
        .join(", ");
      return { label: "CHECK FAILED", cls: "b-bad", msg: failed ? `Live check failed: ${failed}` : "A live check did not verify — see rows above" };
    }
    if (itemIdx === 1) {
      // Every call counts (J2 R2 M3): the old code read only outcomes[0],
      // so a confirmed tx + a failed 2nd (tvl) call still rendered CLEAR
      // while a stream row showed HTTP 500. Any failed call fails the
      // check, exactly like item 01's all-four rule.
      const failed = outcomes.filter((o) => !o.data).map((o) => o.key);
      if (failed.length > 0) {
        return {
          label: "CHECK FAILED",
          cls: "b-bad",
          msg: `Live check failed: ${failed.join(", ")}`,
        };
      }
      const txRes = outcomes[0];
      const status = (txRes.data as { status?: string } | null)?.status;
      if (status === "reverted") {
        // No signing flow exists anywhere on this page (read-only GET
        // checks, no wallet) — nothing is "refused automatically".
        return { label: "REJECT", cls: "b-bad", msg: "Counterparty reference tx reverted · reject this reference — read-only check, no wallet or signing" };
      }
      if (status === "confirmed") {
        return { label: "CLEAR", cls: "b-ok", msg: "Counterparty reference tx confirmed on-chain · no trap in the checked reference" };
      }
      return { label: "CHECK FAILED", cls: "b-bad", msg: txRes.error ? `Tx lookup failed: ${errorMessage(txRes.error)}` : "Tx lookup returned no status" };
    }
    if (itemIdx === 2 || itemIdx === 3) {
      const g = outcomes[0];
      if (g.data) {
        const d = g.data as { lmp_usd_per_mwh?: number; node_or_zone?: string; market?: string };
        // Same rationale as item 01 (see above): no SHA-256 recompute
        // happens here, so "VERIFIED" would overstate — the live
        // response arrived with a receipt.
        return {
          label: "RECEIPTED",
          cls: "b-ok",
          msg: `Live LMP ${d.node_or_zone ?? ""} $${(d.lmp_usd_per_mwh ?? 0).toFixed(2)}/MWh (${d.market ?? ""}) — live response with receipt, no threshold applied`,
        };
      }
      return { label: "CHECK FAILED", cls: "b-bad", msg: g.error ? `Grid lookup failed: ${errorMessage(g.error)}` : "Grid lookup returned no data" };
    }
    // item 05 — future window guardrail.
    const g = outcomes[0];
    if (g.error && g.error.status === 422) {
      return { label: "HOLD", cls: "b-warn", msg: "Upstream returned 422 interval_in_future · no receipt issued" };
    }
    if (g.data) {
      const d = g.data as { lmp_usd_per_mwh?: number; node_or_zone?: string };
      return {
        label: "AVAILABLE",
        cls: "b-ok",
        msg: `Interval has closed since the preset was written — live LMP ${d.node_or_zone ?? ""} $${(d.lmp_usd_per_mwh ?? 0).toFixed(2)}/MWh`,
      };
    }
    return { label: "CHECK FAILED", cls: "b-bad", msg: g.error ? `Grid lookup failed: ${errorMessage(g.error)}` : "Grid lookup returned no data" };
  }

  async function play() {
    const id = ++runRef.current;
    setPhase("running");
    setRows([]);
    setReceipts([]);
    setVerdict(null);
    const outcomes: { key: IntentKey; data: AnyResponse | null; error: ApiError | null }[] = [];
    for (const key of item.calls) {
      const t0 = performance.now();
      try {
        const data = await callLive(key, params[key]);
        if (runRef.current !== id) return;
        const ms = Math.round(performance.now() - t0);
        outcomes.push({ key, data, error: null });
        setRows((r) => [
          ...r,
          {
            intent: INTENTS.find((i) => i.key === key)?.name ?? key,
            ms,
            out: outcomeFor(key, data, params[key]),
            sig: shortHash(data.receipt.raw_response_sha256),
            ok: true,
          },
        ]);
        setReceipts((prev) => [...prev, data.receipt]);
      } catch (err) {
        if (runRef.current !== id) return;
        const ms = Math.round(performance.now() - t0);
        const apiErr = err instanceof ApiError ? err : new ApiError(errorMessage(err), 0);
        outcomes.push({ key, data: null, error: apiErr });
        setRows((r) => [
          ...r,
          {
            intent: INTENTS.find((i) => i.key === key)?.name ?? key,
            ms,
            out: `${apiErr.status ? `HTTP ${apiErr.status} ` : ""}${errorMessage(apiErr)}`,
            sig: sigFor(apiErr),
            ok: false,
          },
        ]);
      }
    }
    if (runRef.current !== id) return;
    setVerdict(deriveVerdict(cur, outcomes));
    setPhase("done");
  }

  const total = rows.length;
  const expected = item.calls.length;

  return (
    <section id="desk-logs" className="sec-pad">
      <div className="sec-top-row reveal">
        <div>
          <div className="kicker">// desk logs</div>
          <h2 className="sec-h2">
            Real calls, <span className="it">receipted in the open.</span>
          </h2>
        </div>
        <a href="#probe" className="mono" style={{ fontSize: 12, color: "var(--text)" }}>
          Run live probe ↗
        </a>
      </div>

      <div className="stage-shell">
        <div className="stage-main">
          <svg
            viewBox="0 0 320 340"
            style={{ position: "absolute", right: -8, bottom: -10, height: "94%", width: "auto", opacity: 0.24, pointerEvents: "none" }}
            fill="none"
            aria-hidden="true"
          >
            <defs>
              <pattern id="engPat" width="6" height="6" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
                <line x1="0" y1="0" x2="0" y2="6" stroke="#F3F2EE" strokeWidth="1.3" />
              </pattern>
            </defs>
            <path
              d="M168 38 C210 36 244 68 242 114 C240 144 226 164 214 184 L268 228 L254 328 H94 L88 232 L136 184 C126 164 118 140 122 108 C126 64 138 40 168 38 Z"
              fill="url(#engPat)"
              stroke="#F3F2EE"
              strokeWidth="1.1"
            />
            <circle cx="182" cy="112" r="96" stroke="#F3F2EE" strokeOpacity="0.25" strokeDasharray="4 5" />
            <circle cx="176" cy="242" r="5" fill="#FF5722" />
          </svg>

          <div style={{ position: "relative", zIndex: 3, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="mono" style={{ padding: "5px 9px", borderRadius: 6, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)", fontSize: 11, fontWeight: 600 }}>
                v*
              </span>
              <span style={{ color: "#8F8E8A", fontSize: 12 }}>+</span>
              <span className="mono" style={{ padding: "5px 10px", borderRadius: 6, background: "rgba(255,87,34,0.18)", border: "1px solid rgba(255,87,34,0.45)", color: "#FF5722", fontSize: 11 }}>
                {item.pill}
              </span>
            </div>
            {phase !== "cover" && (
              <button
                type="button"
                className="mono"
                style={{ fontSize: 11, color: "#8F8E8A" }}
                onClick={() => selectItem(cur)}
              >
                // reset
              </button>
            )}
          </div>

          {phase === "cover" && (
            <div style={{ position: "relative", zIndex: 3, margin: "auto 0", padding: "28px 0", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 22 }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <div className="mono" style={{ fontSize: 11.5, color: "#8F8E8A", marginBottom: 10 }}>
                  // {item.sub}
                </div>
                <h3 style={{ fontSize: "clamp(2.1rem,3.6vw,3.15rem)", fontWeight: 400, letterSpacing: "-0.03em", lineHeight: 1.04 }}>
                  {item.title}
                </h3>
                <div className="mono" style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 10, fontSize: 11.5 }}>
                  {item.calls.map((key) => (
                    <div key={key}>
                      <div style={{ color: "#8F8E8A", marginBottom: 6 }}>
                        {INTENTS.find((i) => i.key === key)?.name}
                      </div>
                      {Object.entries(params[key] ?? {}).map(([field, value]) => (
                        <label key={field} style={{ display: "grid", gridTemplateColumns: "130px 1fr", gap: 10, alignItems: "center", marginBottom: 6 }}>
                          <span style={{ color: "#CECDC8" }}>{FIELD_LABELS[field] ?? field}</span>
                          <input
                            type="text"
                            value={value}
                            onChange={(e) => setParam(key, field, e.target.value)}
                            aria-label={`${key} ${field}`}
                            style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 6, padding: "6px 9px", fontSize: 11.5, color: "#F3F2EE", width: "100%" }}
                          />
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
              <button
                type="button"
                className="play-fab"
                aria-label={`Run ${item.title} live checks`}
                onClick={() => void play()}
              >
                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" style={{ marginLeft: 3 }} aria-hidden="true">
                  <polygon points="6,4 20,12 6,20" />
                </svg>
              </button>
            </div>
          )}

          {phase !== "cover" && (
            <div style={{ position: "relative", zIndex: 3, margin: "16px 0", flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 12 }}>
              <div style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 9, background: "rgba(11,11,12,0.92)", overflow: "hidden" }}>
                <div className="mono" style={{ padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.09)", display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "#8F8E8A" }}>
                  <span>GET /api/v1/… · same-origin · no wallet, no signing</span>
                  <span>
                    {total} / {expected}
                  </span>
                </div>
                <div>
                  {rows.map((row, i) => (
                    <div key={i} className="stream-row">
                      <span style={{ color: "#F3F2EE" }}>{row.intent}</span>
                      <span style={{ color: row.ok ? "#22C55E" : "#F59E0B" }}>{row.out}</span>
                      <span style={{ color: "#8F8E8A" }}>
                        {row.ms}ms · {row.sig}
                      </span>
                    </div>
                  ))}
                  {phase === "running" && (
                    <div className="stream-row">
                      <span style={{ color: "#8F8E8A" }}>querying live endpoint…</span>
                      <span />
                      <span />
                    </div>
                  )}
                </div>
              </div>

              {verdict && (
                <div style={{ borderRadius: 8, padding: "11px 14px", border: "1px solid rgba(255,255,255,0.14)", background: "#0B0B0C", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className={`badge ${verdict.cls}`}>{verdict.label}</span>
                    <span style={{ fontSize: 12.5, color: "#F3F2EE" }}>{verdict.msg}</span>
                  </div>
                  <span className="mono" style={{ fontSize: 11, color: "#8F8E8A" }}>
                    {receipts.length} live receipt{receipts.length === 1 ? "" : "s"}
                  </span>
                </div>
              )}

              {phase === "done" && receipts.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {receipts.map((r) => (
                    <ReceiptCard key={r.receipt_id} receipt={r} />
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="mono" style={{ position: "relative", zIndex: 3, display: "flex", justifyContent: "space-between", fontSize: 11, color: "#6E6D69" }}>
            <span>/*v*/erireceipt</span>
            <span>sepolia · live receipts, no wallet</span>
          </div>
        </div>

        <aside className="pl-side">
          <div>
            <div className="mono" style={{ padding: "13px 16px", borderBottom: "1px solid rgba(255,255,255,0.09)", display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "#8F8E8A" }}>
              <span>// playlist</span>
              <span>
                {item.num} / 0{DESK_PLAYLIST.length}
              </span>
            </div>
            <div>
              {DESK_PLAYLIST.map((d, i) => (
                <button
                  key={d.num}
                  type="button"
                  className={`pl-item${i === cur ? " active" : ""}`}
                  onClick={() => selectItem(i)}
                >
                  <span className="mono" style={{ fontSize: 10.5, color: "#8F8E8A", width: 20 }}>
                    {d.num}
                  </span>
                  <div className="pl-thumb">{d.thumb}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "#F3F2EE", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {d.title}
                    </div>
                    <div className="mono" style={{ fontSize: 10.5, color: "#8F8E8A", marginTop: 2 }}>
                      {d.calls.length} live call{d.calls.length === 1 ? "" : "s"} · {d.pill.replace("MISSION ", "M")}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div className="mono" style={{ padding: "12px 16px", borderTop: "1px solid rgba(255,255,255,0.09)", fontSize: 11, color: "#6E6D69" }}>
            // runs here. zero wallet required.
          </div>
        </aside>
      </div>
    </section>
  );
}
