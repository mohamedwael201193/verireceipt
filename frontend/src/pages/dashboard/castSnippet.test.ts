// pin3-r2: the copy-paste registration commands (/docs "Registration (cast)"
// and the dashboard "cast" tab share REGISTRATION_CAST_SNIPPET) must use the
// official telegraph-docs miners/miner-registration.md signatures and only
// real VeriReceipt values, with the key left as a placeholder.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DOC_SNIPPETS, REGISTRATION_CAST_SNIPPET as S } from "./docs";

const minerYaml = readFileSync(resolve(__dirname, "../../../../miner.yaml"));
const yamlSha = createHash("sha256").update(minerYaml).digest("hex");

describe("registration cast snippet", () => {
  it("is the single source for the dashboard cast tab", () => {
    expect(DOC_SNIPPETS.cast).toBe(S);
  });

  it("uses only the official registerMiner / updateMiner signatures", () => {
    expect(S).toContain('"registerMiner(string,bytes32,address,uint256,string[])(uint256)"');
    expect(S).toContain('"registerMiner(string,bytes32,address,uint256,string[])"');
    expect(S).toContain('"updateMiner(uint256,string,bytes32,address,uint256,string[])(uint256)"');
    expect(S).toContain('"updateMiner(uint256,string,bytes32,address,uint256,string[])"');
    const sigs = S.match(/(registerMiner|updateMiner)\([^)]*\)/g) ?? [];
    expect(sigs.length).toBe(4);
    for (const sig of sigs) {
      expect([
        "registerMiner(string,bytes32,address,uint256,string[])",
        "updateMiner(uint256,string,bytes32,address,uint256,string[])",
      ]).toContain(sig);
    }
  });

  it("approves exactly the live quoteMinerBond amount in Sepolia Test USDC", () => {
    expect(S).toContain('"quoteMinerBond(uint256)(uint256,uint256)" 6');
    expect(S).toContain('cast send "$USDC" "approve(address,uint256)" "$DIAMOND" "$BOND"');
    expect(S).not.toMatch(/MACHINA/);
  });

  it("carries only the real VeriReceipt values", () => {
    expect(S).toContain('DIAMOND="0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b"');
    expect(S).toContain('USDC="0xcc194e1a843B658526D0D5C431f670028582Ae17"');
    expect(S).toContain(
      'YAML_URL="https://raw.githubusercontent.com/mohamedwael201193/verireceipt/4f471e48296d7225a482ef70025352e954b9cf5d/miner.yaml"',
    );
    expect(S).toContain(`YAML_HASH="0x${yamlSha}"`);
    expect(yamlSha).toBe("1653f3c00f8ee983bc2d2b36579c665c94ce2215ab1bb0d526564a9aec183e9f");
    expect(S).toContain('FEE_ADDRESS="$(cast wallet address --private-key "$PRIVATE_KEY")"');
    // no hardcoded wallet address other than the Diamond and Test USDC
    const addrs = (S.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []).map((a) => a.toLowerCase());
    expect(new Set(addrs)).toEqual(
      new Set(["0x72a70e949362670bf8bcead24efc5b8f950aa08b", "0xcc194e1a843b658526d0d5c431f670028582ae17"]),
    );
    expect(S).toContain("MIN_PRICE=10000");
    expect(S).toContain("OLD_REGISTRATION_ID=6152");
    const intents = S.match(/INTENTS='(\[[^']*\])'/);
    expect(intents).not.toBeNull();
    expect(JSON.parse(intents![1])).toEqual([
      "ONCHAIN_TX_LOOKUP_GENERAL",
      "REGULATORY_FILING_MONITOR_GENERAL",
      "TVL_LOOKUP_GENERAL",
      "OPTIMAL_EXECUTION_ROUTE_GENERAL",
      "GRID_POWER_PRICE_GENERAL",
      "VALIDATOR_PERFORMANCE_VERIFY_GENERAL",
    ]);
  });

  it("never embeds a private key, only the $PRIVATE_KEY placeholder", () => {
    expect(S).toContain('--private-key "$PRIVATE_KEY"');
    expect(S).not.toMatch(/--private-key\s+(?!"\$PRIVATE_KEY")/);
    // no 32-byte hex secret anywhere except the documented yaml hash
    const hex64 = (S.match(/0x[0-9a-fA-F]{64}/g) ?? []).filter((h) => h.toLowerCase() !== `0x${yamlSha}`);
    expect(hex64).toEqual([]);
    expect(S).not.toMatch(/\$KEY\b/);
  });
});
