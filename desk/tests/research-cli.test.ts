import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
const desk = resolve(__dirname, "..");
const cli = join(desk, "scripts", "research-packet.ts");
function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { cwd: desk, encoding: "utf8",
    env: { ...process.env, DESK_SECRETS_FILE: "/intentionally-not-present", DESK_PAYER_ADDRESS: "not-an-address" } });
}
describe("research CLI plan mode, no key or payment", () => {
  it("creates a frozen plan without accessing an invalid secret path and refuses reuse", () => {
    const dir = mkdtempSync(join(tmpdir(), "vr-research-test-"));
    try {
      const input = join(dir, "input.json"), out = join(dir, "new-run");
      writeFileSync(input, JSON.stringify({ cik: "320193", year: 2025, form: "10-Q", minimum_count: 3 }));
      const result = run(["plan", input, out]);
      expect(result.status).toBe(0); expect(result.stdout).toContain("no purchase");
      expect(JSON.parse(readFileSync(join(out, "plan.json"), "utf8")).network).toBe("eip155:11155111");
      expect(readFileSync(join(out, "plan.sha256"), "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
      expect(run(["plan", input, out]).status).not.toBe(0);
      expect(run(["buy", out]).status).not.toBe(0); // explicit payer/key checks before any ask.
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("rejects extra input properties and never silently buys on unknown commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "vr-research-test-"));
    try {
      const input = join(dir, "input.json");
      writeFileSync(input, JSON.stringify({ cik: "320193", year: 2025, form: "10-Q", minimum_count: 3, buy: true }));
      expect(run(["plan", input, join(dir, "new-run")]).status).not.toBe(0);
      expect(run(["auto", input]).status).not.toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
