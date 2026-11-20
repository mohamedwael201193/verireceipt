import { useEffect, useRef, useState } from "react";
import type { Receipt } from "../lib/types";
import { formatDate, hasVisibleCharacter, shortenSha } from "../lib/format";
import {
  MAX_RECEIPT_FETCHED_AT_LENGTH,
  MAX_RECEIPT_ID_LENGTH,
  MAX_RECEIPT_SHA_LENGTH,
  MAX_RECEIPT_UPSTREAM_URL_LENGTH,
} from "../lib/api";

/**
 * A receipt field is renderable only as a non-empty string with at
 * least one visible character, within its length cap (J2 R4 M-1).
 * hasVisibleCharacter (not trim()) decides blankness: trim() does not
 * strip U+200B etc., so an invisible-format-only string used to render
 * as a blank cell (J2 R5 B-1). The API layer (assertValidBody)
 * rejects over-cap fields as INVALID_RESPONSE, but a receipt can reach
 * this card from any other caller — so the card enforces the SAME caps
 * in its own rendering path, importing the constants from api.ts so the
 * two layers can never drift. Over-cap renders "—", never verbatim:
 * a 1 MB upstream_url / fetched_at / sha / receipt_id must not land in
 * the DOM (or in the sha's title= attribute) through the card's
 * non-API path.
 */
function isRenderableReceiptString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && hasVisibleCharacter(value) && value.length <= maxLength;
}

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
    // The WHATWG parser strips tabs/newlines/carriage returns anywhere
    // in the URL (J2 R5 m3), so the raw authority is compared after
    // stripping those same characters: "https://example.com\n/" parses
    // to host example.com, and the raw text must be read the same way
    // or a legit-shape URL fails closed as plain text. The "%" check
    // above runs on this same stripped authority, so stripping cannot
    // hide a percent-encoded host.
    const comparable = value.replace(/[\t\n\r]/g, "");
    const authority = comparable.trim().match(/^[^:]+:\/\/([^/?#]*)/)?.[1] ?? "";
    if (authority.includes("%")) return false;
    if (parsed.hostname.includes("%")) return false;
    // Triple-slash bypass (J2 R3 M-3): Node's WHATWG parser treats
    // "https:///evil.com" and "https://///evil.com/" as host evil.com
    // while the raw-authority regex above captures "" — so a bare
    // "%"-check passes and the URL renders as a link to evil.com.
    // The raw authority must therefore be non-empty AND its host part
    // must equal the parsed hostname (case-insensitive, brackets
    // stripped for IPv6). A mismatch means the parser normalised
    // something the raw text did not say (e.g. "evil%2ecom" -> "evil.com"
    // or extra slashes swallowing the authority) — plain text, never a
    // link. The port, if any, is the part after the first ":" (or after
    // the "]" for IPv6) and is not compared: "example.com:8443" is legit.
    // Empty userinfo (J2 R5 m3): the parser ignores a bare "@" —
    // "https://@example.com/" has empty username/password and host
    // example.com — but the raw authority is "@example.com", which
    // failed the host comparison below. The parsed userinfo check
    // above already rejected any NON-empty userinfo, so anything
    // before the last "@" here can only be empty (or a lone ":",
    // user "" + pass ""); strip it before the host compare, and fail
    // closed if it is anything else.
    const atIndex = authority.lastIndexOf("@");
    const hostPort =
      atIndex === -1
        ? authority
        : (() => {
            const userinfo = authority.slice(0, atIndex);
            if (userinfo !== "" && userinfo !== ":") return null;
            return authority.slice(atIndex + 1);
          })();
    if (hostPort === null) return false;
    if (hostPort.length === 0) return false;
    const rawHost = hostPort.startsWith("[")
      ? (hostPort.match(/^\[[^\]]*\]/)?.[0] ?? "")
      : (hostPort.split(":")[0] ?? "");
    const stripBrackets = (h: string) => h.replace(/^\[|\]$/g, "");
    if (rawHost.length === 0) return false;
    if (stripBrackets(rawHost).toLowerCase() !== stripBrackets(parsed.hostname).toLowerCase()) {
      return false;
    }
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
    // Never copy the literal string "undefined" when the sha is missing.
    // Same renderability rule as the card itself (B-1 trim + M-1 cap):
    // a whitespace-only or over-cap sha renders "—", so it must not be
    // copied either.
    if (!isRenderableReceiptString(sha, MAX_RECEIPT_SHA_LENGTH)) return;
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
  // The link branch is gated on the length cap too (M-1): isSafeUpstreamUrl
  // alone would accept a 1 MB https URL and render it as a 1 MB link.
  const upstreamIsLink =
    isRenderableReceiptString(upstreamUrl, MAX_RECEIPT_UPSTREAM_URL_LENGTH) &&
    isSafeUpstreamUrl(upstreamUrl);
  // Defense in depth (B-1b): assertValidBody now rejects malformed
  // receipts, but a receipt can still reach this card from any other
  // caller — so every rendered field is total over non-string values
  // AND over-cap values (M-1, same caps as the API layer).
  // A number/object receipt_id, sha or fetched_at renders "—", never
  // throws and never hands React an object child.
  const receiptId = isRenderableReceiptString(receipt.receipt_id, MAX_RECEIPT_ID_LENGTH)
    ? receipt.receipt_id
    : "—";
  const sha = isRenderableReceiptString(receipt.raw_response_sha256, MAX_RECEIPT_SHA_LENGTH)
    ? receipt.raw_response_sha256
    : undefined;
  const fetchedAt = isRenderableReceiptString(receipt.fetched_at, MAX_RECEIPT_FETCHED_AT_LENGTH)
    ? formatDate(receipt.fetched_at)
    : "—";

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
          // Whitespace-only/empty strings pass the typeof check but must
          // render "—", not a blank span (J2 R4 B-1, re-opened); over-cap
          // strings render "—", never verbatim (J2 R4 M-1) — same
          // renderability rule as the other three fields.
          <span style={styles.plainUrl}>{isRenderableReceiptString(upstreamUrl, MAX_RECEIPT_UPSTREAM_URL_LENGTH) ? upstreamUrl : "—"}</span>
        )}
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Response SHA-256</span>
        <span>
          <code style={styles.mono} title={sha}>
            {shortenSha(sha)}
          </code>
          <button type="button" style={styles.copyBtn} onClick={copySha}>
            {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Fetched at</span>
        <span style={styles.value}>{fetchedAt}</span>
      </div>
    </section>
  );
}
