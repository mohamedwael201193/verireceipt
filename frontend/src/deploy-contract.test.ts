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

  it("no-cache headers cover every index.html-serving pathname, exactly (J2 C3 F1 + P-C3)", () => {
    // The first C3 vercel.json only listed "/index.html" and "/" — but
    // Vercel matches a header `source` against the INCOMING pathname,
    // so a deep-link request (/receipts, /dashboard, /receipts/:id, …)
    // got no `no-cache` on its rewritten index.html response: the
    // stale-chunk class the C3 fix claims to close stayed open on 6 of
    // 7 routes. The P-C3 J2 verdict found 10 more index.html-serving
    // forms uncovered: 6 trailing-slash forms, 1 case variant, and the
    // open-ended catch-all class (3+ unmatched paths of any depth).
    //
    // The fix covers the 10 enumerated forms EXPLICITLY and closes the
    // open-ended class with a "/(.*)" no-cache rule. Enumeration alone
    // cannot close the catch-all class (a 4-segment path, another case
    // variant, …), so the catch-all is load-bearing, not decorative.
    // The "/assets/:path*" immutable rule sits AFTER it: Vercel applies
    // every matching header rule and the later entry wins for the same
    // key, so hashed bundles keep their long cache. The "/(.*)" rule
    // also matches /api/* proxied responses — accepted deliberately:
    // /api responses are live dynamic data, the miner sets no
    // Cache-Control of its own, and Vercel's own default for them is
    // "public, max-age=0, must-revalidate", which is equivalent to
    // no-cache for reuse purposes (revalidate every time).
    //
    // Exactness: the no-cache source set must EQUAL this list — no
    // more, no fewer — so a future edit cannot silently drop a form or
    // add an unreviewed one.
    const vercel = JSON.parse(read("vercel.json")) as {
      headers: { source: string; headers: { key: string; value: string }[] }[];
      rewrites: { source: string; destination: string }[];
    };
    const noCacheSources = new Set(
      vercel.headers
        .filter((h) =>
          h.headers.some(
            (x) => x.key.toLowerCase() === "cache-control" && x.value === "no-cache",
          ),
        )
        .map((h) => h.source),
    );
    expect(noCacheSources).toEqual(
      new Set([
        // The 8 app routes.
        "/index.html",
        "/",
        "/dashboard",
        "/receipts",
        "/receipts/:id",
        "/benchmarks",
        "/status",
        "/docs",
        // The 6 trailing-slash forms (J2 P-C3).
        "/dashboard/",
        "/receipts/",
        "/receipts/:id/",
        "/benchmarks/",
        "/status/",
        "/docs/",
        // The case variant (J2 P-C3).
        "/Dashboard",
        // The catch-all: closes the open-ended class (J2 P-C3).
        "/(.*)",
      ]),
    );
    // No EXPLICIT /api no-cache source: the only rule matching /api/*
    // is the "/(.*)" catch-all above, by design (see the comment).
    expect([...noCacheSources].some((s) => s.startsWith("/api"))).toBe(false);
    // Hashed assets keep their long cache: the immutable rule exists
    // and is positioned AFTER the "/(.*)" no-cache rule (later wins).
    const assetRuleIdx = vercel.headers.findIndex(
      (h) =>
        h.source === "/assets/:path*" &&
        h.headers.some(
          (x) =>
            x.key.toLowerCase() === "cache-control" &&
            x.value === "public, max-age=31536000, immutable",
        ),
    );
    expect(assetRuleIdx).toBeGreaterThan(-1);
    const catchAllIdx = vercel.headers.findIndex((h) => h.source === "/(.*)");
    expect(assetRuleIdx).toBeGreaterThan(catchAllIdx);
    // No no-cache source matches /assets/* (only the immutable rule does).
    expect([...noCacheSources].some((s) => s.startsWith("/assets"))).toBe(false);
    // Rewrites intact: the API proxy and the SPA fallback.
    expect(vercel.rewrites).toContainEqual({
      source: "/api/:path*",
      destination: "https://verireceipt.onrender.com/:path*",
    });
    expect(vercel.rewrites).toContainEqual({
      source: "/(.*)",
      destination: "/index.html",
    });
  });

  it("@types/node is a declared devDependency (merged-tree typecheck)", () => {
    const pkg = JSON.parse(read("package.json")) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies["@types/node"]).toMatch(/^\^24\./);
  });
});
