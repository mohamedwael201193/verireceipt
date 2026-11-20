import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("boom in render");
  return <p>child is fine</p>;
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    // componentDidCatch logs the error; silence it for the suite output.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("child is fine")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("catches a child render error and shows an honest fallback", () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("boom in render")).toBeTruthy();
    expect(screen.queryByText("child is fine")).toBeNull();
  });

  it("Retry resets the boundary and renders the child again", () => {
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error("transient boom");
      return <p>recovered</p>;
    }
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("recovered")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a custom fallback when one is provided", () => {
    render(
      <ErrorBoundary fallback={<p>custom fallback</p>}>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByText("custom fallback")).toBeTruthy();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });
});
