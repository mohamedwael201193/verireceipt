import { useCallback, useState } from "react";
import { rehashFromAudit, type AuditRehashResult } from "../lib/auditRehash";
import type { Receipt } from "../lib/types";

/**
 * "Recompute from stored bytes" — the Desk's receipt re-hash control.
 *
 * Fetches the exact raw bytes the miner hashed at fetch time from its
 * audit endpoint (GET /receipts/:id/raw, see CONTRACT.md) and recomputes
 * SHA-256 in the browser, showing MATCH or MISMATCH honestly with both
 * hashes. When the miner has not shipped the audit endpoint yet the
 * control says so plainly (UNAVAILABLE) — it never presents a missing
 * proof as a failed receipt.
 */
export function AuditRehashControl({ receipt }: { receipt: Receipt }) {
  const [state, setState] = useState<AuditRehashResult | null>(null);
  const [checking, setChecking] = useState(false);

  const run = useCallback(async () => {
    setChecking(true);
    try {
      setState(await rehashFromAudit(receipt));
    } finally {
      setChecking(false);
    }
  }, [receipt]);

  return (
    <div className="vr-verify" data-testid="audit-rehash">
      <div className="vr-verify-head">
        <span className="vr-kicker" style={{ marginBottom: 0 }}>
          // receipt re-hash · miner&apos;s stored bytes
        </span>
        <button
          type="button"
          className="vr-btn-ghost"
          onClick={run}
          disabled={checking}
        >
          {checking ? "Verifying…" : "Recompute from stored bytes"}
        </button>
      </div>
      {state === null && (
        <p className="vr-muted vr-small">
          Re-hashes the exact raw bytes the miner stored for this receipt
          (GET /receipts/:id/raw) and compares with the recorded digest.
          Unlike an upstream re-fetch, the stored bytes cannot drift, so
          this is the check that can honestly prove MATCH or MISMATCH.
        </p>
      )}
      {checking && <p className="vr-muted vr-small">Verifying…</p>}
      {!checking && state !== null && state.status === "match" && (
        <div>
          <span className="vr-badge vr-b-ok">MATCH — STORED BYTES HASH TO RECORDED DIGEST</span>
          <p className="vr-muted vr-small" style={{ marginTop: 8 }}>
            Computed: {state.computedSha}
            <br />
            Recorded: {state.recordedSha}
          </p>
        </div>
      )}
      {!checking && state !== null && state.status === "mismatch" && (
        <div>
          <span className="vr-badge vr-b-warn">MISMATCH — STORED BYTES DO NOT HASH TO RECORDED DIGEST</span>
          <p className="vr-muted vr-small" style={{ marginTop: 8 }}>
            Computed: {state.computedSha}
            <br />
            Recorded: {state.recordedSha}
            <br />
            {state.reason}
          </p>
        </div>
      )}
      {!checking && state !== null && state.status === "unavailable" && (
        <div>
          <span className="vr-badge vr-b-dim">AUDIT ENDPOINT NOT AVAILABLE — RE-HASH UNPROVEN</span>
          <p className="vr-muted vr-small" style={{ marginTop: 8 }}>
            {state.reason}
          </p>
        </div>
      )}
    </div>
  );
}
