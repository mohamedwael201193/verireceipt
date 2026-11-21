// GRACEFUL-SHUTDOWN (2026-11-21).
//
// WHY THIS EXISTS: Render stops the old instance with SIGTERM on every
// deploy (and, because this service has a persistent disk, BEFORE the new
// instance starts — Render docs, "Disk limitations": a disk prevents
// zero-downtime deploys). The server had no SIGTERM handler, so Node died
// on the default signal action: in-flight requests were cut mid-response
// and SQLite never checkpointed (each boot logged a WAL "uncommitted
// tail" warning). This handler drains in-flight requests, stops the
// background timers, closes the DB cleanly, then exits 0 — well inside
// Render's shutdown window (30 s, not configurable for disk services).

import type { FastifyInstance } from "fastify";

export interface ShutdownDeps {
  /** Stop background timers (ingester, refresh). Must not throw. */
  stopTimers?: () => void;
  /** Close storage after the HTTP server drained (sync or async). */
  closeDb?: () => unknown;
  /** Exit hook (tests inject a spy). Default: process.exit. */
  exit?: (code: number) => void;
  /** Hard cap for the drain; exit(1) if it is exceeded. Default 20 s. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface ShutdownHandle {
  /** Run the shutdown sequence once (idempotent). Resolves after exit() was called. */
  shutdown: (signal: string) => Promise<void>;
  /** Remove the process signal listeners (tests). */
  uninstall: () => void;
  isShuttingDown: () => boolean;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;

export function installGracefulShutdown(
  app: FastifyInstance,
  deps: ShutdownDeps = {},
  signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"],
): ShutdownHandle {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((line: string) => console.log(line));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let running: Promise<void> | null = null;

  const shutdown = (signal: string): Promise<void> => {
    if (running) return running;
    running = (async () => {
      const started = Date.now();
      log(`verireceipt: ${signal} received, draining`);
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      });
      try {
        deps.stopTimers?.();
      } catch {
        // timers are best effort; the drain below is what matters
      }
      // app.close() stops accepting and waits for open sockets. Render's
      // proxy (like any HTTP/1.1 client) keeps connections alive, and
      // Node's closeIdleConnections() only reaps sockets idle AT THE
      // MOMENT it is called — a socket whose in-flight response finishes
      // later would hold close() open until keepAliveTimeout (72 s in
      // Fastify), past Render's 30 s window. So keep reaping idle
      // sockets every 100 ms during the drain; in-flight requests are
      // never cut (only sockets with no active request are closed).
      const server = (app as { server?: { closeIdleConnections?: () => void } }).server;
      const reap = () => {
        try {
          server?.closeIdleConnections?.();
        } catch {
          // reaping is best effort
        }
      };
      const reaper = setInterval(reap, 100);
      if (typeof reaper.unref === "function") reaper.unref();
      const closing = app.close().catch(() => undefined);
      reap();
      await Promise.race([closing, deadline]);
      clearInterval(reaper);
      try {
        // PG-MIGRATE r2 (J2 M1): closeDb may be async (Postgres
        // pool.end()). The ONE deadline stays armed across the drain AND
        // the close — it is cleared only after this race — so a hung
        // close can never block exit(): exit(1) fires at timeoutMs
        // (20 s total, under Render's 30 s SIGKILL window). A closeDb
        // that throws synchronously is caught here too.
        await Promise.race([Promise.resolve().then(() => deps.closeDb?.()), deadline]);
      } catch {
        // closeDb never throws in production; belt-and-braces
      }
      if (timer) clearTimeout(timer);
      const ms = Date.now() - started;
      log(
        timedOut
          ? `verireceipt: shutdown drain exceeded ${timeoutMs}ms, exiting 1`
          : `verireceipt: shutdown complete in ${ms}ms`,
      );
      exit(timedOut ? 1 : 0);
    })();
    return running;
  };

  const listener = (sig: NodeJS.Signals) => {
    void shutdown(sig);
  };
  for (const s of signals) process.on(s, listener);

  return {
    shutdown,
    uninstall: () => {
      for (const s of signals) process.off(s, listener);
    },
    isShuttingDown: () => running !== null,
  };
}
