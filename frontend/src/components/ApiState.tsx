import type { ReactNode } from "react";
import { ApiError } from "../lib/api";

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    fontFamily: "'Inter', system-ui, sans-serif",
    color: "#E6E9EE",
  },
  center: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
    padding: "32px 16px",
    textAlign: "center",
  },
  spinner: {
    width: 28,
    height: 28,
    borderRadius: "50%",
    border: "3px solid #232A35",
    borderTopColor: "#FF5722",
    animation: "vr-spin 0.8s linear infinite",
  },
  message: { fontSize: 14, color: "#9AA4B2" },
  errorBox: {
    background: "#12161D",
    border: "1px solid #5A2320",
    borderRadius: 12,
    padding: 16,
    fontSize: 13,
  },
  errorTitle: { color: "#FF8A65", fontWeight: 600, marginBottom: 4 },
  errorDetail: {
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 12,
    color: "#C7CDD6",
    overflowWrap: "anywhere",
  },
  retryBtn: {
    background: "#FF5722",
    color: "#FFFFFF",
    border: "none",
    borderRadius: 8,
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 600,
    fontFamily: "'Inter', system-ui, sans-serif",
    cursor: "pointer",
  },
};

export interface ApiStateProps {
  loading: boolean;
  error: Error | null;
  empty: boolean;
  onRetry: () => void;
  children: ReactNode;
}

/**
 * Single state machine for every live-data panel: loading spinner,
 * real error (message + HTTP status from ApiError), empty state with
 * retry, otherwise the children.
 */
export function ApiState({ loading, error, empty, onRetry, children }: ApiStateProps) {
  if (loading) {
    return (
      <div style={styles.wrap}>
        <style>{"@keyframes vr-spin { to { transform: rotate(360deg); } }"}</style>
        <div style={styles.center} role="status" aria-label="Loading">
          <div style={styles.spinner} />
          <p style={styles.message}>Fetching live data…</p>
        </div>
      </div>
    );
  }

  if (error) {
    const status = error instanceof ApiError ? error.status : null;
    const retryAfter =
      error instanceof ApiError ? (error.retry_after_sec ?? null) : null;
    return (
      <div style={styles.wrap}>
        <div style={styles.center}>
          <div style={styles.errorBox} role="alert">
            <div style={styles.errorTitle}>
              {status ? `Request failed (${status})` : "Request failed"}
            </div>
            <div style={styles.errorDetail}>{error.message}</div>
            {retryAfter !== null && (
              <div style={styles.errorDetail}>Retry after {retryAfter}s</div>
            )}
          </div>
          <button type="button" style={styles.retryBtn} onClick={onRetry}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (empty) {
    return (
      <div style={styles.wrap}>
        <div style={styles.center}>
          <p style={styles.message}>No data yet — try a different query.</p>
          <button type="button" style={styles.retryBtn} onClick={onRetry}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return <div style={styles.wrap}>{children}</div>;
}
