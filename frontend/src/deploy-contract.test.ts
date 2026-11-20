import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MINER_BASE_URL } from "./config";

// Vitest runs with cwd = frontend/, so repo files are read by relative path.
const read = (rel: string) => readFileSync(rel, "utf8");

describe("deploy contract (J2 M3 / J2 M5 / J2 M6, J1-4)", () => {
  it("miner base URL is one source of truth across config, vite, and vercel", () => {
    const origin = new URL(MINER_BASE_URL).origin;
    expect(origin).toBe("https://verireceipt.onrender.com");

    // vite.config.ts must import the constant, not restate the literal.
    const vite = read("vite.config.ts");
    expect(vite).toContain('import { MINER_BASE_URL } from "./src/config"');
    expect(vite).toContain("target: MINER_BASE_URL");
    expect(vite).not.toContain("verireceipt.onrender.com");

    // vercel.json is static JSON: it carries the literal, and it must be
    // the same origin as config.ts or drift fails the suite.
    const vercel = JSON.parse(read("vercel.json")) as {
      rewrites: { source: string; destination: string }[];
    };
    const apiRewrite = vercel.rewrites.find((r) => r.source === "/api/:path*");
    expect(apiRewrite).toBeDefined();
    expect(new URL(apiRewrite!.destination).origin).toBe(origin);
  });

  it("index.html title is the design file A title (J1-4)", () => {
    const html = read("index.html");
    expect(html).toContain(
      "<title>/*v*/erireceipt — Zero-LLM Receipt Oracle &amp; Mission 13/12 Desk</title>",
    );
  });

  it("Google Fonts load non-blockingly with the same families (J2 M6)", () => {
    const html = read("index.html");
    const families =
      "family=Inter:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400;1,500&family=JetBrains+Mono:wght@400;500&family=Newsreader:ital,opsz,wght@0,6..72,400;1,6..72,400;1,6..72,500&display=swap";
    // Preload + media=print onload swap; no plain render-blocking stylesheet.
    expect(html).toContain(`rel="preload"`);
    expect(html).toContain(`as="style"`);
    expect(html).toContain(`href="https://fonts.googleapis.com/css2?${families}"`);
    expect(html).toContain(`media="print"`);
    expect(html).toContain(`onload="this.media='all'"`);
    // No plain render-blocking font stylesheet link may exist: every
    // fonts.googleapis.com stylesheet link must carry media="print".
    // (The <noscript> fallback is stripped first: it is only parsed when
    // JS is off, so it is not a render-blocking link in normal use.)
    const jsHtml = html.replace(/<noscript>[\s\S]*?<\/noscript>/g, "");
    const blocking = [...jsHtml.matchAll(/<link[^>]*>/g)].filter(
      (m) => m[0].includes("fonts.googleapis.com") && m[0].includes('rel="stylesheet"') && !m[0].includes('media="print"'),
    );
    expect(blocking).toEqual([]);
    // noscript fallback keeps fonts for no-JS browsers.
    expect(html).toContain("<noscript>");
  });

  it("frontend README states the Vercel deploy contract (J2 M5)", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/Root Directory MUST be `frontend`/);
    expect(readme).toMatch(/Framework preset:.*Vite/);
    expect(readme).toMatch(/Build command:.*`npm run build`/);
    expect(readme).toMatch(/Environment variables:.*none required/i);
    expect(readme).toMatch(/\/api.*proxy rewrite/i);
    expect(readme).toContain("https://verireceipt.onrender.com");
  });

  it("@types/node is a declared devDependency (merged-tree typecheck)", () => {
    const pkg = JSON.parse(read("package.json")) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies["@types/node"]).toMatch(/^\^24\./);
  });
});
