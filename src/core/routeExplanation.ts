// Presentation only. Never changes quote selection, amount, receipts or confidence.
export function explainRouteQuote(input: {
  blockNumber: number;
  venue: string;
  amountOut: bigint;
  survivingQuotes: number;
  degradedReasons: readonly string[];
}): string {
  const { blockNumber, venue, amountOut, survivingQuotes, degradedReasons } = input;
  const whole = amountOut / 1_000_000n;
  const fraction = (amountOut % 1_000_000n).toString().padStart(6, "0");
  return `For selling exactly 1 ETH for USDC on Ethereum mainnet, ${venue} has the highest gross output ` +
    `among the ${survivingQuotes} venue quote${survivingQuotes === 1 ? "" : "s"} that survived this service's plausibility filters ` +
    `at block ${blockNumber}: ${whole}.${fraction} USDC (${amountOut} base units, 6 decimals). ` +
    `This compares the supported Uniswap V2/V3 and SushiSwap V2 venue quotes that were available at that block, ` +
    `not every pool, aggregator or split route. Gas costs are not deducted, so this is not a best-net-execution claim. ` +
    `Price impact is not separately measured and no slippage limit or MEV protection is applied by this quote endpoint. ` +
    `A transaction would need a fresh quote, gas estimate, an explicit minimum amount out and an execution/protection choice; ` +
    `this endpoint does not submit a swap.` +
    (degradedReasons.length ? ` Coverage is degraded: ${degradedReasons.join("; ")}.` : "");
}
