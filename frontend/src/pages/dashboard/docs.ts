// 30-Second Integration Hub snippets.
//
// Replaces DOC_SNIPPETS (DESIGN-SPEC §6 D-13). Corrections applied:
// - curl tab: the miner's endpoints are GET (miner.yaml), not the design's
//   POST /v1/tx-lookup etc. All curls below are real and runnable.
// - miner.yaml tab: the REAL miner.yaml verbatim (id 774921, slug
//   verireceipt). The design's 89412 / verireceipt-oracle is wrong (§8 A2).
//   Byte-identity with the repo-root miner.yaml is enforced by the drift
//   test in Dashboard.test.tsx — if miner.yaml changes, this tab must be
//   re-synced from it or the suite fails. Do NOT hand-edit this string.
// - cast tab: <user> / <COMMIT_SHA> filled with real values (§8 A13); the
//   Test USDC address was verified as a live Sepolia contract (eth_getCode)
//   on 2026-11-20. Amounts are template values — verify against the live
//   Diamond before broadcasting.
// - escrow / mcp tabs are display-only reference text (not executed code).
//   escrow mirrors the official escrow-inference.md example (telegraph-docs
//   c652c68) with an intent + `params` body (engine-ask.md; `input` is
//   refused live with HTTP 400); payTo comes from the 402 challenge. The
//   r7 build ran it live with an unfunded throwaway key (see PC2-BUILD.md).
//   The mcp tab uses only env vars from mcp-server.md; the $2.00 daily cap
//   matches DESK_DAILY_SPEND_CAP_USD in render.yaml.
// - cast tab registration values (YAML_URL commit, YAML_HASH, current
//   registrationId) come from lib/minerRegistration.ts, i.e. the yaml that is
//   REGISTERED on-chain. During an updateMiner the repo-root miner.yaml (and
//   the miner.yaml tab above) is committed first and can be ahead of that pin
//   until the tx lands; the pin is then moved in minerRegistration.ts only.

import {
  SEPOLIA_PREVIOUS_REGISTRATION_ID,
  SEPOLIA_REGISTRATION_ID,
  SEPOLIA_YAML_HASH,
  SEPOLIA_YAML_PIN,
} from "../../lib/minerRegistration";

export type DocTabId = "curl" | "escrow" | "mcp" | "yaml" | "cast";

export const DOC_TABS: Array<{ id: DocTabId; label: string }> = [
  { id: "curl", label: "curl" },
  { id: "escrow", label: "EIP-191 Escrow (TS)" },
  { id: "mcp", label: "MCP Config" },
  { id: "yaml", label: "miner.yaml" },
  { id: "cast", label: "Registration (cast)" },
];

const CONFIRMED_TX =
  "0x1b9e2b48eb3510ee1a8aae2fc402139784f32d43b76d5853387cacb484a9a9d3";

/**
 * Copy-paste registration commands, shared by the dashboard "cast" tab and
 * /docs. Signatures match telegraph-docs miners/miner-registration.md;
 * the bond is approved in Sepolia Test USDC for the live quoteMinerBond
 * amount (addresses-and-params.md: bonds are paid in USDC on this Diamond).
 */
export const REGISTRATION_CAST_SNIPPET =
  "# VeriReceipt on Ethereum Sepolia: the official Telegraph flow\n# (miners/miner-registration.md Step 4 + \"Updating your miner\";\n# protocol/addresses-and-params.md: on this Diamond bonds are paid in USDC).\n# Set $PRIVATE_KEY yourself (testnet key only). Nothing below contains a key.\nexport DIAMOND=\"0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b\"\nexport USDC=\"0xcc194e1a843B658526D0D5C431f670028582Ae17\"   # Sepolia Test USDC, 6 decimals\nexport RPC=\"https://ethereum-sepolia-rpc.publicnode.com\"\nexport YAML_URL=\"https://raw.githubusercontent.com/mohamedwael201193/verireceipt/" + SEPOLIA_YAML_PIN + "/miner.yaml\"\nexport YAML_HASH=\"" + SEPOLIA_YAML_HASH + "\"\nexport FEE_ADDRESS=\"$(cast wallet address --private-key \"$PRIVATE_KEY\")\"   # payout address = your wallet\nexport MIN_PRICE=10000   # 0.01 USDC in 6-decimal units (minimum allowed)\nexport INTENTS='[\"ONCHAIN_TX_LOOKUP_GENERAL\",\"REGULATORY_FILING_MONITOR_GENERAL\",\"TVL_LOOKUP_GENERAL\",\"OPTIMAL_EXECUTION_ROUTE_GENERAL\",\"GRID_POWER_PRICE_GENERAL\",\"VALIDATOR_PERFORMANCE_VERIFY_GENERAL\"]'\n\n# 0. The hash must be SHA-256 (not keccak256) of the raw bytes at YAML_URL.\n#    This must print exactly $YAML_HASH:\necho \"0x$(curl -s \"$YAML_URL\" | sha256sum | awk '{print $1}')\"\n\n# 1. Bond: quote it for the 6 intents and approve exactly that amount of Test USDC.\n#    (Read live; on 2026-11-21 quoteMinerBond(6) returned 1500000 = $1.50.)\nexport BOND=$(cast call \"$DIAMOND\" \"quoteMinerBond(uint256)(uint256,uint256)\" 6 --rpc-url \"$RPC\" | head -n1 | awk '{print $1}')\ncast send \"$USDC\" \"approve(address,uint256)\" \"$DIAMOND\" \"$BOND\" \\\n  --rpc-url \"$RPC\" --private-key \"$PRIVATE_KEY\"\n\n# 2. Dry run (free): returns the registrationId you would get, or the exact revert.\ncast call \"$DIAMOND\" \\\n  \"registerMiner(string,bytes32,address,uint256,string[])(uint256)\" \\\n  \"$YAML_URL\" \"$YAML_HASH\" \"$FEE_ADDRESS\" \"$MIN_PRICE\" \"$INTENTS\" \\\n  --from \"$(cast wallet address --private-key \"$PRIVATE_KEY\")\" --rpc-url \"$RPC\"\n\n# 3. Register.\ncast send \"$DIAMOND\" \\\n  \"registerMiner(string,bytes32,address,uint256,string[])\" \\\n  \"$YAML_URL\" \"$YAML_HASH\" \"$FEE_ADDRESS\" \"$MIN_PRICE\" \"$INTENTS\" \\\n  --rpc-url \"$RPC\" --private-key \"$PRIVATE_KEY\"\n\n# Update path: change the YAML / price / fee address / intents of an existing\n# registration. Never re-register. It creates a NEW registrationId; the old one ends.\n# VeriReceipt's current registrationId is " + SEPOLIA_REGISTRATION_ID + " (updateMiner of " + SEPOLIA_PREVIOUS_REGISTRATION_ID + ").\nexport OLD_REGISTRATION_ID=" + SEPOLIA_REGISTRATION_ID + "\ncast call \"$DIAMOND\" \\\n  \"updateMiner(uint256,string,bytes32,address,uint256,string[])(uint256)\" \\\n  \"$OLD_REGISTRATION_ID\" \"$YAML_URL\" \"$YAML_HASH\" \"$FEE_ADDRESS\" \"$MIN_PRICE\" \"$INTENTS\" \\\n  --from \"$(cast wallet address --private-key \"$PRIVATE_KEY\")\" --rpc-url \"$RPC\"\ncast send \"$DIAMOND\" \\\n  \"updateMiner(uint256,string,bytes32,address,uint256,string[])\" \\\n  \"$OLD_REGISTRATION_ID\" \"$YAML_URL\" \"$YAML_HASH\" \"$FEE_ADDRESS\" \"$MIN_PRICE\" \"$INTENTS\" \\\n  --rpc-url \"$RPC\" --private-key \"$PRIVATE_KEY\"\n\n# Then read the node verdict ~10-15 min after the tx. Use the registrationId the\n# dry run printed (registerMiner or updateMiner):\nexport NEW_REGISTRATION_ID=\"REPLACE_WITH_ID_FROM_DRY_RUN\"\ncurl -s \"https://devnode.telegraphprotocol.com/api/miners/$NEW_REGISTRATION_ID\"\n";

export const DOC_SNIPPETS: Record<DocTabId, string> = {
  curl:
    "# 1. Direct Miner Probe (Zero Auth — Verifiable SHA-256 Receipt)\n" +
    "# Endpoints are GET (see miner.yaml). No API key, no wallet.\n" +
    `curl -s "https://verireceipt.onrender.com/v1/tx?tx_hash=${CONFIRMED_TX}&chain=ethereum"\n\n` +
    '# 2. TVL, filings, route, grid, validator — same GET pattern\n' +
    'curl -s "https://verireceipt.onrender.com/v1/tvl?protocol=aave-v3"\n' +
    'curl -s "https://verireceipt.onrender.com/v1/filings?entity=AAPL&period=last%2012%20months"\n' +
    'curl -s "https://verireceipt.onrender.com/v1/route?pair=ETH%2FUSDC"\n' +
    'curl -s "https://verireceipt.onrender.com/v1/grid-price?node_or_zone=TH_NP15_GEN-APND&interval_start=2026-11-20T05:00:00.000Z"\n' +
    'curl -s "https://verireceipt.onrender.com/v1/validator?validator_index=1"\n\n' +
    "# 3. Ranked Telegraph Engine Ask: with no payment header the node answers\n#    402 Payment Required, listing the accepted schemes (exact / escrow)\n" +
    "curl -i -X POST https://devnode.telegraphprotocol.com/engine/v1/ask \\\n" +
    '  -H "Content-Type: application/json" \\\n' +
    `  -d '{"intent":"TVL_LOOKUP_GENERAL","params":{"protocol":"aave-v3"},"max_budget_usdc":10000}'\n\n` +
    "# 4. Recompute a receipt SHA-256 independently\n" +
    "#    Take receipt.receipt_id from any response, fetch the stored evidence bytes, hash them:\n" +
    'curl -s "https://verireceipt.onrender.com/receipts/$RECEIPT_ID/raw" | sha256sum\n' +
    "#    Compare with receipt.raw_response_sha256 in the same response. (Re-fetching the live\n" +
    "#    upstream_url is not a proof: live upstreams such as DeFiLlama change between calls.)",

  escrow:
    "// EIP-191 escrow payment over X-PAYMENT, following the official Telegraph\n" +
    "// escrow-inference.md example (telegraph-docs c652c68). Display-only reference:\n" +
    "// the dashboard does not execute it. Fund escrow first (LedgerFacet.depositUSDC).\n" +
    'import { createWalletClient, http } from "viem";\n' +
    'import { privateKeyToAccount } from "viem/accounts";\n' +
    'import { sepolia } from "viem/chains";\n\n' +
    'const NODE = "https://devnode.telegraphprotocol.com";\n' +
    "const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);\n" +
    "const wallet = createWalletClient({ account, chain: sepolia, transport: http() });\n\n" +
    "export async function askEscrow(intent: string, params: Record<string, unknown>) {\n" +
    "  // Request field is `params` (engine-ask.md); `input` is refused with HTTP 400.\n" +
    "  const body = JSON.stringify({ intent, params, max_budget_usdc: 40000 });\n" +
    '  const json = { "Content-Type": "application/json" };\n\n' +
    "  // 1: no payment header -> 402; pick the escrow entry from accepts[]\n" +
    "  const challenge = await fetch(`${NODE}/engine/v1/ask`, { method: \"POST\", headers: json, body })\n" +
    "    .then((r) => r.json());\n" +
    '  const escrow = challenge.accepts.find((a: any) => a.scheme === "escrow");\n' +
    '  if (!escrow) throw new Error("this node does not accept escrow");\n\n' +
    "  const template: string = escrow.extra.message;\n" +
    "  const now = Math.floor(Date.now() / 1000);\n" +
    "  const authorization = {\n" +
    "    from: account.address.toLowerCase(), // lowercase, or the signature will not match\n" +
    "    to: escrow.payTo,\n" +
    "    value: template.match(/Amount:\\s*(\\d+)\\s*uUSDC/)![1],\n" +
    "    validAfter: String(now - 5),\n" +
    "    validBefore: String(now + 100), // window must stay under 2 minutes\n" +
    "    nonce: crypto.randomUUID(), // fresh every attempt\n" +
    "  };\n\n" +
    "  // 2: fill the template in place and sign it verbatim (EIP-191 personal_sign)\n" +
    "  const message = template\n" +
    '    .replace("{from}", authorization.from)\n' +
    '    .replace("{nonce}", authorization.nonce)\n' +
    '    .replace("{validAfter}", authorization.validAfter)\n' +
    '    .replace("{validBefore}", authorization.validBefore);\n' +
    "  const signature = await wallet.signMessage({ message });\n\n" +
    "  // 3: same body, now with X-PAYMENT (never PAYMENT-SIGNATURE for escrow)\n" +
    "  const payment = btoa(JSON.stringify({\n" +
    '    x402Version: 2, scheme: "escrow", network: escrow.network,\n' +
    "    payload: { signature, authorization },\n" +
    "  }));\n" +
    "  const res = await fetch(`${NODE}/engine/v1/ask`, {\n" +
    '    method: "POST", headers: { ...json, "X-PAYMENT": payment }, body,\n' +
    "  });\n" +
    "  if (res.status === 402) throw new Error((await res.json()).reason);\n" +
    '  const header = res.headers.get("X-PAYMENT-RESPONSE");\n' +
    "  return { answer: await res.json(), receipt: header ? JSON.parse(atob(header)) : null };\n" +
    "}",

  mcp:
    "// Claude Desktop / Cursor config for the official Telegraph MCP server (stdio via npx).\n" +
    "// Pays from escrow: create and fund the wallet first with\n" +
    "//   npx -y @telegraphprotocol/telegraph-protocol-mcp setup\n" +
    "{\n" +
    '  "mcpServers": {\n' +
    '    "telegraph-network": {\n' +
    '      "command": "npx",\n' +
    '      "args": ["-y", "@telegraphprotocol/telegraph-protocol-mcp"],\n' +
    '      "env": {\n' +
    '        "TELEGRAPH_PAYMENT": "escrow",\n' +
    '        "TELEGRAPH_MAX_ASK_USD": "0.10",\n' +
    '        "TELEGRAPH_DAILY_LIMIT_USD": "2.00"\n' +
    "      }\n" +
    "    }\n" +
    "  }\n" +
    "}",

  yaml:
    'version: "1"\n' +
    'kind: miner\n' +
    'protocol: generic\n' +
    'id: 774921\n' +
    'slug: verireceipt\n' +
    'name: VeriReceipt Deterministic Oracle\n' +
    'description: >-\n' +
    '  Zero-LLM deterministic provider with a SHA-256 receipt on every answer\n' +
    '  (raw_response_sha256: 64 lowercase hex characters, no 0x prefix, over the\n' +
    '  exact evidence bytes served at /receipts/{receipt_id}/raw): EVM\n' +
    '  transaction lookups (archive-RPC quorum), SEC\n' +
    '  EDGAR filing counts by company, form type and period, DeFi TVL\n' +
    '  (DeFiLlama), block-pinned 1 ETH -> USDC execution quotes on Ethereum\n' +
    '  mainnet, wholesale grid power prices (CAISO, NYISO, Elering), and Ethereum\n' +
    '  beacon-chain validator effective balances (2-of-4 beacon API quorum). It\n' +
    '  refuses (400/422/502/504) rather than guessing.\n' +
    'base_url: https://verireceipt.onrender.com\n' +
    '\n' +
    'auth:\n' +
    '  type: none\n' +
    '\n' +
    'cache_ttl_sec: 10\n' +
    'rate_limit_per_sec: 20\n' +
    'circuit_threshold: 5\n' +
    'circuit_cooldown_seconds: 30\n' +
    '\n' +
    'docs:\n' +
    '  website: https://verireceipt.vercel.app\n' +
    '  documentation: https://verireceipt.vercel.app/docs\n' +
    '  repository: https://github.com/mohamedwael201193/verireceipt\n' +
    '\n' +
    'limitations:\n' +
    '  - code: MAX_PARAM_SIZE\n' +
    '    message: entity must not exceed 512 characters.\n' +
    '    param: entity\n' +
    '    property: length\n' +
    '    value_num: 512\n' +
    '    operator: lte\n' +
    '  - code: MAX_PARAM_SIZE\n' +
    '    message: protocol must not exceed 512 characters.\n' +
    '    param: protocol\n' +
    '    property: length\n' +
    '    value_num: 512\n' +
    '    operator: lte\n' +
    '  - code: MAX_PARAM_VALUE\n' +
    '    message: validator_index must be at most 1000000000.\n' +
    '    param: validator_index\n' +
    '    property: value\n' +
    '    value_num: 1000000000\n' +
    '    operator: lte\n' +
    '\n' +
    'errors:\n' +
    '  message_path: message\n' +
    '  code_path: code\n' +
    '\n' +
    'semantics:\n' +
    '  supported_intents:\n' +
    '    - ONCHAIN_TX_LOOKUP_GENERAL\n' +
    '    - REGULATORY_FILING_MONITOR_GENERAL\n' +
    '    - TVL_LOOKUP_GENERAL\n' +
    '    - OPTIMAL_EXECUTION_ROUTE_GENERAL\n' +
    '    - GRID_POWER_PRICE_GENERAL\n' +
    '    - VALIDATOR_PERFORMANCE_VERIFY_GENERAL\n' +
    '  signal_mapping:\n' +
    '    confidence_field: confidence\n' +
    '    label_field: verdict\n' +
    '    reason_field: source\n' +
    '\n' +
    'endpoints:\n' +
    '  - path: /v1/tx\n' +
    '    external_path: /v1/tx\n' +
    '    method: GET\n' +
    '    description: >-\n' +
    '      Looks up one EVM transaction by hash on a named chain with a 2-of-N\n' +
    '      archive-RPC quorum and returns tx_hash, status (confirmed, reverted,\n' +
    '      pending, not_found), from, to, block_number, value_eth and a SHA-256\n' +
    '      receipt. Use for questions such as "In which block was transaction\n' +
    '      0x... included?".\n' +
    '    intents:\n' +
    '      - ONCHAIN_TX_LOOKUP_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '          - name: tx_hash\n' +
    '            type: string\n' +
    '            intents: ["ONCHAIN_TX_LOOKUP_GENERAL"]\n' +
    '            description: Complete 0x-prefixed 64-hex-character transaction hash.\n' +
    '          - name: chain\n' +
    '            type: string\n' +
    '            intents: ["ONCHAIN_TX_LOOKUP_GENERAL"]\n' +
    '            description: >-\n' +
    '              EVM chain name, lower case: ethereum, base, arbitrum, optimism,\n' +
    '              polygon, sepolia or base-sepolia. Ethereum mainnet may also be\n' +
    '              written eth or mainnet.\n' +
    '\n' +
    '  - path: /v1/filings\n' +
    '    external_path: /v1/filings\n' +
    '    method: GET\n' +
    '    description: >-\n' +
    '      Counts a company\'s filings on SEC EDGAR (data.sec.gov submissions,\n' +
    '      by filing date) in a period, optionally of one exact EDGAR form type,\n' +
    '      and returns entity, form_type, filing_count, the filing titles newest first,\n' +
    '      their URLs and a SHA-256 receipt. Use for questions such as "How many\n' +
    '      Form 10-Q filings by Tesla, Inc. (CIK 1318605) in calendar 2023 are on\n' +
    '      SEC EDGAR?". SEC EDGAR only: an unknown or ambiguous company or form\n' +
    '      is refused (422), never answered from another source or with an\n' +
    '      unfiltered count.\n' +
    '    intents:\n' +
    '      - REGULATORY_FILING_MONITOR_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '          - name: entity\n' +
    '            type: string\n' +
    '            intents: ["REGULATORY_FILING_MONITOR_GENERAL"]\n' +
    '            description: >-\n' +
    '              The subject of the question verbatim, including any SEC form\n' +
    '              type and CIK, e.g. "Form 10-Q filings by Tesla, Inc. (CIK\n' +
    '              1318605)", "Tesla, Inc.", "TSLA", "1318605".\n' +
    '          - name: period\n' +
    '            type: string\n' +
    '            intents: ["REGULATORY_FILING_MONITOR_GENERAL"]\n' +
    '            description: Search period such as last 12 months, 2026, calendar 2023, or YYYY-MM-DD..YYYY-MM-DD. Calendar years only; fiscal-year periods are rejected.\n' +
    '        optional:\n' +
    '          - name: form_type\n' +
    '            type: string\n' +
    '            intents: ["REGULATORY_FILING_MONITOR_GENERAL"]\n' +
    '            description: One SEC EDGAR form type exactly as asked, e.g. 10-K, 10-Q, 8-K, 144/A, 4/A. Exact match (10-K counts originals only; 10-K/A counts amendments only). Omit to count all forms.\n' +
    '\n' +
    '  - path: /v1/tvl\n' +
    '    external_path: /v1/tvl\n' +
    '    method: GET\n' +
    '    description: >-\n' +
    '      Returns the current total value locked of a DeFi protocol or chain\n' +
    '      from DeFiLlama\'s keyless API: protocol_or_chain, tvl_usd,\n' +
    '      chain_tvl_usd, as_of and a SHA-256 receipt. Use for questions such as\n' +
    '      "What is the total value locked in Aave V3, in US dollars?".\n' +
    '    intents:\n' +
    '      - TVL_LOOKUP_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '          - name: protocol\n' +
    '            type: string\n' +
    '            intents: ["TVL_LOOKUP_GENERAL"]\n' +
    '            description: >-\n' +
    '              DeFi protocol name or DeFiLlama slug, keeping the version when\n' +
    '              one is named (Aave V3 or aave-v3, Uniswap V3 or uniswap-v3,\n' +
    '              Lido), or a chain name (ethereum). At most 512 characters.\n' +
    '\n' +
    '  - path: /v1/route\n' +
    '    external_path: /v1/route\n' +
    '    method: GET\n' +
    '    description: >-\n' +
    '      Returns a block-pinned Ethereum mainnet execution quote for selling\n' +
    '      exactly 1 ETH for USDC, the best quote across Uniswap V2/V3, SushiSwap V2,\n' +
    '      as amount_out in USDC base units (6 decimals) with a SHA-256 receipt.\n' +
    '    intents:\n' +
    '      - OPTIMAL_EXECUTION_ROUTE_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '          - name: pair\n' +
    '            type: string\n' +
    '            intents: ["OPTIMAL_EXECUTION_ROUTE_GENERAL"]\n' +
    '            description: The swap to route. Only ETH/USDC (sell exactly 1 ETH for USDC on Ethereum mainnet).\n' +
    '            accepted_fields:\n' +
    '              ETH/USDC:\n' +
    '                intents: ["OPTIMAL_EXECUTION_ROUTE_GENERAL"]\n' +
    '                description: Sell exactly 1 ETH for USDC on Ethereum mainnet.\n' +
    '\n' +
    '  - path: /v1/grid-price\n' +
    '    external_path: /v1/grid-price\n' +
    '    method: GET\n' +
    '    description: >-\n' +
    '      Returns the wholesale electricity price lmp_usd_per_mwh for one\n' +
    '      pricing node or zone and one finished settlement interval, from\n' +
    '      official public feeds: CAISO OASIS day-ahead hourly LMP, NYISO\n' +
    '      real-time 5-minute zonal LBMP, and the Elering dashboard API\n' +
    '      15-minute prices (EUR/MWh converted to USD with the open.er-api.com\n' +
    '      EUR rate). Returns node_or_zone, market, interval_start, currency and\n' +
    '      a SHA-256 receipt. Any other node or zone is refused (422). Use for\n' +
    '      questions such as "What is the CAISO day-ahead LMP for settlement\n' +
    '      interval 2026-09-13T14:00:00Z?".\n' +
    '    intents:\n' +
    '      - GRID_POWER_PRICE_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '          - name: node_or_zone\n' +
    '            type: string\n' +
    '            intents: ["GRID_POWER_PRICE_GENERAL"]\n' +
    '            description: >-\n' +
    '              Exactly one of: CAISO hubs TH_NP15_GEN-APND, TH_SP15_GEN-APND,\n' +
    '              TH_ZP26_GEN-APND (short names NP15, SP15, ZP26 also accepted),\n' +
    '              or CAISO when no CAISO node is named (answered for the NP15\n' +
    '              trading hub TH_NP15_GEN-APND, as the answer states); NYISO\n' +
    '              zones ZONE_A to ZONE_K (NYISO names such as N.Y.C. also\n' +
    '              accepted); Elering zones EE, FI, LV, LT.\n' +
    '          - name: interval_start\n' +
    '            type: string\n' +
    '            intents: ["GRID_POWER_PRICE_GENERAL"]\n' +
    '            description: >-\n' +
    '              Start of the settlement interval, ISO-8601 UTC, e.g.\n' +
    '              2026-09-13T14:00:00Z.\n' +
    '\n' +
    '  - path: /v1/validator\n' +
    '    external_path: /v1/validator\n' +
    '    method: GET\n' +
    '    description: >-\n' +
    '      Returns the effective balance in gwei of one Ethereum beacon-chain\n' +
    '      validator at the finalized state, read from four independently\n' +
    '      operated public beacon APIs (2-of-4 quorum): answered only when at\n' +
    '      least two sources agree on effective_balance and status; fewer than\n' +
    '      two agreeing sources, or any source that disagrees, fails closed\n' +
    '      (502, no answer). Returns validator_index, effective_balance, status\n' +
    '      and a SHA-256 receipt. Use for questions such as "What is the\n' +
    '      effective balance of Ethereum validator index 1, in gwei?".\n' +
    '    intents:\n' +
    '      - VALIDATOR_PERFORMANCE_VERIFY_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '          - name: validator_index\n' +
    '            type: string\n' +
    '            intents: ["VALIDATOR_PERFORMANCE_VERIFY_GENERAL"]\n' +
    '            description: >-\n' +
    '              Ethereum beacon-chain validator index as a canonical decimal\n' +
    '              digit string (0, or a non-negative integer with no sign and no\n' +
    '              leading zeros), e.g. 1, at most 1000000000 (the official\n' +
    '              intent max). The handler rejects any other shape.\n' +
    '\n' +
    'intent_mapping:\n' +
    '  ONCHAIN_TX_LOOKUP_GENERAL:\n' +
    '    endpoint: /v1/tx\n' +
    '    input:\n' +
    '      tx_hash:\n' +
    '        from: tx_hash\n' +
    '      chain:\n' +
    '        from: chain\n' +
    '    output:\n' +
    '      tx_hash:\n' +
    '        path: tx_hash\n' +
    '      status:\n' +
    '        path: status\n' +
    '      from:\n' +
    '        path: from\n' +
    '      to:\n' +
    '        path: to\n' +
    '      block_number:\n' +
    '        path: block_number\n' +
    '        unit: "block height"\n' +
    '      value_eth:\n' +
    '        path: value_eth\n' +
    '        unit: "whole native units"\n' +
    '\n' +
    '  REGULATORY_FILING_MONITOR_GENERAL:\n' +
    '    endpoint: /v1/filings\n' +
    '    input:\n' +
    '      entity:\n' +
    '        from: entity\n' +
    '        how: "Copy the subject of the question verbatim, including any SEC form type and CIK (e.g. \'Form 10-Q filings by Tesla, Inc. (CIK 1318605)\')."\n' +
    '      period:\n' +
    '        from: period\n' +
    '        how: "Pass the requested time period verbatim (e.g., last 12 months, 2026, calendar 2023)."\n' +
    '      form_type:\n' +
    '        from: entity\n' +
    '        how: "Only the SEC EDGAR form type the request names, exactly as EDGAR writes it (10-K, 10-Q, 8-K, 144/A). Leave empty when no form type is named."\n' +
    '    output:\n' +
    '      entity:\n' +
    '        path: entity\n' +
    '      filing_count:\n' +
    '        path: filing_count\n' +
    '        unit: "filings"\n' +
    '      filings:\n' +
    '        path: filings\n' +
    '      urls:\n' +
    '        path: urls\n' +
    '\n' +
    '  TVL_LOOKUP_GENERAL:\n' +
    '    endpoint: /v1/tvl\n' +
    '    input:\n' +
    '      protocol:\n' +
    '        from: protocol\n' +
    '        how: "The protocol or chain name as asked, keeping any version (Aave V3, Uniswap V3), without extra words."\n' +
    '    output:\n' +
    '      protocol_or_chain:\n' +
    '        path: protocol_or_chain\n' +
    '      tvl_usd:\n' +
    '        path: tvl_usd\n' +
    '        unit: "USD"\n' +
    '      chain_tvl_usd:\n' +
    '        path: chain_tvl_usd\n' +
    '        unit: "USD"\n' +
    '      as_of:\n' +
    '        path: as_of\n' +
    '\n' +
    '  OPTIMAL_EXECUTION_ROUTE_GENERAL:\n' +
    '    endpoint: /v1/route\n' +
    '    input:\n' +
    '      pair:\n' +
    '        from: pair\n' +
    '    output:\n' +
    '      amount_out:\n' +
    '        path: amount_out\n' +
    '        unit: "USDC base units (6 decimals)"\n' +
    '\n' +
    '  GRID_POWER_PRICE_GENERAL:\n' +
    '    endpoint: /v1/grid-price\n' +
    '    input:\n' +
    '      node_or_zone:\n' +
    '        from: node_or_zone\n' +
    '        how: "The exact node or zone identifier named; CAISO when the request names CAISO without a node."\n' +
    '      interval_start:\n' +
    '        from: interval_start\n' +
    '        how: "ISO-8601 UTC datetime, e.g. 2026-09-13T14:00:00Z."\n' +
    '    output:\n' +
    '      lmp_usd_per_mwh:\n' +
    '        path: lmp_usd_per_mwh\n' +
    '        unit: "USD per MWh"\n' +
    '      node_or_zone:\n' +
    '        path: node_or_zone\n' +
    '      market:\n' +
    '        path: market\n' +
    '      interval_start:\n' +
    '        path: interval_start\n' +
    '      currency:\n' +
    '        path: currency\n' +
    '\n' +
    '  VALIDATOR_PERFORMANCE_VERIFY_GENERAL:\n' +
    '    endpoint: /v1/validator\n' +
    '    input:\n' +
    '      validator_index:\n' +
    '        from: validator_index\n' +
    '    output:\n' +
    '      effective_balance:\n' +
    '        path: effective_balance\n' +
    '        unit: "gwei"\n',
  cast: REGISTRATION_CAST_SNIPPET,
};
