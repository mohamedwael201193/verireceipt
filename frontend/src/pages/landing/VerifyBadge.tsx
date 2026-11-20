// "Compute envelope digest" — envelope-digest UI.
//
// Fetches the same-origin endpoint as raw text and recomputes SHA-256
// over those exact bytes. The result is shown next to the receipt's
// recorded digest — it is NOT a browser verification: the recorded
// digest covers the miner's upstream raw bytes (src/core/receipt.ts
// `makeReceipt`), not the envelope the browser receives, so the two
// digests are not expected to be equal with the current miner and a
// match is unreachable by construction (J2 minor 4). The button is
// therefore labelled "Compute envelope digest", never "Verify", and no
// copy here promises a verification. The steady state for the expected
// mismatch is NEUTRAL: it is not a failed verification, it is a digest
// of the envelope, which is not comparable to the upstream receipt. The
// computed and recorded digests are both shown, with the explanation,
// so the user can see exactly what was compared. (The deeper fix — the
// miner exposing the raw upstream bytes so a real browser verification
// becomes possible — is miner-team owned, not this branch.)
import { useState } from "react";
import { verifyEndpoint, type VerifyState } from "./verify";

export function VerifyBadge({ url, label = "Compute envelope digest" }: { url: string; label?: string }) {
  const [state, setState] = useState<VerifyState>({ status: "idle" });

  async function run() {
    setState({ status: "running" });
    setState(await verifyEndpoint(url));
  }

  return (
    <div className="mono" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
      {state.status === "idle" && (
        <button type="button" className="micro-btn" style={{ padding: "4px 10px", fontSize: 11 }} onClick={run}>
          {label}
        </button>
      )}
      {state.status === "running" && <span style={{ color: "var(--muted)" }}>Hashing response body…</span>}
      {state.status === "done" &&
        (state.match ? (
          <span className="badge b-ok">MATCH VERIFIED ✓</span>
        ) : (
          <span>
            <span className="badge b-neutral">ENVELOPE DIGEST — NOT COMPARABLE TO UPSTREAM RECEIPT</span>
            <span style={{ display: "block", marginTop: 8, color: "var(--muted)" }}>
              Computed (SHA-256 of the response body this browser received):
              <br />
              <span style={{ color: "var(--text)", overflowWrap: "anywhere" }}>0x{state.computedDigest}</span>
              <br />
              Recorded in receipt {state.receiptId}:
              <br />
              <span style={{ color: "var(--text)", overflowWrap: "anywhere" }}>{state.recordedDigest}</span>
              <br />
              The receipt covers the miner&apos;s upstream raw bytes, not this
              envelope — so the two digests are not expected to be equal. The
              computed digest above is the SHA-256 of the exact bytes your
              browser received.
            </span>
          </span>
        ))}
      {state.status === "done" && state.match && (
        <span style={{ display: "block", marginTop: 8, color: "var(--muted)" }}>
          SHA-256 of the response body matches receipt {state.receiptId}.
        </span>
      )}
      {state.status === "no-receipt" && (
        <span style={{ color: "var(--muted)" }}>No receipt in this response — no digest to compute.</span>
      )}
      {state.status === "error" && <span style={{ color: "var(--bad)" }}>Digest refused: {state.message}</span>}
      {state.status !== "idle" && state.status !== "running" && (
        <span style={{ display: "block", marginTop: 6 }}>
          <button type="button" className="micro-btn" style={{ padding: "3px 9px", fontSize: 10.5 }} onClick={run}>
            Recompute digest
          </button>
        </span>
      )}
    </div>
  );
}
