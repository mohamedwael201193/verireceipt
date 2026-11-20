import { useEffect, useRef, useState } from "react";
import type { Receipt } from "../lib/types";
import { formatDate, shortenSha } from "../lib/format";

/**
 * The only URL schemes that may ever render as a clickable link.
 * `upstream_url` comes from the server (and therefore from upstream data),
 * so an attacker-controlled value such as `javascript:…`, `data:…` or
 * `vbscript:…` must never become an <a href> — those schemes execute in
 * the page origin when clicked. Anything outside the allowlist (including
 * relative URLs, which `new URL` rejects, and non-string values) renders
 * as plain text. https only: every real upstream in this system is https.
 *
 * Scheme-only was not enough (J2 M-3): `https://user:pass@evil.com/`
 * passes a scheme check and renders a clickable link to evil.com while
 * looking like a trusted host. So userinfo is rejected too — any
 * username/password in the authority means plain text, never a link.
 * Also rejected: a raw NUL escape (%00, any case) anywhere in the value,
 * and a `%` in the hostname (percent-encoded host tricks such as
 * `https://evil.com%2fexample.com/` fail the parse anyway, but a
 * percent-encoded hostname is never a real upstream).
 */
export function isSafeUpstreamUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (/%00/i.test(value)) return false;
  try {
    // The URL parser normalises case, strips leading/trailing whitespace
    // and control characters, and strips tabs/newlines — so obfuscations
    // like "JaVaScRiPt:…", "  javascript:…" or "java\tscript:…" still
    // parse to the javascript: scheme and are rejected here.
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return false;
    if (parsed.username !== "" || parsed.password !== "") return false;
    // Percent-encoded host tricks: the parser percent-decodes the
    // hostname (%65 -> "e", %2f -> "/"), so a %-encoded host looks clean
    // AFTER parsing. Check the RAW authority instead — a real upstream
    // host never contains "%" (userinfo was already rejected above, so
    // any "%" left in the authority is in the host:port part).
    const authority = value.trim().match(/^[^:]+:\/\/([^/?#]*)/)?.[1] ?? "";
    if (authority.includes("%")) return false;
    if (parsed.hostname.includes("%")) return false;
    return true;
  } catch {
    return false;
  }
}

// Theme: every colour is a design token (tokens.css, scaffold branch:
// html[data-theme="light"] = Light Stone, :root = dark). NO hardcoded
// theme colours here — the card must follow whichever theme the page
// sets. The variables resolve once tokens.css is loaded by the app shell
// (scaffold branch owns that file; it is deliberately NOT duplicated in
// this data-layer branch). The badge's white text is theme-safe:
// --accent is #ff5722 in BOTH themes, so white on-accent is correct
// in light and dark alike.
const styles: Record<string, React.CSSProperties> = {
  card: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: 16,
    fontFamily: "'Inter', system-ui, sans-serif",
    color: "var(--text)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  },
  badge: {
    background: "var(--accent)",
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    padding: "3px 8px",
    borderRadius: 999,
  },
  title: { fontSize: 13, fontWeight: 600, color: "var(--muted)" },
  row: {
    display: "grid",
    gridTemplateColumns: "130px 1fr",
    gap: 8,
    alignItems: "baseline",
    padding: "6px 0",
    borderTop: "1px solid var(--border)",
    fontSize: 13,
  },
  label: { color: "var(--muted)", fontSize: 12 },
  value: { overflowWrap: "anywhere", color: "var(--text)" },
  mono: {
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 12,
    color: "var(--text)",
  },
  link: { color: "var(--accent)", overflowWrap: "anywhere", fontSize: 12 },
  plainUrl: {
    color: "var(--muted)",
    overflowWrap: "anywhere",
    fontSize: 12,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  },
  copyBtn: {
    marginLeft: 8,
    background: "transparent",
    border: "1px solid var(--accent)",
    color: "var(--accent)",
    borderRadius: 6,
    padding: "2px 8px",
    fontSize: 11,
    fontFamily: "'Inter', system-ui, sans-serif",
    cursor: "pointer",
  },
  unavailable: {
    padding: "12px 0",
    fontSize: 13,
    color: "var(--muted)",
  },
};

interface ReceiptCardProps {
  // Nullable by design: a receipted response that arrives without a
  // usable receipt must render an honest "unavailable" state, never throw.
  receipt: Receipt | null | undefined;
}

export function ReceiptCard({ receipt }: ReceiptCardProps) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the "Copied" reset timer on unmount so it never fires setState
  // after the card is gone.
  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    };
  }, []);

  async function copySha() {
    // Never copy the literal string "undefined" when the sha is missing.
    const sha = receipt?.raw_response_sha256;
    if (typeof sha !== "string" || sha.length === 0) return;
    try {
      await navigator.clipboard.writeText(sha);
      setCopied(true);
      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
      }
      resetTimerRef.current = setTimeout(() => {
        resetTimerRef.current = null;
        setCopied(false);
      }, 2000);
    } catch {
      // Clipboard unavailable (non-secure context): leave button as-is.
      setCopied(false);
    }
  }

  if (receipt === null || receipt === undefined) {
    return (
      <section style={styles.card} aria-label="Verification receipt">
        <div style={styles.header}>
          <span style={styles.badge}>Receipt</span>
          <span style={styles.title}>Verifiable source</span>
        </div>
        <p style={styles.unavailable}>Receipt unavailable — no receipt was returned.</p>
      </section>
    );
  }

  const upstreamUrl = receipt.upstream_url;
  const upstreamIsLink = isSafeUpstreamUrl(upstreamUrl);
  // Defense in depth (B-1b): assertValidBody now rejects malformed
  // receipts, but a receipt can still reach this card from any other
  // caller — so every rendered field is total over non-string values.
  // A number/object receipt_id, sha or fetched_at renders "—", never
  // throws and never hands React an object child.
  const receiptId = typeof receipt.receipt_id === "string" ? receipt.receipt_id : "—";
  const sha = typeof receipt.raw_response_sha256 === "string" ? receipt.raw_response_sha256 : undefined;

  return (
    <section style={styles.card} aria-label="Verification receipt">
      <div style={styles.header}>
        <span style={styles.badge}>Receipt</span>
        <span style={styles.title}>Verifiable source</span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Receipt ID</span>
        <span style={{ ...styles.value, ...styles.mono }}>{receiptId}</span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Upstream</span>
        {upstreamIsLink ? (
          <a
            style={styles.link}
            href={upstreamUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            {upstreamUrl}
          </a>
        ) : (
          // Deliberately NOT a link: unsafe scheme, relative URL, or
          // missing value — rendered as plain text so it cannot execute.
          <span style={styles.plainUrl}>{typeof upstreamUrl === "string" ? upstreamUrl : "—"}</span>
        )}
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Response SHA-256</span>
        <span>
          <code style={styles.mono} title={sha}>
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
