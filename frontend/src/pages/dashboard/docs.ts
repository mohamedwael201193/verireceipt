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


import { BOND_INTENT_COUNT } from "../../lib/minerBond";
import {
  SEPOLIA_PREVIOUS_REGISTRATION_ID,
  SEPOLIA_REGISTERED_INTENTS,
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
  "# VeriReceipt on Ethereum Sepolia: the official Telegraph flow\n# (miners/miner-registration.md Step 4 + \"Updating your miner\";\n# protocol/addresses-and-params.md: on this Diamond bonds are paid in USDC).\n# Display-only reference, not executed by this site. Review live terms before signing.\n# Set $PRIVATE_KEY yourself (testnet key only). Nothing below contains a key.\nexport DIAMOND=\"0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b\"\nexport USDC=\"0xcc194e1a843B658526D0D5C431f670028582Ae17\"   # Sepolia Test USDC, 6 decimals\nexport RPC=\"https://ethereum-sepolia-rpc.publicnode.com\"\nexport YAML_URL=\"https://raw.githubusercontent.com/mohamedwael201193/verireceipt/" + SEPOLIA_YAML_PIN + "/miner.yaml\"\nexport YAML_HASH=\"" + SEPOLIA_YAML_HASH + "\"\nexport FEE_ADDRESS=\"$(cast wallet address --private-key \"$PRIVATE_KEY\")\"   # payout address = your wallet\nexport MIN_PRICE=10000   # 0.01 USDC in 6-decimal units (minimum allowed)\nexport INTENTS='" + JSON.stringify(SEPOLIA_REGISTERED_INTENTS) + "'\n\n# 0. The hash must be SHA-256 (not keccak256) of the raw bytes at YAML_URL.\n#    This must print exactly $YAML_HASH:\necho \"0x$(curl -s \"$YAML_URL\" | sha256sum | awk '{print $1}')\"\n\n# 1. Bond: quote it for the " + String(BOND_INTENT_COUNT) + " declared intents and approve exactly that amount of Test USDC.\n#    (Read live; on 2026-11-23 quoteMinerBond(54) returned 4950000 = $4.95.)\nexport BOND=$(cast call \"$DIAMOND\" \"quoteMinerBond(uint256)(uint256,uint256)\" " + String(BOND_INTENT_COUNT) + " --rpc-url \"$RPC\" | head -n1 | awk '{print $1}')\ncast send \"$USDC\" \"approve(address,uint256)\" \"$DIAMOND\" \"$BOND\" \\\n  --rpc-url \"$RPC\" --private-key \"$PRIVATE_KEY\"\n\n# 2. Dry run (free): returns the registrationId you would get, or the exact revert.\ncast call \"$DIAMOND\" \\\n  \"registerMiner(string,bytes32,address,uint256,string[])(uint256)\" \\\n  \"$YAML_URL\" \"$YAML_HASH\" \"$FEE_ADDRESS\" \"$MIN_PRICE\" \"$INTENTS\" \\\n  --from \"$(cast wallet address --private-key \"$PRIVATE_KEY\")\" --rpc-url \"$RPC\"\n\n# 3. Register.\ncast send \"$DIAMOND\" \\\n  \"registerMiner(string,bytes32,address,uint256,string[])\" \\\n  \"$YAML_URL\" \"$YAML_HASH\" \"$FEE_ADDRESS\" \"$MIN_PRICE\" \"$INTENTS\" \\\n  --rpc-url \"$RPC\" --private-key \"$PRIVATE_KEY\"\n\n# Update path: change the YAML / price / fee address / intents of an existing\n# registration. Never re-register. It creates a NEW registrationId; the old one ends.\n# VeriReceipt's current registrationId is " + SEPOLIA_REGISTRATION_ID + " (updateMiner of " + SEPOLIA_PREVIOUS_REGISTRATION_ID + ").\nexport OLD_REGISTRATION_ID=" + SEPOLIA_REGISTRATION_ID + "\ncast call \"$DIAMOND\" \\\n  \"updateMiner(uint256,string,bytes32,address,uint256,string[])(uint256)\" \\\n  \"$OLD_REGISTRATION_ID\" \"$YAML_URL\" \"$YAML_HASH\" \"$FEE_ADDRESS\" \"$MIN_PRICE\" \"$INTENTS\" \\\n  --from \"$(cast wallet address --private-key \"$PRIVATE_KEY\")\" --rpc-url \"$RPC\"\ncast send \"$DIAMOND\" \\\n  \"updateMiner(uint256,string,bytes32,address,uint256,string[])\" \\\n  \"$OLD_REGISTRATION_ID\" \"$YAML_URL\" \"$YAML_HASH\" \"$FEE_ADDRESS\" \"$MIN_PRICE\" \"$INTENTS\" \\\n  --rpc-url \"$RPC\" --private-key \"$PRIVATE_KEY\"\n\n# Then read the node verdict ~10-15 min after the tx. Use the registrationId the\n# dry run printed (registerMiner or updateMiner):\nexport NEW_REGISTRATION_ID=\"REPLACE_WITH_ID_FROM_DRY_RUN\"\ncurl -s \"https://devnode.telegraphprotocol.com/api/miners/$NEW_REGISTRATION_ID\"\n";

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
    'description: \'Zero-LLM deterministic provider with a SHA-256 receipt on every answer (raw_response_sha256:\n' +
    '  64 lowercase hex characters, no 0x prefix, over the exact evidence bytes served at /receipts/{receipt_id}/raw):\n' +
    '  seven named EVM transaction chains, SEC EDGAR filing counts by company, exact form and inclusive filing-date\n' +
    '  period, DeFiLlama protocol or chain TVL, a canonical fixed-size Ethereum mainnet ETH/USDC execution quote,\n' +
    '  supported CAISO/NYISO/Elering grid prices, and finalized-root Ethereum validator effective balances. Unsupported,\n' +
    '  ambiguous or unavailable evidence is refused rather than guessed. Additional receipt-backed endpoints provide\n' +
    '  named-chain gas and balances, explicit-chain ERC20 supply, World Bank unemployment, DNS record observations,\n' +
    '  dated currency conversion, TLS certificate validity and DNS response status. Thirty-one further receipt-backed\n' +
    '  endpoints provide academic search, Chainlink reserve attestations, GitHub CI patch verification, SEC corporate\n' +
    '  registry lookup, cross-chain transaction-state agreement, CVE records, resolved prediction-market outcomes, market\n' +
    '  data, current FX rates, IP geolocation, pool liquidity, malware and threat-intelligence blocklist reads, news\n' +
    '  headlines and search, card BIN lookup, driving ETAs, sanctions screening, delivered-uptime reads, sports scores,\n' +
    '  US equity quotes, token holder counts, transaction risk reads, US airport disruption status, URL safety reads, EU\n' +
    '  VAT verification, CVE triage and weather forecasts. Declared source, scope and\n' +
    '  freshness limits apply.\'\n' +
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
    '    - GAS_PRICE_GENERAL\n' +
    '    - WALLET_BALANCE_CHECK_GENERAL\n' +
    '    - TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL\n' +
    '    - MACRO_ECONOMIC_INDICATOR_GENERAL\n' +
    '    - DNS_RECORD_LOOKUP_GENERAL\n' +
    '    - CURRENCY_EXCHANGE_CONVERT\n' +
    '    - SSL_VERIFICATION_CERT\n' +
    '    - EMAIL_SECURITY_GENERAL\n' +
    '    - ACADEMIC_SEARCH_GENERAL\n' +
    '    - ASSET_RESERVE_ATTESTATION_GENERAL\n' +
    '    - CODE_PATCH_VERIFY_GENERAL\n' +
    '    - CORPORATE_REGISTRY_LOOKUP_GENERAL\n' +
    '    - CROSS_CHAIN_STATE_VERIFY_GENERAL\n' +
    '    - CRYPTO_PRICE_USD\n' +
    '    - CVE_LOOKUP_CVSS\n' +
    '    - EVENT_OUTCOME_RESOLUTION_GENERAL\n' +
    '    - FINANCIAL_DATA_GENERAL\n' +
    '    - FX_NOW_CAD\n' +
    '    - FX_NOW_EUR\n' +
    '    - FX_NOW_SEK\n' +
    '    - IP_GEOLOCATION_GENERAL\n' +
    '    - LIQUIDITY_DEPTH_VERIFY_GENERAL\n' +
    '    - MALWARE_DETECTION_HASH\n' +
    '    - MINING_HASHPRICE_VERIFY_GENERAL\n' +
    '    - NEWS_HEADLINES_GENERAL\n' +
    '    - NEWS_SEARCH_GENERAL\n' +
    '    - PAYMENT_METHOD_VERIFY_GENERAL\n' +
    '    - ROUTE_ETA_GENERAL\n' +
    '    - SANCTIONS_SCREENING_MATCH_GENERAL\n' +
    '    - SLA_COMPLIANCE_GENERAL\n' +
    '    - SPORTS_SCORE_GENERAL\n' +
    '    - STORM_ALERT_GENERAL\n' +
    '    - STOCK_PRICE_US_EQUITY\n' +
    '    - THREAT_INTELLIGENCE_INDICATOR\n' +
    '    - TOKEN_HOLDER_COUNT_GENERAL\n' +
    '    - TRANSACTION_RISK_GENERAL\n' +
    '    - TRAVEL_DISRUPTION_GENERAL\n' +
    '    - URL_SAFE_GENERAL\n' +
    '    - URL_SCAN_VERDICT\n' +
    '    - VENDOR_VERIFY_GENERAL\n' +
    '    - VULNERABILITY_TRIAGE_GENERAL\n' +
    '    - WEATHER_CHECK_TEMPERATURE\n' +
    '    - WEATHER_FORECAST_GENERAL\n' +
    '    - ONCHAIN_METRIC_VERIFY_GENERAL\n' +
    '    - AIR_QUALITY_INDEX_GENERAL\n' +
    '    - API_HEALTH_CHECK_GENERAL\n' +
    '    - SERVER_UPTIME_MONITOR_GENERAL\n' +
    '    - SECURITY_REVIEW_GENERAL\n' +
    '    - WEATHER_FORECAST_VERIFY_GENERAL\n' +
    '    - RETURN_POLICY_VERIFY_GENERAL\n' +
    '    - GAME_RESULT_GENERAL\n' +
    '    - CRYPTO_YIELD_RATE_GENERAL\n' +
    '  signal_mapping:\n' +
    '    confidence_field: confidence\n' +
    '    label_field: answer\n' +
    '    reason_field: source\n' +
    '\n' +
    'endpoints:\n' +
    '  - path: /v1/tx\n' +
    '    external_path: /v1/tx\n' +
    '    method: GET\n' +
    '    description: Looks up one complete EVM transaction hash on an explicitly named supported chain using a public\n' +
    '      archive-capable RPC quorum. Returns tx_hash, status (confirmed, reverted, pending or not_found), from,\n' +
    '      to, block_number, value_eth and a SHA-256 receipt. A quorum is required; an unavailable or conflicting\n' +
    '      source set is not a not_found answer. This is an observation, not a transaction submission.\n' +
    '    intents:\n' +
    '    - ONCHAIN_TX_LOOKUP_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: tx_hash\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - ONCHAIN_TX_LOOKUP_GENERAL\n' +
    '          description: Complete 0x-prefixed 64-hex-character transaction hash.\n' +
    '        - name: chain\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - ONCHAIN_TX_LOOKUP_GENERAL\n' +
    '          description: \'Supported canonical chain names: ethereum, base, arbitrum, optimism, polygon, sepolia\n' +
    '            and base-sepolia. Ethereum aliases eth and mainnet are accepted. State the chain explicitly; do\n' +
    '            not infer another chain from a transaction hash.\'\n' +
    '\n' +
    '  - path: /v1/filings\n' +
    '    external_path: /v1/filings\n' +
    '    method: GET\n' +
    '    description: Counts one company\'s SEC EDGAR submissions by inclusive filing_date, optionally restricted\n' +
    '      to one exact form type. Supports calendar years, explicit calendar quarters, valid quarter-ending dates\n' +
    '      and explicit date ranges, not company fiscal periods. Returns entity, form_type, filing_count, newest-first\n' +
    '      filing titles and URLs, and a SHA-256 receipt. Unknown or ambiguous company/form and unsupported periods\n' +
    '      are refused, not replaced with an unfiltered count or another source.\n' +
    '    intents:\n' +
    '    - REGULATORY_FILING_MONITOR_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: entity\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - REGULATORY_FILING_MONITOR_GENERAL\n' +
    '          description: The subject of the question verbatim, including any SEC form type and CIK, e.g. "Form\n' +
    '            10-Q filings by Tesla, Inc. (CIK 1318605)", "Tesla, Inc.", "TSLA", "1318605".\n' +
    '        - name: period\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - REGULATORY_FILING_MONITOR_GENERAL\n' +
    '          description: \'An inclusive filing-date period: last N months, a calendar year, year to date\n' +
    '            (YTD, January 1 of the current calendar year through today), an explicit calendar\n' +
    '            Q1/Q2/Q3/Q4 with year (e.g. "Q3 2026"), a valid quarter ending YYYY-MM-DD (March 31, June 30, September 30 or December\n' +
    '            31), YYYY-MM-DD..YYYY-MM-DD, or a supported year/date range using to or through. Bare Q1-Q4 without\n' +
    '            calendar qualification and company fiscal-year or fiscal-quarter requests are rejected.\'\n' +
    '        optional:\n' +
    '        - name: form_type\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - REGULATORY_FILING_MONITOR_GENERAL\n' +
    '          description: One exact SEC EDGAR form type as asked, including slash amendments, e.g. 10-K, 10-Q,\n' +
    '            8-K, 144/A or 4/A. 10-K excludes 10-K/A and amendments are not folded into originals. A form embedded\n' +
    '            in entity is retained; conflicting form specifications are rejected. Omit only when the question\n' +
    '            asks for all forms.\n' +
    '\n' +
    '  - path: /v1/tvl\n' +
    '    external_path: /v1/tvl\n' +
    '    method: GET\n' +
    '    description: Returns current DeFiLlama TVL in USD for one resolvable protocol, catalog parent aggregate\n' +
    '      or chain. Version-qualified names remain version-qualified; catalog parent relationships are not replaced\n' +
    '      by guessed slug substitutions. Returns protocol_or_chain, tvl_usd, as_of and a SHA-256 receipt. chain_tvl_usd\n' +
    '      is an optional nullable breakdown, not a second required total. Unknown or ambiguous identities are refused.\n' +
    '    intents:\n' +
    '    - TVL_LOOKUP_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: protocol\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - TVL_LOOKUP_GENERAL\n' +
    '          description: Protocol name or DeFiLlama slug, preserving any requested version, catalog parent name,\n' +
    '            or supported chain name. Use the complete identity from the question, at most 512 characters. A\n' +
    '            protocol parent aggregate is not interchangeable with one child version; a missing optional chain\n' +
    '            breakdown does not mean the total is missing.\n' +
    '\n' +
    '  - path: /v1/route\n' +
    '    external_path: /v1/route\n' +
    '    method: GET\n' +
    '    description: The typed intent contract quotes exactly 1 ETH sold for USDC on Ethereum mainnet, with block-pinned\n' +
    '      public RPC evidence and amount_out in USDC base units (6 decimals). Compares implemented Uniswap V2/V3\n' +
    '      and SushiSwap V2 venues. The API separately implements native ETH/USDT, DAI/USDC, USDT/USDC, DAI/USDT\n' +
    '      and WBTC/USDC extensions, each selling one whole input token with output in its actual buy-token base\n' +
    '      units. Those extensions are outside this typed canonical contract and its accepted_fields; native amounts\n' +
    '      are never inflated into the canonical range or relabelled as another token. Quotes are gross, not gas-adjusted;\n' +
    '      no cross-chain, arbitrary-size or arbitrary-pair routing is promised.\n' +
    '    intents:\n' +
    '    - OPTIMAL_EXECUTION_ROUTE_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: pair\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - OPTIMAL_EXECUTION_ROUTE_GENERAL\n' +
    '          description: \'Typed canonical intent pair: ETH/USDC only, selling exactly 1 ETH for USDC on Ethereum\n' +
    '            mainnet. Separately implemented native API extension pairs are not accepted values for this typed\n' +
    '            contract.\'\n' +
    '          accepted_fields:\n' +
    '            ETH/USDC:\n' +
    '              intents:\n' +
    '              - OPTIMAL_EXECUTION_ROUTE_GENERAL\n' +
    '              description: Sell exactly 1 ETH for USDC on Ethereum mainnet; amount_out is USDC base units (6 decimals).\n' +
    '  - path: /v1/grid-price\n' +
    '    external_path: /v1/grid-price\n' +
    '    method: GET\n' +
    '    description: Returns lmp_usd_per_mwh for a supported pricing node or zone and a finished UTC interval from\n' +
    '      CAISO OASIS day-ahead hourly LMP, NYISO real-time 5-minute zonal LBMP, or Elering cached published price\n' +
    '      rows converted from EUR/MWh with the recorded EUR/USD source. Returns node_or_zone, market, interval_start,\n' +
    '      currency, checked_at and receipt timestamps, not a separate freshness/finality field. Normal valid cache\n' +
    '      rows, including eligible provisional rows, use verdict=verified and confidence=1 without a provisional\n' +
    '      label. An unconfirmed post-close row after failed revalidation or unavailable historical re-fetch instead\n' +
    '      carries the unverified-cached-price warning in the answer. Elering is cache-only; absent evidence is not\n' +
    '      interpolated or invented. A finished interval is not a promise of final settlement.\n' +
    '    intents:\n' +
    '    - GRID_POWER_PRICE_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: node_or_zone\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - GRID_POWER_PRICE_GENERAL\n' +
    '          description: CAISO hubs TH_NP15_GEN-APND, TH_SP15_GEN-APND or TH_ZP26_GEN-APND (NP15, SP15, ZP26 aliases);\n' +
    '            bare CAISO explicitly selects NP15. NYISO zones ZONE_A..ZONE_K or supported NYISO names, including\n' +
    '            WEST and N.Y.C.; source-qualified NYISO WEST is accepted. Elering zones EE, FI, LV, LT, also source-qualified\n' +
    '            as Elering EE, Elering FI, Elering LV or Elering LT. Other market/zone combinations are refused.\n' +
    '        - name: interval_start\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - GRID_POWER_PRICE_GENERAL\n' +
    '          description: \'Exact finished settlement-interval start in ISO-8601 UTC with Z or +00:00, aligned to\n' +
    '            the selected market: CAISO 60 minutes, NYISO 5 minutes, Elering 15-minute accepted keys. An aligned\n' +
    '            key is not proof that a source row exists; do not shift an absent interval or infer a current/historical\n' +
    '            price.\'\n' +
    '\n' +
    '  - path: /v1/validator\n' +
    '    external_path: /v1/validator\n' +
    '    method: GET\n' +
    '    description: Returns effective_balance in gwei and status for one Ethereum beacon validator, bound to an\n' +
    '      agreed finalized_state_root. At least two configured public beacon sources must agree on the finalized\n' +
    '      root and at least two validator responses must agree on effective_balance/status for that root. Any returned\n' +
    '      dissent or found-versus-404 conflict fails closed; unavailable legs do not become votes. Verified answers\n' +
    '      may be reused only for the same validator and agreed finalized root, with their original receipt. This\n' +
    '      is effective balance, not APY, reward income, uptime or slashing history.\n' +
    '    intents:\n' +
    '    - VALIDATOR_PERFORMANCE_VERIFY_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: validator_index\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - VALIDATOR_PERFORMANCE_VERIFY_GENERAL\n' +
    '          description: Ethereum beacon-chain validator index as a canonical decimal digit string (0, or a non-negative\n' +
    '            integer with no sign and no leading zeros), e.g. 1, at most 1000000000 (the official intent max).\n' +
    '            The handler rejects any other shape.\n' +
    '\n' +
    '  - path: /v1/gas-price\n' +
    '    external_path: /v1/gas-price\n' +
    '    method: GET\n' +
    '    description: Returns current gas_price_gwei on an explicitly named supported EVM chain from public RPC\n' +
    '      quorum, with stored source evidence.\n' +
    '    intents:\n' +
    '    - GAS_PRICE_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: chain\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - GAS_PRICE_GENERAL\n' +
    '          description: Copy the requested chain without inventing or silently defaulting identity or scope.\n' +
    '  - path: /v1/balance\n' +
    '    external_path: /v1/balance\n' +
    '    method: GET\n' +
    '    description: Returns a finalized native or ERC20 balance in whole token units for an explicit address\n' +
    '      and supported chain. Optional token selects the asset; absent token means the native asset. No transaction\n' +
    '      is sent.\n' +
    '    intents:\n' +
    '    - WALLET_BALANCE_CHECK_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: address\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - WALLET_BALANCE_CHECK_GENERAL\n' +
    '          description: Copy the requested address without inventing or silently defaulting identity or scope.\n' +
    '        - name: chain\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - WALLET_BALANCE_CHECK_GENERAL\n' +
    '          description: Copy the requested chain without inventing or silently defaulting identity or scope.\n' +
    '        optional:\n' +
    '        - name: token\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - WALLET_BALANCE_CHECK_GENERAL\n' +
    '          description: Copy the requested token without inventing or silently defaulting identity or scope.\n' +
    '  - path: /v1/token-supply\n' +
    '    external_path: /v1/token-supply\n' +
    '    method: GET\n' +
    '    description: Returns ERC20 total_supply in whole tokens from finalized-tag RPC quorum. The token text\n' +
    '      must preserve explicit chain and contract identity, for example a token followed by on and the named\n' +
    '      chain. Does not infer a chain for an ambiguous symbol.\n' +
    '    intents:\n' +
    '    - TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: token\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL\n' +
    '          description: Copy the complete token string, keeping any explicit chain, contract address and\n' +
    '            display label. Do not invent a chain.\n' +
    '  - path: /v1/macro\n' +
    '    external_path: /v1/macro\n' +
    '    method: GET\n' +
    '    description: Returns World Bank SL.UEM.TOTL.ZS unemployment rate_pct for a country and optional calendar\n' +
    '      year. Omitted year uses latest published nonempty annual data; missing explicit-year data is refused.\n' +
    '      Other economic indicators are not supported.\n' +
    '    intents:\n' +
    '    - MACRO_ECONOMIC_INDICATOR_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: indicator\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - MACRO_ECONOMIC_INDICATOR_GENERAL\n' +
    '          description: Copy the requested indicator without inventing or silently defaulting identity or\n' +
    '            scope.\n' +
    '          accepted_fields:\n' +
    '            unemployment rate:\n' +
    '              intents:\n' +
    '              - MACRO_ECONOMIC_INDICATOR_GENERAL\n' +
    '              description: Supported canonical value.\n' +
    '        - name: country\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - MACRO_ECONOMIC_INDICATOR_GENERAL\n' +
    '          description: Copy the requested country without inventing or silently defaulting identity or scope.\n' +
    '        optional:\n' +
    '        - name: year\n' +
    '          type: integer\n' +
    '          intents:\n' +
    '          - MACRO_ECONOMIC_INDICATOR_GENERAL\n' +
    '          description: Optional explicit calendar year. Preserve the requested year; omit only when no year\n' +
    '            was requested.\n' +
    '  - path: /v1/dns\n' +
    '    external_path: /v1/dns\n' +
    '    method: GET\n' +
    '    description: Returns has_record for one DNS name and one of the ten declared record types from recursive\n' +
    '      resolver observations. Inconclusive failures and existence disagreement are refused, not reported\n' +
    '      as absence.\n' +
    '    intents:\n' +
    '    - DNS_RECORD_LOOKUP_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: name\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - DNS_RECORD_LOOKUP_GENERAL\n' +
    '          description: Copy the requested name without inventing or silently defaulting identity or scope.\n' +
    '        - name: record_type\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - DNS_RECORD_LOOKUP_GENERAL\n' +
    '          description: Copy the requested record_type without inventing or silently defaulting identity\n' +
    '            or scope.\n' +
    '          accepted_fields:\n' +
    '            A:\n' +
    '              intents:\n' +
    '              - DNS_RECORD_LOOKUP_GENERAL\n' +
    '              description: Supported canonical value.\n' +
    '            AAAA:\n' +
    '              intents:\n' +
    '              - DNS_RECORD_LOOKUP_GENERAL\n' +
    '              description: Supported canonical value.\n' +
    '            CNAME:\n' +
    '              intents:\n' +
    '              - DNS_RECORD_LOOKUP_GENERAL\n' +
    '              description: Supported canonical value.\n' +
    '            MX:\n' +
    '              intents:\n' +
    '              - DNS_RECORD_LOOKUP_GENERAL\n' +
    '              description: Supported canonical value.\n' +
    '            NS:\n' +
    '              intents:\n' +
    '              - DNS_RECORD_LOOKUP_GENERAL\n' +
    '              description: Supported canonical value.\n' +
    '            TXT:\n' +
    '              intents:\n' +
    '              - DNS_RECORD_LOOKUP_GENERAL\n' +
    '              description: Supported canonical value.\n' +
    '            SOA:\n' +
    '              intents:\n' +
    '              - DNS_RECORD_LOOKUP_GENERAL\n' +
    '              description: Supported canonical value.\n' +
    '            CAA:\n' +
    '              intents:\n' +
    '              - DNS_RECORD_LOOKUP_GENERAL\n' +
    '              description: Supported canonical value.\n' +
    '            SRV:\n' +
    '              intents:\n' +
    '              - DNS_RECORD_LOOKUP_GENERAL\n' +
    '              description: Supported canonical value.\n' +
    '            PTR:\n' +
    '              intents:\n' +
    '              - DNS_RECORD_LOOKUP_GENERAL\n' +
    '              description: Supported canonical value.\n' +
    '  - path: /v1/fx\n' +
    '    external_path: /v1/fx\n' +
    '    method: GET\n' +
    '    description: Returns converted_amount in the requested to_currency using dated daily public rate sources\n' +
    '      and disclosed agreement or degraded coverage, not a live trading quote.\n' +
    '    intents:\n' +
    '    - CURRENCY_EXCHANGE_CONVERT\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: from_currency\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - CURRENCY_EXCHANGE_CONVERT\n' +
    '          description: Copy the requested from_currency without inventing or silently defaulting identity\n' +
    '            or scope.\n' +
    '        - name: to_currency\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - CURRENCY_EXCHANGE_CONVERT\n' +
    '          description: Copy the requested to_currency without inventing or silently defaulting identity\n' +
    '            or scope.\n' +
    '        optional:\n' +
    '        - name: amount\n' +
    '          type: number\n' +
    '          intents:\n' +
    '          - CURRENCY_EXCHANGE_CONVERT\n' +
    '          description: Copy the requested amount without inventing or silently defaulting identity or scope.\n' +
    '  - path: /v1/ssl\n' +
    '    external_path: /v1/ssl\n' +
    '    method: GET\n' +
    '    description: Returns certificate_valid from an actual TLS certificate and hostname/trust-store check\n' +
    '      on an allowed public hostname. Network failure is refused. No revocation or multi-vantage assurance\n' +
    '      is claimed.\n' +
    '    intents:\n' +
    '    - SSL_VERIFICATION_CERT\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: host\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - SSL_VERIFICATION_CERT\n' +
    '          description: Copy the requested host without inventing or silently defaulting identity or scope.\n' +
    '  - path: /v1/email-security\n' +
    '    external_path: /v1/email-security\n' +
    '    method: GET\n' +
    '    description: Returns lookup_ok for a public DNS response status for one domain/name and record type.\n' +
    '      It does not report record presence, email safety or deliverability; NOERROR can have no matching records.\n' +
    '    intents:\n' +
    '    - EMAIL_SECURITY_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: domain\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - EMAIL_SECURITY_GENERAL\n' +
    '          description: Copy the requested domain without inventing or silently defaulting identity or scope.\n' +
    '        - name: record_type\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - EMAIL_SECURITY_GENERAL\n' +
    '          description: Copy the requested record_type without inventing or silently defaulting identity\n' +
    '            or scope.\n' +
    '\n' +
    '  - path: /v1/academic-search\n' +
    '    external_path: /v1/academic-search\n' +
    '    method: GET\n' +
    '    description: Searches the Crossref scholarly index for works matching a topic and returns the top\n' +
    '      titles with their DOIs, with a SHA-256 receipt over the exact upstream body.\n' +
    '    intents:\n' +
    '    - ACADEMIC_SEARCH_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: query\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - ACADEMIC_SEARCH_GENERAL\n' +
    '          description: Topic or question to search scholarly papers for\n' +
    '\n' +
    '  - path: /v1/reserve-attestation\n' +
    '    external_path: /v1/reserve-attestation\n' +
    '    method: GET\n' +
    '    description: The latest Chainlink Proof-of-Reserve attestation for a supported asset, read on\n' +
    '      ethereum mainnet through the RPC quorum, with a SHA-256 receipt.\n' +
    '    intents:\n' +
    '    - ASSET_RESERVE_ATTESTATION_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: asset\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - ASSET_RESERVE_ATTESTATION_GENERAL\n' +
    '          description: "The tokenized asset: its symbol or contract address"\n' +
    '\n' +
    '  - path: /v1/code-patch\n' +
    '    external_path: /v1/code-patch\n' +
    '    method: GET\n' +
    '    description: "Verifies a GitHub patch by reading its real CI results from the GitHub API: check runs plus the combined commit status for the exact ref. GitHub patches only."\n' +
    '    intents:\n' +
    '    - CODE_PATCH_VERIFY_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: patch\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - CODE_PATCH_VERIFY_GENERAL\n' +
    '          description: Repository and commit, pull request or CI run to check\n' +
    '\n' +
    '  - path: /v1/corporate-registry\n' +
    '    external_path: /v1/corporate-registry\n' +
    '    method: GET\n' +
    '    description: Looks up a US public company in the SEC\'s EDGAR registry, the only jurisdiction this\n' +
    '      endpoint covers. Active means a filing within the last 400 days.\n' +
    '    intents:\n' +
    '    - CORPORATE_REGISTRY_LOOKUP_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: company\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - CORPORATE_REGISTRY_LOOKUP_GENERAL\n' +
    '          description: Company name or registry identifier\n' +
    '        - name: jurisdiction\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - CORPORATE_REGISTRY_LOOKUP_GENERAL\n' +
    '          description: Country or jurisdiction of registration\n' +
    '\n' +
    '  - path: /v1/cross-chain-state\n' +
    '    external_path: /v1/cross-chain-state\n' +
    '    method: GET\n' +
    '    description: Resolves one transaction hash independently on each listed chain through the 2-of-N\n' +
    '      RPC quorum and reports per-chain agreement; disagreement is reported, never averaged.\n' +
    '    intents:\n' +
    '    - CROSS_CHAIN_STATE_VERIFY_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: reference\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - CROSS_CHAIN_STATE_VERIFY_GENERAL\n' +
    '          description: Address, transfer or transaction to check\n' +
    '        - name: chains\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - CROSS_CHAIN_STATE_VERIFY_GENERAL\n' +
    '          description: Source and destination chains\n' +
    '\n' +
    '  - path: /v1/cve\n' +
    '    external_path: /v1/cve\n' +
    '    method: GET\n' +
    '    description: The published CVSS v3.1 assessment for a CVE from the CVE record, with assessor,\n' +
    '      version and vector disclosed. NVD is opt-in only and off by default.\n' +
    '    intents:\n' +
    '    - CVE_LOOKUP_CVSS\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: cve_id\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - CVE_LOOKUP_CVSS\n' +
    '          description: CVE identifier, e.g. CVE-2024-3094\n' +
    '\n' +
    '  - path: /v1/event-outcome\n' +
    '    external_path: /v1/event-outcome\n' +
    '    method: GET\n' +
    '    description: "The resolved outcome of a prediction-market event from the Polymarket gamma API: closed and UMA-resolved binary Yes/No markets with a clean 1/0 price pair only. One venue\'s resolution record, not an independent determination of the underlying event."\n' +
    '    intents:\n' +
    '    - EVENT_OUTCOME_RESOLUTION_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: event\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - EVENT_OUTCOME_RESOLUTION_GENERAL\n' +
    '          description: The event or question to resolve\n' +
    '\n' +
    '  - path: /v1/financial-data\n' +
    '    external_path: /v1/financial-data\n' +
    '    method: GET\n' +
    '    description: Market capitalisation and trading volume for a supported asset from named, keyless,\n' +
    '      measured sources, with a SHA-256 receipt over the exact upstream bodies.\n' +
    '    intents:\n' +
    '    - FINANCIAL_DATA_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: asset\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - FINANCIAL_DATA_GENERAL\n' +
    '          description: Company, token or market\n' +
    '\n' +
    '  - path: /v1/fx-now\n' +
    '    external_path: /v1/fx-now\n' +
    '    method: GET\n' +
    '    description: The current CAD, EUR and SEK rates vs the US dollar from named keyless sources\n' +
    '      with quoted observation times, with a SHA-256 receipt.\n' +
    '    intents:\n' +
    '    - FX_NOW_CAD\n' +
    '    - FX_NOW_EUR\n' +
    '    - FX_NOW_SEK\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: currency\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - FX_NOW_CAD\n' +
    '          - FX_NOW_EUR\n' +
    '          - FX_NOW_SEK\n' +
    '          description: Currency code priced against the US dollar, one of CAD, EUR, SEK\n' +
    '\n' +
    '\n' +
    '  - path: /v1/ip-geolocation\n' +
    '    external_path: /v1/ip-geolocation\n' +
    '    method: GET\n' +
    '    description: Resolves an IP address to its approximate location from two keyless public\n' +
    '      geolocation services. Approximate network geography, not a physical address.\n' +
    '    intents:\n' +
    '    - IP_GEOLOCATION_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: ip\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - IP_GEOLOCATION_GENERAL\n' +
    '          description: IP address\n' +
    '\n' +
    '  - path: /v1/liquidity\n' +
    '    external_path: /v1/liquidity\n' +
    '    method: GET\n' +
    '    description: Total reserve liquidity in USD for a named pool and chain from the pinned-block\n' +
    '      indexed observation, not executable depth at a slippage threshold.\n' +
    '    intents:\n' +
    '    - LIQUIDITY_DEPTH_VERIFY_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: pool\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - LIQUIDITY_DEPTH_VERIFY_GENERAL\n' +
    '          description: DEX pool address or name\n' +
    '        - name: chain\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - LIQUIDITY_DEPTH_VERIFY_GENERAL\n' +
    '          description: Chain of the pool\n' +
    '\n' +
    '  - path: /v1/malware-hash\n' +
    '    external_path: /v1/malware-hash\n' +
    '    method: GET\n' +
    '    description: Whether a file hash, domain or IP is flagged as malicious by the named keyless\n' +
    '      threat-intelligence sources. Absence from a blocklist is not clearance, and an unknown hash is\n' +
    '      not a clean verdict.\n' +
    '    intents:\n' +
    '    - MALWARE_DETECTION_HASH\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: indicator\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - MALWARE_DETECTION_HASH\n' +
    '          description: Domain, IP address or file hash\n' +
    '\n' +
    '  - path: /v1/news-headlines\n' +
    '    external_path: /v1/news-headlines\n' +
    '    method: GET\n' +
    '    description: The top headline for a topic from the two named indexes (Hacker News via Algolia,\n' +
    '      current BBC News World RSS) inside the requested window; no matching item is an honest refusal.\n' +
    '    intents:\n' +
    '    - NEWS_HEADLINES_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: topic\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - NEWS_HEADLINES_GENERAL\n' +
    '          description: Topic or region\n' +
    '\n' +
    '  - path: /v1/news-search\n' +
    '    external_path: /v1/news-search\n' +
    '    method: GET\n' +
    '    description: A deterministic digest of what the two named news indexes carry for a query, with a\n' +
    '      SHA-256 receipt over the exact upstream bodies.\n' +
    '    intents:\n' +
    '    - NEWS_SEARCH_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: query\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - NEWS_SEARCH_GENERAL\n' +
    '          description: Topic, entity or event\n' +
    '\n' +
    '  - path: /v1/payment-method\n' +
    '    external_path: /v1/payment-method\n' +
    '    method: GET\n' +
    '    description: Verifies a card BIN (bank identification number, the first 6-8 digits of a card\n' +
    '      number) against a public BIN database. A recognized BIN is not a card validity or funds check.\n' +
    '    intents:\n' +
    '    - PAYMENT_METHOD_VERIFY_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: bin\n' +
    '          type: integer\n' +
    '          intents:\n' +
    '          - PAYMENT_METHOD_VERIFY_GENERAL\n' +
    '          description: Card number prefix (BIN, the first 6 to 8 digits); a job\'s params are public,\n' +
    '            so never a full card number\n' +
    '\n' +
    '  - path: /v1/route-eta\n' +
    '    external_path: /v1/route-eta\n' +
    '    method: GET\n' +
    '    description: Driving ETA between two coordinates from the public OSRM demo server, with a SHA-256\n' +
    '      receipt over the exact upstream response body.\n' +
    '    intents:\n' +
    '    - ROUTE_ETA_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: origin\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - ROUTE_ETA_GENERAL\n' +
    '          description: Start point\n' +
    '        - name: destination\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - ROUTE_ETA_GENERAL\n' +
    '          description: End point\n' +
    '\n' +
    '  - path: /v1/sanctions-screen\n' +
    '    external_path: /v1/sanctions-screen\n' +
    '    method: GET\n' +
    '    description: Screens a person or entity name against two keyless public sanctions lists, the OFAC\n' +
    '      SDN list with its published aliases and a second named list. A non-match is not clearance.\n' +
    '    intents:\n' +
    '    - SANCTIONS_SCREENING_MATCH_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: name\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - SANCTIONS_SCREENING_MATCH_GENERAL\n' +
    '          description: Person or entity name\n' +
    '\n' +
    '  - path: /v1/sla-compliance\n' +
    '    external_path: /v1/sla-compliance\n' +
    '    method: GET\n' +
    '    description: The delivered uptime for a named service over a period from its public status\n' +
    '      history. Where no machine-readable SLA target is published, sla_target_pct and compliant are\n' +
    '      null rather than guessed.\n' +
    '    intents:\n' +
    '    - SLA_COMPLIANCE_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: service\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - SLA_COMPLIANCE_GENERAL\n' +
    '          description: The service\n' +
    '        - name: period\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - SLA_COMPLIANCE_GENERAL\n' +
    '          description: Period to measure, e.g. last 30 days\n' +
    '\n' +
    '  - path: /v1/sports-score\n' +
    '    external_path: /v1/sports-score\n' +
    '    method: GET\n' +
    '    description: The score of a game from the official league scoreboards for the dates searched (NHL\n' +
    '      and MLB). A game not found on those scoreboards is refused, not approximated.\n' +
    '    intents:\n' +
    '    - SPORTS_SCORE_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: game\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - SPORTS_SCORE_GENERAL\n' +
    '          description: Teams or fixture\n' +
    '\n' +
    '  - path: /v1/stock-price\n' +
    '    external_path: /v1/stock-price\n' +
    '    method: GET\n' +
    '    description: The latest quote for a US-listed equity from the Yahoo Finance chart API, with a\n' +
    '      SHA-256 receipt over the exact upstream body.\n' +
    '    intents:\n' +
    '    - STOCK_PRICE_US_EQUITY\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: ticker\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - STOCK_PRICE_US_EQUITY\n' +
    '          description: Stock ticker, e.g. AAPL\n' +
    '\n' +
    '  - path: /v1/threat-indicator\n' +
    '    external_path: /v1/threat-indicator\n' +
    '    method: GET\n' +
    '    description: Whether an IP, domain, URL or file hash appears on the named keyless public\n' +
    '      threat-intelligence blocklists. Absence from those lists is not clearance.\n' +
    '    intents:\n' +
    '    - THREAT_INTELLIGENCE_INDICATOR\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: indicator\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - THREAT_INTELLIGENCE_INDICATOR\n' +
    '          description: IP address, domain, hash, CVE or actor\n' +
    '\n' +
    '  - path: /v1/token-holders\n' +
    '    external_path: /v1/token-holders\n' +
    '    method: GET\n' +
    '    description: The number of distinct addresses holding an ERC-20 token from a keyless public block\n' +
    '      indexer, with a SHA-256 receipt over the exact upstream body.\n' +
    '    intents:\n' +
    '    - TOKEN_HOLDER_COUNT_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: token\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - TOKEN_HOLDER_COUNT_GENERAL\n' +
    '          description: Token contract address or name\n' +
    '        - name: chain\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - TOKEN_HOLDER_COUNT_GENERAL\n' +
    '          description: Chain of the token\n' +
    '\n' +
    '  - path: /v1/transaction-risk\n' +
    '    external_path: /v1/transaction-risk\n' +
    '    method: GET\n' +
    '    description: A deterministic, fully-disclosed risk read of an ethereum mainnet transaction from\n' +
    '      named in-repo-verified sources. A low score is not a safety guarantee.\n' +
    '    intents:\n' +
    '    - TRANSACTION_RISK_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: transaction\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - TRANSACTION_RISK_GENERAL\n' +
    '          description: Transaction hash or details\n' +
    '\n' +
    '  - path: /v1/travel-disruption\n' +
    '    external_path: /v1/travel-disruption\n' +
    '    method: GET\n' +
    '    description: US airport-level disruption status from the FAA NAS status feed, with a SHA-256\n' +
    '      receipt over the exact upstream body.\n' +
    '    intents:\n' +
    '    - TRAVEL_DISRUPTION_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: route_or_flight\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - TRAVEL_DISRUPTION_GENERAL\n' +
    '          description: Flight, route or station\n' +
    '\n' +
    '  - path: /v1/url-safe\n' +
    '    external_path: /v1/url-safe\n' +
    '    method: GET\n' +
    '    description: Safety verdict for a URL from the named keyless public threat-intelligence\n' +
    '      blocklists. Absence from those lists is not clearance.\n' +
    '    intents:\n' +
    '    - URL_SAFE_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: url\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - URL_SAFE_GENERAL\n' +
    '          description: The URL\n' +
    '\n' +
    '  - path: /v1/url-scan\n' +
    '    external_path: /v1/url-scan\n' +
    '    method: GET\n' +
    '    description: Whether a URL is safe to visit, with no phishing or malware, per the named keyless\n' +
    '      blocklists screening the exact URL and its host. Absence from those lists is not clearance.\n' +
    '    intents:\n' +
    '    - URL_SCAN_VERDICT\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: url\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - URL_SCAN_VERDICT\n' +
    '          description: The URL\n' +
    '\n' +
    '  - path: /v1/vendor-verify\n' +
    '    external_path: /v1/vendor-verify\n' +
    '    method: GET\n' +
    '    description: Verifies an EU VAT registration number against the European Commission\'s VIES\n' +
    '      service. A valid VAT number is not proof of the vendor\'s identity.\n' +
    '    intents:\n' +
    '    - VENDOR_VERIFY_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: vendor\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - VENDOR_VERIFY_GENERAL\n' +
    '          description: Vendor or company\n' +
    '        - name: vat_number\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - VENDOR_VERIFY_GENERAL\n' +
    '          description: VAT or tax identifier\n' +
    '\n' +
    '  - path: /v1/vulnerability-triage\n' +
    '    external_path: /v1/vulnerability-triage\n' +
    '    method: GET\n' +
    '    description: "A deterministic triage read for a CVE from the published record: severity, vector and references, with a SHA-256 receipt."\n' +
    '    intents:\n' +
    '    - VULNERABILITY_TRIAGE_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: cve_id\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - VULNERABILITY_TRIAGE_GENERAL\n' +
    '          description: CVE identifier\n' +
    '\n' +
    '  - path: /v1/weather-forecast\n' +
    '    external_path: /v1/weather-forecast\n' +
    '    method: GET\n' +
    '    description: Forecast high and low temperature, peak precipitation probability and dominant\n' +
    '      condition for a place over a forward window from the Open-Meteo API, with a SHA-256 receipt.\n' +
    '    intents:\n' +
    '    - WEATHER_FORECAST_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: location\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - WEATHER_FORECAST_GENERAL\n' +
    '          description: City or place name\n' +
    '        optional:\n' +
    '        - name: window_hours\n' +
    '          type: integer\n' +
    '          intents:\n' +
    '          - WEATHER_FORECAST_GENERAL\n' +
    '          description: Forecast window\n' +
    '\n' +
    '  - path: /v1/crypto-price\n' +
    '    external_path: /v1/crypto-price\n' +
    '    method: GET\n' +
    '    description: Current USD spot price for one crypto symbol from the Coinbase public spot API,\n' +
    '      with a SHA-256 receipt. One named exchange\'s last spot quote, not an index or VWAP; symbols\n' +
    '      the source does not list are refused, never guessed.\n' +
    '    intents:\n' +
    '    - CRYPTO_PRICE_USD\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: symbol\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - CRYPTO_PRICE_USD\n' +
    '          description: Asset symbol, e.g. BTC\n' +
    '\n' +
    '  - path: /v1/mining-hashprice\n' +
    '    external_path: /v1/mining-hashprice\n' +
    '    method: GET\n' +
    '    description: Bitcoin hashprice at the current tip computed from measured inputs (mempool.space\n' +
    '      1-week hashrate and per-block fee series, deterministic subsidy, Coinbase spot), with a SHA-256\n' +
    '      receipt. A spot value from current measured series, never a forecast; a block_height other\n' +
    '      than the current tip is an honest refusal, not an interpolated answer.\n' +
    '    intents:\n' +
    '    - MINING_HASHPRICE_VERIFY_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        optional:\n' +
    '        - name: block_height\n' +
    '          type: integer\n' +
    '          intents:\n' +
    '          - MINING_HASHPRICE_VERIFY_GENERAL\n' +
    '          description: Bitcoin block height; only the current tip is served\n' +
    '\n' +
    '  - path: /v1/storm-alert\n' +
    '    external_path: /v1/storm-alert\n' +
    '    method: GET\n' +
    '    description: Storm risk for a US point over a forward window from issued NWS alert products only,\n' +
    '      with a SHA-256 receipt. The score is the worst severity among active issued products expiring\n' +
    '      inside the window; no forecast model output is scored, and peak gust and precipitation numerics\n' +
    '      are not carried by issued products. US coverage only.\n' +
    '    intents:\n' +
    '    - STORM_ALERT_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: location\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - STORM_ALERT_GENERAL\n' +
    '          description: Point as latitude,longitude (US coverage)\n' +
    '        optional:\n' +
    '        - name: window_hours\n' +
    '          type: integer\n' +
    '          intents:\n' +
    '          - STORM_ALERT_GENERAL\n' +
    '          description: Assessment window in hours, 1-240, default 24\n' +
    '\n' +
    '  - path: /v1/weather-check\n' +
    '    external_path: /v1/weather-check\n' +
    '    method: GET\n' +
    '    description: Measured air temperature for a place from the nearest NOAA aviationweather.gov METAR\n' +
    '      station, at most 90 minutes old, with a SHA-256 receipt. A measured station observation, not a\n' +
    '      forecast, reanalysis or city-wide value; the station binding is explicit in the evidence.\n' +
    '    intents:\n' +
    '    - WEATHER_CHECK_TEMPERATURE\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: location\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - WEATHER_CHECK_TEMPERATURE\n' +
    '          description: City or place name, or latitude,longitude\n' +
    '\n' +
    '  - path: /v1/onchain-metric\n' +
    '    external_path: /v1/onchain-metric\n' +
    '    method: GET\n' +
    '    description: \'Reads native balance and nonce for one EVM address at an explicit finalized block on ethereum,\n' +
    '      polygon or arbitrum. At least two configured public RPC sources must agree on chain identity, block hash,\n' +
    '      balance and nonce; the block hash is checked before and after reads. balance_gwei is Gwei (not ETH or POL),\n' +
    '      balance_wei is exact base units and tx_count is sent-transaction nonce, not received transfers. No pending,\n' +
    '      latest or unfinalized snapshot is served. Missing quorum is an honest refusal.\'\n' +
    '    intents:\n' +
    '    - ONCHAIN_METRIC_VERIFY_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: address\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - ONCHAIN_METRIC_VERIFY_GENERAL\n' +
    '          description: Explicit 0x-prefixed 20-byte EVM wallet address.\n' +
    '        - name: block\n' +
    '          type: integer\n' +
    '          intents:\n' +
    '          - ONCHAIN_METRIC_VERIFY_GENERAL\n' +
    '          description: Finalized block number from 0 to 1000000000000; no latest or pending tag.\n' +
    '        optional:\n' +
    '        - name: chain\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - ONCHAIN_METRIC_VERIFY_GENERAL\n' +
    '          description: \'ethereum (default), polygon or arbitrum.\'\n' +
    '        - name: metric\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - ONCHAIN_METRIC_VERIFY_GENERAL\n' +
    '          description: \'balance (default) or tx_count. Both are observed and returned for either selection.\'\n' +
    '\n' +
    '  - path: /v1/air-quality\n' +
    '    external_path: /v1/air-quality\n' +
    '    method: GET\n' +
    '    description: "Current Open-Meteo CAMS model-derived air quality estimate at the returned grid cell, not a ground-station measurement. The current estimate may be derived from model output. Discloses grid, source time and interval. Refuses stale, future, wrong-unit or mismatched-grid evidence. acceptable is a local threshold (US AQI at or below 100), not personal medical advice or an official clearance."\n' +
    '    intents:\n' +
    '    - AIR_QUALITY_INDEX_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: lat\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - AIR_QUALITY_INDEX_GENERAL\n' +
    '          description: "Explicit latitude in decimal degrees, from -90 to 90."\n' +
    '        - name: lon\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - AIR_QUALITY_INDEX_GENERAL\n' +
    '          description: "Explicit longitude in decimal degrees, from -180 to 180."\n' +
    '\n' +
    '  - path: /v1/api-health\n' +
    '    external_path: /v1/api-health\n' +
    '    method: GET\n' +
    '    description: "One measured public-target GET from this server vantage with DNS address pinned through connection and TLS hostname validation. Reports response-header latency and status, not JSON schema payload validation, historical uptime or global availability. Redirects are not followed. Private, reserved and ambiguous targets are refused; one check per target per minute."\n' +
    '    intents:\n' +
    '    - API_HEALTH_CHECK_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: url\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - API_HEALTH_CHECK_GENERAL\n' +
    '          description: "Public HTTP or HTTPS URL, no credentials; only ports 80 and 443."\n' +
    '\n' +
    '  - path: /v1/server-uptime\n' +
    '    external_path: /v1/server-uptime\n' +
    '    method: GET\n' +
    '    description: "Point-in-time public-host HTTP reachability from this server only, not an uptime percentage, historical measurement or multiple-edge observation. DNS address is pinned through connection, TLS hostname is checked and redirects are never followed. Private and reserved targets are refused; one check per target per minute."\n' +
    '    intents:\n' +
    '    - SERVER_UPTIME_MONITOR_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: host\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - SERVER_UPTIME_MONITOR_GENERAL\n' +
    '          description: "Public HTTP or HTTPS hostname or URL, no credentials; only ports 80 and 443."\n' +
    '\n' +
    '  - path: /v1/security-review\n' +
    '    external_path: /v1/security-review\n' +
    '    method: GET\n' +
    '    description: \'Exact npm release package@major.minor.patch known-advisory lookup using OSV. Supports optional\n' +
    '      npm: prefix and scoped npm names only. No source-code, contract, site or transitive-dependency audit.\n' +
    '      Positive active advisory coverage returns Needs changes with unique OSV record count and published\n' +
    '      severity ordering; aliases do not increase count. No active matches is an honest refusal, never Secure.\n' +
    '      Unsupported local version bounds use OSV query membership with explicit disclosure. Retains raw\n' +
    '      upstream evidence verbatim, source timestamp and a five-minute cache limit.\'\n' +
    '    intents:\n' +
    '    - SECURITY_REVIEW_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: target\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - SECURITY_REVIEW_GENERAL\n' +
    '          description: \'Exact npm package@major.minor.patch, for example semver@7.5.1. No ranges, tags, URLs or prereleases.\'\n' +
    '\n' +
    '  - path: /v1/weather-history\n' +
    '    external_path: /v1/weather-history\n' +
    '    method: GET\n' +
    '    description: \'Measured NOAA NCEI daily station archive only, for Cairo, London, New York JFK,\n' +
    '      Dubai or Frankfurt on an explicit past YYYY-MM-DD date. Coverage depends on published complete\n' +
    '      TMAX, TMIN and precipitation observations for the bound station. Missing or quality-failed days\n' +
    '      are refused, never replaced by zero, forecast or reanalysis. Reports a station-labelled climate\n' +
    '      day, not necessarily local midnight; weather condition is not inferred from daily extrema.\'\n' +
    '    intents:\n' +
    '    - WEATHER_FORECAST_VERIFY_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: location\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - WEATHER_FORECAST_VERIFY_GENERAL\n' +
    '          description: \'Cairo, London, New York JFK, Dubai or Frankfurt; exact bound station only.\'\n' +
    '        - name: date\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - WEATHER_FORECAST_VERIFY_GENERAL\n' +
    '          description: \'Explicit past YYYY-MM-DD calendar date, not today or a future date.\'\n' +
    '\n' +
    '  - path: /v1/return-policy\n' +
    '    external_path: /v1/return-policy\n' +
    '    method: GET\n' +
    '    description: \'Live official Apple US or Walmart US standard return policy only. Returns the standard\n' +
    '      window in days with current holiday and category exceptions disclosed in conditions. Not item or\n' +
    '      order eligibility. Exact reviewed policy section must match; changed, expired or unavailable\n' +
    '      policies are refused, never replaced by remembered or stale values. Interpretation reviewed\n' +
    '      through December 1, 2026 UTC. No country or retailer substitution.\'\n' +
    '    intents:\n' +
    '    - RETURN_POLICY_VERIFY_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: retailer\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - RETURN_POLICY_VERIFY_GENERAL\n' +
    '          description: \'Exact Apple US or Walmart US. Plain Apple and Walmart explicitly mean US only.\'\n' +
    '\n' +
    '  - path: /v1/game-result\n' +
    '    external_path: /v1/game-result\n' +
    '    method: GET\n' +
    '    description: \'Exact dated completed game with two named teams separated by vs, v or at.\n' +
    '      NFL, NBA, MLB and NHL ESPN scoreboards; MLB-only official final fallback if all\n' +
    '      primary sources fail fast. No latest-game substitution, no other sports, no\n' +
    '      ambiguous doubleheaders, no inferred scores. Source failures are errors, not zero scores.\'\n' +
    '    intents:\n' +
    '    - GAME_RESULT_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: game\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - GAME_RESULT_GENERAL\n' +
    '          description: \'Two competitor names and exact YYYY-MM-DD date, at most 200 characters.\'\n' +
    '\n' +
    '\n' +
    '  - path: /v1/yield\n' +
    '    external_path: /v1/yield\n' +
    '    method: GET\n' +
    '    description: \'Current on-chain Aave v3 supply APY for USDC, USDT, DAI or WETH on Ethereum only.\n' +
    '      Two RPC services must agree on exact safe-head block and reserve state. Safe-head is not\n' +
    '      finalized and reorganization remains possible. Observation must be within 15 minutes.\n' +
    '      Supply rate only, excluding rewards, incentives and token appreciation. No other protocols,\n' +
    '      assets or chains are substituted; unavailable or conflicting observations are refused.\'\n' +
    '    intents:\n' +
    '    - CRYPTO_YIELD_RATE_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '        - name: project\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - CRYPTO_YIELD_RATE_GENERAL\n' +
    '          description: \'Exact aave-v3, case-insensitive. No protocol substitution.\'\n' +
    '        - name: symbol\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - CRYPTO_YIELD_RATE_GENERAL\n' +
    '          description: \'USDC, USDT, DAI or WETH. Native ETH is not substituted for WETH.\'\n' +
    '        - name: chain\n' +
    '          type: string\n' +
    '          intents:\n' +
    '          - CRYPTO_YIELD_RATE_GENERAL\n' +
    '          description: \'Exact ethereum, case-insensitive. No chain substitution.\'\n' +
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
    '        unit: "gwei"\n' +
    '\n' +
    '  GAS_PRICE_GENERAL:\n' +
    '    endpoint: /v1/gas-price\n' +
    '    input:\n' +
    '      chain:\n' +
    '        from: chain\n' +
    '    output:\n' +
    '      chain:\n' +
    '        path: chain\n' +
    '      gas_price_gwei:\n' +
    '        path: gas_price_gwei\n' +
    '        unit: gwei\n' +
    '      transfer_fee_usd:\n' +
    '        path: transfer_fee_usd\n' +
    '        unit: USD\n' +
    '      as_of:\n' +
    '        path: as_of\n' +
    '  WALLET_BALANCE_CHECK_GENERAL:\n' +
    '    endpoint: /v1/balance\n' +
    '    input:\n' +
    '      address:\n' +
    '        from: address\n' +
    '      chain:\n' +
    '        from: chain\n' +
    '      token:\n' +
    '        from: token\n' +
    '    output:\n' +
    '      address:\n' +
    '        path: address\n' +
    '      chain:\n' +
    '        path: chain\n' +
    '      balance:\n' +
    '        path: balance\n' +
    '        unit: whole token units\n' +
    '      token_symbol:\n' +
    '        path: token_symbol\n' +
    '      as_of:\n' +
    '        path: as_of\n' +
    '  TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL:\n' +
    '    endpoint: /v1/token-supply\n' +
    '    input:\n' +
    '      token:\n' +
    '        from: token\n' +
    '        how: Preserve explicit contract, display label and chain context verbatim; do not silently discard\n' +
    '          a conflicting identity or assume a chain.\n' +
    '    output:\n' +
    '      total_supply:\n' +
    '        path: total_supply\n' +
    '        unit: whole tokens\n' +
    '  MACRO_ECONOMIC_INDICATOR_GENERAL:\n' +
    '    endpoint: /v1/macro\n' +
    '    input:\n' +
    '      indicator:\n' +
    '        from: indicator\n' +
    '      country:\n' +
    '        from: country\n' +
    '      year:\n' +
    '        from: year\n' +
    '    output:\n' +
    '      rate_pct:\n' +
    '        path: rate_pct\n' +
    '        unit: percent\n' +
    '  DNS_RECORD_LOOKUP_GENERAL:\n' +
    '    endpoint: /v1/dns\n' +
    '    input:\n' +
    '      name:\n' +
    '        from: name\n' +
    '      record_type:\n' +
    '        from: record_type\n' +
    '    output:\n' +
    '      has_record:\n' +
    '        path: has_record\n' +
    '  CURRENCY_EXCHANGE_CONVERT:\n' +
    '    endpoint: /v1/fx\n' +
    '    input:\n' +
    '      from_currency:\n' +
    '        from: from_currency\n' +
    '      to_currency:\n' +
    '        from: to_currency\n' +
    '      amount:\n' +
    '        from: amount\n' +
    '    output:\n' +
    '      converted_amount:\n' +
    '        path: converted_amount\n' +
    '  SSL_VERIFICATION_CERT:\n' +
    '    endpoint: /v1/ssl\n' +
    '    input:\n' +
    '      host:\n' +
    '        from: host\n' +
    '    output:\n' +
    '      certificate_valid:\n' +
    '        path: certificate_valid\n' +
    '  EMAIL_SECURITY_GENERAL:\n' +
    '    endpoint: /v1/email-security\n' +
    '    input:\n' +
    '      domain:\n' +
    '        from: domain\n' +
    '      record_type:\n' +
    '        from: record_type\n' +
    '    output:\n' +
    '      lookup_ok:\n' +
    '        path: lookup_ok\n' +
    '  ACADEMIC_SEARCH_GENERAL:\n' +
    '    endpoint: /v1/academic-search\n' +
    '    input:\n' +
    '      query:\n' +
    '        from: query\n' +
    '    output:\n' +
    '      answer:\n' +
    '        path: answer\n' +
    '      paper_titles:\n' +
    '        path: paper_titles\n' +
    '      dois:\n' +
    '        path: dois\n' +
    '      total_matches:\n' +
    '        path: total_matches\n' +
    '\n' +
    '  ASSET_RESERVE_ATTESTATION_GENERAL:\n' +
    '    endpoint: /v1/reserve-attestation\n' +
    '    input:\n' +
    '      asset:\n' +
    '        from: asset\n' +
    '    output:\n' +
    '      attested_reserve:\n' +
    '        path: attested_reserve\n' +
    '        unit: "micro-units of the underlying asset"\n' +
    '      asset:\n' +
    '        path: asset\n' +
    '      block:\n' +
    '        path: block\n' +
    '      source:\n' +
    '        path: source\n' +
    '\n' +
    '  CODE_PATCH_VERIFY_GENERAL:\n' +
    '    endpoint: /v1/code-patch\n' +
    '    input:\n' +
    '      patch:\n' +
    '        from: patch\n' +
    '    output:\n' +
    '      passed:\n' +
    '        path: passed\n' +
    '      commit:\n' +
    '        path: commit\n' +
    '      pipeline:\n' +
    '        path: pipeline\n' +
    '\n' +
    '  CORPORATE_REGISTRY_LOOKUP_GENERAL:\n' +
    '    endpoint: /v1/corporate-registry\n' +
    '    input:\n' +
    '      company:\n' +
    '        from: company\n' +
    '      jurisdiction:\n' +
    '        from: jurisdiction\n' +
    '    output:\n' +
    '      legal_name:\n' +
    '        path: legal_name\n' +
    '      registration_id:\n' +
    '        path: registration_id\n' +
    '      active:\n' +
    '        path: active\n' +
    '      jurisdiction:\n' +
    '        path: jurisdiction\n' +
    '      registered_address:\n' +
    '        path: registered_address\n' +
    '      incorporated:\n' +
    '        path: incorporated\n' +
    '\n' +
    '  CROSS_CHAIN_STATE_VERIFY_GENERAL:\n' +
    '    endpoint: /v1/cross-chain-state\n' +
    '    input:\n' +
    '      reference:\n' +
    '        from: reference\n' +
    '      chains:\n' +
    '        from: chains\n' +
    '    output:\n' +
    '      address:\n' +
    '        path: address\n' +
    '      status:\n' +
    '        path: status\n' +
    '      chains:\n' +
    '        path: chains\n' +
    '      consistent:\n' +
    '        path: consistent\n' +
    '      summary:\n' +
    '        path: summary\n' +
    '\n' +
    '  CVE_LOOKUP_CVSS:\n' +
    '    endpoint: /v1/cve\n' +
    '    input:\n' +
    '      cve_id:\n' +
    '        from: cve_id\n' +
    '    output:\n' +
    '      cve_id:\n' +
    '        path: cve_id\n' +
    '      cvss_score:\n' +
    '        path: cvss_score\n' +
    '        unit: "CVSS score (0-10)"\n' +
    '      description:\n' +
    '        path: description\n' +
    '      published:\n' +
    '        path: published\n' +
    '      references:\n' +
    '        path: references\n' +
    '\n' +
    '  EVENT_OUTCOME_RESOLUTION_GENERAL:\n' +
    '    endpoint: /v1/event-outcome\n' +
    '    input:\n' +
    '      event:\n' +
    '        from: event\n' +
    '    output:\n' +
    '      event:\n' +
    '        path: event\n' +
    '      resolved_yes:\n' +
    '        path: resolved_yes\n' +
    '      winner:\n' +
    '        path: winner\n' +
    '      resolved_at:\n' +
    '        path: resolved_at\n' +
    '      sources:\n' +
    '        path: sources\n' +
    '\n' +
    '  FINANCIAL_DATA_GENERAL:\n' +
    '    endpoint: /v1/financial-data\n' +
    '    input:\n' +
    '      asset:\n' +
    '        from: asset\n' +
    '    output:\n' +
    '      asset:\n' +
    '        path: asset\n' +
    '      market_cap_usd:\n' +
    '        path: market_cap_usd\n' +
    '        unit: "USD"\n' +
    '      volume_24h_usd:\n' +
    '        path: volume_24h_usd\n' +
    '        unit: "USD"\n' +
    '      metrics:\n' +
    '        path: metrics\n' +
    '      as_of:\n' +
    '        path: as_of\n' +
    '\n' +
    '  FX_NOW_CAD:\n' +
    '    endpoint: /v1/fx-now\n' +
    '    input:\n' +
    '      currency:\n' +
    '        from: currency\n' +
    '    output:\n' +
    '      rate:\n' +
    '        path: rate\n' +
    '        unit: "{key} per USD"\n' +
    '\n' +
    '  FX_NOW_EUR:\n' +
    '    endpoint: /v1/fx-now\n' +
    '    input:\n' +
    '      currency:\n' +
    '        from: currency\n' +
    '    output:\n' +
    '      rate:\n' +
    '        path: rate\n' +
    '        unit: "{key} per USD"\n' +
    '\n' +
    '  FX_NOW_SEK:\n' +
    '    endpoint: /v1/fx-now\n' +
    '    input:\n' +
    '      currency:\n' +
    '        from: currency\n' +
    '    output:\n' +
    '      rate:\n' +
    '        path: rate\n' +
    '        unit: "{key} per USD"\n' +
    '\n' +
    '  IP_GEOLOCATION_GENERAL:\n' +
    '    endpoint: /v1/ip-geolocation\n' +
    '    input:\n' +
    '      ip:\n' +
    '        from: ip\n' +
    '    output:\n' +
    '      ip:\n' +
    '        path: ip\n' +
    '      country:\n' +
    '        path: country\n' +
    '      city:\n' +
    '        path: city\n' +
    '      latitude:\n' +
    '        path: latitude\n' +
    '        unit: "degrees"\n' +
    '      longitude:\n' +
    '        path: longitude\n' +
    '        unit: "degrees"\n' +
    '      isp:\n' +
    '        path: isp\n' +
    '\n' +
    '  LIQUIDITY_DEPTH_VERIFY_GENERAL:\n' +
    '    endpoint: /v1/liquidity\n' +
    '    input:\n' +
    '      pool:\n' +
    '        from: pool\n' +
    '      chain:\n' +
    '        from: chain\n' +
    '    output:\n' +
    '      liquidity_usd:\n' +
    '        path: liquidity_usd\n' +
    '        unit: "USD"\n' +
    '\n' +
    '  MALWARE_DETECTION_HASH:\n' +
    '    endpoint: /v1/malware-hash\n' +
    '    input:\n' +
    '      indicator:\n' +
    '        from: indicator\n' +
    '    output:\n' +
    '      malicious:\n' +
    '        path: malicious\n' +
    '\n' +
    '  NEWS_HEADLINES_GENERAL:\n' +
    '    endpoint: /v1/news-headlines\n' +
    '    input:\n' +
    '      topic:\n' +
    '        from: topic\n' +
    '    output:\n' +
    '      topic:\n' +
    '        path: topic\n' +
    '      headlines:\n' +
    '        path: headlines\n' +
    '      urls:\n' +
    '        path: urls\n' +
    '      window:\n' +
    '        path: window\n' +
    '      top_headline:\n' +
    '        path: top_headline\n' +
    '\n' +
    '  NEWS_SEARCH_GENERAL:\n' +
    '    endpoint: /v1/news-search\n' +
    '    input:\n' +
    '      query:\n' +
    '        from: query\n' +
    '    output:\n' +
    '      answer:\n' +
    '        path: answer\n' +
    '      result_count:\n' +
    '        path: result_count\n' +
    '      sources:\n' +
    '        path: sources\n' +
    '\n' +
    '  PAYMENT_METHOD_VERIFY_GENERAL:\n' +
    '    endpoint: /v1/payment-method\n' +
    '    input:\n' +
    '      bin:\n' +
    '        from: bin\n' +
    '    output:\n' +
    '      network:\n' +
    '        path: network\n' +
    '      issuing_bank:\n' +
    '        path: issuing_bank\n' +
    '      issuing_country:\n' +
    '        path: issuing_country\n' +
    '      valid:\n' +
    '        path: valid\n' +
    '      card_type:\n' +
    '        path: card_type\n' +
    '\n' +
    '  ROUTE_ETA_GENERAL:\n' +
    '    endpoint: /v1/route-eta\n' +
    '    input:\n' +
    '      origin:\n' +
    '        from: origin\n' +
    '      destination:\n' +
    '        from: destination\n' +
    '    output:\n' +
    '      duration:\n' +
    '        path: duration\n' +
    '        unit: "seconds"\n' +
    '\n' +
    '  SANCTIONS_SCREENING_MATCH_GENERAL:\n' +
    '    endpoint: /v1/sanctions-screen\n' +
    '    input:\n' +
    '      name:\n' +
    '        from: name\n' +
    '    output:\n' +
    '      name:\n' +
    '        path: name\n' +
    '      matched:\n' +
    '        path: matched\n' +
    '      matches:\n' +
    '        path: matches\n' +
    '      lists:\n' +
    '        path: lists\n' +
    '      match_score:\n' +
    '        path: match_score\n' +
    '        unit: "fraction (0-1)"\n' +
    '\n' +
    '  SLA_COMPLIANCE_GENERAL:\n' +
    '    endpoint: /v1/sla-compliance\n' +
    '    input:\n' +
    '      service:\n' +
    '        from: service\n' +
    '      period:\n' +
    '        from: period\n' +
    '    output:\n' +
    '      service:\n' +
    '        path: service\n' +
    '      uptime_pct:\n' +
    '        path: uptime_pct\n' +
    '        unit: "percent"\n' +
    '      sla_target_pct:\n' +
    '        path: sla_target_pct\n' +
    '        unit: "percent"\n' +
    '      compliant:\n' +
    '        path: compliant\n' +
    '      period:\n' +
    '        path: period\n' +
    '\n' +
    '  SPORTS_SCORE_GENERAL:\n' +
    '    endpoint: /v1/sports-score\n' +
    '    input:\n' +
    '      game:\n' +
    '        from: game\n' +
    '    output:\n' +
    '      home_team:\n' +
    '        path: home_team\n' +
    '      away_team:\n' +
    '        path: away_team\n' +
    '      home_score:\n' +
    '        path: home_score\n' +
    '        unit: "points"\n' +
    '      away_score:\n' +
    '        path: away_score\n' +
    '        unit: "points"\n' +
    '      status:\n' +
    '        path: status\n' +
    '      date:\n' +
    '        path: date\n' +
    '\n' +
    '  STOCK_PRICE_US_EQUITY:\n' +
    '    endpoint: /v1/stock-price\n' +
    '    input:\n' +
    '      ticker:\n' +
    '        from: ticker\n' +
    '    output:\n' +
    '      price_usd:\n' +
    '        path: price_usd\n' +
    '        unit: "US dollars"\n' +
    '\n' +
    '  THREAT_INTELLIGENCE_INDICATOR:\n' +
    '    endpoint: /v1/threat-indicator\n' +
    '    input:\n' +
    '      indicator:\n' +
    '        from: indicator\n' +
    '    output:\n' +
    '      malicious:\n' +
    '        path: malicious\n' +
    '\n' +
    '  TOKEN_HOLDER_COUNT_GENERAL:\n' +
    '    endpoint: /v1/token-holders\n' +
    '    input:\n' +
    '      token:\n' +
    '        from: token\n' +
    '      chain:\n' +
    '        from: chain\n' +
    '    output:\n' +
    '      token:\n' +
    '        path: token\n' +
    '      chain:\n' +
    '        path: chain\n' +
    '      holders_count:\n' +
    '        path: holders_count\n' +
    '        unit: "addresses"\n' +
    '      token_symbol:\n' +
    '        path: token_symbol\n' +
    '\n' +
    '  TRANSACTION_RISK_GENERAL:\n' +
    '    endpoint: /v1/transaction-risk\n' +
    '    input:\n' +
    '      transaction:\n' +
    '        from: transaction\n' +
    '    output:\n' +
    '      risk_score:\n' +
    '        path: risk_score\n' +
    '        unit: "fraction (0-1)"\n' +
    '      signals:\n' +
    '        path: signals\n' +
    '      summary:\n' +
    '        path: summary\n' +
    '\n' +
    '  TRAVEL_DISRUPTION_GENERAL:\n' +
    '    endpoint: /v1/travel-disruption\n' +
    '    input:\n' +
    '      route_or_flight:\n' +
    '        from: route_or_flight\n' +
    '    output:\n' +
    '      route_or_flight:\n' +
    '        path: route_or_flight\n' +
    '      disrupted:\n' +
    '        path: disrupted\n' +
    '      status:\n' +
    '        path: status\n' +
    '      delay_minutes:\n' +
    '        path: delay_minutes\n' +
    '        unit: "minutes"\n' +
    '      reason:\n' +
    '        path: reason\n' +
    '\n' +
    '  URL_SAFE_GENERAL:\n' +
    '    endpoint: /v1/url-safe\n' +
    '    input:\n' +
    '      url:\n' +
    '        from: url\n' +
    '    output:\n' +
    '      url:\n' +
    '        path: url\n' +
    '      verdict:\n' +
    '        path: url_check.verdict\n' +
    '      detections:\n' +
    '        path: detections\n' +
    '        unit: "detections"\n' +
    '      summary:\n' +
    '        path: summary\n' +
    '\n' +
    '  URL_SCAN_VERDICT:\n' +
    '    endpoint: /v1/url-scan\n' +
    '    input:\n' +
    '      url:\n' +
    '        from: url\n' +
    '    output:\n' +
    '      safe:\n' +
    '        path: safe\n' +
    '\n' +
    '  VENDOR_VERIFY_GENERAL:\n' +
    '    endpoint: /v1/vendor-verify\n' +
    '    input:\n' +
    '      vendor:\n' +
    '        from: vendor\n' +
    '      vat_number:\n' +
    '        from: vat_number\n' +
    '    output:\n' +
    '      vendor:\n' +
    '        path: vendor\n' +
    '      vat_number:\n' +
    '        path: vat_number\n' +
    '      valid:\n' +
    '        path: valid\n' +
    '      registered_name:\n' +
    '        path: registered_name\n' +
    '      registered_address:\n' +
    '        path: registered_address\n' +
    '\n' +
    '  VULNERABILITY_TRIAGE_GENERAL:\n' +
    '    endpoint: /v1/vulnerability-triage\n' +
    '    input:\n' +
    '      cve_id:\n' +
    '        from: cve_id\n' +
    '    output:\n' +
    '      cvss_base_score:\n' +
    '        path: cvss_base_score\n' +
    '        unit: "CVSS score (0-10)"\n' +
    '\n' +
    '  WEATHER_FORECAST_GENERAL:\n' +
    '    endpoint: /v1/weather-forecast\n' +
    '    input:\n' +
    '      location:\n' +
    '        from: location\n' +
    '      window_hours:\n' +
    '        from: window_hours\n' +
    '    output:\n' +
    '      location:\n' +
    '        path: location\n' +
    '      when:\n' +
    '        path: when\n' +
    '      temp_max_c:\n' +
    '        path: temp_max_c\n' +
    '        unit: "degrees Celsius"\n' +
    '      temp_min_c:\n' +
    '        path: temp_min_c\n' +
    '        unit: "degrees Celsius"\n' +
    '      precipitation_probability_pct:\n' +
    '        path: precipitation_probability_pct\n' +
    '        unit: "percent"\n' +
    '      condition:\n' +
    '        path: condition\n' +
    '\n' +
    '  CRYPTO_PRICE_USD:\n' +
    '    endpoint: /v1/crypto-price\n' +
    '    input:\n' +
    '      symbol:\n' +
    '        from: symbol\n' +
    '        how: "The asset symbol as asked (BTC, ETH, SOL), uppercase, without a currency pair suffix."\n' +
    '    output:\n' +
    '      price_usd:\n' +
    '        path: price_usd\n' +
    '        unit: "US dollars"\n' +
    '\n' +
    '  MINING_HASHPRICE_VERIFY_GENERAL:\n' +
    '    endpoint: /v1/mining-hashprice\n' +
    '    input:\n' +
    '      block_height:\n' +
    '        from: block_height\n' +
    '        how: "The requested Bitcoin block height. Leave empty when no height is named; only the current tip is served."\n' +
    '    output:\n' +
    '      hashprice_sats_per_ph_day:\n' +
    '        path: hashprice_sats_per_ph_day\n' +
    '        unit: "sats per PH/s per day"\n' +
    '      block_height:\n' +
    '        path: block_height\n' +
    '        unit: "block height"\n' +
    '      hashrate_eh_s:\n' +
    '        path: hashrate_eh_s\n' +
    '        unit: "EH/s"\n' +
    '      hashprice_usd_per_ph_day:\n' +
    '        path: hashprice_usd_per_ph_day\n' +
    '        unit: "USD per PH/s per day"\n' +
    '\n' +
    '  STORM_ALERT_GENERAL:\n' +
    '    endpoint: /v1/storm-alert\n' +
    '    input:\n' +
    '      location:\n' +
    '        from: location\n' +
    '        how: "The place as latitude,longitude. US coverage only (NWS alert products)."\n' +
    '      window_hours:\n' +
    '        from: window_hours\n' +
    '        how: "The assessment window in hours when named (next 24 hours, this weekend); otherwise leave empty for the 24-hour default."\n' +
    '    output:\n' +
    '      location:\n' +
    '        path: location\n' +
    '      risk_score:\n' +
    '        path: risk_score\n' +
    '        unit: "fraction (0-1)"\n' +
    '      risk_level:\n' +
    '        path: risk_level\n' +
    '      peak_gust_kmh:\n' +
    '        path: peak_gust_kmh\n' +
    '        unit: "km/h"\n' +
    '      precipitation_mm:\n' +
    '        path: precipitation_mm\n' +
    '        unit: "mm"\n' +
    '      window:\n' +
    '        path: window\n' +
    '\n' +
    '  WEATHER_CHECK_TEMPERATURE:\n' +
    '    endpoint: /v1/weather-check\n' +
    '    input:\n' +
    '      location:\n' +
    '        from: location\n' +
    '        how: "The city or place name as asked, or latitude,longitude when given as coordinates."\n' +
    '    output:\n' +
    '      temperature_c:\n' +
    '        path: temperature_c\n' +
    '        unit: "degrees Celsius"\n' +
    '\n' +
    '  ONCHAIN_METRIC_VERIFY_GENERAL:\n' +
    '    endpoint: /v1/onchain-metric\n' +
    '    input:\n' +
    '      address:\n' +
    '        from: address\n' +
    '      block:\n' +
    '        from: block\n' +
    '      chain:\n' +
    '        from: chain\n' +
    '      metric:\n' +
    '        from: metric\n' +
    '    output:\n' +
    '      balance_gwei:\n' +
    '        path: balance_gwei\n' +
    '        unit: "Gwei"\n' +
    '      address:\n' +
    '        path: address\n' +
    '      block:\n' +
    '        path: block\n' +
    '      chain:\n' +
    '        path: chain\n' +
    '      tx_count:\n' +
    '        path: tx_count\n' +
    '\n' +
    '  AIR_QUALITY_INDEX_GENERAL:\n' +
    '    endpoint: /v1/air-quality\n' +
    '    input:\n' +
    '      lat:\n' +
    '        from: lat\n' +
    '      lon:\n' +
    '        from: lon\n' +
    '    output:\n' +
    '      aqi:\n' +
    '        path: aqi\n' +
    '      aqi_scale:\n' +
    '        path: aqi_scale\n' +
    '      acceptable:\n' +
    '        path: acceptable\n' +
    '      european_aqi:\n' +
    '        path: european_aqi\n' +
    '      pm2_5_ugm3:\n' +
    '        path: pm2_5_ugm3\n' +
    '        unit: "micrograms per cubic metre"\n' +
    '      pm10_ugm3:\n' +
    '        path: pm10_ugm3\n' +
    '        unit: "micrograms per cubic metre"\n' +
    '      nitrogen_dioxide_ugm3:\n' +
    '        path: nitrogen_dioxide_ugm3\n' +
    '        unit: "micrograms per cubic metre"\n' +
    '      ozone_ugm3:\n' +
    '        path: ozone_ugm3\n' +
    '        unit: "micrograms per cubic metre"\n' +
    '      carbon_monoxide_ugm3:\n' +
    '        path: carbon_monoxide_ugm3\n' +
    '        unit: "micrograms per cubic metre"\n' +
    '      latitude:\n' +
    '        path: latitude\n' +
    '        unit: "degrees"\n' +
    '      longitude:\n' +
    '        path: longitude\n' +
    '        unit: "degrees"\n' +
    '      upstream_hour:\n' +
    '        path: upstream_hour\n' +
    '\n' +
    '  API_HEALTH_CHECK_GENERAL:\n' +
    '    endpoint: /v1/api-health\n' +
    '    input:\n' +
    '      url:\n' +
    '        from: url\n' +
    '    output:\n' +
    '      url:\n' +
    '        path: url\n' +
    '      healthy:\n' +
    '        path: healthy\n' +
    '      reachable:\n' +
    '        path: reachable\n' +
    '      http_status:\n' +
    '        path: http_status\n' +
    '      latency_ms:\n' +
    '        path: latency_ms\n' +
    '        unit: "milliseconds"\n' +
    '\n' +
    '  SERVER_UPTIME_MONITOR_GENERAL:\n' +
    '    endpoint: /v1/server-uptime\n' +
    '    input:\n' +
    '      host:\n' +
    '        from: host\n' +
    '    output:\n' +
    '      host:\n' +
    '        path: host\n' +
    '      reachable_now:\n' +
    '        path: reachable_now\n' +
    '      http_status:\n' +
    '        path: http_status\n' +
    '      latency_ms:\n' +
    '        path: latency_ms\n' +
    '        unit: "milliseconds"\n' +
    '\n' +
    '  SECURITY_REVIEW_GENERAL:\n' +
    '    endpoint: /v1/security-review\n' +
    '    input:\n' +
    '      target:\n' +
    '        from: target\n' +
    '    output:\n' +
    '      verdict:\n' +
    '        path: verdict\n' +
    '      vulnerability_count:\n' +
    '        path: vulnerability_count\n' +
    '        unit: "vulnerabilities"\n' +
    '      issues:\n' +
    '        path: issues\n' +
    '      summary:\n' +
    '        path: summary\n' +
    '\n' +
    '  WEATHER_FORECAST_VERIFY_GENERAL:\n' +
    '    endpoint: /v1/weather-history\n' +
    '    input:\n' +
    '      location:\n' +
    '        from: location\n' +
    '      date:\n' +
    '        from: date\n' +
    '    output:\n' +
    '      location:\n' +
    '        path: location\n' +
    '      date:\n' +
    '        path: date\n' +
    '      temp_max_c:\n' +
    '        path: temp_max_c\n' +
    '        unit: "degrees Celsius"\n' +
    '      temp_min_c:\n' +
    '        path: temp_min_c\n' +
    '        unit: "degrees Celsius"\n' +
    '      precipitation_mm:\n' +
    '        path: precipitation_mm\n' +
    '        unit: "mm"\n' +
    '      condition:\n' +
    '        path: condition\n' +
    '\n' +
    '  RETURN_POLICY_VERIFY_GENERAL:\n' +
    '    endpoint: /v1/return-policy\n' +
    '    input:\n' +
    '      retailer:\n' +
    '        from: retailer\n' +
    '    output:\n' +
    '      retailer:\n' +
    '        path: retailer\n' +
    '      return_window_days:\n' +
    '        path: return_window_days\n' +
    '        unit: "days"\n' +
    '      conditions:\n' +
    '        path: conditions\n' +
    '      verified:\n' +
    '        path: verified\n' +
    '      sources:\n' +
    '        path: sources\n' +
    '\n' +
    '  GAME_RESULT_GENERAL:\n' +
    '    endpoint: /v1/game-result\n' +
    '    input:\n' +
    '      game:\n' +
    '        from: game\n' +
    '    output:\n' +
    '      winner:\n' +
    '        path: winner\n' +
    '      home_team:\n' +
    '        path: home_team\n' +
    '      away_team:\n' +
    '        path: away_team\n' +
    '      home_score:\n' +
    '        path: home_score\n' +
    '        unit: "points"\n' +
    '      away_score:\n' +
    '        path: away_score\n' +
    '        unit: "points"\n' +
    '      date:\n' +
    '        path: date\n' +
    '\n' +
    '  CRYPTO_YIELD_RATE_GENERAL:\n' +
    '    endpoint: /v1/yield\n' +
    '    input:\n' +
    '      project:\n' +
    '        from: project\n' +
    '      symbol:\n' +
    '        from: symbol\n' +
    '      chain:\n' +
    '        from: chain\n' +
    '    output:\n' +
    '      supply_apy:\n' +
    '        path: supply_apy\n' +
    '        unit: "basis points"\n',

  cast: REGISTRATION_CAST_SNIPPET,
};
