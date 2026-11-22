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
    'description: \'Zero-LLM deterministic provider with a SHA-256 receipt on every answer (raw_response_sha256:\n' +
    '  64 lowercase hex characters, no 0x prefix, over the exact evidence bytes served at /receipts/{receipt_id}/raw):\n' +
    '  seven named EVM transaction chains, SEC EDGAR filing counts by company, exact form and inclusive filing-date\n' +
    '  period, DeFiLlama protocol or chain TVL, a canonical fixed-size Ethereum mainnet ETH/USDC execution quote,\n' +
    '  supported CAISO/NYISO/Elering grid prices, and finalized-root Ethereum validator effective balances. Unsupported,\n' +
    '  ambiguous or unavailable evidence is refused rather than guessed. Additional receipt-backed endpoints provide\n' +
    '  named-chain gas and balances, explicit-chain ERC20 supply, World Bank unemployment, DNS record observations,\n' +
    '  dated currency conversion, TLS certificate validity and DNS response status. Declared source, scope and\n' +
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
    '          description: \'An inclusive filing-date period: last N months, a calendar year, an explicit calendar\n' +
    '            Q1/Q2/Q3/Q4 with year, a valid quarter ending YYYY-MM-DD (March 31, June 30, September 30 or December\n' +
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
    '        path: lookup_ok\n',
  cast: REGISTRATION_CAST_SNIPPET,
};
