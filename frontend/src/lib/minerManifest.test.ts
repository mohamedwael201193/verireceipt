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
 it("matches repo manifest declarations and pending raw-byte hash", () => {
  const raw = readFileSync(resolve(__dirname, "../../../miner.yaml"));
  const section = raw.toString().split("  supported_intents:\n")[1].split(/\n[^ ]/)[0];
  const listed = [...section.matchAll(/^    - ([A-Z0-9_]+)$/gm)].map(m => m[1]);
  expect(listed).toEqual([...DECLARED_INTENTS]);
  expect(DECLARED_INTENT_COUNT).toBe(58);
  // Declaration metadata follows this file. Registered-chain metadata
  // is separate and must change only after a verified registration update.
  const workingHash = "0x" + createHash("sha256").update(raw).digest("hex");
  expect(workingHash).toBe(MINER_YAML_SHA256);
  expect(SEPOLIA_YAML_HASH).toBe("0x373438711810673d7e22f0d928352668a3bc882e9127a228e02b404c4a3747a2");
 });
 it("separates six selected demos from the declarations", () => {
  expect(INTENTS).toHaveLength(6);
  expect(INTENT_ENDPOINTS).toHaveLength(6);
  expect(BOND_INTENT_COUNT).toBe(58); // on-chain registered count (registration 6205)
  expect(BOND_REGISTRATION_ID).toBe(SEPOLIA_REGISTRATION_ID);
  expect(SEPOLIA_REGISTRATION_ID).toBe(6205);
  expect(MINER_BOND_BASE_UNITS).toBe(5_230_000);
  expect(SEPOLIA_SERVING_REGISTRATION_IDS).toEqual([6152, 6160, 6174, 6176, 6177, 6181, 6188, 6196, 6205]);
 });
 it("derives every visible declared-intent count from the manifest", () => {
  for (const f of ["../components/Layout.tsx", "../pages/landing/SiteFooter.tsx", "../pages/landing/IntentIde.tsx"]) {
    const text = readFileSync(resolve(__dirname, f), "utf8");
    expect(text).not.toMatch(/\d+ declared intents/);
    expect(text).toContain("DECLARED_INTENT_COUNT");
  }
  expect(DECLARED_INTENT_COUNT).toBe(DECLARED_INTENTS.length);
 });
 it("does not conflate manual Desk probes with header health", () => {
  const text = readFileSync(resolve(__dirname, "../pages/Dashboard.tsx"), "utf8");
  expect(text).toContain("No manual /health probe in this tab");
  expect(text).not.toContain('"/health: not probed yet"');
 });
});
