// 2-Tier Auth Mode drawer.
//
// Replaces the auth drawer values (DESIGN-SPEC §6 D-14, §8 A3): the
// fabricated "$1.84 / 184 checks" sponsored balance is NOT displayed. The
// sponsored card shows the on-chain registration bond instead ($1.50 =
// minerBond(6152), see lib/minerBond.ts), and
// the 5/day per-IP limit is labelled as Desk config (render.yaml:
// DESK_FREE_CHECKS_PER_IP_DAY=5). r9: src/ reads no DESK_* variable, so the
// limit is labelled "not enforced yet". Desk Phase D: the Desk AGENT's own
// escrow-paid engine purchases are proven (desk/ledger/purchases.jsonl,
// shown under Receipts), but visitor checks in this browser are still
// direct and unbilled — sponsoring them from escrow is not shipped, so that
// stays UNVERIFIED (consistent with landing plate 09).
//
// There is deliberately NO "Bring Your Own Key" tier: the miner API is
// auth:none and there is no authenticated header path, so an API-key /
// wallet-address field could never be applied — the old drawer collected
// credentials, toasted "applied" and showed a "BYO Key · Active" pill for
// a mode that did nothing. The drawer is now 2-tier (Sponsored, MCP/CLI).
// r8: the MCP tab no longer advertises a miner MCP URL on onrender.com
// — the miner serves no MCP endpoint (live 404 on GET and POST, 2026-11-21).
// It points at the official Telegraph MCP package only.

import { useRef, useState } from "react";
import type { AuthMode } from "./types";
import { copyText, DIAMOND_SHORT, MINER_BOND_USDC, useDrawerFocus } from "./utils";

interface AuthDrawerProps {
  open: boolean;
  authMode: AuthMode;
  onSelectMode: (mode: AuthMode) => void;
  onClose: () => void;
  showToast: (msg: string) => void;
}

export default function AuthDrawer({ open, authMode, onSelectMode, onClose, showToast }: AuthDrawerProps) {
  const [tab, setTab] = useState<AuthMode>("sponsored");
  const panelRef = useRef<HTMLElement | null>(null);
  useDrawerFocus(open, panelRef);

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal={open}
      aria-label="Auth & Payment Mode"
      inert={!open}
      className={`drawer${open ? " open" : ""}`}
    >
      <div className="drawer-head">
        <div className="mono" style={{ fontSize: 13, fontWeight: 500 }}>// 2-tier access &amp; payment mode</div>
        <button type="button" className="btn-ghost" style={{ padding: "4px 10px" }} onClick={onClose} aria-label="Close Auth Drawer">✕</button>
      </div>

      <div className="drawer-body">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 6 }}>
          <button type="button" className={`pill${tab === "sponsored" ? " active" : ""}`} style={{ justifyContent: "center" }} onClick={() => setTab("sponsored")}>01 Sponsored</button>
          <button type="button" className={`pill${tab === "mcp" ? " active" : ""}`} style={{ justifyContent: "center" }} onClick={() => setTab("mcp")}>02 MCP / CLI</button>
        </div>

        {tab === "sponsored" && (
          <div className="panel" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <strong style={{ fontSize: 15 }}>Zero-Wallet Mode · direct probes</strong>
              <span className="badge b-ok">ACTIVE DEFAULT</span>
            </div>
            <p style={{ fontSize: 13, color: "var(--muted)" }}>
              Judges and reviewers run live Desk checks immediately without installing MetaMask or minting Sepolia Test USDC:
              today every check calls the miner&apos;s keyless GET endpoints directly — no wallet, no signing, unbilled ($0.00).
              Sponsoring visitor checks from escrow on Diamond <code className="mono" style={{ color: "var(--text)" }}>{DIAMOND_SHORT}</code> is{" "}
              <strong>UNVERIFIED — not shipped for visitor checks</strong>. The Desk agent&apos;s own escrow-paid engine purchases
              are real and listed, with their receipts, under Receipts (same status as plate 09 on the landing page).
            </p>
            <div className="kpi-grid-4" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 0 }}>
              <div className="card" style={{ padding: 12 }}>
                <div className="kpi-lbl">Miner Bond</div>
                <div className="mono" style={{ fontSize: 18, color: "var(--accent)" }}>{MINER_BOND_USDC}</div>
                <div className="kpi-sub">on-chain minerBond(6152) · 6 intents</div>
              </div>
              <div className="card" style={{ padding: 12 }}>
                <div className="kpi-lbl">Per-IP Limit</div>
                <div className="mono" style={{ fontSize: 18 }}>5 / day</div>
                <div className="kpi-sub">planned Desk config (render.yaml) · not enforced yet — UNVERIFIED</div>
              </div>
            </div>
            <div className="note-line">
              No live escrow balance is exposed by the miner API, so no runway figure is shown here. The {MINER_BOND_USDC} figure above is
              the bond of registration 6152 as read on-chain on 2026-11-21 (minerBond(6152) = quoteMinerBond(6) =
              1,500,000 base units); the Status page re-reads it live. Sepolia registration status is on the Status page and
              is not called active unless the live Telegraph node says so.
            </div>
            <button
              type="button"
              className="btn-accent"
              onClick={() => {
                onSelectMode("sponsored");
                onClose();
                showToast("Switched to Zero-Wallet Mode (direct, unbilled probes)");
              }}
            >
              Use Zero-Wallet Mode
            </button>
          </div>
        )}

        {tab === "mcp" && (
          <div className="panel" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <strong style={{ fontSize: 15 }}>Developer Mode · Telegraph MCP</strong>
            <p style={{ fontSize: 12.5, color: "var(--muted)" }}>
              Ask the Telegraph network from any MCP-compatible agent with the official Telegraph MCP server (stdio via npx;
              it pays from your own escrow wallet). This miner serves no MCP endpoint of its own — agents reach it through the
              Telegraph node, or call its keyless GET endpoints directly.
            </p>
            <div className="code-box">
              <div className="code-bar">
                <span className="mono" style={{ fontSize: 10.5, color: "#8E8D89" }}>Official Telegraph MCP server (stdio)</span>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ borderColor: "rgba(255,255,255,0.22)", color: "#F2F1EC", padding: "3px 9px", fontSize: 10 }}
                  onClick={() => {
                    if (copyText("npx -y @telegraphprotocol/telegraph-protocol-mcp")) showToast("Copied to clipboard");
                    else showToast("Clipboard copy unavailable");
                  }}
                >
                  Copy
                </button>
              </div>
              <pre className="code-pre" style={{ padding: "11px 14px" }}>npx -y @telegraphprotocol/telegraph-protocol-mcp</pre>
            </div>
            {authMode === "mcp" && <div className="note-line">MCP / CLI mode active.</div>}
            <button
              type="button"
              className="btn-accent"
              onClick={() => {
                onSelectMode("mcp");
                onClose();
                showToast("Switched to MCP / CLI Mode");
              }}
            >
              Use MCP / CLI Mode
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
