// PG-MIGRATE (2026-11-21): vitest setup file. When the suite runs against
// Postgres (DATABASE_URL set), every test FILE gets its own fresh schema
// via search_path, so files running in parallel never see each other's
// rows (e.g. "receipt count unchanged" assertions). No-op without
// DATABASE_URL (the SQLite suite is untouched).
import { afterAll, beforeAll } from "vitest";
import { Client } from "pg";
import { randomBytes } from "crypto";

// The un-scoped URL is kept so a worker that runs several files still
// gives each file a NEW schema.
const base = (process.env.VR_TEST_BASE_URL ?? process.env.DATABASE_URL ?? "").trim();
if (base) {
  process.env.VR_TEST_BASE_URL = base;
  const schema = "vt_" + randomBytes(6).toString("hex");
  // The URL is switched synchronously (before any test-file code can open
  // the pool); the schema itself is created before the first test runs.
  const u = new URL(base);
  u.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = u.toString();
  process.env.VR_TEST_SCHEMA = schema;
  beforeAll(async () => {
    const c = new Client({ connectionString: base });
    c.on("error", () => undefined); // r3: a terminated backend must not crash the worker
    await c.connect();
    await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await c.end();
  });
  // r2 (J1 m7): drop the per-file schema so the test DB does not
  // accumulate vt_* schemas. The file's pool is closed first (an idle
  // pooled session holds no locks, but closing makes the drop instant).
  afterAll(async () => {
    try {
      const { closePg } = await import("../../src/core/pgStore");
      await closePg();
    } catch {
      // the file may never have opened the pool
    }
    const c = new Client({ connectionString: base });
    c.on("error", () => undefined); // r3: a terminated backend must not crash the worker
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await c.end();
  });
}
