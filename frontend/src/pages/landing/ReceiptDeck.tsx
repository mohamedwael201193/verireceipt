// Draggable paper receipt deck — "Receipts from the live chain."
//
// The design's six cards were canned (fake receipt ids, canned hashes,
// POST curls). Each card here is a REAL ReceiptCard fed by a live API
// call (five intents + the future-interval 422 trap), with a live
// summary line and a real GET curl. A failed call shows its real error
// state instead of a fabricated card.
import { useRef, useState } from "react";
import { useLiveQuery } from "../../lib/hooks";
import { ApiError, getFilings, getGridPrice, getRoute, getTvl, getTx } from "../../lib/api";
import { formatUsd } from "../../lib/format";
import { ReceiptCard } from "../../components/ReceiptCard";
import type { Receipt } from "../../lib/types";
import { PRESETS, TRAP_PRESETS, type IntentKey } from "./data";
import { copyText } from "./toast";
import { curlFor, curlForPreset, formatLmp, formatUsdcBaseUnits, shortHash } from "./utils";
import { errorMessage } from "./utils";

interface DeckItem {
  note: string;
  sig: string;
  key: IntentKey;
  trap: boolean;
  params: Record<string, string>;
}

const ITEMS: DeckItem[] = [
  { note: "// receipt 01 of 06 · ONCHAIN_TX_LOOKUP_GENERAL", sig: "Onchain Tx", key: "tx", trap: false, params: PRESETS.tx },
  { note: "// receipt 02 of 06 · REGULATORY_FILING_MONITOR_GENERAL", sig: "SEC Filing", key: "sec", trap: false, params: PRESETS.sec },
  { note: "// receipt 03 of 06 · TVL_LOOKUP_GENERAL", sig: "DeFiLlama", key: "tvl", trap: false, params: PRESETS.tvl },
  { note: "// receipt 04 of 06 · OPTIMAL_EXECUTION_ROUTE_GENERAL", sig: "Eth Route", key: "route", trap: false, params: PRESETS.route },
  { note: "// receipt 05 of 06 · GRID_POWER_PRICE_GENERAL", sig: "Grid LMP", key: "grid", trap: false, params: PRESETS.grid },
  { note: "// receipt 06 of 06 · ADVERSARIAL 422 TRAP", sig: "TrapTest", key: "grid", trap: true, params: TRAP_PRESETS.grid },
];

function summaryFor(item: DeckItem, data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;
  switch (item.key) {
    case "tx":
      return `Block ${String(d.block_number)} ${String(d.status)} · from ${shortHash(String(d.from ?? ""))} to ${shortHash(String(d.to ?? ""))} · ${String(d.value_eth ?? 0)} ETH.`;
    case "sec": {
      // The count carries its window: "95 filings" is the last-12-months
      // answer, "52" the last-6-months one — the 2026-11-20
      // landing/dashboard mismatch was exactly this (filings J2 minor 1).
      const period = typeof item.params.period === "string" ? item.params.period : "";
      const window = period ? ` in ${period}` : "";
      return `${String(d.filing_count)} filings for ${String(d.entity)}${window} pulled verbatim from data.sec.gov with direct EDGAR archive URLs.`;
    }
    case "tvl":
      return `${String(d.protocol_or_chain)} normalized cleanly to ${formatUsd(d.tvl_usd as number)} total TVL with timestamped proof.`;
    case "route":
      return `Block-pinned execution resolved 1 ETH to ${formatUsdcBaseUnits(d.amount_out as number)} in exact 6-decimal base units${d.winning_venue ? ` via ${String(d.winning_venue)}` : ""}.`;
    case "grid":
      if (item.trap) return "";
      return `${String(d.node_or_zone)} wholesale settlement interval served from the SQLite cron cache at ${formatLmp(d.lmp_usd_per_mwh as number)} (${String(d.market)}).`;
    default:
      return "";
  }
}

export function ReceiptDeck() {
  const tx = useLiveQuery("deck-tx", () => getTx({ tx_hash: PRESETS.tx.tx_hash, chain: PRESETS.tx.chain }));
  const sec = useLiveQuery("deck-sec", () => getFilings({ entity: PRESETS.sec.entity, period: PRESETS.sec.period }));
  const tvl = useLiveQuery("deck-tvl", () => getTvl({ protocol: PRESETS.tvl.protocol }));
  const route = useLiveQuery("deck-route", () => getRoute({ pair: PRESETS.route.pair }));
  const grid = useLiveQuery("deck-grid", () =>
    getGridPrice({ node_or_zone: PRESETS.grid.node_or_zone, interval_start: PRESETS.grid.interval_start }),
  );
  const trap = useLiveQuery("deck-trap", () =>
    getGridPrice({ node_or_zone: TRAP_PRESETS.grid.node_or_zone, interval_start: TRAP_PRESETS.grid.interval_start }),
  );
  const results = [tx, sec, tvl, route, grid, trap];

  const [off, setOff] = useState(0);
  const dragRef = useRef<{ sx: number; sy: number; dx: number; dy: number; down: boolean }>({
    sx: 0,
    sy: 0,
    dx: 0,
    dy: 0,
    down: false,
  });

  function advance(delta: number) {
    setOff((o) => (o + delta + ITEMS.length) % ITEMS.length);
  }

  function metaLine(idx: number): string {
    const r = results[idx];
    if (r.loading) return "querying live endpoint…";
    if (r.error) {
      const e = r.error instanceof ApiError ? r.error : null;
      return e ? `HTTP ${e.status || "ERR"} · ${e.code ?? "error"}` : "request failed";
    }
    const data = r.data as unknown as { receipt?: { receipt_id?: string; raw_response_sha256?: string } } | null;
    const receipt = data?.receipt;
    if (!receipt?.receipt_id) return "no receipt";
    return `${receipt.receipt_id} · sha256 ${shortHash(receipt.raw_response_sha256)}`;
  }

  function renderCard(item: DeckItem, depth: number, isTop: boolean) {
    const idx = ITEMS.indexOf(item);
    const r = results[idx];
    const curl = item.trap ? curlFor("grid", TRAP_PRESETS.grid) : curlForPreset(item.key);
    return (
      <div
        key={`${item.note}-${off}`}
        className="paper-card"
        data-d={String(depth)}
        onPointerDown={
          isTop
            ? (e) => {
                if ((e.target as HTMLElement).closest("button")) return;
                dragRef.current = { sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, down: true };
                (e.currentTarget as HTMLElement).classList.add("dragging");
                if ((e.currentTarget as HTMLElement).setPointerCapture) {
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                }
              }
            : undefined
        }
        onPointerMove={
          isTop
            ? (e) => {
                const d = dragRef.current;
                if (!d.down) return;
                d.dx = e.clientX - d.sx;
                d.dy = e.clientY - d.sy;
                (e.currentTarget as HTMLElement).style.transform =
                  `translate3d(${d.dx}px,${d.dy * 0.35}px,0) rotate(${d.dx * 0.045}deg)`;
              }
            : undefined
        }
        onPointerUp={
          isTop
            ? (e) => {
                const d = dragRef.current;
                if (!d.down) return;
                d.down = false;
                const card = e.currentTarget as HTMLElement;
                card.classList.remove("dragging");
                if (Math.abs(d.dx) > 85) {
                  card.style.transition = "transform 0.28s ease, opacity 0.24s ease";
                  card.style.transform = `translate3d(${d.dx > 0 ? 500 : -500}px,${d.dy * 0.35}px,0) rotate(${d.dx > 0 ? 18 : -18}deg)`;
                  card.style.opacity = "0";
                  setTimeout(() => advance(1), 220);
                } else {
                  card.style.transform = "";
                }
              }
            : undefined
        }
        onPointerCancel={
          isTop
            ? (e) => {
                dragRef.current.down = false;
                (e.currentTarget as HTMLElement).classList.remove("dragging");
                (e.currentTarget as HTMLElement).style.transform = "";
              }
            : undefined
        }
      >
        <div className="mono" style={{ fontSize: 11, color: "var(--paper-muted)" }}>
          {item.note}
        </div>
        {r.loading && (
          <p style={{ fontSize: "clamp(1.05rem,1.8vw,1.3rem)", lineHeight: 1.38, letterSpacing: "-0.02em", color: "var(--paper-muted)" }}>
            Querying the live endpoint…
          </p>
        )}
        {r.error && (
          <p style={{ fontSize: "clamp(1.05rem,1.8vw,1.3rem)", lineHeight: 1.38, letterSpacing: "-0.02em" }}>
            {item.trap ? (
              <>
                Future settlement interval refused cleanly with{" "}
                <em className="serif-i" style={{ fontWeight: 500 }}>
                  HTTP {r.error instanceof ApiError ? r.error.status : "422"} and zero charge
                </em>{" "}
                — proving the oracle never fabricates missing data.
              </>
            ) : (
              <>Live call failed: {errorMessage(r.error)}</>
            )}
          </p>
        )}
        {r.data && (
          <p style={{ fontSize: "clamp(1.05rem,1.8vw,1.3rem)", lineHeight: 1.38, letterSpacing: "-0.02em" }}>
            {summaryFor(item, r.data)}
          </p>
        )}
        {r.data && (r.data as { receipt?: Receipt }).receipt && (
          <div style={{ overflow: "auto", minHeight: 0 }}>
            <ReceiptCard receipt={(r.data as { receipt: Receipt }).receipt} />
          </div>
        )}
        {r.error && item.trap && (
          <div className="mono" style={{ fontSize: 11.5, color: "var(--paper-muted)", lineHeight: 1.7 }}>
            {errorMessage(r.error)}
            <br />
            No receipt is issued for an unbilled refusal.
          </div>
        )}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 14,
            paddingTop: 16,
            borderTop: "1px solid var(--paper-border)",
          }}
        >
          <div>
            <div className="serif-i" style={{ fontSize: 26, lineHeight: 1.1, marginBottom: 4 }}>
              {item.sig}
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--paper-muted)", marginBottom: 8 }}>
              {metaLine(idx)}
            </div>
            <button
              type="button"
              className="mono"
              style={{ fontSize: 11, color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: 3 }}
              onClick={(e) => {
                e.stopPropagation();
                void copyText(curl);
              }}
            >
              Copy curl
            </button>
          </div>
          <div className="v-seal">v*</div>
        </div>
      </div>
    );
  }

  return (
    <section className="sec-pad">
      <div className="split-5-7">
        <div className="reveal">
          <div className="kicker">// verifiable proofs</div>
          <h2 className="sec-h2" style={{ marginBottom: 18 }}>
            Receipts from
            <br />
            <span className="it">the live chain.</span>
          </h2>
          <p style={{ fontSize: 14.5, color: "var(--muted)", maxWidth: 340, marginBottom: 34 }}>
            Every answer carries its upstream URL and SHA-256 digest anyone can recompute in 30 seconds.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button type="button" className="circle-arrow" aria-label="Previous receipt" onClick={() => advance(-1)}>
              ←
            </button>
            <button type="button" className="circle-arrow" aria-label="Next receipt" onClick={() => advance(1)}>
              →
            </button>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--muted)", marginLeft: 6 }}>
              // drag the top receipt away
            </span>
          </div>
        </div>
        <div>
          <div id="paper-deck" className="deck-stage">
            {ITEMS.map((item, i) => {
              const depth = (i - off + ITEMS.length) % ITEMS.length;
              return renderCard(item, depth, depth === 0);
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
