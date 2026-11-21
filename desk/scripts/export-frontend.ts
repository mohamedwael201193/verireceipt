// Copies desk/ledger/purchases.jsonl into the frontend as JSON
// (frontend/src/lib/deskPurchases.json), unchanged record for record.
// A frontend test fails if the two ever drift.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLedger } from "../src/ledger.js";

const here = dirname(fileURLToPath(import.meta.url));
const recs = readLedger(join(here, "..", "ledger", "purchases.jsonl"));
const out = join(here, "..", "..", "frontend", "src", "lib", "deskPurchases.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(recs, null, 2) + "\n");
console.log(`exported ${recs.length} purchases to ${out}`);
