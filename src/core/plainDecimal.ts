/** The measured JavaScript number as an ungrouped decimal, without rounding it
 * for display. Keep the typed numeric field and source evidence separately. */
export function plainDecimal(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError("measured value must be finite");
  }
  if (Object.is(value, -0)) return "0";
  return value.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 21 });
}
