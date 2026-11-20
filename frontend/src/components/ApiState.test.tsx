import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { ApiState } from "./ApiState";

describe("ApiState", () => {
  it("shows a loading spinner state", () => {
    render(
      <ApiState loading error={null} empty={false} onRetry={() => {}}>
        <p>child</p>
      </ApiState>,
    );
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Fetching live data…")).toBeTruthy();
    expect(screen.queryByText("child")).toBeNull();
  });

  it("shows the real ApiError message and status with a retry button", () => {
    const onRetry = vi.fn();
    render(
      <ApiState
        loading={false}
        error={new ApiError("no cached price for X", 502, "GRID_CACHE_MISS")}
        empty={false}
        onRetry={onRetry}
      >
        <p>child</p>
      </ApiState>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Request failed (502)")).toBeTruthy();
    expect(screen.getByText("no cached price for X")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state with a retry button", () => {
    const onRetry = vi.fn();
    render(
      <ApiState loading={false} error={null} empty onRetry={onRetry}>
        <p>child</p>
      </ApiState>,
    );
    expect(screen.getByText("No data yet — try a different query.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders children when not loading, error or empty", () => {
    render(
      <ApiState loading={false} error={null} empty={false} onRetry={() => {}}>
        <p>child content</p>
      </ApiState>,
    );
    expect(screen.getByText("child content")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
