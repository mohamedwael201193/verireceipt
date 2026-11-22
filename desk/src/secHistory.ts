// Independent Desk implementation of the backend's bounded SEC history policy.
// Keep probe bytes in receipts. Do not weaken this to arbitrary manifest extras.
const DAY = 86_400_000;
const SLACK = 7 * DAY;
const PROBE = 366 * DAY;
export interface HistoryRef {
  url: string;
  from: number;
  to: number;
  count: number | null;
}
export interface HistoryPolicy {
  required: HistoryRef[];
  neighborGroups: HistoryRef[][];
  allowed: Map<string, HistoryRef>;
}
function iso(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Malformed SEC history date");
  const time = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error("Invalid SEC history calendar date");
  return time;
}
export function historyPolicy(files: unknown[], cik: string, year: number): HistoryPolicy {
  const names = new Set<string>();
  const refs: HistoryRef[] = files.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed SEC history entry");
    const row = value as Record<string, unknown>;
    if (typeof row.name !== "string" || !new RegExp(`^CIK${cik.padStart(10, "0")}-submissions-\\d{3}\\.json$`).test(row.name) || names.has(row.name)) throw new Error("Foreign or duplicate SEC history manifest name");
    names.add(row.name);
    const from = iso(row.filingFrom), to = iso(row.filingTo);
    if (from > to || (row.filingCount !== undefined && (typeof row.filingCount !== "number" || !Number.isInteger(row.filingCount) || row.filingCount < 1))) throw new Error("Invalid SEC history range or row count");
    return { url: `https://data.sec.gov/submissions/${row.name}`, from, to, count: typeof row.filingCount === "number" ? row.filingCount : null };
  });
  const start = iso(`${year}-01-01`), end = iso(`${year}-12-31`);
  const required = refs.filter((row) => row.to + SLACK >= start && row.from - SLACK <= end);
  if (required.length > 25) throw new Error("More than 25 overlapping SEC history pages");
  const selected = new Set(required.map((row) => row.url));
  const rest = refs.filter((row) => !selected.has(row.url));
  const below = rest.filter((row) => row.to < start && row.to + PROBE >= start);
  const above = rest.filter((row) => row.from > end && row.from - PROBE <= end);
  // Equal nearest bounds can occur on distinct pages. Exactly one tied nearest
  // probe per side is allowed; arbitrary further-away manifest pages are not.
  const nearestBelow = below.length ? Math.max(...below.map((row) => row.to)) : null;
  const nearestAbove = above.length ? Math.min(...above.map((row) => row.from)) : null;
  const neighborGroups = [below.filter((row) => row.to === nearestBelow), above.filter((row) => row.from === nearestAbove)].filter((group) => group.length > 0);
  return { required, neighborGroups, allowed: new Map([...required, ...neighborGroups.flat()].map((row) => [row.url, row])) };
}
export function historyPagesMatch(policy: HistoryPolicy, urls: unknown[]): boolean {
  if (urls.length !== policy.required.length + policy.neighborGroups.length || urls.length > 27 || new Set(urls).size !== urls.length) return false;
  if (!urls.every((url) => typeof url === "string" && policy.allowed.has(url))) return false;
  if (!policy.required.every((row) => urls.includes(row.url))) return false;
  return policy.neighborGroups.every((group) => group.filter((row) => urls.includes(row.url)).length === 1);
}
export function historyRowsMatch(ref: HistoryRef, dates: string[]): boolean {
  return ref.count !== null && dates.length === ref.count && dates.length > 0 && dates.every((date) => {
    const time = iso(date);
    return time >= ref.from - SLACK && time <= ref.to + SLACK;
  });
}
