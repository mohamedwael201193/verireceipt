import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReceiptCard } from "./ReceiptCard";
import type { Receipt } from "../lib/types";

const receipt: Receipt = {
  receipt_id: "rcpt_GRF9RKGBEOLITK2J4C3QFU5IDQ",
  upstream_url: "https://ethereum-sepolia-rpc.publicnode.com",
  raw_response_sha256:
    "0x1b9f3e593e73354720f2329c7bc53c56abf4ef1c4ce38ecc7d6aa26c211b9685",
  fetched_at: "2026-11-20T07:36:40.471Z",
};

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
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(receipt.raw_response_sha256));
    // findBy* waits for the async React state update to flush.
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });
});
