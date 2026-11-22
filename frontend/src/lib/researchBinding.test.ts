import { describe, expect, it } from "vitest";
import { assertResearchReportMatchesInput, inspectResearchInput } from "./researchBinding";

const question = { cik: "1318605", year: 2024, form: "10-Q", minimum_count: 3 };
const inputJson = JSON.stringify(question);

describe("original research question binding, test-only inputs", () => {
  it("accepts matching fields without depending on JSON key order or whitespace", () => {
    expect(inspectResearchInput(inputJson)).toEqual(question);
    expect(() => assertResearchReportMatchesInput({ report: question,
      inputJson: JSON.stringify({ minimum_count: 3, form: "10-Q", year: 2024, cik: "1318605" }, null, 2) })).not.toThrow();
  });
  it.each([{ cik: "320193" }, { year: 2023 }, { form: "10-K" }, { minimum_count: 4 }])("rejects a report for different question fields %j", change => {
    expect(() => assertResearchReportMatchesInput({ report: { ...question, ...change }, inputJson })).toThrow(/original submitted question/);
  });
  it.each([null, [], {}, { ...question, extra: true }, { ...question, cik: "01318605" },
    { ...question, year: "2024" }, { ...question, year: 2024.5 }, { ...question, form: "10-Q/A" },
    { ...question, minimum_count: 0 }, { ...question, minimum_count: true }])("rejects malformed original input %j", input => {
    expect(() => inspectResearchInput(JSON.stringify(input))).toThrow();
  });
  it("requires actual input and report fields, not arbitrary empty success", () => {
    expect(() => inspectResearchInput(" ".repeat(2049))).toThrow(/limit/);
    expect(() => inspectResearchInput("not json")).toThrow();
    expect(() => assertResearchReportMatchesInput({ report: {} as typeof question, inputJson })).toThrow();
  });
});
