// P1: miner.yaml must parse as YAML with a real parser. The 650d288 file was
// rejected on-chain ("YAML schema validation failed") because four plain
// scalars contained ": " and the text-only A8 test could not see it. This
// test parses the whole file and pins the structural contract the node
// consumes: every supported intent is mapped, every mapping points at a
// declared endpoint, and endpoint intent lists are covered by the mappings.
import { readFileSync } from "fs";
import { resolve } from "path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

interface Endpoint { path: string; intents?: string[] }
interface MinerYaml {
  endpoints: Endpoint[];
  intent_mapping: Record<string, { endpoint: string }>;
  semantics: { supported_intents: string[] };
}

const doc = loadYaml(readFileSync(resolve(process.cwd(), "miner.yaml"), "utf8")) as MinerYaml;

describe("miner.yaml parses as real YAML (P1: on-chain rejection 6176)", () => {
  it("parses and keeps intents, mappings and endpoints consistent", () => {
    const intents = doc.semantics.supported_intents;
    expect(intents).toHaveLength(56);
    expect(Object.keys(doc.intent_mapping).sort()).toEqual([...intents].sort());
    const paths = new Set(doc.endpoints.map((e) => e.path));
    for (const [intent, m] of Object.entries(doc.intent_mapping)) {
      expect(paths.has(m.endpoint), `${intent} -> ${m.endpoint}`).toBe(true);
    }
    const endpointIntents = new Set(doc.endpoints.flatMap((e) => e.intents ?? []));
    for (const intent of endpointIntents) {
      expect(doc.intent_mapping[intent], intent).toBeDefined();
    }
  });
});
