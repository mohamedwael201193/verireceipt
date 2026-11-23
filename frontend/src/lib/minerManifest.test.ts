import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DECLARED_INTENTS, DECLARED_INTENT_COUNT, MINER_YAML_SHA256 } from "./minerManifest";
import { BOND_INTENT_COUNT, BOND_REGISTRATION_ID, MINER_BOND_BASE_UNITS } from "./minerBond";
import { SEPOLIA_REGISTRATION_ID, SEPOLIA_YAML_HASH, SEPOLIA_SERVING_REGISTRATION_IDS } from "./minerRegistration";
import { INTENT_ENDPOINTS } from "../config";
import { INTENTS } from "../pages/landing/data";

describe("current frontend contract metadata", () => {
 it("is exactly the canonical YAML45 declarations and pending hash", () => {
  const raw = readFileSync(resolve(__dirname, "../../../miner.yaml"));
  const section = raw.toString().split("  supported_intents:\n")[1].split(/\n[^ ]/)[0];
  const listed = [...section.matchAll(/^    - ([A-Z0-9_]+)$/gm)].map(m => m[1]);
  expect(listed).toEqual([...DECLARED_INTENTS]);
  expect(DECLARED_INTENT_COUNT).toBe(45);
  // The working miner.yaml is ahead of the chain: its hash is the pending
  // update hash, and SEPOLIA_YAML_HASH stays the registered hash until the tx.
  const workingHash = "0x" + createHash("sha256").update(raw).digest("hex");
  expect(workingHash).toBe(MINER_YAML_SHA256);
  expect(SEPOLIA_YAML_HASH).toBe("0x7e6ba1228d6c171535fdc82f31d220acf4695dc5d9319530cb206be36f0ea9c7");
 });
 it("separates six selected demos from the declarations", () => {
  expect(INTENTS).toHaveLength(6);
  expect(INTENT_ENDPOINTS).toHaveLength(6);
  expect(BOND_INTENT_COUNT).toBe(14); // on-chain registered count, pending the 45-intent update
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
