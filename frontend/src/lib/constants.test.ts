import { describe, expect, it } from "vitest";
import { MINER_BOND_USDC, MINER_IDENTITY, MINER_NAME } from "./constants";

// Guards the DESIGN-SPEC §8 decisions: the dashboard file's
// "89412 / verireceipt-oracle" and "$1.84 / 184 checks" must never resurface.
describe("miner identity", () => {
  it("is id 774921, slug verireceipt", () => {
    expect(MINER_IDENTITY.id).toBe(774921);
    expect(MINER_IDENTITY.slug).toBe("verireceipt");
    expect(MINER_IDENTITY.slug).not.toBe("verireceipt-oracle");
  });

  it("names the miner", () => {
    expect(MINER_NAME).toBe("VeriReceipt Deterministic Oracle");
  });

  it("bond is the on-chain $2.15 (minerBond(6174) = quoteMinerBond(14)), not the stale $1.40 or fabricated $1.84", () => {
    expect(MINER_BOND_USDC).toBe(2.15);
    expect(MINER_BOND_USDC).not.toBe(1.4);
    expect(MINER_BOND_USDC).not.toBe(1.84);
  });
});
