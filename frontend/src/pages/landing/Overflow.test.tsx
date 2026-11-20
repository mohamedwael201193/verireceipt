// J2 R2 B4/M5 regression tests: horizontal overflow containment rules.
//
// jsdom has no layout, so these tests assert the CSS rules that contain
// the overflow exist in landing.css. The real proof is the Chromium
// measurement (production build): scrollWidth == innerWidth at 320 /
// 360 / 390px, .sprint-cols right edge <= viewport, .paper-card[data-d]
// right edge <= viewport.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Vitest runs with cwd = frontend/, like the scaffold's routes.test.tsx.
const css = readFileSync("src/pages/landing/landing.css", "utf8");

describe("landing overflow containment (J2 R2 B4/M5)", () => {
  it("B4: sprint-cols tracks can shrink below min-content", () => {
    // A bare repeat(8, 1fr) track cannot shrink below its min-content,
    // and the label words (~38px each) forced the grid to ~408px wide
    // at a 320px viewport (right edge 343.9, scrollWidth 344).
    expect(css).toContain("repeat(8, minmax(0, 1fr))");
    // Strip block comments first: the B4 comment in landing.css names
    // the old rule for documentation, and that mention must not trip
    // this assertion — only a real rule counts.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toContain("repeat(8, 1fr)");
  });

  it("B4: sprint label spans break instead of forcing tracks wide", () => {
    expect(css).toMatch(/\.sprint-cols\s*>\s*span\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.sprint-cols\s*>\s*span\s*\{[^}]*min-width:\s*0/);
  });

  it("M5: the stacked paper card has no rightward offset on phones", () => {
    // The +8px x-offset + 1.7deg rotation pushed the card's top-right
    // corner to x=361 at 360px / 391 at 390px. The <=540px override
    // must come after the base [data-d] rules (same specificity).
    const baseAt = css.indexOf('.paper-card[data-d="1"]');
    const override = css.match(
      /@media\s*\(max-width:\s*540px\)\s*\{[^}]*\.paper-card\[data-d="1"\]\s*\{[^}]*translate3d\(0,\s*10px,\s*0\)/,
    );
    expect(override).not.toBeNull();
    expect(override!.index!).toBeGreaterThan(baseAt);
  });
});
