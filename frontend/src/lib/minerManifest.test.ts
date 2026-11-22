import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DECLARED_INTENTS, DECLARED_INTENT_COUNT } from "./minerManifest";
import { BOND_INTENT_COUNT, BOND_REGISTRATION_ID, MINER_BOND_BASE_UNITS } from "./minerBond";
import { SEPOLIA_REGISTRATION_ID, SEPOLIA_YAML_HASH, SEPOLIA_SERVING_REGISTRATION_IDS } from "./minerRegistration";
import { INTENT_ENDPOINTS } from "../config";
import { INTENTS } from "../pages/landing/data";

describe("current frontend contract metadata", () => {
 it("is exactly the canonical YAML14 declarations and registered hash", () => {
  const raw = readFileSync(resolve(__dirname, "../../../miner.yaml"));
  const section = raw.toString().split("  supported_intents:\n")[1].split(/\n[^ ]/)[0];
  const listed = [...section.matchAll(/^    - ([A-Z0-9_]+)$/gm)].map(m => m[1]);
  expect(listed).toEqual([...DECLARED_INTENTS]);
  expect(DECLARED_INTENT_COUNT).toBe(14);
  expect("0x" + createHash("sha256").update(raw).digest("hex")).toBe(SEPOLIA_YAML_HASH);
 });
 it("separates six selected demos from the14 declarations", () => {
  expect(INTENTS).toHaveLength(6);
  expect(INTENT_ENDPOINTS).toHaveLength(6);
  expect(BOND_INTENT_COUNT).toBe(DECLARED_INTENT_COUNT);
  expect(BOND_REGISTRATION_ID).toBe(SEPOLIA_REGISTRATION_ID);
  expect(SEPOLIA_REGISTRATION_ID).toBe(6174);
  expect(MINER_BOND_BASE_UNITS).toBe(2_150_000);
  expect(SEPOLIA_SERVING_REGISTRATION_IDS).toEqual([6152, 6160, 6174]);
 });
 it("does not conflate manual Desk probes with header health", () => {
  const text = readFileSync(resolve(__dirname, "../pages/Dashboard.tsx"), "utf8");
  expect(text).toContain("No manual /health probe in this tab");
  expect(text).not.toContain('"/health: not probed yet"');
 });
});
