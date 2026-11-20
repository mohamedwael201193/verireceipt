import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// CSS regression tests for the J2 re-review layout fixes (B2, M1, M2).
// jsdom does not apply the imported stylesheet, so these assert on the
// CSS text; the real-browser measurement (headless Chrome) asserts the
// computed styles the text is supposed to produce.
const readFrontendFile = (rel: string) => readFileSync(rel, "utf8");

describe("placeholder padding + footer wordmark + navbar band (J2 B2, M1, M2)", () => {
  it("page-placeholder must not zero horizontal padding (J2 B2)", () => {
    const css = readFrontendFile("src/styles/tokens.css");
    const block = /\.page-placeholder\s*\{[^}]*\}/.exec(css)?.[0];
    expect(block).toBeDefined();
    // Vertical padding only — the sides belong to .container.
    expect(block).toMatch(/padding-block:\s*88px/);
    expect(block).not.toMatch(/padding\s*:/);
    // .container still owns the sides (28px, 16px ≤640px).
    expect(css).toMatch(/\.container\s*\{[^}]*padding:\s*0 28px/);
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)[\s\S]*?\.container\s*\{[^}]*padding:\s*0 16px/);
  });

  it("giant footer wordmark inherits the giant size (J2 M1)", () => {
    const css = readFrontendFile("src/styles/tokens.css");
    const rule = /\.giant-wm\s+\.wordmark\s*\{[^}]*\}/.exec(css)?.[0];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/font-size:\s*inherit/);
    // The override must come after the base .wordmark rule (17px).
    expect(css.indexOf(".giant-wm .wordmark")).toBeGreaterThan(css.indexOf(".wordmark {"));
    // Clamp floor 2rem, not 3rem: at 48px the wordmark is ~324px wide
    // and overflows a 320px viewport (288px usable) — the giant fix
    // must not reintroduce horizontal overflow (measured in Chrome).
    const giant = /\.giant-wm\s*\{[^}]*font-size:\s*clamp\(2rem/.exec(css);
    expect(giant).not.toBeNull();
  });

  it("small-laptop band keeps the navbar to one row (J2 M2)", () => {
    const css = readFrontendFile("src/styles/tokens.css");
    const band = /@media\s*\(min-width:\s*861px\)\s*and\s*\(max-width:\s*1035px\)[\s\S]*?\n\}/.exec(css)?.[0];
    expect(band).toBeDefined();
    // Pill hidden + compact CTA + tighter gaps in the band.
    expect(band).toMatch(/\.health-pill\s*\{[^}]*display:\s*none/);
    expect(band).toMatch(/\.cta-label-full\s*\{[^}]*display:\s*none/);
    expect(band).toMatch(/\.cta-label-short\s*\{[^}]*display:\s*inline/);
    expect(band).toMatch(/\.nav-links\s*\{[^}]*gap:\s*16px/);
  });
});
