import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Research from "./Research";

afterEach(() => vi.unstubAllGlobals());
describe("Research page, real evidence and local preparation", () => {
  it("does not ask for a wallet, make a payment or fetch evidence", () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    render(<Research />);
    expect(screen.getByText(/No wallet key in this browser/)).toBeInTheDocument();
    expect(screen.queryByText(/SIMULATION|synthetic fixture/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /buy|pay|connect wallet/i })).not.toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });
  it("prepares only JSON input and clears it when a field changes", () => {
    render(<Research />); fireEvent.click(screen.getByRole("button", { name: /Prepare input/ }));
    expect(screen.getByRole("heading", { name: /not a frozen policy or paid result/ })).toBeInTheDocument();
    expect(screen.getByText(/"cik": "320193"/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("SEC CIK"), { target: { value: "1318605" } });
    expect(screen.queryByRole("button", { name: "Copy input JSON" })).not.toBeInTheDocument();
  });
  it.each(["0320193", "Apple", "0"])("rejects ambiguous/noncanonical CIK %s", value => {
    render(<Research />); fireEvent.change(screen.getByLabelText("SEC CIK"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: /Prepare input/ }));
    expect(screen.getByRole("alert")).toHaveTextContent(/CIK/);
    expect(screen.queryByRole("button", { name: "Copy input JSON" })).not.toBeInTheDocument();
  });
  it("rejects current year and noninteger criterion", () => {
    render(<Research />); fireEvent.change(screen.getByLabelText("Calendar filing year"), { target: { value: String(new Date().getUTCFullYear()) } });
    fireEvent.click(screen.getByRole("button", { name: /Prepare input/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("completed calendar year");
    fireEvent.change(screen.getByLabelText("Calendar filing year"), { target: { value: "2025" } });
    fireEvent.change(screen.getByLabelText("Minimum count"), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: /Prepare input/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("integer");
  });
  it("inspects a file locally as an unverified claim and exposes contradictory checks", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f); render(<Research />);
    fireEvent.click(screen.getByRole("tab", { name: /Inspect a saved report/ }));
    const data = { version: "research-run-v1", plan: { version: "research-packet-v1", cik: "320193", year: 2025, form: "10-Q", minimum_count: 3, network: "eip155:11155111" }, plan_hash: "a".repeat(64),
      result: { status: "SUPPORTED", reason: "Synthetic file test", observed_count: 3, checks: [{ name: "source mismatch", ok: false }] }, verification_checks: [], delivery: { status: "pending" } };
    const file = new File([JSON.stringify(data)], "report.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => JSON.stringify(data) });
    fireEvent.change(screen.getByLabelText("Choose a saved report.json"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText(/UNVERIFIED LOCAL FILE/)).toBeInTheDocument());
    expect(screen.getByText(/claimed success conflicts with failed checks/)).toBeInTheDocument();
    expect(screen.getByText("REPORTED FAIL")).toBeInTheDocument(); expect(f).not.toHaveBeenCalled();
  });
  it("rejects a malformed imported file instead of showing its claimed result", async () => {
    render(<Research />); fireEvent.click(screen.getByRole("tab", { name: /Inspect a saved report/ })); const file = new File(["{}"], "wrong.json");
    Object.defineProperty(file, "text", { value: async () => "{}" });
    fireEvent.change(screen.getByLabelText("Choose a saved report.json"), { target: { files: [file] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot inspect this file");
    expect(screen.queryByText(/UNVERIFIED LOCAL FILE/)).not.toBeInTheDocument();
  });
  it("keeps the source, settlement, adoption and cost boundaries visible", () => {
    render(<Research />);
    expect(screen.getByText(/Pending delivery is not settlement/)).toBeInTheDocument();
    expect(screen.getByText(/prize incentives/)).toBeInTheDocument();
    expect(screen.getByText(/Requires the reviewed research CLI/)).toHaveTextContent(/One call is capped at \$0.01 test USDC/);
    expect(screen.getByText(/Source|Stored-byte integrity/)).toHaveTextContent(/not independent source truth/);
  });
});
