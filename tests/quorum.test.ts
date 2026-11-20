// Unit tests for src/core/quorum.ts — quorum2of3 short-circuit (Part B, round 4).
// No network, no stubs: tasks are in-process promises with controllable timing.
// The handler-level latency tests live in tests/route.test.ts.
import { describe, expect, it } from "vitest";
import { quorum2of3 } from "../src/core/quorum";

const eq = (a: number, b: number) => a === b;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const never = <T>(): Promise<T> => new Promise(() => {});

describe("quorum2of3 short-circuit (Part B)", () => {
  it("early-resolve: 2 fast agreeing legs resolve at once while the 3rd hangs", async () => {
    const startedAt = Date.now();
    const result = await quorum2of3<number>(
      [async () => 7, async () => 7, () => never<number>()],
      eq,
      5000,
    );
    const elapsedMs = Date.now() - startedAt;
    expect(result.value).toBe(7);
    expect(result.votes).toBe("2/3 sources agreed");
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("early-resolve: a disagreeing first leg does not block the agreeing pair", async () => {
    const result = await quorum2of3<number>(
      [
        async () => 1,
        async () => {
          await sleep(50);
          return 2;
        },
        async () => {
          await sleep(100);
          return 2;
        },
      ],
      eq,
      5000,
    );
    expect(result.value).toBe(2);
    expect(result.votes).toBe("2/3 sources agreed");
  });

  it("early-fail: 2 fast failures reject at once without waiting for the hung 3rd leg", async () => {
    const startedAt = Date.now();
    await expect(
      quorum2of3<number>(
        [
          async () => {
            throw new Error("leg 1 down");
          },
          async () => {
            throw new Error("leg 2 down");
          },
          () => never<number>(),
        ],
        eq,
        5000,
      ),
    ).rejects.toMatchObject({ status: 502, code: "QUORUM_UNREACHABLE" });
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("early-fail: a single failure with 2 tasks (2-of-2) rejects at once", async () => {
    const startedAt = Date.now();
    await expect(
      quorum2of3<number>(
        [
          async () => {
            throw new Error("leg 1 down");
          },
          () => never<number>(),
        ],
        eq,
        5000,
      ),
    ).rejects.toMatchObject({ status: 502, code: "QUORUM_UNREACHABLE" });
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("all legs settle with no agreeing pair -> 502 QUORUM_UNREACHABLE", async () => {
    await expect(
      quorum2of3<number>([async () => 1, async () => 2, async () => 3], eq, 5000),
    ).rejects.toMatchObject({ status: 502, code: "QUORUM_UNREACHABLE" });
  });

  it("only 1 success out of 3 -> 502 QUORUM_UNREACHABLE", async () => {
    await expect(
      quorum2of3<number>(
        [
          async () => 9,
          async () => {
            throw new Error("down");
          },
          async () => {
            throw new Error("down");
          },
        ],
        eq,
        5000,
      ),
    ).rejects.toMatchObject({ status: 502, code: "QUORUM_UNREACHABLE" });
  });

  it("per-leg timeout: a leg slower than timeoutMs counts as failed, the agreeing pair still wins", async () => {
    const result = await quorum2of3<number>(
      [
        async () => 4,
        async () => 4,
        async () => {
          await sleep(500);
          return 4;
        },
      ],
      eq,
      100,
    );
    expect(result.value).toBe(4);
    expect(result.votes).toBe("2/3 sources agreed");
  });

  it("fewer than 2 tasks can never form a quorum -> 502 QUORUM_UNREACHABLE", async () => {
    await expect(quorum2of3<number>([async () => 1], eq, 5000)).rejects.toMatchObject({
      status: 502,
      code: "QUORUM_UNREACHABLE",
    });
    await expect(quorum2of3<number>([], eq, 5000)).rejects.toMatchObject({
      status: 502,
      code: "QUORUM_UNREACHABLE",
    });
  });

  it("3 agreeing legs resolve with 2/3 votes at decision time (the 3rd need not be awaited)", async () => {
    const result = await quorum2of3<number>(
      [async () => 5, async () => 5, async () => 5],
      eq,
      5000,
    );
    expect(result.value).toBe(5);
    expect(result.votes).toMatch(/^[23]\/3 sources agreed$/);
  });
});
