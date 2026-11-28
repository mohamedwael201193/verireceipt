// Frozen closed vocabulary of public token tickers (184). The only raw symbol
// strings diagnostics may ever record; anything else is reduced to a fixed class.
export const SYMBOL_VOCAB: ReadonlySet<string> = new Set([
  "BTC", "ETH", "USDT", "USDC", "BNB", "XRP", "SOL", "ADA", "DOGE", "TRX", "TON", "DOT",
  "MATIC", "POL", "LINK", "AVAX", "SHIB", "WBTC", "DAI", "LTC", "BCH", "UNI", "ATOM", "XLM",
  "XMR", "ETC", "HBAR", "FIL", "APT", "ARB", "OP", "NEAR", "VET", "ICP", "INJ", "GRT",
  "AAVE", "MKR", "RUNE", "STX", "ALGO", "QNT", "EGLD", "SAND", "MANA", "AXS", "THETA", "FTM",
  "FLOW", "CHZ", "CRV", "LDO", "SNX", "COMP", "SUSHI", "YFI", "BAL", "CVX", "1INCH", "GNO",
  "DYDX", "ENS", "APE", "IMX", "LRC", "BAT", "ZRX", "FRAX", "LUSD", "TUSD", "USDE", "USDP",
  "PYUSD", "FDUSD", "GUSD", "BUSD", "USDD", "STETH", "WSTETH", "RETH", "WETH", "CBETH", "WEETH", "CBBTC",
  "PEPE", "FLOKI", "BONK", "WIF", "ONDO", "RENDER", "RNDR", "FET", "AGIX", "OCEAN", "TAO", "WLD",
  "PAXG", "XAUT", "CRO", "LEO", "OKB", "KCS", "GT", "FTT", "BNT", "UMA", "REN", "KNC",
  "CEL", "AMP", "ANKR", "AUDIO", "BAND", "CELO", "CKB", "COTI", "CTSI", "DENT", "ENJ", "GALA",
  "GLM", "HNT", "HOT", "ICX", "IOTA", "IOST", "KAVA", "KSM", "LSK", "MINA", "NEO", "OMG",
  "ONT", "QTUM", "RVN", "SC", "STORJ", "SYN", "TWT", "WAVES", "XEM", "XTZ", "ZEC", "ZIL",
  "ENA", "EIGEN", "PENDLE", "JUP", "PYTH", "JTO", "TIA", "SEI", "SUI", "BLUR", "MAGIC", "GMX",
  "LPT", "RPL", "SSV", "ETHFI", "REZ", "ZRO", "STRK", "ZK", "MNT", "METIS", "MORPHO", "ARKM",
  "PEOPLE", "MEME", "NOT", "DOGS", "HYPE", "SKY", "USDS", "S", "XDC", "FLR", "KAS", "BERA",
  "PENGU", "TRUMP", "VIRTUAL", "AI16Z",
]);

export const SYMBOL_OTHER_RE = /^other:(1-3|4-6|7-12|>12):(alpha|alnum|digit_lead|other)$/;

/** Fixed-label bucket for a user-supplied token string: the uppercased
 * symbol if it is in the closed vocabulary, else other:<len>:<shape>. */
export function symbolBucket(raw: string): string {
  const v = raw.trim();
  const up = v.toUpperCase();
  if (SYMBOL_VOCAB.has(up)) return up;
  const n = v.length;
  const len = n <= 3 ? "1-3" : n <= 6 ? "4-6" : n <= 12 ? "7-12" : ">12";
  const shape = /^0x/i.test(v) || !/^[A-Za-z0-9]+$/.test(v) ? "other"
    : /^[0-9]/.test(v) ? "digit_lead" : /^[A-Za-z]+$/.test(v) ? "alpha" : "alnum";
  return `other:${len}:${shape}`;
}
