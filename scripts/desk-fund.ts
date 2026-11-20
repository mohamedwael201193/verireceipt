// Desk funding helper (scripts/desk-fund.ts) — testnet ONLY.
//
//   npx tsx scripts/desk-fund.ts --check              # balances only
//   npx tsx scripts/desk-fund.ts --mint 10000000      # mint Test USDC to payer
//   npx tsx scripts/desk-fund.ts --deposit 2000000    # approve + deposit $2.00
//   npx tsx scripts/desk-fund.ts --ensure             # mint if USDC < $2, then deposit $2
//
// Reads DESK_PAYER_PRIVATE_KEY from the environment. The key is NEVER
// printed, logged, or written anywhere by this script. The expected
// payer address is 0xf76e6B0920e9332fF4410f6dD53F01722AbC71a3 — the script
// refuses to run if the key derives a different address.

import {
  depositEscrow,
  getPayerBalances,
  mintTestUsdc,
  payerAccountFromKey,
  sepoliaPublicClient,
  TELEGRAPH_DIAMOND,
  type Hex,
} from "../src/desk/telegraphClient";

const EXPECTED_PAYER = "0xf76e6b0920e9332ff4410f6dd53f01722abc71a3";

async function main(): Promise<void> {
  const key = (process.env.DESK_PAYER_PRIVATE_KEY ?? "").trim();
  if (!key) throw new Error("DESK_PAYER_PRIVATE_KEY is not set");
  const account = payerAccountFromKey(key as Hex);
  if (account.address.toLowerCase() !== EXPECTED_PAYER) {
    throw new Error(
      `payer key derives ${account.address}, not the expected Desk payer ${EXPECTED_PAYER} — refusing to run`,
    );
  }
  const args = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };

  const show = async (label: string): Promise<void> => {
    const b = await getPayerBalances(account.address);
    console.log(
      `${label} payer=${b.address} sepETH=${b.eth} testUSDC=$${b.test_usdc} ` +
        `escrowDeposited=${b.escrow_deposited_uusdc} uusdc ` +
        `escrowWithdrawn=${b.escrow_withdrawn_uusdc} escrowRequested=${b.escrow_requested_uusdc}`,
    );
  };

  if (args.includes("--check")) {
    await show("balances:");
    return;
  }

  const mintArg = flag("--mint");
  if (mintArg) {
    const amount = BigInt(mintArg);
    const tx = await mintTestUsdc(key as Hex, account.address, amount);
    console.log(`mint tx: ${tx} (waiting for receipt...)`);
    await sepoliaPublicClient().waitForTransactionReceipt({ hash: tx });
    console.log("mint confirmed");
    await show("after mint:");
  }

  const depositArg = flag("--deposit");
  if (depositArg) {
    const amount = BigInt(depositArg);
    const { approveTx, depositTx } = await depositEscrow(key as Hex, amount);
    console.log(`approve tx: ${approveTx}`);
    console.log(`deposit tx: ${depositTx} (Diamond ${TELEGRAPH_DIAMOND})`);
    console.log("deposit confirmed");
    await show("after deposit:");
  }

  if (args.includes("--ensure")) {
    const before = await getPayerBalances(account.address);
    if (BigInt(before.eth_wei) === 0n) {
      throw new Error("Sepolia ETH balance is zero — fund the wallet from a Sepolia faucet first, then re-run");
    }
    if (before.test_usdc_uusdc < 2_000_000n) {
      const need = 10_000_000n - before.test_usdc_uusdc;
      console.log(`Test USDC $${before.test_usdc} < $2.00 — minting ${need} uusdc...`);
      const tx = await mintTestUsdc(key as Hex, account.address, need);
      await sepoliaPublicClient().waitForTransactionReceipt({ hash: tx });
      console.log(`mint tx: ${tx} confirmed`);
    }
    const { approveTx, depositTx } = await depositEscrow(key as Hex, 2_000_000n);
    console.log(`approve tx: ${approveTx}`);
    console.log(`deposit tx: ${depositTx} (Diamond ${TELEGRAPH_DIAMOND})`);
    await show("after ensure:");
  }

  if (!args.includes("--check") && !mintArg && !depositArg && !args.includes("--ensure")) {
    await show("balances:");
  }
}

main().catch((err: unknown) => {
  console.error(`desk-fund FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
