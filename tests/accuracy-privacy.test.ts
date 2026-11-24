// Test-only: the public 502 body for GET /accuracy.json must not carry
// driver error detail. A mocked pg Client throws an error containing a
// private marker (and a credentialed URL); neither may reach the body.
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "accuracy-privacy-"));
process.env.SQLITE_PATH = join(dir, "db.sqlite");
process.env.DATABASE_URL = "postgresql://u:p@db.invalid:5432/x";

const MARKER = "PRIVATE-MARKER-7f3a91";
vi.mock("pg", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  class Client {
    async connect(): Promise<void> {
      throw new Error(`connect failed ${MARKER} postgresql://secretuser:secretpw@internal-host:5432/db`);
    }
    async end(): Promise<void> {}
  }
  return { ...real, default: { ...(real.default as object), Client }, Client };
});

import { buildServer } from "../src/server";
import { __setStorageBackendForTests } from "../src/core/storage";
import { __resetAccuracyCacheForTests } from "../src/core/accuracy";
__setStorageBackendForTests("sqlite");

afterAll(() => {
  delete process.env.DATABASE_URL;
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /accuracy.json privacy", () => {
  it("502 body is generic: no driver error text, marker, host or credentials", async () => {
    __resetAccuracyCacheForTests();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = buildServer();
    try {
      const res = await app.inject("/accuracy.json");
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe("ACCURACY_UNAVAILABLE");
      for (const leak of [MARKER, "secretuser", "secretpw", "internal-host", "connect failed"]) {
        expect(res.body).not.toContain(leak);
      }
      // detail is logged, with the URL redacted
      const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain(MARKER);
      expect(logged).not.toContain("secretpw");
    } finally {
      await app.close();
      errSpy.mockRestore();
    }
  });
});
