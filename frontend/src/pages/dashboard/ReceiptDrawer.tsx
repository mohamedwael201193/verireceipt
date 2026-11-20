// Receipt Inspector drawer — shows a REAL receipt from a live call.
//
// Replaces openReceiptDrawer (DESIGN-SPEC §6 D-15, §8 A16/A19):
// - No devnode signal link (no such proof exists for direct probes) and no
//   "Merkle Verified / Pending hourly epoch" badge (no epoch mechanism
//   exists). The proof link is receipt.audit_url, returned by the miner.
// - "Recompute SHA-256 in Browser" fetches receipt.upstream_url and hashes
//   the fetched bytes, comparing with receipt.raw_response_sha256. Outcomes:
//   MATCH / MISMATCH (both real) / UNVERIFIABLE (upstream not fetchable via
//   GET from the browser — e.g. POST-only RPCs — with a curl fallback).
//   WebCrypto unavailable => an error, never a fallback fake hash (A19).
// - Copy curl rebuilds the real GET request; Copy JSON copies the live body.

import { useEffect, useRef, useState } from "react";
import { isSafeUpstreamUrl, ReceiptCard } from "../../components/ReceiptCard";
import type { LiveReceipt } from "./types";
import { copyText, highlightJson, sha256Hex, useDrawerFocus } from "./utils";

interface ReceiptDrawerProps {
  receipt: LiveReceipt | null;
  onClose: () => void;
  showToast: (msg: string) => void;
}

type VerifyState =
  | { kind: "idle" }
  | { kind: "fetching" }
  | { kind: "match"; computed: string }
  | { kind: "mismatch"; computed: string }
  | { kind: "unverifiable"; reason: string }
  | { kind: "no-crypto" };

export default function ReceiptDrawer({ receipt, onClose, showToast }: ReceiptDrawerProps) {
  const [verify, setVerify] = useState<VerifyState>({ kind: "idle" });
  const panelRef = useRef<HTMLElement | null>(null);
  const open = receipt !== null;
  useDrawerFocus(open, panelRef);

  // A verification result belongs to the receipt it was computed for.
  useEffect(() => {
    setVerify({ kind: "idle" });
  }, [receipt?.id]);

  const recorded = receipt?.receipt?.raw_response_sha256 ?? null;
  // audit_url / quorum_votes come through the Receipt index signature as
  // unknown; narrow before rendering.
  const auditUrl =
    receipt?.receipt && typeof receipt.receipt.audit_url === "string"
      ? receipt.receipt.audit_url
      : null;
  // The audit URL comes from the server (and therefore from upstream
  // data): it renders as a link ONLY when it passes the shared
  // https-only allowlist (isSafeUpstreamUrl, data-layer lib). Anything
  // else — javascript:, data:, http:, relative — renders as plain text,
  // never as an <a href> (XSS sink).

  async function recompute() {
    if (!receipt?.receipt) return;
    if (!window.crypto?.subtle) {
      setVerify({ kind: "no-crypto" });
      return;
    }
    setVerify({ kind: "fetching" });
    try {
      const res = await fetch(receipt.receipt.upstream_url);
      if (!res.ok) {
        setVerify({
          kind: "unverifiable",
          reason: `Upstream answered HTTP ${res.status} to a browser GET — the hashed bytes cannot be re-fetched this way.`,
        });
        return;
      }
      const buf = await res.arrayBuffer();
      const computed = await sha256Hex(buf);
      if (computed === null) {
        setVerify({ kind: "no-crypto" });
        return;
      }
      setVerify(
        computed.toLowerCase() === receipt.receipt.raw_response_sha256.toLowerCase()
          ? { kind: "match", computed }
          : { kind: "mismatch", computed },
      );
      if (computed.toLowerCase() === receipt.receipt.raw_response_sha256.toLowerCase()) {
        showToast("SHA-256 bit-exact match verified in browser");
      }
    } catch (err) {
      setVerify({
        kind: "unverifiable",
        reason: `Browser could not fetch the upstream URL (${err instanceof Error ? err.message : "network/CORS error"}). Upstream RPCs are POST-only and some hosts block browser fetches.`,
      });
    }
  }

  const curlCmd = receipt ? `curl -s "${receipt.requestUrl}"` : "";

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal={open}
      aria-label="Receipt Inspector"
      inert={!open}
      className={`drawer${open ? " open" : ""}`}
    >      <div className="drawer-head">
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span className="mono" style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" }}>
            {receipt?.id ?? ""}
          </span>
          {receipt && (
            <span className={`badge ${receipt.status === 200 ? "b-ok" : receipt.status === 0 ? "b-err" : "b-warn"}`}>
              {receipt.status === 0 ? "TIMEOUT" : `${receipt.status}${receipt.status === 200 ? " OK" : ""}`}
            </span>
          )}
        </div>
        <button type="button" className="btn-ghost" style={{ padding: "4px 10px" }} onClick={onClose} aria-label="Close Inspector">✕</button>
      </div>

      <div className="drawer-body">
        {receipt === null ? (
          <div className="live-empty">No receipt selected.</div>
        ) : (
          <>
            <div className="panel mono" style={{ padding: "13px 14px", fontSize: 11.5, display: "flex", flexDirection: "column", gap: 9 }}>
              <div>
                <div style={{ color: "var(--muted)", fontSize: 10, marginBottom: 2 }}>UPSTREAM SOURCE URL</div>
                <div style={{ color: "var(--text)", wordBreak: "break-all" }}>
                  {receipt.receipt ? receipt.receipt.upstream_url : "— (no receipt — call was refused before receipting)"}
                </div>
              </div>
              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 9 }}>
                <div style={{ color: "var(--muted)", fontSize: 10, marginBottom: 2 }}>MINER AUDIT URL</div>
                {auditUrl ? (
                  isSafeUpstreamUrl(auditUrl) ? (
                    <a href={auditUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", textDecoration: "underline", wordBreak: "break-all" }}>
                      {auditUrl}
                    </a>
                  ) : (
                    <div style={{ color: "var(--text)", wordBreak: "break-all" }}>
                      {auditUrl} <span style={{ color: "var(--muted)" }}>(not rendered as a link — non-https URL)</span>
                    </div>
                  )
                ) : (
                  <div style={{ color: "var(--text)" }}>No audit URL — refused before receipting.</div>
                )}
              </div>
              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 9, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <span style={{ color: "var(--muted)", fontSize: 10 }}>EPOCH / MERKLE ATTESTATION</span>
                <span className="badge b-dim">none in this build</span>
              </div>
              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 9, fontSize: 10.5, color: "var(--muted)", lineHeight: 1.6 }}>
                No hourly-epoch or Merkle attestation exists for direct probes (DESIGN-SPEC §8 A16). The receipt block above is the proof.
              </div>
            </div>

            {receipt.receipt && (
              <div className="receipt-card-wrap">
                <ReceiptCard receipt={receipt.receipt} />
              </div>
            )}

            <div className="panel" style={{ padding: "14px 15px", borderColor: "var(--border-strong)" }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
                <div>
                  <div className="mono" style={{ fontSize: 11, fontWeight: 500 }}>// browser sha-256 verification</div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>Fetch the upstream URL and re-hash its bytes via Web Crypto API</div>
                </div>
                <button
                  type="button"
                  className="btn-accent"
                  style={{ padding: "7px 14px", fontSize: 12 }}
                  onClick={() => void recompute()}
                  disabled={!receipt.receipt || verify.kind === "fetching"}
                >
                  {verify.kind === "fetching" ? "Fetching upstream…" : "Recompute SHA-256 in Browser"}
                </button>
              </div>
              <div className="mono" style={{ fontSize: 11, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ color: "var(--muted)" }}>
                  Recorded: <span style={{ color: "var(--text)", wordBreak: "break-all" }}>{recorded ?? "— (no receipt)"}</span>
                </div>
                {(verify.kind === "match" || verify.kind === "mismatch") && (
                  <div style={{ color: "var(--muted)" }}>
                    Computed: <span style={{ color: "var(--ok)", wordBreak: "break-all" }}>{verify.computed}</span>
                  </div>
                )}
              </div>
              {verify.kind === "match" && (
                <div className="badge b-ok" style={{ marginTop: 10, padding: "5px 10px", fontSize: 11.5 }}>BIT-EXACT MATCH VERIFIED ✓</div>
              )}
              {verify.kind === "mismatch" && (
                <div className="badge b-err" style={{ marginTop: 10, padding: "5px 10px", fontSize: 11.5 }}>
                  DIGEST MISMATCH — the upstream bytes changed since the receipt was minted (live data moves)
                </div>
              )}
              {verify.kind === "unverifiable" && (
                <div style={{ marginTop: 10 }}>
                  <div className="badge b-warn" style={{ padding: "5px 10px", fontSize: 11.5 }}>NOT VERIFIABLE FROM THIS BROWSER</div>
                  <div className="note-line" style={{ marginTop: 8 }}>{verify.reason}</div>
                  <div className="note-line" style={{ marginTop: 6 }}>Verify from a terminal instead:</div>
                  <div className="code-box" style={{ marginTop: 6 }}>
                    <pre className="code-pre" style={{ padding: "10px 12px" }}>{`curl -s "${receipt.receipt?.upstream_url ?? ""}" | sha256sum\n# compare with ${recorded ?? ""}`}</pre>
                  </div>
                </div>
              )}
              {verify.kind === "no-crypto" && (
                <div className="badge b-err" style={{ marginTop: 10, padding: "5px 10px", fontSize: 11.5 }}>
                  Web Crypto unavailable — cannot recompute in this browser
                </div>
              )}
              {!receipt.receipt && (
                <div className="note-line" style={{ marginTop: 10 }}>
                  This call was refused before a receipt was minted, so there is no hash to verify.
                </div>
              )}
            </div>

            <div className="code-box">
              <div className="code-bar">
                <span className="mono" style={{ fontSize: 11, color: "#8E8D89" }}>canonical root fields + receipt envelope</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    className="btn-ghost"
                    style={{ borderColor: "rgba(255,255,255,0.22)", color: "#F2F1EC", padding: "4px 10px", fontSize: 10.5 }}
                    onClick={() => {
                      if (copyText(curlCmd)) showToast("Copied to clipboard");
                      else showToast("Clipboard copy unavailable");
                    }}
                  >
                    Copy curl
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    style={{ borderColor: "rgba(255,255,255,0.22)", color: "#F2F1EC", padding: "4px 10px", fontSize: 10.5 }}
                    onClick={() => {
                      if (copyText(JSON.stringify(receipt.body, null, 2))) showToast("Copied to clipboard");
                      else showToast("Clipboard copy unavailable");
                    }}
                  >
                    Copy JSON
                  </button>
                </div>
              </div>
              <pre
                className="code-pre"
                style={{ maxHeight: 320 }}
                dangerouslySetInnerHTML={{ __html: highlightJson(receipt.body) }}
              />
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
