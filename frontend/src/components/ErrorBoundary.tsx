import { Component, type ReactNode } from "react";

/**
 * Error boundary for the page tree: a render crash in any live-data panel
 * (e.g. a malformed receipt reaching a component) must degrade to an
 * honest fallback instead of blanking the whole page. Wrap each page's
 * content in this boundary once page files land.
 *
 * Reset behaviour (J2 M-7): the fallback used to be sticky — it stayed
 * until the user clicked Retry. Pass `resetKeys` (e.g. the query the
 * page is showing, `resetKeys={[txHash, chain]}`) and the boundary
 * clears its error state whenever any key changes, so navigating to a
 * new query or refetching recovers automatically. The Retry button
 * still works as a manual reset. Without resetKeys the old behaviour
 * (reset only via Retry) is unchanged.
 */

const styles: Record<string, React.CSSProperties> = {
  box: {
    background: "#12161D",
    border: "1px solid #5A2320",
    borderRadius: 12,
    padding: 16,
    fontFamily: "'Inter', system-ui, sans-serif",
    color: "#E6E9EE",
    fontSize: 13,
  },
  title: { color: "#FF8A65", fontWeight: 600, marginBottom: 4 },
  detail: {
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 12,
    color: "#C7CDD6",
    overflowWrap: "anywhere",
    marginBottom: 12,
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

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Custom fallback rendered instead of the default error box. */
  fallback?: ReactNode;
  /** Called when the user retries after an error (before state resets). */
  onReset?: () => void;
  /**
   * Keys that reset the boundary when they change (shallow-compared with
   * Object.is per element). Pages should pass the identity of what is
   * being shown — e.g. `resetKeys={[txHash, chain]}` on a tx page, or
   * `resetKeys={[entity, period]}` on a filings page — so a new query
   * clears a stale fallback without a manual Retry click.
   */
  resetKeys?: unknown[];
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Shallow resetKeys comparison: changed if length differs or any element differs by Object.is. */
function hasResetKeysChanged(prev: unknown[] | undefined, next: unknown[] | undefined): boolean {
  if (prev === next) return false;
  if (prev === undefined || next === undefined) return prev !== next;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // Deliberately not rethrown: the boundary owns the failure. Logging
    // keeps the crash visible in diagnostics without blanking the page.
    console.error("ErrorBoundary caught a render error:", error);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    // J2 M-7: a stale fallback must not survive a navigation/query
    // change. When resetKeys change while an error is shown, clear the
    // error so the new children render; if they still throw, the
    // boundary catches again and the fallback returns.
    if (this.state.error && hasResetKeysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.setState({ error: null });
    }
  }

  private handleReset = (): void => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div style={styles.box} role="alert">
          <div style={styles.title}>Something went wrong</div>
          <div style={styles.detail}>{this.state.error.message}</div>
          <button type="button" style={styles.retryBtn} onClick={this.handleReset}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
