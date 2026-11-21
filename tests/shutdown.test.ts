// GRACEFUL-SHUTDOWN (2026-11-21) tests.
//
// Unit: installGracefulShutdown drains an in-flight request before exit,
// stops timers, closes the DB AFTER the HTTP drain, is idempotent, and
// exits 1 when the drain exceeds its cap.
// Process: the BUILT server (dist/server.js, exactly what Render runs)
// receives a real SIGTERM, logs "shutdown complete", exits 0 quickly, and
// leaves no SQLite -wal file behind (the DB was checkpointed + closed —
// before this patch every Render boot logged a WAL "uncommitted tail").

import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { spawn, execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join, resolve } from "path";
import { installGracefulShutdown } from "../src/core/shutdown";

const SCRATCH = resolve(process.cwd(), "..", "tmp", "graceful-shutdown-test");

describe("installGracefulShutdown (unit)", () => {
  it("drains an in-flight request, then stops timers, closes db, exits 0 once", async () => {
    const app = Fastify();
    const order: string[] = [];
    app.get("/slow", async () => {
      await new Promise((r) => setTimeout(r, 300));
      order.push("response");
      return { ok: true };
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const exits: number[] = [];
    const h = installGracefulShutdown(
      app,
      {
        stopTimers: () => order.push("timers"),
        closeDb: () => order.push("db"),
        exit: (c) => {
          order.push("exit");
          exits.push(c);
        },
        log: () => undefined,
      },
      [],
    );
    const inflight = fetch(`http://127.0.0.1:${port}/slow`).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 50));
    const p1 = h.shutdown("SIGTERM");
    const p2 = h.shutdown("SIGTERM");
    expect(h.isShuttingDown()).toBe(true);
    expect(await inflight).toEqual({ ok: true });
    await Promise.all([p1, p2]);
    expect(exits).toEqual([0]);
    expect(order).toEqual(["timers", "response", "db", "exit"]);
    h.uninstall();
  });

  it("exits 1 when the drain exceeds timeoutMs, still closing the db", async () => {
    const fake = { close: () => new Promise<void>(() => undefined) } as unknown as Parameters<
      typeof installGracefulShutdown
    >[0];
    const calls: string[] = [];
    const h = installGracefulShutdown(
      fake,
      { closeDb: () => calls.push("db"), exit: (c) => calls.push(`exit:${c}`), timeoutMs: 100, log: () => undefined },
      [],
    );
    const t0 = Date.now();
    await h.shutdown("SIGTERM");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(calls).toEqual(["db", "exit:1"]);
  });

  it("a HUNG closeDb cannot block exit: the one deadline stays armed and exit(1) fires (r2, J2 M1)", async () => {
    const app = Fastify();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const calls: string[] = [];
    const h = installGracefulShutdown(
      app,
      {
        closeDb: () => {
          calls.push("db");
          return new Promise<void>(() => undefined); // never settles (stalled pool.end)
        },
        exit: (c) => calls.push(`exit:${c}`),
        timeoutMs: 300,
        log: () => undefined,
      },
      [],
    );
    const t0 = Date.now();
    await h.shutdown("SIGTERM");
    const took = Date.now() - t0;
    expect(calls).toEqual(["db", "exit:1"]);
    expect(took).toBeGreaterThanOrEqual(280);
    expect(took).toBeLessThan(1500);
  });

  it("a closeDb that throws synchronously still exits 0 after a clean drain", async () => {
    const app = Fastify();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const calls: string[] = [];
    const h = installGracefulShutdown(
      app,
      {
        closeDb: () => {
          calls.push("db");
          throw new Error("boom");
        },
        exit: (c) => calls.push(`exit:${c}`),
        timeoutMs: 2000,
        log: () => undefined,
      },
      [],
    );
    await h.shutdown("SIGTERM");
    expect(calls).toEqual(["db", "exit:0"]);
  });

  it("the shutdown budget (drain + close) and the pool-close cap fit inside Render's 30 s SIGKILL window", async () => {
    const { DEFAULT_SHUTDOWN_TIMEOUT_MS } = await import("../src/core/shutdown");
    const { PG_CLOSE_WAIT_MS } = await import("../src/core/pgStore");
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBeLessThan(30_000);
    expect(PG_CLOSE_WAIT_MS).toBeLessThan(DEFAULT_SHUTDOWN_TIMEOUT_MS);
  });

  it("registers and removes real signal listeners", () => {
    const app = Fastify();
    const before = process.listenerCount("SIGTERM");
    const h = installGracefulShutdown(app, { exit: () => undefined, log: () => undefined });
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    h.uninstall();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("built server under a real SIGTERM (process)", () => {
  it("exits 0 fast, logs shutdown complete, leaves no WAL file", async () => {
    execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { stdio: "ignore" });
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
    const dbPath = join(SCRATCH, "verireceipt.sqlite");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ["dist/server.js"], {
      env: {
        ...process.env,
        PORT: String(port),
        SQLITE_PATH: dbPath,
        DATABASE_URL: "", // this case is the SQLite layout even when the suite runs on Postgres
        SEC_USER_AGENT: process.env.SEC_USER_AGENT ?? "verireceipt-test test@example.invalid",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    const deadline = Date.now() + 20000;
    while (!out.includes("listening on") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(out).toContain("listening on");
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(existsSync(dbPath + "-wal")).toBe(true); // WAL mode while open
    const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    const t0 = Date.now();
    child.kill("SIGTERM");
    const code = await exited;
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(out).toContain("SIGTERM received, draining");
    expect(out).toMatch(/shutdown complete in \d+ms/);
    expect(existsSync(dbPath + "-wal")).toBe(false);
  }, 60000);
});

describe.skipIf(!(process.env.DATABASE_URL ?? "").trim())("built server on Postgres (process)", () => {
  it("boots on DATABASE_URL, /health reports storage ok, SIGTERM drains + ends the pool, exit 0", async () => {
    execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { stdio: "ignore" });
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ["dist/server.js"], {
      env: {
        ...process.env,
        PORT: String(port),
        SEC_USER_AGENT: process.env.SEC_USER_AGENT ?? "verireceipt-test test@example.invalid",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    const deadline = Date.now() + 80000; // includes the capped pre-listen TVL warm
    while (!out.includes("listening on") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(out).toContain("listening on");
    expect(out).not.toContain("db ready"); // SQLite never opened on the Postgres layout
    let health: { storage?: { backend: string; ok: boolean | null } } = {};
    for (let i = 0; i < 30; i++) {
      health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as typeof health;
      if (health.storage?.ok !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(health.storage).toMatchObject({ backend: "postgres", ok: true });
    const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(out).toMatch(/shutdown complete in \d+ms/);
  }, 120000);
});
