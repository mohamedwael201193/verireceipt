import { useState } from "react";
import type { Receipt } from "../lib/types";
import { formatDate, shortenSha } from "../lib/format";

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: "#12161D",
    border: "1px solid #232A35",
    borderRadius: 12,
    padding: 16,
    fontFamily: "'Inter', system-ui, sans-serif",
    color: "#E6E9EE",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  },
  badge: {
    background: "#FF5722",
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    padding: "3px 8px",
    borderRadius: 999,
  },
  title: { fontSize: 13, fontWeight: 600, color: "#9AA4B2" },
  row: {
    display: "grid",
    gridTemplateColumns: "130px 1fr",
    gap: 8,
    alignItems: "baseline",
    padding: "6px 0",
    borderTop: "1px solid #1D232E",
    fontSize: 13,
  },
  label: { color: "#8A94A3", fontSize: 12 },
  value: { overflowWrap: "anywhere", color: "#E6E9EE" },
  mono: {
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 12,
    color: "#E6E9EE",
  },
  link: { color: "#FF8A65", overflowWrap: "anywhere", fontSize: 12 },
  copyBtn: {
    marginLeft: 8,
    background: "transparent",
    border: "1px solid #FF5722",
    color: "#FF5722",
    borderRadius: 6,
    padding: "2px 8px",
    fontSize: 11,
    fontFamily: "'Inter', system-ui, sans-serif",
    cursor: "pointer",
  },
};

interface ReceiptCardProps {
  receipt: Receipt;
}

export function ReceiptCard({ receipt }: ReceiptCardProps) {
  const [copied, setCopied] = useState(false);

  async function copySha() {
    try {
      await navigator.clipboard.writeText(receipt.raw_response_sha256);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (non-secure context): leave button as-is.
      setCopied(false);
    }
  }

  return (
    <section style={styles.card} aria-label="Verification receipt">
      <div style={styles.header}>
        <span style={styles.badge}>Receipt</span>
        <span style={styles.title}>Verifiable source</span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Receipt ID</span>
        <span style={{ ...styles.value, ...styles.mono }}>{receipt.receipt_id}</span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Upstream</span>
        <a
          style={styles.link}
          href={receipt.upstream_url}
          target="_blank"
          rel="noreferrer"
        >
          {receipt.upstream_url}
        </a>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Response SHA-256</span>
        <span>
          <code style={styles.mono} title={receipt.raw_response_sha256}>
            {shortenSha(receipt.raw_response_sha256)}
          </code>
          <button type="button" style={styles.copyBtn} onClick={copySha}>
            {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Fetched at</span>
        <span style={styles.value}>{formatDate(receipt.fetched_at)}</span>
      </div>
    </section>
  );
}
