// RPC URLs verified live 2026-11-20 with ALL THREE methods on a real tx
// of each chain — eth_blockNumber AND eth_getTransactionByHash AND
// eth_getTransactionReceipt (blockNumber-only verification is NOT enough:
// see below). LlamaRPC failed on every chain (eth/base: Cloudflare 525;
// arbitrum/optimism/polygon: empty response) and Ankr public now requires
// an API key (HTTP 200 with JSON-RPC error -32000 "Unauthorized"), so
// neither is included.
// Every mainnet chain EXCEPT polygon has 3 verified URLs (true 2-of-3
// quorum with a spare); polygon has 2 verified URLs (drpc + Tenderly,
// 2-of-2, no spare — see the 2026-11-20 replacement note below).
// sepolia has 3 (two publicnode hosts + Tenderly). base-sepolia has 2
// (publicnode + official sepolia.base.org), both verified live 2026-11-20
// with ALL THREE methods on real Base Sepolia trap tx t02 (0.001 ETH,
// block 55258439) AND on an unknown hash (null/null, no archive gate).
// MAINNET_RPCS mirrors ethereum's 3.
// Replacements 2026-11-20 (TX Judge 1, re-confirmed live by us):
// arbitrum-one-rpc.publicnode.com and optimism-rpc.publicnode.com both
// return JSON-RPC -32602 "Archive requests require a personal token" for
// eth_getTransactionReceipt, so those legs could never succeed — replaced
// by each chain's official public RPC (arb1.arbitrum.io, mainnet.optimism.io).
// Sepolia publicnode re-checked with tx+receipt on a real Sepolia tx and
// PASSES, so it stays. BlastAPI was not used for arbitrum/optimism/polygon
// at that time: optimism/polygon return -32000 "Blast API is no longer
// available" (phased shutdown), and 1rpc.io is inconsistent (eth
// rate-limited -32029, arb "discontinued"). (Base BlastAPI was verified
// working later, 2026-11-20 round 3 — see below.)
// Replacements 2026-11-20 (TX Judge round 3 — base + polygon PublicNode):
// base-rpc.publicnode.com and polygon-bor-rpc.publicnode.com both return
// JSON-RPC -32602 "Archive requests require a personal token" for
// eth_getTransactionByHash AND eth_getTransactionReceipt, on old txs AND
// on unknown hashes (reproduced via plain sequential curl). A gated leg
// must NOT stay in the config: with the fail-closed quorum fix an
// always-erroring leg turns every unanimous-null answer into a 502.
//   base: replaced by https://base-mainnet.public.blastapi.io — verified
//   live 2026-11-20 with the OLD tx 0x7f18654ad60076c65e88ecb2dd626c3de
//   0d58ff355a9b10cc1de762025d2e1e1 (block 30,000,000, status 0x1, hash and
//   blockNumber match) returning tx+receipt, and unknown hash
//   0x1111…1111 (64 hex 1s) returning null/null with no error.
//   Rejected live: base.llamarpc.com (Cloudflare 525), 1rpc.io/base
//   (returns null for a real old tx). BlastAPI is PER-CHAIN: base works,
//   polygon returns -32000 "Blast API is no longer available".
//   polygon: NO third keyless leg exists. All candidates below were tried
//   live 2026-11-20 with the OLD tx 0x85263e854c21b5ac7fe67915c26815fb6
//   40cf404b259ec735855b69f0940e8f4 (block 69,999,424, first tx of the
//   block) + the unknown hash, and ALL FAILED: polygon-rpc.com (HTTP 403
//   "tenant disabled"), polygon.llamarpc.com (empty response),
//   1rpc.io/matic (null for a real tx), polygon-mainnet.public.blastapi.io
//   (-32000 "no longer available"), rpc-mainnet.matic.network (empty),
//   rpc.ankr.com/polygon (-32000 "must authenticate with an API key"),
//   polygon.meowrpc.com (empty), polygon.api.onfinality.io/public
//   (-32029 rate-limited), polygon-mainnet.chainstacklabs.com (empty /
//   timeout), rpc-mainnet.maticvigil.com ("Our RPC has been shut down"),
//   matic-mainnet-full-rpc.bwarelabs.com (Cloudflare 1016),
//   polygon-pokt.nodies.app (paid plan required),
//   polygon-mainnet.blockpi.network (unknown host), rpc.matic.network
//   (empty), polygon.publicnode.com (-32602 archive gate, same as bor).
//   So the gated leg is REMOVED and polygon runs 2 verified legs
//   (polygon.drpc.org + polygon.gateway.tenderly.co, both re-verified live
//   on the same old tx + unknown hash). The "3 verified URLs" claim for
//   polygon is therefore FALSE and is corrected here: polygon is 2-of-2
//   with no spare until a third keyless archive leg is found.
// A2 (2026-11-20): ethereum-rpc.publicnode.com is PRUNED — it returns
// null/null for the pre-Byzantium reference tx 0x5c504ed4…2060 (block
// 46147) and eth_getBlockByNumber 0xb43b errors 4444 "pruned history
// unavailable: requested 46139, earliest available 15500000". It is
// therefore REPLACED on ethereum by https://eth-mainnet.public.blastapi.io,
// verified live 2026-11-20 with ALL THREE methods on the reference tx
// (tx blockNumber 0xb443, receipt status 0x1) AND on a recent tx
// (0x1b9e2b48…, block 26454409) AND on an unknown hash (null/null, no
// archive gate). S5's claim that publicnode served the reference tx is
// stale — re-checked live by A2, it does not.
export const CHAIN_RPCS: Record<string, string[]> = {
  ethereum: [
    "https://eth-mainnet.public.blastapi.io",
    "https://eth.drpc.org",
    "https://rpc.mevblocker.io",
  ],
  base: [
    "https://base-mainnet.public.blastapi.io",
    "https://base.drpc.org",
    "https://mainnet.base.org",
  ],
  arbitrum: [
    "https://arbitrum.drpc.org",
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum.gateway.tenderly.co",
  ],
  optimism: [
    "https://optimism.drpc.org",
    "https://mainnet.optimism.io",
    "https://optimism.gateway.tenderly.co",
  ],
  polygon: [
    "https://polygon.drpc.org",
    "https://polygon.gateway.tenderly.co",
  ],
  // Avalanche C-Chain (G2, verified live 2026-11-23 with ALL THREE
  // methods on a real tx of block 0x607794f, plus an unknown hash):
  // official api.avax.network, drpc and publicnode all return
  // eth_gasPrice 0x1bf08eb96, tx+receipt for the real tx, and null/null
  // for the unknown hash with no archive gate. Tenderly
  // (avalanche.gateway.tenderly.co) passes the same gate and is the
  // documented spare; blastapi (avalanche.public.blastapi.io) returned
  // an empty body and is NOT included.
  avalanche: [
    "https://api.avax.network/ext/bc/C/rpc",
    "https://avalanche.drpc.org",
    "https://avalanche-c-chain-rpc.publicnode.com",
  ],
  sepolia: [
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://sepolia.gateway.tenderly.co",
    "https://ethereum-sepolia.publicnode.com",
  ],
  // Base Sepolia (chain 84532): the frozen TrapTest gate is 12/12 cases on
  // this chain. Two legs (2-of-2 quorum); both verified live 2026-11-20.
  "base-sepolia": [
    "https://base-sepolia-rpc.publicnode.com",
    "https://sepolia.base.org",
  ],
};

export const MAINNET_RPCS: string[] = [
  "https://eth-mainnet.public.blastapi.io",
  "https://eth.drpc.org",
  "https://rpc.mevblocker.io",
];
