// Deliberate metadata edge cases below are test fixtures, never live source data.
import { describe, expect, it } from "vitest";
import { historyPolicy, historyPagesMatch, historyRowsMatch } from "../src/secHistory";
const cik = "1318605";
const file = (i: number, from: string, to = from, count: unknown = 1) => ({ name: `CIK0001318605-submissions-${String(i).padStart(3, "0")}.json`, filingFrom: from, filingTo: to, filingCount: count });
const url = (i: number) => `https://data.sec.gov/submissions/CIK0001318605-submissions-${String(i).padStart(3, "0")}.json`;
describe("independent bounded SEC history selection", () => {
  it("requires the valid adjacent probe that strict overlap alone would reject", () => {
    const policy = historyPolicy([file(1, "2018-01-01", "2018-06-16")], cik, 2019);
    expect(policy.required).toHaveLength(0); expect(policy.neighborGroups).toHaveLength(1);
    expect(historyPagesMatch(policy, [url(1)])).toBe(true); expect(historyPagesMatch(policy, [])).toBe(false);
  });
  it("includes both seven-day overlap margins", () => {
    const policy = historyPolicy([file(1, "2018-12-25"), file(2, "2020-01-07")], cik, 2019);
    expect(policy.required.map(row => row.url)).toEqual([url(1), url(2)]);
    expect(historyPagesMatch(policy, [url(2), url(1)])).toBe(true);
  });
  it("requires one nearest probe per side, never arbitrary manifest extras", () => {
    const policy = historyPolicy([file(1, "2018-06-01"), file(2, "2018-05-01"), file(3, "2020-06-01"), file(4, "2020-07-01")], cik, 2019);
    expect(historyPagesMatch(policy, [url(1), url(3)])).toBe(true);
    expect(historyPagesMatch(policy, [url(2), url(3)])).toBe(false);
    expect(historyPagesMatch(policy, [url(1), url(4)])).toBe(false);
  });
  it("accepts exactly one of tied nearest probes, not both or neither", () => {
    const policy = historyPolicy([file(1, "2018-06-01"), file(2, "2018-06-01")], cik, 2019);
    expect(historyPagesMatch(policy, [url(1)])).toBe(true); expect(historyPagesMatch(policy, [url(2)])).toBe(true);
    expect(historyPagesMatch(policy, [url(1), url(2)])).toBe(false); expect(historyPagesMatch(policy, [])).toBe(false);
  });
  it("excludes distant pages even if present in the same issuer manifest", () => {
    const policy = historyPolicy([file(1, "2010-01-01"), file(2, "2025-01-01")], cik, 2019);
    expect(historyPagesMatch(policy, [])).toBe(true); expect(historyPagesMatch(policy, [url(1)])).toBe(false);
  });
  it("supports 25 overlap pages plus two probes, not a mistaken 25-total cap", () => {
    const files = Array.from({ length: 25 }, (_, i) => file(i, "2019-01-01"));
    const policy = historyPolicy([...files, file(25, "2018-06-01"), file(26, "2020-06-01")], cik, 2019);
    expect(historyPagesMatch(policy, Array.from({ length: 27 }, (_, i) => url(i)))).toBe(true);
    expect(() => historyPolicy([...files, file(26, "2019-06-01")], cik, 2019)).toThrow();
  });
  it("rejects a missing required page, duplicates, wrong host and unknown source", () => {
    const policy = historyPolicy([file(1, "2019-06-01")], cik, 2019);
    for (const urls of [[], [url(1), url(1)], [url(2)], [url(1).replace("data.sec.gov", "example.invalid")]]) expect(historyPagesMatch(policy, urls)).toBe(false);
  });
  it.each(["2019-02-30", "2019-13-01", "2019-01-00", "2019-1-01", "no-date"])("rejects impossible manifest date %s", date => {
    expect(() => historyPolicy([file(1, date)], cik, 2019)).toThrow();
  });
  it.each([0, -1, 1.5, "1", null, NaN])("rejects malformed manifest count %j", count => {
    expect(() => historyPolicy([file(1, "2019-01-01", "2019-01-01", count)], cik, 2019)).toThrow();
  });
  it("rejects reversed dates, duplicate names, foreign CIKs and traversal names", () => {
    for (const files of [[file(1, "2019-02-01", "2019-01-01")], [file(1, "2019-01-01"), file(1, "2019-01-01")], [{ ...file(1, "2019-01-01"), name: "CIK0000000001-submissions-001.json" }], [{ ...file(1, "2019-01-01"), name: "../../foreign" }]]) expect(() => historyPolicy(files, cik, 2019)).toThrow();
  });
  it("checks every selected page's row count and actual dates, including slack", () => {
    const ref = historyPolicy([file(1, "2018-12-31", "2018-12-31", 1)], cik, 2019).required[0];
    expect(historyRowsMatch(ref, ["2019-01-07"])).toBe(true);
    expect(historyRowsMatch(ref, ["2019-01-08"])).toBe(false);
    expect(historyRowsMatch(ref, [])).toBe(false); expect(historyRowsMatch(ref, ["2018-12-31", "2019-01-01"])).toBe(false);
  });
  it("will not accept a selected page without the manifest row count", () => {
    const entry = file(1, "2019-01-01"); delete (entry as { filingCount?: unknown }).filingCount;
    const ref = historyPolicy([entry], cik, 2019).required[0]; expect(historyRowsMatch(ref, ["2019-01-01"])).toBe(false);
  });
});
