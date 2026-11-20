import { Component, type ReactNode } from "react";

/**
 * Error boundary for the page tree: a render crash in any live-data panel
 * (e.g. a malformed receipt reaching a component) must degrade to an
 * honest fallback instead of blanking the whole page. Wrap each page's
 * content in this boundary once page files land.
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
}

interface ErrorBoundaryState {
  error: Error | null;
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
