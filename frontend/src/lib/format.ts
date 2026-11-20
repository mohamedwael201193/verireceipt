const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const usdPrecise = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** $15,083,256,265 — whole dollars, no cents. */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return usd.format(value);
}

/** $43.43 — two decimals, for per-MWh prices and other small USD values. */
export function formatUsdPrecise(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return usdPrecise.format(value);
}

/** 1.2345 ETH — up to 6 decimals, trailing zeros trimmed. */
export function formatEth(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const num = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(num)) return "—";
  return `${num.toLocaleString("en-US", { maximumFractionDigits: 6 })} ETH`;
}

/** ISO timestamp -> "20 Nov 2026, 07:37 UTC" (UTC, deterministic). */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = date.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const year = date.getUTCFullYear();
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year}, ${hh}:${mm} UTC`;
}

/** 0x1234…abcd — first 6 chars, ellipsis, last 4. */
export function shortenHash(value: string | null | undefined): string {
  if (!value) return "—";
  if (value.length <= 13) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** 0x1b9f3e59…211b9685 — first 10 chars, ellipsis, last 8. */
export function shortenSha(value: string | null | undefined): string {
  if (!value) return "—";
  if (value.length <= 20) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}
