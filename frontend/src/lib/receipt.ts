/**
 * Real receipt verification (DESIGN-SPEC §8 A16/A19).
 *
 * "Merkle Verified" claims in the design files are self-referential: a hash
 * computed over canned input, so it always passes. The real check is:
 * recompute SHA-256 of the fetched upstream response body and compare it
 * with the receipt's `raw_response_sha256`. Show Verified ONLY on match.
 *
 * If WebCrypto is unavailable, verification REFUSES with an error — it must
 * never fall back to a fake hash (no FNV-1a fallback, no canned SHA-256).
 */

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "WebCrypto SHA-256 is unavailable in this environment — receipt verification refused rather than showing a fake hash.",
    );
  }
  return subtle;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await getSubtle().digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The ONE digest contract (QA-04): `raw_response_sha256` is 64 hex
 * characters (the live API emits lowercase, no prefix). An optional
 * `0x`/`0X` prefix is tolerated; anything else — wrong length, non-hex,
 * non-string — is null. Returns the canonical bare lowercase form.
 */
export function normalizeSha256Hex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const bare = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  return /^[0-9a-fA-F]{64}$/.test(bare) ? bare.toLowerCase() : null;
}

/** Short shape description of a digest value for failure messages. */
export function describeDigestShape(value: unknown): string {
  if (typeof value !== "string") return `type ${value === null ? "null" : typeof value}`;
  const prefixed = value.startsWith("0x") || value.startsWith("0X");
  const bare = prefixed ? value.slice(2) : value;
  const hex = /^[0-9a-fA-F]*$/.test(bare);
  return `${prefixed ? "0x-prefixed, " : ""}${bare.length} chars${hex ? "" : ", non-hex"}`;
}

/** Returns true only when the SHA-256 of `rawBody` equals `expectedSha256`
 *  (with or without a `0x` prefix, case-insensitive). Non-string inputs
 *  return false instead of throwing — except when WebCrypto itself is
 *  unavailable, which still throws (never a fake hash). */
export async function verifyReceipt(
  rawBody: unknown,
  expectedSha256: unknown,
): Promise<boolean> {
  // WebCrypto availability is checked first on purpose: an unavailable
  // WebCrypto must refuse loudly even for malformed inputs.
  void getSubtle();
  if (typeof rawBody !== "string" || typeof expectedSha256 !== "string") {
    return false;
  }
  const normalized = normalizeSha256Hex(expectedSha256);
  if (normalized === null) return false;
  const actual = await sha256Hex(rawBody);
  return actual === normalized;
}
