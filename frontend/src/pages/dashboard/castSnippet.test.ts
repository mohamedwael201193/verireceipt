// pin3-r2: the copy-paste registration commands (/docs "Registration (cast)"
// and the dashboard "cast" tab share REGISTRATION_CAST_SNIPPET) must use the
// official telegraph-docs miners/miner-registration.md signatures and only
// real VeriReceipt values, with the key left as a placeholder.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DOC_SNIPPETS, REGISTRATION_CAST_SNIPPET as S } from "./docs";
import {
  SEPOLIA_REGISTRATION_ID,
  SEPOLIA_YAML_HASH,
  SEPOLIA_YAML_PIN,
} from "../../lib/minerRegistration";

// yaml-np15: the cast snippet carries the REGISTERED yaml (pin + hash from
// lib/minerRegistration.ts), not the working-tree miner.yaml. updateMiner
// needs the new miner.yaml committed BEFORE its raw URL/hash exist, so for
// a while the repo-root file is ahead of the on-chain pin. What must always
// hold: the hash in the snippet is the SHA-256 of miner.yaml AT the pinned
// commit (the bytes raw.githubusercontent.com serves for YAML_URL).
const repoRoot = resolve(__dirname, "../../../..");
function minerYamlAtPin(): Buffer | null {
  try {
    return execFileSync("git", ["show", `${SEPOLIA_YAML_PIN}:miner.yaml`], {
      cwd: repoRoot,
      maxBuffer: 1 << 20,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null; // shallow clone / no git: the pin cannot be checked offline
  }
}
const pinnedYaml = minerYamlAtPin();
const yamlSha = SEPOLIA_YAML_HASH.replace(/^0x/, "");
const workingTreeYaml = readFileSync(resolve(repoRoot, "miner.yaml"));

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
    expect(SEPOLIA_YAML_PIN).toMatch(/^[0-9a-f]{40}$/);
    expect(SEPOLIA_YAML_HASH).toMatch(/^0x[0-9a-f]{64}$/);
    expect(S).toContain(
      `YAML_URL="https://raw.githubusercontent.com/mohamedwael201193/verireceipt/${SEPOLIA_YAML_PIN}/miner.yaml"`,
    );
    expect(S).toContain(`YAML_HASH="0x${yamlSha}"`);
    expect(S).toContain('FEE_ADDRESS="$(cast wallet address --private-key "$PRIVATE_KEY")"');
    // no hardcoded wallet address other than the Diamond and Test USDC
    const addrs = (S.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []).map((a) => a.toLowerCase());
    expect(new Set(addrs)).toEqual(
      new Set(["0x72a70e949362670bf8bcead24efc5b8f950aa08b", "0xcc194e1a843b658526d0d5c431f670028582ae17"]),
    );
    expect(S).toContain("MIN_PRICE=10000");
    expect(S).toContain(`OLD_REGISTRATION_ID=${SEPOLIA_REGISTRATION_ID}\n`);
    expect(S.match(/OLD_REGISTRATION_ID=\d+/g)).toEqual([`OLD_REGISTRATION_ID=${SEPOLIA_REGISTRATION_ID}`]);
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

  it.skipIf(pinnedYaml === null)(
    "YAML_HASH is the SHA-256 of miner.yaml at the pinned commit (git object, offline)",
    () => {
      expect(createHash("sha256").update(pinnedYaml!).digest("hex")).toBe(yamlSha);
    },
  );

  it("a working-tree miner.yaml ahead of the pin keeps the registered identity", () => {
    // Either nothing is pending (same bytes as the pin), or an updateMiner is
    // pending: the slug and routing id must stay the same (slug = identity).
    const cur = createHash("sha256").update(workingTreeYaml).digest("hex");
    if (cur === yamlSha) return;
    const text = workingTreeYaml.toString("utf8");
    for (const t of [text, pinnedYaml?.toString("utf8")]) {
      if (t === undefined) continue;
      expect(t).toMatch(/^id: "?774921"?$/m);
      expect(t).toMatch(/^slug: "?verireceipt"?$/m);
    }
  });
});
