// "Verify receipt" — the landing badge for a live call's receipt.
//
// Calls THE ONE verifier (src/lib/verifyReceipt.ts, PLAN.md C2): stored
// raw bytes first (/api/receipts/:id/raw), live re-check while the miner
// does not serve them. This replaces the old envelope-digest badge,
// which hashed the miner envelope — a digest that can never match the
// recorded upstream digest — and therefore could never verify anything.
// The badge shows which path was used (method + mode, evidence kind
// when the miner sends one); a mismatch names the path, because a
// raw_bytes mismatch and a live_recheck mismatch mean different things.
import { useState } from "react";
import {
  verifyReceipt,
  type VerifyData,
  type VerifyResult,
  type VerifyEndpoint,
} from "../../lib/verifyReceipt";
import type { Receipt } from "../../lib/types";

export function VerifyBadge({
  receipt,
  endpoint,
  data,
}: {
  receipt: Receipt;
  endpoint: VerifyEndpoint;
  data?: VerifyData;
}) {
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "running" }
    | { status: "done"; result: VerifyResult }
  >({ status: "idle" });

  async function run() {
    setState({ status: "running" });
    const result = await verifyReceipt(receipt, endpoint, data);
    if (result.kind === "cancelled") {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "done", result });
  }

  const result = state.status === "done" ? state.result : null;

  return (
    <div className="mono" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
      {state.status === "idle" && (
        <button type="button" className="micro-btn" style={{ padding: "4px 10px", fontSize: 11 }} onClick={run}>
          Verify receipt
        </button>
      )}
      {state.status === "running" && <span style={{ color: "var(--muted)" }}>Verifying receipt…</span>}
      {result?.kind === "verified" && (
        <span>
          <span className="badge b-ok">SHA-256 MATCH VERIFIED ✓</span>
          <span style={{ display: "block", marginTop: 8, color: "var(--muted)" }}>
            Method: {result.method}
            {result.evidenceKind ? ` · evidence: ${result.evidenceKind}` : ""}.
            <br />
            Computed (SHA-256 of the bytes checked):
            <br />
            <span style={{ color: "var(--text)", overflowWrap: "anywhere" }}>{result.computed}</span>
            <br />
            Recorded in receipt {receipt.receipt_id}:
            <br />
            <span style={{ color: "var(--text)", overflowWrap: "anywhere" }}>
              {receipt.raw_response_sha256}
            </span>
          </span>
        </span>
      )}
      {result?.kind === "mismatch" && (
        <span>
          <span className="badge b-warn">DIGEST MISMATCH</span>
          <span style={{ display: "block", marginTop: 8, color: "var(--muted)" }}>
            Method: {result.method}
            {result.evidenceKind ? ` · evidence: ${result.evidenceKind}` : ""}.{" "}
            {result.mode === "raw_bytes"
              ? "The stored bytes do not hash to the recorded digest — the receipt is not verified."
              : "The bytes checked now differ from the bytes the miner hashed — upstream data can move after the receipt is issued, so this does not by itself prove tampering, but the receipt is not verified."}
            <br />
            Computed:
            <br />
            <span style={{ color: "var(--text)", overflowWrap: "anywhere" }}>{result.computed}</span>
            <br />
            Recorded in receipt {receipt.receipt_id}:
            <br />
            <span style={{ color: "var(--text)", overflowWrap: "anywhere" }}>
              {receipt.raw_response_sha256}
            </span>
          </span>
        </span>
      )}
      {result?.kind === "unverifiable" && (
        <span>
          <span className="badge b-dim">COULD NOT VERIFY IN BROWSER</span>
          <span style={{ display: "block", marginTop: 8, color: "var(--muted)" }}>{result.reason}</span>
        </span>
      )}
      {result?.kind === "not-reproducible" && (
        <span>
          <span className="badge b-dim">NOT REPRODUCIBLE IN BROWSER</span>
          <span style={{ display: "block", marginTop: 8, color: "var(--muted)" }}>{result.reason}</span>
        </span>
      )}
      {result?.kind === "no-crypto" && (
        <span className="badge b-dim">WEB CRYPTO UNAVAILABLE — CANNOT VERIFY IN THIS BROWSER</span>
      )}
      {state.status !== "idle" && state.status !== "running" && (
        <span style={{ display: "block", marginTop: 6 }}>
          <button type="button" className="micro-btn" style={{ padding: "3px 9px", fontSize: 10.5 }} onClick={run}>
            Re-verify receipt
          </button>
        </span>
      )}
    </div>
  );
}
