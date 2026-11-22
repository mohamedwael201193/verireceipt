import type { InspectedResearchReport } from "./researchReport";

type ResearchQuestion = Pick<InspectedResearchReport, "cik" | "year" | "form" | "minimum_count">;

/** The original submission identity, not a policy grant or evidence verification. */
export function inspectResearchInput(inputJson: string): ResearchQuestion {
  if (inputJson.length > 2048) throw new Error("Research input exceeds the recovery limit.");
  const value: unknown = JSON.parse(inputJson);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid research input.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "cik,form,minimum_count,year" ||
      typeof input.cik !== "string" || !/^[1-9][0-9]{0,9}$/.test(input.cik) ||
      !Number.isInteger(input.year) || Number(input.year) < 1994 || Number(input.year) > 9999 ||
      typeof input.form !== "string" || !["10-Q", "10-K", "8-K"].includes(input.form) ||
      !Number.isInteger(input.minimum_count) || Number(input.minimum_count) < 1 || Number(input.minimum_count) > 1000) {
    throw new Error("Invalid original research question.");
  }
  return { cik: input.cik, year: Number(input.year), form: input.form, minimum_count: Number(input.minimum_count) };
}

/** Named inputs prevent a schema/instance argument swap. Matching is not authentication. */
export function assertResearchReportMatchesInput({ report, inputJson }: { report: ResearchQuestion; inputJson: string }): void {
  const input = inspectResearchInput(inputJson);
  if (report.cik !== input.cik || report.year !== input.year || report.form !== input.form || report.minimum_count !== input.minimum_count) {
    throw new Error("The report does not match the original submitted question.");
  }
}
