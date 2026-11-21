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
// - escrow / mcp tabs are display-only reference text (not executed code);
//   the Diamond address matches render.yaml; the $2.00 daily cap matches
//   DESK_DAILY_SPEND_CAP_USD in render.yaml.

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

export const DOC_SNIPPETS: Record<DocTabId, string> = {
  curl:
    "# 1. Direct Miner Probe (Zero Auth — Verifiable SHA-256 Receipt)\n" +
    "# Endpoints are GET (see miner.yaml). No API key, no wallet.\n" +
    `curl -s "https://verireceipt.onrender.com/v1/tx?tx_hash=${CONFIRMED_TX}&chain=ethereum"\n\n` +
    '# 2. TVL, filings, route, grid — same GET pattern\n' +
    'curl -s "https://verireceipt.onrender.com/v1/tvl?protocol=aave-v3"\n' +
    'curl -s "https://verireceipt.onrender.com/v1/filings?entity=AAPL&period=last%2012%20months"\n' +
    'curl -s "https://verireceipt.onrender.com/v1/route?pair=ETH%2FUSDC"\n' +
    'curl -s "https://verireceipt.onrender.com/v1/grid-price?node_or_zone=TH_NP15_GEN-APND&interval_start=2026-11-20T05:00:00.000Z"\n\n' +
    "# 3. Ranked Telegraph Engine Ask (Returns 402 Escrow Challenge -> Sign X-PAYMENT)\n" +
    "curl -i -X POST https://devnode.telegraphprotocol.com/engine/v1/ask \\\n" +
    '  -H "Content-Type: application/json" \\\n' +
    `  -d '{"intent":"TVL_LOOKUP_GENERAL","input":{"protocol":"aave-v3"},"max_budget_usdc":10000}'\n\n` +
    "# 4. Recompute a Receipt SHA-256 Independently in 30 Seconds\n" +
    "#    Take receipt.upstream_url from any response, fetch it, hash it:\n" +
    'curl -s "https://api.llama.fi/protocol/aave-v3" | sha256sum\n' +
    "#    Compare with receipt.raw_response_sha256 in the same response.",

  escrow:
    "// EIP-191 Escrow Primary Rail (X-PAYMENT) + pLimit(1) x402 Fallback\n" +
    "// Display-only reference — this snippet is not executed by the dashboard.\n" +
    'import { privateKeyToAccount } from "viem/accounts";\n\n' +
    'const DIAMOND = "0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b";\n' +
    'const NODE = "https://devnode.telegraphprotocol.com";\n\n' +
    "export async function askRankedEscrow(intent: string, input: Record<string, unknown>) {\n" +
    "  const account = privateKeyToAccount(process.env.DESK_KEY as `0x${string}`);\n" +
    '  const body = JSON.stringify({ intent, input, max_budget_usdc: 40000 });\n\n' +
    "  // Step 1: Fetch 402 escrow challenge template\n" +
    "  const challenge = await fetch(`${NODE}/engine/v1/ask`, {\n" +
    '    method: "POST", headers: { "Content-Type": "application/json" }, body\n' +
    "  }).then(r => r.json());\n\n" +
    '  const esc = challenge.accepts.find((a: any) => a.scheme === "escrow");\n' +
    "  const from = account.address.toLowerCase(); // MUST be lowercase\n" +
    "  const signature = await account.signMessage({ message: esc.extra.message });\n\n" +
    "  // Step 2: Retry with X-PAYMENT (never PAYMENT-SIGNATURE for escrow)\n" +
    "  const headerVal = Buffer.from(JSON.stringify({\n" +
    '    scheme: "escrow", from, to: DIAMOND, amount: esc.maxAmountRequired, signature\n' +
    '  })).toString("base64");\n\n' +
    "  return fetch(`${NODE}/engine/v1/ask`, {\n" +
    '    method: "POST",\n' +
    '    headers: { "Content-Type": "application/json", "X-PAYMENT": headerVal },\n' +
    "    body\n" +
    "  });\n" +
    "}",

  mcp:
    "// Claude Desktop / Cursor MCP Configuration (Zero-Wallet Streamable HTTP)\n" +
    "{\n" +
    '  "mcpServers": {\n' +
    '    "verireceipt-desk": {\n' +
    '      "url": "https://verireceipt.onrender.com/api/mcp"\n' +
    "    },\n" +
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
    '  Zero-LLM, cryptographically receipted deterministic provider for on-chain\n' +
    '  transactions, SEC EDGAR filings, DeFi TVL, block-pinned ETH/USDC\n' +
    '  execution routing, and wholesale grid power prices. Every answer includes a\n' +
    '  verifiable source hash and fails closed rather than guessing.\n' +
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
    '  website: https://verireceipt.onrender.com\n' +
    '  documentation: https://verireceipt.onrender.com/docs\n' +
    '  repository: https://github.com/mohamedwael201193/verireceipt\n' +
    '\n' +
    'limitations:\n' +
    '  - code: MAX_PARAM_SIZE\n' +
    '    message: Input parameter length must not exceed 512 characters.\n' +
    '    param: entity\n' +
    '    property: length\n' +
    '    value_num: 512\n' +
    '    operator: lte\n' +
    '\n' +
    'semantics:\n' +
    '  supported_intents:\n' +
    '    - ONCHAIN_TX_LOOKUP_GENERAL\n' +
    '    - REGULATORY_FILING_MONITOR_GENERAL\n' +
    '    - TVL_LOOKUP_GENERAL\n' +
    '    - OPTIMAL_EXECUTION_ROUTE_GENERAL\n' +
    '    - GRID_POWER_PRICE_GENERAL\n' +
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
    '      Looks up an EVM transaction hash on a specified chain using a 2-of-N\n' +
    '      archive-RPC quorum (N = configured RPCs per chain), including the\n' +
    '      OP-stack L1 data fee, and returns exact tx_hash, status, from, to,\n' +
    '      block_number, value_eth, and a SHA-256 receipt.\n' +
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
    '            description: EVM chain name (ethereum, base, arbitrum, optimism, polygon, sepolia, base-sepolia).\n' +
    '\n' +
    '  - path: /v1/filings\n' +
    '    external_path: /v1/filings\n' +
    '    method: GET\n' +
    '    description: >-\n' +
    '      Counts a company\'s filings on SEC EDGAR (data.sec.gov submissions,\n' +
    '      by filing date) in a period, optionally of one exact EDGAR form type,\n' +
    '      and returns entity, form_type, filing_count, the filings newest first,\n' +
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
    '      Queries DeFiLlama keyless APIs with protocol normalization and returns\n' +
    '      protocol_or_chain, tvl_usd, chain_tvl_usd, as_of timestamp, and a SHA-256 receipt.\n' +
    '    intents:\n' +
    '      - TVL_LOOKUP_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '          - name: protocol\n' +
    '            type: string\n' +
    '            intents: ["TVL_LOOKUP_GENERAL"]\n' +
    '            description: DeFi protocol slug/name or blockchain name (e.g., aave-v3, uniswap, ethereum).\n' +
    '\n' +
    '  - path: /v1/route\n' +
    '    external_path: /v1/route\n' +
    '    method: GET\n' +
    '    description: >-\n' +
    '      Returns block-pinned Ethereum mainnet execution quote (amount_out in\n' +
    '      6-decimal USDC base units) for selling exactly 1 ETH for USDC across\n' +
    '      Uniswap V2/V3, SushiSwap V2, with a SHA-256 receipt.\n' +
    '    intents:\n' +
    '      - OPTIMAL_EXECUTION_ROUTE_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '          # pair is declared as type string: the miner-config param types are\n' +
    '          # only string/integer/number/boolean/array/object (no enum type).\n' +
    '          # Live registered OPTIMAL miners declare pair as type string with\n' +
    '          # enum ["ETH/USDC"] in their input_schema; the enum is expressed\n' +
    '          # here in the description instead.\n' +
    '          - name: pair\n' +
    '            type: string\n' +
    '            intents: ["OPTIMAL_EXECUTION_ROUTE_GENERAL"]\n' +
    '            description: Must be ETH/USDC (sell exactly 1 ETH for USDC on Ethereum mainnet).\n' +
    '\n' +
    '  - path: /v1/grid-price\n' +
    '    external_path: /v1/grid-price\n' +
    '    method: GET\n' +
    '    description: >-\n' +
    '      Returns wholesale electricity locational marginal price (lmp_usd_per_mwh)\n' +
    '      from official public ISO feeds (CAISO, NYISO, ENTSO-E/Elering)\n' +
    '      for a node_or_zone and interval_start datetime with a SHA-256 receipt.\n' +
    '    intents:\n' +
    '      - GRID_POWER_PRICE_GENERAL\n' +
    '    params:\n' +
    '      query:\n' +
    '        required:\n' +
    '          - name: node_or_zone\n' +
    '            type: string\n' +
    '            intents: ["GRID_POWER_PRICE_GENERAL"]\n' +
    '            description: Pricing node or bidding zone (e.g., TH_NP15_GEN-APND, ZONE_J).\n' +
    '          - name: interval_start\n' +
    '            type: string\n' +
    '            intents: ["GRID_POWER_PRICE_GENERAL"]\n' +
    '            description: ISO-8601 UTC start datetime of the settlement interval.\n' +
    '\n' +
    'intent_mapping:\n' +
    '  ONCHAIN_TX_LOOKUP_GENERAL:\n' +
    '    endpoint: /v1/tx\n' +
    '    input:\n' +
    '      tx_hash:\n' +
    '        from: tx_hash\n' +
    '        how: "Copy the complete 0x-prefixed 64-hex-character transaction hash verbatim."\n' +
    '      chain:\n' +
    '        from: chain\n' +
    '        how: "Normalize chain name to lowercase (ethereum, base, arbitrum, optimism, polygon, sepolia, base-sepolia)."\n' +
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
    '      l1_fee_eth:\n' +
    '        path: l1_fee_eth\n' +
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
    '        how: "Pass the DeFi protocol or chain name cleanly without extra prose."\n' +
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
    '        how: "Must be ETH/USDC."\n' +
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
    '        how: "Extract the exact pricing node or bidding zone identifier."\n' +
    '      interval_start:\n' +
    '        from: interval_start\n' +
    '        how: "Format settlement interval start as ISO-8601 UTC datetime."\n' +
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
    '        path: currency\n',

  cast:
    "# Sepolia Registration Commands (Active Diamond — Nov 17 Migration)\n" +
    "# TEMPLATE: fill $YOUR_ADDRESS / $KEY. Verify amounts against the live\n" +
    "# Diamond before broadcasting — do not run blind.\n" +
    'export RPC="https://ethereum-sepolia-rpc.publicnode.com"\n' +
    'export DIAMOND="0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b"\n' +
    'export USDC="0xcc194e1a843B658526D0D5C431f670028582Ae17"\n\n' +
    "# 1. Confirm live on-chain bond ($1.00 + 4 x $0.10 = $1.40 Test USDC)\n" +
    'cast call $DIAMOND "minerBondParams()(uint256,uint256,uint256,uint256,uint256)" --rpc-url $RPC\n\n' +
    "# 2. Mint 10 Test USDC & approve Diamond for $2.00 allowance\n" +
    "cast send $USDC \"mint(address,uint256)\" $YOUR_ADDRESS 10000000 --rpc-url $RPC --private-key $KEY\n" +
    "cast send $USDC \"approve(address,uint256)\" $DIAMOND 2000000 --rpc-url $RPC --private-key $KEY\n\n" +
    "# 3. Compute exact SHA-256 (NOT keccak256) of commit-pinned miner.yaml\n" +
    'export YAML_URL="https://raw.githubusercontent.com/mohamedwael201193/verireceipt/e35fb0ac303ee2c2477030c22329bf2b0195d299/miner.yaml"\n' +
    'export YAML_HASH="0x$(curl -s "$YAML_URL" | sha256sum | awk \'{print $1}\')"\n\n' +
    "# 4. Dry-run registerMiner (free) then broadcast\n" +
    'cast call $DIAMOND "registerMiner(string,bytes32,address,uint256,string[])(uint256)" \\\n' +
    '  "$YAML_URL" "$YAML_HASH" "$YOUR_ADDRESS" 10000 \\\n' +
    `  '["ONCHAIN_TX_LOOKUP_GENERAL","REGULATORY_FILING_MONITOR_GENERAL","TVL_LOOKUP_GENERAL","OPTIMAL_EXECUTION_ROUTE_GENERAL","GRID_POWER_PRICE_GENERAL"]' \\\n` +
    "  --rpc-url $RPC",
};
