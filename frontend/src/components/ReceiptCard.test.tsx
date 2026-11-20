import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReceiptCard, isSafeUpstreamUrl } from "./ReceiptCard";
import type { Receipt } from "../lib/types";

const receipt: Receipt = {
  receipt_id: "rcpt_GRF9RKGBEOLITK2J4C3QFU5IDQ",
  upstream_url: "https://ethereum-sepolia-rpc.publicnode.com",
  raw_response_sha256:
    "0x1b9f3e593e73354720f2329c7bc53c56abf4ef1c4ce38ecc7d6aa26c211b9685",
  fetched_at: "2026-11-20T07:36:40.471Z",
};

function receiptWithUrl(upstream_url: string): Receipt {
  return { ...receipt, upstream_url };
}

describe("ReceiptCard", () => {
  it("renders receipt id, upstream link, truncated sha and fetched time", () => {
    render(<ReceiptCard receipt={receipt} />);
    expect(screen.getByText("rcpt_GRF9RKGBEOLITK2J4C3QFU5IDQ")).toBeTruthy();
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://ethereum-sepolia-rpc.publicnode.com");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.getByText("0x1b9f3e59…211b9685")).toBeTruthy();
    expect(screen.getByText("20 Nov 2026, 07:36 UTC")).toBeTruthy();
  });

  it("copies the full sha on button click and shows Copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<ReceiptCard receipt={receipt} />);
    // Awaited act() flushes the async clipboard promise + setState so no
    // "not wrapped in act(...)" warning is emitted (J1 M5).
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(writeText).toHaveBeenCalledWith(receipt.raw_response_sha256);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("renders an honest unavailable state instead of throwing on a null receipt", () => {
    expect(() => render(<ReceiptCard receipt={null} />)).not.toThrow();
    expect(screen.getByText(/receipt unavailable/i)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders an honest unavailable state on an undefined receipt", () => {
    expect(() => render(<ReceiptCard receipt={undefined} />)).not.toThrow();
    expect(screen.getByText(/receipt unavailable/i)).toBeTruthy();
  });
});

describe("upstream URL scheme allowlist (B1 — stored-XSS regression)", () => {
  it.each([
    "javascript:alert(document.domain)",
    "JaVaScRiPt:alert(document.domain)",
    "  javascript:alert(document.domain)",
    "java\tscript:alert(document.domain)",
    "data:text/html,<script>alert(1)</script>",
    "DATA:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "VBSCRIPT:msgbox(1)",
  ])("renders %s as plain text, never a link", (url) => {
    const { container } = render(<ReceiptCard receipt={receiptWithUrl(url)} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    // The value is still shown (honest display), just not clickable.
    expect(container.textContent).toContain(url);
  });

  it("renders http: and relative URLs as plain text (https-only allowlist)", () => {
    const { container } = render(
      <ReceiptCard receipt={receiptWithUrl("http://example.com/upstream")} />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.textContent).toContain("http://example.com/upstream");

    const { container: rel } = render(
      <ReceiptCard receipt={receiptWithUrl("/api/v1/tx?tx_hash=0x00")} />,
    );
    expect(rel.querySelector("a")).toBeNull();
  });

  it("isSafeUpstreamUrl allows https only", () => {
    expect(isSafeUpstreamUrl("https://example.com/x")).toBe(true);
    expect(isSafeUpstreamUrl("http://example.com/x")).toBe(false);
    expect(isSafeUpstreamUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUpstreamUrl("data:text/html,hi")).toBe(false);
    expect(isSafeUpstreamUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeUpstreamUrl("/relative/path")).toBe(false);
    expect(isSafeUpstreamUrl("")).toBe(false);
    expect(isSafeUpstreamUrl(undefined)).toBe(false);
    expect(isSafeUpstreamUrl(null)).toBe(false);
  });
});

describe("theme (Light Stone / dark via tokens.css)", () => {
  // The old hardcoded dark hex values that must never come back.
  const HARDCODED_DARK = ["#12161D", "#232A35", "#E6E9EE", "#9AA4B2", "#8A94A3", "#1D232E", "#FF8A65", "#FF5722"];

  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it("renders under data-theme=light using theme variables, no hardcoded dark colors", () => {
    document.documentElement.setAttribute("data-theme", "light");
    const { container } = render(<ReceiptCard receipt={receipt} />);
    const section = screen.getByLabelText("Verification receipt");
    const styleText = section.getAttribute("style") ?? "";
    expect(styleText).toContain("var(--surface)");
    expect(styleText).toContain("var(--border)");
    expect(styleText).toContain("var(--text)");
    for (const hex of HARDCODED_DARK) {
      expect(styleText).not.toContain(hex);
    }
    // No element in the card may carry a hardcoded dark colour inline.
    for (const el of container.querySelectorAll("[style]")) {
      const style = el.getAttribute("style") ?? "";
      for (const hex of HARDCODED_DARK) {
        expect(style).not.toContain(hex);
      }
    }
    // Accent-driven elements reference the token, not the hex.
    const link = screen.getByRole("link");
    expect(link.getAttribute("style") ?? "").toContain("var(--accent)");
    const copyBtn = screen.getByRole("button", { name: "Copy" });
    expect(copyBtn.getAttribute("style") ?? "").toContain("var(--accent)");
  });

  it("renders under data-theme=dark using the same theme variables", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    render(<ReceiptCard receipt={receipt} />);
    const styleText = screen.getByLabelText("Verification receipt").getAttribute("style") ?? "";
    expect(styleText).toContain("var(--surface)");
    for (const hex of HARDCODED_DARK) {
      expect(styleText).not.toContain(hex);
    }
  });
});

describe("copySha guard (J2 M6)", () => {
  it("does not copy the literal string 'undefined' when the sha is missing", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const badReceipt = {
      ...receipt,
      raw_response_sha256: undefined as unknown as string,
    };
    render(<ReceiptCard receipt={badReceipt} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("clears the Copied reset timer on unmount without crashing", async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });
      const { unmount } = render(<ReceiptCard receipt={receipt} />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      });
      expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
      unmount();
      // Advancing past the 2s reset must not throw or warn after unmount.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("malformed receipt fields — defense in depth (J2 R2 B-1b)", () => {
  it("renders '—' and never throws when raw_response_sha256 is a number", () => {
    const bad = { ...receipt, raw_response_sha256: 12345 as unknown as string };
    expect(() => render(<ReceiptCard receipt={bad} />)).not.toThrow();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("12345")).toBeNull();
  });

  it("renders '—' and never throws when fetched_at is an object", () => {
    const bad = { ...receipt, fetched_at: { when: "now" } as unknown as string };
    expect(() => render(<ReceiptCard receipt={bad} />)).not.toThrow();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("renders '—' and never throws when receipt_id is an object", () => {
    const bad = { ...receipt, receipt_id: { id: "rcpt_OK" } as unknown as string };
    expect(() => render(<ReceiptCard receipt={bad} />)).not.toThrow();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/rcpt_OK/)).toBeNull();
  });

  it("renders '—' for every field when all receipt fields are malformed at once", () => {
    const bad = {
      receipt_id: {} as unknown as string,
      upstream_url: "https://example.com/upstream",
      raw_response_sha256: 12345 as unknown as string,
      fetched_at: [] as unknown as string,
    };
    expect(() => render(<ReceiptCard receipt={bad} />)).not.toThrow();
    // Receipt ID + SHA + fetched_at all fall back to "—".
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
    // The safe upstream URL still renders as a link.
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "https://example.com/upstream",
    );
  });

  it("renders '—' (not blank whitespace) when receipt_id is whitespace-only (J2 R3 B-1)", () => {
    const bad = { ...receipt, receipt_id: "   " };
    expect(() => render(<ReceiptCard receipt={bad} />)).not.toThrow();
    // Only the Receipt ID row falls back: sha, upstream and fetched_at
    // are all valid in this receipt.
    expect(screen.getAllByText("—")).toHaveLength(1);
    expect(screen.queryByText("   ", { exact: true })).toBeNull();
  });

  it("renders '—' (not an empty span) when receipt_id is empty (J2 R3 B-1)", () => {
    const bad = { ...receipt, receipt_id: "" };
    expect(() => render(<ReceiptCard receipt={bad} />)).not.toThrow();
    expect(screen.getAllByText("—")).toHaveLength(1);
  });

  it("renders '—' (not a blank cell) when fetched_at is whitespace-only (J2 R4 B-1, re-opened)", () => {
    for (const fetched_at of ["   ", "\t\n"]) {
      const bad = { ...receipt, fetched_at };
      const { unmount } = render(<ReceiptCard receipt={bad} />);
      // Only the Fetched-at row falls back: id, sha and upstream are valid.
      expect(screen.getAllByText("—")).toHaveLength(1);
      expect(screen.queryByText("   ", { exact: true })).toBeNull();
      expect(screen.queryByText("\t\n", { exact: true })).toBeNull();
      unmount();
    }
  });

  it("renders '—' (not a blank cell) when upstream_url is empty or whitespace-only (J2 R4 B-1, re-opened)", () => {
    for (const upstream_url of ["", "   ", "\t\n"]) {
      const bad = { ...receipt, upstream_url };
      const { container, unmount } = render(<ReceiptCard receipt={bad} />);
      // Only the Upstream row falls back: id, sha and fetched_at are valid.
      expect(screen.getAllByText("—")).toHaveLength(1);
      expect(screen.queryByRole("link")).toBeNull();
      // The fallback span must contain the dash, not blank text.
      expect(container.textContent).not.toContain("\t\n");
      unmount();
    }
  });
});

describe("over-cap receipt fields render '—', never verbatim (J2 R4 M-1)", () => {
  // The caps live in the API layer (assertValidBody) AND in the card's
  // own rendering path: through the card's non-API path a 1 MB field
  // used to render verbatim (~1,002,000 chars of HTML).
  const ONE_MB = "x".repeat(1_000_000);

  it.each([
    ["receipt_id", { ...receipt, receipt_id: ONE_MB }],
    ["upstream_url", { ...receipt, upstream_url: ONE_MB }],
    ["raw_response_sha256", { ...receipt, raw_response_sha256: ONE_MB }],
    ["fetched_at", { ...receipt, fetched_at: ONE_MB }],
  ])("renders '—' for a 1 MB %s and keeps the card HTML small", (_field, bad) => {
    const { container } = render(<ReceiptCard receipt={bad} />);
    // Only the over-cap row falls back: the other three fields are valid.
    expect(screen.getAllByText("—")).toHaveLength(1);
    // The 1 MB value must not appear anywhere in the rendered output.
    expect(container.textContent).not.toContain(ONE_MB);
    expect(container.innerHTML.length).toBeLessThan(10_000);
  });

  it("accepts receipt_id at exactly the 512-char cap and dashes at 513", () => {
    const atCap = { ...receipt, receipt_id: "r".repeat(512) };
    const { unmount } = render(<ReceiptCard receipt={atCap} />);
    expect(screen.getByText("r".repeat(512))).toBeTruthy();
    expect(screen.queryAllByText("—")).toHaveLength(0);
    unmount();
    const overCap = { ...receipt, receipt_id: "r".repeat(513) };
    render(<ReceiptCard receipt={overCap} />);
    expect(screen.getAllByText("—")).toHaveLength(1);
  });
});

describe("upstream URL userinfo / encoding tricks (J2 R2 M-3)", () => {
  it.each([
    "https://user:pass@evil.com/",
    "https://user@evil.com/",
    "https://user:pass@evil.com/path?x=1",
    "https://example.com%2f@evil.com/",
    "https://user%2f@evil.com/",
    "https://evil.com%00@example.com/",
    "https://example.com%00.evil.com/",
    "https://exam%00ple.com/",
    "https://evil.com%2fexample.com/",
    "https://example.com%252f@evil.com/",
  ])("renders %s as plain text, never a link", (url) => {
    const { container } = render(<ReceiptCard receipt={receiptWithUrl(url)} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain(url);
  });

  it("isSafeUpstreamUrl rejects userinfo, %00 and %-encoded hosts", () => {
    expect(isSafeUpstreamUrl("https://user:pass@evil.com/")).toBe(false);
    expect(isSafeUpstreamUrl("https://user@evil.com/")).toBe(false);
    expect(isSafeUpstreamUrl("https://example.com%2f@evil.com/")).toBe(false);
    expect(isSafeUpstreamUrl("https://evil.com%00@example.com/")).toBe(false);
    expect(isSafeUpstreamUrl("https://example.com/%00")).toBe(false);
    expect(isSafeUpstreamUrl("https://example.com/%00path")).toBe(false);
    expect(isSafeUpstreamUrl("https://%65xample.com/")).toBe(false);
    // A plain https URL with no userinfo still passes.
    expect(isSafeUpstreamUrl("https://example.com/upstream?x=1&y=2")).toBe(true);
    expect(isSafeUpstreamUrl("https://example.com:8443/upstream")).toBe(true);
  });

  it.each([
    "https:///evil.com",
    "https://///evil.com/",
    "https://evil%2ecom/",
    "https://evil%2Ecom/path",
    "https:///evil.com/path?x=1",
  ])("renders %s as plain text, never a link (J2 R3 M-3 triple-slash / encoded host)", (url) => {
    const { container } = render(<ReceiptCard receipt={receiptWithUrl(url)} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain(url);
  });

  it("isSafeUpstreamUrl rejects triple-slash and %-encoded hosts but keeps legit https (J2 R3 M-3)", () => {
    expect(isSafeUpstreamUrl("https:///evil.com")).toBe(false);
    expect(isSafeUpstreamUrl("https://///evil.com/")).toBe(false);
    expect(isSafeUpstreamUrl("https://evil%2ecom/")).toBe(false);
    expect(isSafeUpstreamUrl("https://evil%2Ecom/")).toBe(false);
    // Raw authority must equal the parsed hostname: legit https with a
    // query string or a non-standard port still passes.
    expect(isSafeUpstreamUrl("https://example.com/upstream?x=1&y=2")).toBe(true);
    expect(isSafeUpstreamUrl("https://example.com:8443/upstream")).toBe(true);
    expect(isSafeUpstreamUrl("https://EXAMPLE.com/upstream")).toBe(true);
  });
});
