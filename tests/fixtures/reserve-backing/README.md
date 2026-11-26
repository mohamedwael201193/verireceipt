# Real pinned Ethereum contract-accounting observations

Retrieved2026-11-26. All three configured RPCs independently returned finalized block0x1944e2a, hash0xaeaf176d7b15d93ca937579a2e27a735872c56ebebeb31c916590ebf2228b7a1. reads.json preserves exact eth_call and eth_getBalance bodies at that number; handler uses stricter EIP1898 blockHash with requireCanonical. Hash-selector compatibility was separately confirmed on eth.drpc.org for both methods. Chain IDs and token decimals were separately captured from all three configured sources.

RPC endpoints:
- https://eth-mainnet.public.blastapi.io
- https://eth.drpc.org
- https://rpc.mevblocker.io

Canonical WETH and wstETH addresses reused from existing verified token registry, not user input. wstETH ABI/semantics verified against https://docs.lido.fi/contracts/wsteth/ and https://docs.lido.fi/contracts/lido/ . wstETH conversion selector already used and documented in optimalRoute.ts. Custody of stETH and its oracle-accounted conversion liability are not validator reserves independently measured. WETH totalSupply equals its ETH balance by contract definition, so its100%ratio is explicitly accounting equality, not independent audit evidence. No price-derived or off-chain solvency claim.

Micro-unit reserve field is derived from the underlying contract custody value, floored with exact base units retained. It is explicitly an on-chain contract-backing observation, not a Chainlink/off-chain attestation. Global collateral/custodian/validator solvency is not asserted.

WETH accounting definition independently read at https://raw.githubusercontent.com/gnosis/canonical-weth/master/contracts/WETH9.sol . No source code was copied into this implementation.
