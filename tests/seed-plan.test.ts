// Seed-plan tests — pure, offline, no spend. Proves the merged 7:3
// call queue buys the documented split (first 10 = 7 M13 + 3 M12,
// first 13 = 10 M13 + 3 M12) and the revised plan arithmetic
// (110 M13 + 30 M12 = 140 calls = $1.40).

import { describe, expect, it } from "vitest";
import {
  buildM12Scenarios,
  buildM13Scenarios,
  buildMergedCallQueue,
  queueSplit,
} from "../scripts/seed-desk-runs";
import { M12_INTENTS, M13_INTENTS } from "../src/desk/scenarios";

describe("seed plan arithmetic", () => {
  it("M13 scenarios buy 6 intents (first 10) / 5 intents (last 10), always with CRYPTO_PRICE_USD", () => {
    const m13 = buildM13Scenarios();
    expect(m13).toHaveLength(20);
    for (const sc of m13.slice(0, 10)) {
      expect(sc.intents).toHaveLength(6);
      expect(sc.intents).toEqual([...M13_INTENTS, "CRYPTO_PRICE_USD"]);
    }
    for (const sc of m13.slice(10)) {
      expect(sc.intents).toHaveLength(5);
      expect(sc.intents).toEqual([...M13_INTENTS.slice(0, 4), "CRYPTO_PRICE_USD"]);
      expect(sc.intents).not.toContain("SANCTIONS_SCREENING_MATCH_GENERAL");
    }
    const total = m13.reduce((s, sc) => s + sc.intents.length, 0);
    expect(total).toBe(110);
  });

  it("M12 scenarios buy 2 intents each: 30 calls total", () => {
    const m12 = buildM12Scenarios();
    expect(m12).toHaveLength(15);
    expect(m12.length * M12_INTENTS.length).toBe(30);
  });

  it("the full merged queue is 140 calls = $1.40 at $0.01/call", () => {
    const queue = buildMergedCallQueue(buildM13Scenarios(), buildM12Scenarios(), "ALL");
    expect(queue).toHaveLength(140);
    expect(queueSplit(queue, 140)).toEqual({ m13: 110, m12: 30 });
  });

  it("first 10 merged jobs buy 7 M13 + 3 M12 (the documented Day-4 split)", () => {
    const queue = buildMergedCallQueue(buildM13Scenarios(), buildM12Scenarios(), "ALL");
    expect(queueSplit(queue, 10)).toEqual({ m13: 7, m12: 3 });
    expect(queue.slice(0, 10).map((j) => j.mission)).toEqual([
      "M13", "M13", "M13", "M13", "M13", "M13", "M13",
      "M12", "M12", "M12",
    ]);
  });

  it("first 13 merged jobs buy 10 M13 + 3 M12 (matches the observed 2026-11-20 ledger)", () => {
    const queue = buildMergedCallQueue(buildM13Scenarios(), buildM12Scenarios(), "ALL");
    expect(queueSplit(queue, 13)).toEqual({ m13: 10, m12: 3 });
    // M13-01 completes at job 6, M12-01 completes at job 9.
    expect(queue[5]).toEqual({ mission: "M13", scenarioId: "M13-01", intent: "CRYPTO_PRICE_USD" });
    expect(queue[8]).toEqual({ mission: "M12", scenarioId: "M12-01", intent: "MINING_HASHPRICE_VERIFY_GENERAL" });
  });

  it("the 7:3 pattern holds only for the first 100 calls; jobs 101-140 are all M13 (overall 11:3, never 7:3)", () => {
    const queue = buildMergedCallQueue(buildM13Scenarios(), buildM12Scenarios(), "ALL");
    expect(queueSplit(queue, 100)).toEqual({ m13: 70, m12: 30 });
    expect(queue.slice(100).every((j) => j.mission === "M13")).toBe(true);
    expect(queue.slice(100)).toHaveLength(40);
    expect(queueSplit(queue, 140)).toEqual({ m13: 110, m12: 30 });
    // The merged queue's own job numbers (not the pre-fix sequential
    // order): job 14 is M13-02 SANCTIONS, M12-02 HASHPRICE is job 18.
    expect(queue[13]).toEqual({ mission: "M13", scenarioId: "M13-02", intent: "SANCTIONS_SCREENING_MATCH_GENERAL" });
    expect(queue[17]).toEqual({ mission: "M12", scenarioId: "M12-02", intent: "MINING_HASHPRICE_VERIFY_GENERAL" });
  });

  it("mission-scoped queues contain only that mission's calls", () => {
    expect(buildMergedCallQueue(buildM13Scenarios(), buildM12Scenarios(), "M13")).toHaveLength(110);
    expect(buildMergedCallQueue(buildM13Scenarios(), buildM12Scenarios(), "M12")).toHaveLength(30);
    expect(
      buildMergedCallQueue(buildM13Scenarios(), buildM12Scenarios(), "M12").every(
        (j) => j.mission === "M12",
      ),
    ).toBe(true);
  });

  it("scenario order is preserved within each mission", () => {
    const queue = buildMergedCallQueue(buildM13Scenarios(), buildM12Scenarios(), "ALL");
    const m13Order = queue.filter((j) => j.mission === "M13").map((j) => j.scenarioId);
    expect(m13Order[0]).toBe("M13-01");
    expect(m13Order.slice(0, 6)).toEqual(Array(6).fill("M13-01"));
    expect(m13Order[6]).toBe("M13-02");
    const m12Order = queue.filter((j) => j.mission === "M12").map((j) => j.scenarioId);
    expect(m12Order.slice(0, 2)).toEqual(["M12-01", "M12-01"]);
    expect(m12Order[2]).toBe("M12-02");
  });
});
