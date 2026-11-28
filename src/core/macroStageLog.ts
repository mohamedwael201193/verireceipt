// Fixed-vocabulary diagnostics for WORLD_BANK_UNAVAILABLE. Only stage and class labels are logged,
// never a message, URL, country, year or indicator.
export type MacroStage = "catalog" | "indicator_fetch" | "indicator_parse" | "row_shape" | "binding" | "nonnumeric" | "discovery_fetch" | "discovery_parse";
export type MacroHttpClass = "429" | "4xx" | "5xx" | "timeout" | "network" | "parse" | "none";
/** Class of a failed fetch: HTTP status when the failure carries one, timeout for a deadline abort, else network. */
export function macroFetchClass(error: unknown): MacroHttpClass {
  try {
    const d = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "status") : undefined;
    const status = d && "value" in d ? d.value : undefined;
    if (typeof status === "number") return status === 429 ? "429" : status >= 500 && status <= 599 ? "5xx" : status >= 400 && status <= 499 ? "4xx" : "network";
    const msg = error instanceof Error ? error.message : "";
    if (/deadline|abort|timeout/i.test(msg) || (error as { name?: unknown })?.name === "AbortError" || (error as { timeout?: unknown })?.timeout === true) return "timeout";
  } catch { /* fall through */ }
  return "network";
}
export function logMacroStage(stage: MacroStage, httpClass: MacroHttpClass): void {
  try { console.info(JSON.stringify({ event: "macro_stage_failure", stage, http_class: httpClass })); } catch { /* never throws */ }
}
/** An indicator observation failure. The source cache also rethrows its validator errors (bad JSON, bad row shape, nonnumeric value), so those are told apart from fetch failures by the fixed error kinds the validator throws. */
export function macroIndicatorFailure(error: unknown): void {
  const msg = error instanceof Error ? error.message : "";
  if (error instanceof SyntaxError) logMacroStage("indicator_parse", "parse");
  else if (msg === "invalid macro source payload") logMacroStage("row_shape", "none");
  else if (msg === "invalid macro observation") logMacroStage("nonnumeric", "none");
  else logMacroStage("indicator_fetch", macroFetchClass(error));
}
