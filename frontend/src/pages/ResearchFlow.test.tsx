import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import Research from "./Research";
import recorded from "../../../docs/research-evidence/tesla-2024-10q-20261121.json";
import reconciliation from "../../../docs/research-evidence/tesla-2024-10q-20261121-delivery.json";

afterEach(() => vi.unstubAllGlobals());
describe("Evidence-first research journey", () => {
  it("shows a historical case with original and reconciled delivery states, not a live verification", () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    render(<Research />);
    expect(screen.getByRole("heading", { name: /Did Tesla file/ })).toBeInTheDocument();
    expect(screen.getByText(/DIRECT · RELATED-PARTY · TESTNET/)).toBeInTheDocument();
    expect(screen.getByText(/Historical evidence, not a live check/)).toHaveTextContent(/pending delivery.*later record reports inclusion/);
    expect(screen.getByRole("link", { name: /Inspect paid signal/ })).toHaveAttribute("href", recorded.evidence_urls.signal);
    expect(screen.getByRole("link", { name: /Block 33 delivery/ })).toHaveAttribute("href", reconciliation.source_url);
    expect(screen.getByText(/The outcome was not blind/)).toHaveTextContent(/not independently timestamped/);
    expect(screen.getByText(/No time or money saving/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("keeps exact source filings and record status tied to the published packet", () => {
    render(<Research />);
    expect(recorded.result.rows).toHaveLength(3);
    for (const row of recorded.result.rows) expect(screen.getByRole("link", { name: new RegExp(row.accession), hidden: true })).toHaveAttribute("href", row.source_url);
    expect(recorded.result.observed_count).toBe(3);
    expect(recorded.result.status).toBe("SUPPORTED");
    expect(recorded.delivery.status).toBe("pending");
    expect(reconciliation.delivery.status).toBe("included");
    expect(recorded.result.checks.length + recorded.verification_checks.length).toBe(31);
  });
  it("shows one task panel and retains form input while switching tasks", () => {
    render(<Research />);
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("SEC CIK"), { target: { value: "1318605" } });
    fireEvent.click(screen.getByRole("tab", { name: /Explore failure cases/ }));
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName(/Explore failure cases/);
    expect(screen.queryByRole("button", { name: /Prepare input/ })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Wrong company/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Prepare a question/ }));
    expect(screen.getByLabelText("SEC CIK")).toHaveValue("1318605");
  });
  it("supports keyboard tab selection with arrows and Home/End", () => {
    render(<Research />);
    const prepare = screen.getByRole("tab", { name: /Prepare a question/ });
    prepare.focus(); fireEvent.keyDown(prepare, { key: "ArrowRight" });
    const inspect = screen.getByRole("tab", { name: /Inspect a saved report/ });
    expect(inspect).toHaveFocus(); expect(inspect).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(inspect, { key: "End" });
    const lab = screen.getByRole("tab", { name: /Explore failure cases/ });
    expect(lab).toHaveFocus(); fireEvent.keyDown(lab, { key: "ArrowRight" });
    expect(prepare).toHaveFocus(); fireEvent.keyDown(prepare, { key: "ArrowLeft" });
    expect(lab).toHaveFocus(); fireEvent.keyDown(lab, { key: "Home" }); expect(prepare).toHaveFocus();
  });
});
