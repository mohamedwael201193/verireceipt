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
