// 3-Tier Auth Mode drawer.
//
// Replaces the auth drawer values (DESIGN-SPEC §6 D-14, §8 A3): the
// fabricated "$1.84 / 184 checks" sponsored balance is NOT displayed. The
// sponsored card shows the verified $1.40 registration bond instead, and
// the 5/day per-IP limit is labelled as Desk config (render.yaml:
// DESK_FREE_CHECKS_PER_IP_DAY=5). BYO values stay in browser memory only
// and are never written to localStorage (the theme key is separate).

import { useState } from "react";
import type { AuthMode } from "./types";
import { copyText, DIAMOND_SHORT, MINER_BOND_USDC } from "./utils";

interface AuthDrawerProps {
  open: boolean;
  authMode: AuthMode;
  onSelectMode: (mode: AuthMode) => void;
  onClose: () => void;
  showToast: (msg: string) => void;
}

export default function AuthDrawer({ open, authMode, onSelectMode, onClose, showToast }: AuthDrawerProps) {
  const [tab, setTab] = useState<AuthMode>("sponsored");
  const [byokKey, setByokKey] = useState("");
  const [byokAddr, setByokAddr] = useState("");

  return (
    <aside className={`drawer${open ? " open" : ""}`} aria-label="Auth & Payment Mode">
      <div className="drawer-head">
        <div className="mono" style={{ fontSize: 13, fontWeight: 500 }}>// 3-tier access &amp; payment mode</div>
        <button type="button" className="btn-ghost" style={{ padding: "4px 10px" }} onClick={onClose} aria-label="Close Auth Drawer">✕</button>
      </div>

      <div className="drawer-body">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6 }}>
          <button type="button" className={`pill${tab === "sponsored" ? " active" : ""}`} style={{ justifyContent: "center" }} onClick={() => setTab("sponsored")}>01 Sponsored</button>
          <button type="button" className={`pill${tab === "byok" ? " active" : ""}`} style={{ justifyContent: "center" }} onClick={() => setTab("byok")}>02 BYO Key</button>
          <button type="button" className={`pill${tab === "mcp" ? " active" : ""}`} style={{ justifyContent: "center" }} onClick={() => setTab("mcp")}>03 MCP / CLI</button>
        </div>

        {tab === "sponsored" && (
          <div className="panel" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <strong style={{ fontSize: 15 }}>Zero-Wallet Sponsored Mode</strong>
              <span className="badge b-ok">ACTIVE DEFAULT</span>
            </div>
            <p style={{ fontSize: 13, color: "var(--muted)" }}>
              Judges and reviewers run live Desk checks immediately without installing MetaMask or minting Sepolia Test USDC.
              Calls settle from the server-funded Sepolia Escrow balance on Diamond <code className="mono" style={{ color: "var(--text)" }}>{DIAMOND_SHORT}</code>.
            </p>
            <div className="kpi-grid-4" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 0 }}>
              <div className="card" style={{ padding: 12 }}>
                <div className="kpi-lbl">Miner Bond</div>
                <div className="mono" style={{ fontSize: 18, color: "var(--accent)" }}>{MINER_BOND_USDC}</div>
                <div className="kpi-sub">on-chain registration bond</div>
              </div>
              <div className="card" style={{ padding: 12 }}>
                <div className="kpi-lbl">Per-IP Limit</div>
                <div className="mono" style={{ fontSize: 18 }}>5 / day</div>
                <div className="kpi-sub">Desk config · zero wallet friction</div>
              </div>
            </div>
            <div className="note-line">
              No live escrow balance is exposed by the miner API, so no runway figure is shown here. The $1.40 bond above is the
              verified on-chain registration bond.
            </div>
            <button
              type="button"
              className="btn-accent"
              onClick={() => {
                onSelectMode("sponsored");
                onClose();
                showToast("Switched to Zero-Wallet Sponsored Mode");
              }}
            >
              Use Sponsored Escrow Mode
            </button>
          </div>
        )}

        {tab === "byok" && (
          <div className="panel" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <strong style={{ fontSize: 15 }}>Bring Your Own Key / Sepolia Wallet</strong>
            <p style={{ fontSize: 12.5, color: "var(--muted)" }}>
              Optional power-user override. Values remain strictly in browser memory only and are never written to localStorage or transmitted to third parties.
            </p>
            <div>
              <label htmlFor="byok-key" className="mono" style={{ display: "block", fontSize: 10.5, color: "var(--muted)", marginBottom: 4 }}>Anjoman API Key (anjoman_...)</label>
              <input id="byok-key" type="password" className="field-input" placeholder="anjoman_live_..." value={byokKey} onChange={(e) => setByokKey(e.target.value)} />
            </div>
            <div>
              <label htmlFor="byok-addr" className="mono" style={{ display: "block", fontSize: 10.5, color: "var(--muted)", marginBottom: 4 }}>Or Sepolia Escrow Wallet Address</label>
              <input id="byok-addr" type="text" className="field-input" placeholder="0x..." value={byokAddr} onChange={(e) => setByokAddr(e.target.value)} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn-accent"
                style={{ flex: 1 }}
                onClick={() => {
                  if (!byokKey.trim() && !byokAddr.trim()) {
                    showToast("Enter an API key or wallet address first");
                    return;
                  }
                  onSelectMode("byok");
                  onClose();
                  showToast("Custom credentials applied in memory only");
                }}
              >
                Apply In-Memory
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setByokKey("");
                  setByokAddr("");
                  onSelectMode("sponsored");
                  showToast("Cleared custom credentials");
                }}
              >
                Clear
              </button>
            </div>
            {authMode === "byok" && <div className="note-line">BYO mode active (in-memory only).</div>}
          </div>
        )}

        {tab === "mcp" && (
          <div className="panel" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <strong style={{ fontSize: 15 }}>Developer MCP / CLI Mode</strong>
            <p style={{ fontSize: 12.5, color: "var(--muted)" }}>
              Connect any MCP-compatible agent directly to the keyless Streamable HTTP endpoint or run the CLI verification runner locally.
            </p>
            <div className="code-box">
              <div className="code-bar">
                <span className="mono" style={{ fontSize: 10.5, color: "#8E8D89" }}>Streamable HTTP MCP Endpoint</span>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ borderColor: "rgba(255,255,255,0.22)", color: "#F2F1EC", padding: "3px 9px", fontSize: 10 }}
                  onClick={() => {
                    if (copyText("https://verireceipt.onrender.com/api/mcp")) showToast("Copied to clipboard");
                    else showToast("Clipboard copy unavailable");
                  }}
                >
                  Copy
                </button>
              </div>
              <pre className="code-pre" style={{ padding: "11px 14px" }}>https://verireceipt.onrender.com/api/mcp</pre>
            </div>
            <div className="code-box">
              <div className="code-bar">
                <span className="mono" style={{ fontSize: 10.5, color: "#8E8D89" }}>One-Command Local CLI</span>
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
          </div>
        )}
      </div>
    </aside>
  );
}
