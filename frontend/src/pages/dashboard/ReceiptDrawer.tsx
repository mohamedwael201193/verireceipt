// Receipt Inspector drawer — shows a REAL receipt from a live call.
//
// Replaces openReceiptDrawer (DESIGN-SPEC §6 D-15, §8 A16/A19):
// - No devnode signal link (no such proof exists for direct probes) and no
//   "Merkle Verified / Pending hourly epoch" badge (no epoch mechanism
//   exists). The proof link is receipt.audit_url, returned by the miner.
// - "Recompute SHA-256 in Browser" calls THE ONE verifier
//   (src/lib/verifyReceipt.ts, PLAN.md C2): stored raw bytes first
//   (/api/receipts/:id/raw), then the per-endpoint live re-check.
//   The match block names the path. A grid + live_recheck match is
//   caveated (N2): it re-hashes the fields already in the receipt, it
//   is not a raw-bytes proof, and the toast is qualified, not a bare
//   "bit-exact match". WebCrypto unavailable => no-crypto, never a
//   fallback fake hash (A19).
// - Copy curl rebuilds the real GET request; Copy JSON copies the live body.

import { useEffect, useRef, useState } from "react";
import { isSafeUpstreamUrl, ReceiptCard } from "../../components/ReceiptCard";
import { REQUEST_TIMEOUT_MS } from "../../lib/api";
import { endpointForIntent, verifyReceipt, type VerifyResult } from "../../lib/verifyReceipt";
import type { LiveReceipt } from "./types";
import { copyText, highlightJson, isVerified, useDrawerFocus } from "./utils";

interface ReceiptDrawerProps {
  receipt: LiveReceipt | null;
  onClose: () => void;
  showToast: (msg: string) => void;
}

type VerifyState =
  | { kind: "idle" }
  | { kind: "fetching" }
  | { kind: "result"; result: VerifyResult };

export default function ReceiptDrawer({ receipt, onClose, showToast }: ReceiptDrawerProps) {
  const [verify, setVerify] = useState<VerifyState>({ kind: "idle" });
  const panelRef = useRef<HTMLElement | null>(null);
  const recomputeController = useRef<AbortController | null>(null);
  const open = receipt !== null;
  useDrawerFocus(open, panelRef);

  // A verification result belongs to the receipt it was computed for.
  // A new receipt (or unmount) also aborts any in-flight recompute so
  // it can never settle into state afterwards (J2 R3 M-2).
  useEffect(() => {
    setVerify({ kind: "idle" });
    recomputeController.current?.abort();
    recomputeController.current = null;
  }, [receipt?.id]);
  useEffect(() => {
    return () => {
      recomputeController.current?.abort();
      recomputeController.current = null;
    };
  }, []);

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
    const endpoint = endpointForIntent(receipt.intent);
    if (!endpoint) {
      setVerify({
        kind: "result",
        result: {
          kind: "unverifiable",
          reason: `No verifier mapping for intent ${receipt.intent} — the hash was not checked.`,
          mode: "not_applicable",
        },
      });
      return;
    }
    recomputeController.current?.abort();
    const controller = new AbortController();
    recomputeController.current = controller;
    setVerify({ kind: "fetching" });
    try {
      const body = receipt.body;
      const data =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : undefined;
      const result = await verifyReceipt(receipt.receipt, endpoint, data, {
        signal: controller.signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (result.kind === "cancelled") {
        setVerify({ kind: "idle" });
        return;
      }
      setVerify({ kind: "result", result });
      if (result.kind === "verified" && result.mode === "live_recheck" && endpoint === "grid") {
        // N2: qualify — do not toast a bare bit-exact match for a
        // canonical-field re-hash.
        showToast(
          "SHA-256 matches the stored grid fields (live re-check — not a stored-raw-bytes proof)",
        );
      } else if (result.kind === "verified") {
        showToast(
          result.mode === "raw_bytes"
            ? "SHA-256 bit-exact match of the stored raw bytes, verified in browser"
            : `SHA-256 match via ${result.method}`,
        );
      }
    } finally {
      if (recomputeController.current === controller) recomputeController.current = null;
    }
  }

  function cancelRecompute() {
    recomputeController.current?.abort();
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
            <span className={`badge ${isVerified(receipt) ? "b-ok" : receipt.status === 0 ? "b-err" : "b-warn"}`}>
              {receipt.status === 0 ? "TIMEOUT" : isVerified(receipt) ? "200 OK" : `${receipt.status} · refused`}
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
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>Stored raw bytes first (/api/receipts/:id/raw), then the per-endpoint live re-check — via THE ONE verifier</div>
                </div>
                <button
                  type="button"
                  className="btn-accent"
                  style={{ padding: "7px 14px", fontSize: 12 }}
                  onClick={() => void recompute()}
                  disabled={!receipt.receipt || verify.kind === "fetching"}
                >
                  {verify.kind === "fetching" ? "Verifying…" : "Recompute SHA-256 in Browser"}
                </button>
                {verify.kind === "fetching" && (
                  <button
                    type="button"
                    className="btn-ghost"
                    style={{ padding: "7px 14px", fontSize: 12 }}
                    onClick={cancelRecompute}
                  >
                    Cancel
                  </button>
                )}
              </div>
              {verify.kind === "result" && (verify.result.kind === "verified" || verify.result.kind === "mismatch") && (
                <div className="mono" style={{ fontSize: 11, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ color: "var(--muted)" }}>
                    Recorded: <span style={{ color: "var(--text)", wordBreak: "break-all" }}>{recorded ?? "— (no receipt)"}</span>
                  </div>
                  <div style={{ color: "var(--muted)" }}>
                    Computed: <span style={{ color: "var(--ok)", wordBreak: "break-all" }}>{verify.result.computed}</span>
                  </div>
                  <div style={{ color: "var(--muted)" }}>
                    Method: {verify.result.method}
                    {verify.result.evidenceKind ? ` · evidence: ${verify.result.evidenceKind}` : ""}
                    {" "}· mode {verify.result.mode}
                  </div>
                </div>
              )}
              {verify.kind !== "result" && (
                <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
                  Recorded: <span style={{ color: "var(--text)", wordBreak: "break-all" }}>{recorded ?? "— (no receipt)"}</span>
                </div>
              )}
              {verify.kind === "result" && verify.result.kind === "verified" && verify.result.mode === "live_recheck" && endpointForIntent(receipt.intent) === "grid" && (
                <div style={{ marginTop: 10 }}>
                  <div className="badge b-warn" style={{ padding: "5px 10px", fontSize: 11.5 }}>
                    HASH MATCHES STORED GRID FIELDS (LIVE RE-CHECK)
                  </div>
                  <div className="note-line" style={{ marginTop: 8 }}>
                    This re-hashes the canonical evidence JSON already in this receipt
                    (node_or_zone, interval_start, lmp_usd_per_mwh, market). It is not a
                    re-fetch of CAISO bytes, and it is not a stored-raw-bytes check. A match
                    here means the recorded digest equals those fields.
                  </div>
                </div>
              )}
              {verify.kind === "result" && verify.result.kind === "verified" && !(verify.result.mode === "live_recheck" && endpointForIntent(receipt.intent) === "grid") && (
                <div className="badge b-ok" style={{ marginTop: 10, padding: "5px 10px", fontSize: 11.5 }}>
                  {verify.result.mode === "raw_bytes" ? "BIT-EXACT MATCH — STORED RAW BYTES ✓" : "SHA-256 MATCH VERIFIED ✓"}
                </div>
              )}
              {verify.kind === "result" && verify.result.kind === "mismatch" && (
                <div className="badge b-err" style={{ marginTop: 10, padding: "5px 10px", fontSize: 11.5 }}>
                  {verify.result.mode === "raw_bytes"
                    ? "DIGEST MISMATCH — the stored bytes do not hash to the recorded digest"
                    : "DIGEST MISMATCH — the bytes checked now differ from the bytes the miner hashed (live data can move)"}
                </div>
              )}
              {verify.kind === "result" && verify.result.kind === "unverifiable" && (
                <div style={{ marginTop: 10 }}>
                  <div className="badge b-warn" style={{ padding: "5px 10px", fontSize: 11.5 }}>NOT VERIFIABLE FROM THIS BROWSER</div>
                  <div className="note-line" style={{ marginTop: 8 }}>{verify.result.reason}</div>
                  <div className="note-line" style={{ marginTop: 6 }}>Verify from a terminal instead:</div>
                  <div className="code-box" style={{ marginTop: 6 }}>
                    <pre className="code-pre" style={{ padding: "10px 12px" }}>{`curl -s "${receipt.receipt?.upstream_url ?? ""}" | sha256sum\n# compare with ${recorded ?? ""}`}</pre>
                  </div>
                </div>
              )}
              {verify.kind === "result" && verify.result.kind === "not-reproducible" && (
                <div style={{ marginTop: 10 }}>
                  <div className="badge b-dim" style={{ padding: "5px 10px", fontSize: 11.5 }}>NOT REPRODUCIBLE IN BROWSER</div>
                  <div className="note-line" style={{ marginTop: 8 }}>{verify.result.reason}</div>
                </div>
              )}
              {verify.kind === "result" && verify.result.kind === "no-crypto" && (
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
