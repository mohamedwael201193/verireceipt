// J2 R2 B1 regression tests: the sprint tooltip must fit inside the
// container on ALL 8 columns at 360px. The old clamp assumed a ~140px
// tooltip (parentWidth - 140), but the single-line nowrap tooltip is
// actually ~310–317px wide, so columns 1–7 overflowed the viewport
// (tip right edge up to 521px vs a 361px viewport, measured in real
// Chrome). The clamp must use the MEASURED tooltip width — these tests
// encode that real-width clamp, not the 140px assumption. The
// real-geometry proof (all 8 columns, 360/390/1280px, production
// build) lives in the Chromium check, not jsdom (which has no layout).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { clampSprintTipLeft, SprintMatrix } from "./SprintMatrix";

// Measured in real Chrome 360×800 (production build): the nowrap
// tooltip is ~310–317px wide (labels ~45 chars). The grid container is
// ~320–344px wide at that viewport (section padding eats the rest).
const TIP_WIDTH = 317;
// Cell offsets across the 8-column grid at ~328px container width.
const COLUMN_OFFSETS = [0, 41, 82, 123, 164, 205, 246, 287];

describe("clampSprintTipLeft — real-width clamp (J2 R2 B1)", () => {
  it.each([320, 328, 344])(
    "fits the tip inside a %dpx container on every column",
    (parentWidth) => {
      for (const offset of COLUMN_OFFSETS) {
        const left = clampSprintTipLeft(offset, parentWidth, TIP_WIDTH);
        expect(left + TIP_WIDTH).toBeLessThanOrEqual(parentWidth);
        expect(left).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it("clamps the last column to parentWidth - tipWidth, not parentWidth - 140", () => {
    // The old assumption: min(328 - 140, 287) = 188 → right edge
    // 188 + 317 = 505, overflowing the viewport. The real clamp:
    expect(clampSprintTipLeft(287, 328, TIP_WIDTH)).toBe(11);
    expect(clampSprintTipLeft(41, 328, TIP_WIDTH)).toBe(11);
  });

  it("leaves the first column and wide viewports alone", () => {
    expect(clampSprintTipLeft(0, 328, TIP_WIDTH)).toBe(0);
    expect(clampSprintTipLeft(100, 1200, TIP_WIDTH)).toBe(100);
    expect(clampSprintTipLeft(1000, 1200, TIP_WIDTH)).toBe(883);
  });

  it("floors at 0 when the tip is wider than the container (ellipsis backstop)", () => {
    expect(clampSprintTipLeft(50, 280, TIP_WIDTH)).toBe(0);
  });
});

describe("SprintMatrix — tooltip renders on hover", () => {
  it("shows the column label tooltip for the last column", () => {
    render(<SprintMatrix />);
    fireEvent.mouseOver(
      screen.getByRole("button", { name: "d11 · Dec 1 · 6 final submissions · gate 1/6" }),
    );
    expect(screen.getByText("d11 · Dec 1 · 6 final submissions · gate 1/6")).toBeInTheDocument();
  });
});
