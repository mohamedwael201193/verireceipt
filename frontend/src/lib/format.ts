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
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  // -0 formats as "-$0" in Intl; normalise it to plain $0 (J2 M-4).
  return usd.format(value === 0 ? 0 : value);
}

/** $43.43 — two decimals, for per-MWh prices and other small USD values. */
export function formatUsdPrecise(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return usdPrecise.format(value === 0 ? 0 : value);
}

/** 1.2345 ETH — up to 6 decimals, trailing zeros trimmed. */
export function formatEth(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  // Whitespace-only strings coerce to 0 via Number(" ") — they are not
  // amounts and must render as "—" (J2 M-4).
  if (typeof value === "string" && value.trim().length === 0) return "—";
  const num = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(num)) return "—";
  // -0 renders as "-0 ETH" via toLocaleString; normalise it (J2 M-4).
  const normalised = num === 0 ? 0 : num;
  return `${normalised.toLocaleString("en-US", { maximumFractionDigits: 6 })} ETH`;
}

/**
 * ISO timestamp -> "20 Nov 2026, 07:37 UTC" (UTC, deterministic).
 * Total over non-string values (B-1b): a receipt field arriving as a
 * number/object must render "—", never throw and never hand React an
 * object child.
 */
export function formatDate(value: unknown): string {
  // Whitespace-only strings are unparseable (new Date("   ") is Invalid
  // Date) and used to be returned verbatim, rendering a blank cell
  // (J2 R4 B-1, re-opened): like shortenSha/shortenHash, they render "—".
  // Non-whitespace unparseable input still passes through ("not-a-date")
  // — that passthrough is tested behaviour, not a blank render.
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) return "—";
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

/**
 * 0x1234…abcd — first 6 chars, ellipsis, last 4.
 * Total over non-string values (B-1b): a numeric sha used to throw
 * (value.slice on a number). Any non-string renders "—".
 */
export function shortenHash(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) return "—";
  if (value.length <= 13) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * 0x1b9f3e59…211b9685 — first 10 chars, ellipsis, last 8.
 * Total over non-string values (B-1b), same as shortenHash.
 */
export function shortenSha(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) return "—";
  if (value.length <= 20) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}
