// Reproduce the published example using only public GETs. Never loads a secret.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { replayResearch, type PublishedResearch } from "../src/judgeReplay.js";

if (process.argv.length > 2) throw new Error("Usage: npm run judge:verify (no arguments, wallet or key)");
const record = JSON.parse(readFileSync(fileURLToPath(new URL("../../docs/research-evidence/tesla-2024-10q-20261121.json", import.meta.url)), "utf8")) as PublishedResearch;
const delivery = JSON.parse(readFileSync(fileURLToPath(new URL("../../docs/research-evidence/tesla-2024-10q-20261121-delivery.json", import.meta.url)), "utf8"));
console.log("VeriReceipt | no-wallet historical research replay");
console.log("This contacts public evidence endpoints. It cannot buy, sign or load a key.");
const result = await replayResearch(record, delivery.delivery.delivery.payer);
for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
console.log(`\n${result.ok ? "PASS" : "HOLD"} historical ${result.status}; count=${result.count ?? "withheld"}; current delivery=${result.delivery}`);
console.log(`Original completion: ${result.historical_at}; checked: ${result.checked_at}`);
for (const limit of result.limits) console.log(`LIMIT ${limit}`);
process.exitCode = result.ok ? 0 : 1;
