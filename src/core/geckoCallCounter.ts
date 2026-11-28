import { publicSourceFailure } from "./publicSource";
// In-memory sliding window of GeckoTerminal call starts. Four handlers share one egress IP quota,
// so a 429 is only readable next to how many calls the whole process made in the last minute.
// Timestamps only: no URL, token or user text is ever stored.
const WINDOW_MS = 60_000;
const CAP = 200;
let stamps: number[] = [];
function prune(now: number): void {
  const cut = now - WINDOW_MS;
  let i = 0;
  while (i < stamps.length && stamps[i] <= cut) i++;
  if (i > 0) stamps = stamps.slice(i);
}
export function recordGeckoCall(): void {
  try {
    const now = Date.now();
    prune(now);
    stamps.push(now);
    if (stamps.length > CAP) stamps = stamps.slice(stamps.length - CAP);
  } catch { /* observability never changes a response */ }
}
export type GeckoCallBucket = "0-10" | "11-20" | "21-30" | ">30";
export function geckoCallsLast60sBucket(): GeckoCallBucket {
  prune(Date.now());
  const n = stamps.length;
  return n <= 10 ? "0-10" : n <= 20 ? "11-20" : n <= 30 ? "21-30" : ">30";
}
export function resetGeckoCallCounterForTests(): void { stamps = []; }
/** One fixed-label line when a Gecko call was refused with HTTP 429 by the source. */
export function logGecko429(error: unknown): void {
  try {
    const failure = publicSourceFailure(error);
    if (failure === "http_429") console.info(JSON.stringify({ event: "gecko_429", gecko_calls_last_60s_bucket: geckoCallsLast60sBucket() }));
  } catch { /* never throws */ }
}
