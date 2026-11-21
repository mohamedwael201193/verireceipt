export interface InspectedResearchReport {
  status: "SUPPORTED" | "NOT_SUPPORTED" | "HOLD";
  reason: string;
  cik: string;
  year: number;
  form: string;
  minimum_count: number;
  count: number | null;
  plan_hash: string;
  checks: { name: string; ok: boolean }[];
  delivery: string;
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected a research report object.");
  return v as Record<string, unknown>;
}
/** Structural inspection only. This does not authenticate the file or reverify live evidence. */
export function inspectResearchReport(text: string): InspectedResearchReport {
  if (text.length > 2_000_000) throw new Error("Report must be under 2 MB.");
  const data = object(JSON.parse(text)), plan = object(data.plan), result = object(data.result), delivery = object(data.delivery);
  if (data.version !== "research-run-v1" || plan.version !== "research-packet-v1" ||
      typeof plan.cik !== "string" || !/^[1-9][0-9]{0,9}$/.test(plan.cik) ||
      !Number.isInteger(plan.year) || Number(plan.year) < 1994 || Number(plan.year) > 9999 ||
      !["10-Q", "10-K", "8-K"].includes(String(plan.form)) ||
      plan.network !== "eip155:11155111" || !Number.isInteger(plan.minimum_count) || Number(plan.minimum_count) < 1 || Number(plan.minimum_count) > 1000 ||
      !["SUPPORTED", "NOT_SUPPORTED", "HOLD"].includes(String(result.status)) ||
      typeof result.reason !== "string" || result.reason.length > 4000 ||
      typeof data.plan_hash !== "string" || !/^[0-9a-f]{64}$/.test(data.plan_hash) ||
      !(result.observed_count === null || Number.isSafeInteger(result.observed_count) && Number(result.observed_count) >= 0) ||
      !["included", "pending", "error"].includes(String(delivery.status))) throw new Error("Not a supported research-run-v1 report.");
  const all = [result.checks, data.verification_checks].flatMap(v => {
    if (!Array.isArray(v) || v.length > 500) throw new Error("Report checks must be bounded arrays.");
    return v.map(item => {
      const x = object(item);
      if (typeof x.name !== "string" || x.name.length > 250 || typeof x.ok !== "boolean") throw new Error("Malformed report check.");
      return { name: x.name, ok: x.ok };
    });
  });
  if (!all.length) throw new Error("Report contains no inspectable checks.");
  return { status: result.status as InspectedResearchReport["status"], reason: result.reason, cik: plan.cik,
    year: Number(plan.year), form: String(plan.form), minimum_count: Number(plan.minimum_count), count: result.observed_count as number | null,
    plan_hash: data.plan_hash, checks: all, delivery: String(delivery.status) };
}
