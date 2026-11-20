import { Link } from "react-router-dom";

/** Honest 404: unknown routes render this instead of silently redirecting
 *  home, so a bad link is visible rather than masked. */
export default function NotFound() {
  return (
    <main className="container page-placeholder">
      <p className="kicker">// verireceipt — 404</p>
      <h1 className="sec-h2">Page not found</h1>
      <p className="placeholder-note">
        This page does not exist. The miner, its receipts, and the desk are
        still here — start from the top.
      </p>
      <p className="placeholder-note" style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
        <Link to="/" style={{ color: "var(--text)", textDecoration: "underline" }}>
          Home ↑
        </Link>
        <Link to="/dashboard" style={{ color: "var(--text)", textDecoration: "underline" }}>
          Dashboard
        </Link>
        <Link to="/docs" style={{ color: "var(--text)", textDecoration: "underline" }}>
          Docs
        </Link>
      </p>
    </main>
  );
}
