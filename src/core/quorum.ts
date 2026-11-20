import { ApiError } from "./errors";
import { CIRCUIT_COOLDOWN_MS, CIRCUIT_THRESHOLD, TIMEOUT_MS } from "../config/limits";

function withTimeout<T>(task: () => Promise<T>, timeoutMs: number): Promise<T> {
  // Race-timeout, NOT AbortSignal.timeout: no abort signal is delivered to
  // tasks, so a hung upstream socket may linger after quorum rejects. The
  // per-task 4500 ms contract (TIMEOUT_MS) is still met — the race rejects
  // at timeoutMs regardless of what the task does afterwards.
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("task timed out"));
    }, timeoutMs);
    task().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * 2-of-N quorum with short-circuit (Part B, round 4).
 *
 * The previous implementation awaited every leg via Promise.allSettled, so
 * one hung leg delayed the answer by the full per-leg timeout even after
 * two legs had already agreed. This version resolves or rejects as soon
 * as the outcome is decided:
 * - EARLY-RESOLVE: as soon as any value has a second agreeing success,
 *   resolve at once with that value. A still-hung leg never delays a
 *   decided quorum. `votes` counts the agreements observed at decision
 *   time (usually 2/N); a later leg that would also have agreed does not
 *   change the returned value, which is equal to it by `equals` anyway.
 * - EARLY-FAIL: as soon as 2 agreeing successes are impossible — i.e.
 *   successes-so-far + legs-still-pending < 2 — reject at once with
 *   QUORUM_UNREACHABLE instead of waiting out the remaining timeouts.
 *   The same rejection fires when every leg has settled and no pair
 *   agrees, or when fewer than 2 tasks were supplied (a quorum of 2 can
 *   never form).
 *
 * Semantics preserved vs the allSettled version: the winner is a value
 * with at least one equal partner; with fewer than 2 successes the call
 * 502s QUORUM_UNREACHABLE; with >= 2 successes but no agreeing pair it
 * also 502s QUORUM_UNREACHABLE. The only change is WHEN the promise
 * settles — at decision time, not at the slowest leg's timeout.
 * Every leg's promise has handlers attached synchronously, so a leg that
 * settles after the quorum is decided can neither reject unhandled nor
 * change the outcome.
 */
export async function quorum2of3<T>(
  tasks: Array<() => Promise<T>>,
  equals: (a: T, b: T) => boolean,
  timeoutMs: number = TIMEOUT_MS,
): Promise<{ value: T; votes: string }> {
  if (tasks.length < 2) {
    throw new ApiError(
      502,
      "QUORUM_UNREACHABLE",
      `quorum unreachable: only 0 of ${tasks.length} sources succeeded`,
    );
  }
  return new Promise<{ value: T; votes: string }>((resolve, reject) => {
    let settled = false;
    const successes: T[] = [];
    let failures = 0;
    let doneCount = 0;

    const finishResolve = (value: T, count: number): void => {
      if (settled) return;
      settled = true;
      resolve({ value, votes: `${count}/${tasks.length} sources agreed` });
    };
    const finishReject = (message: string): void => {
      if (settled) return;
      settled = true;
      reject(new ApiError(502, "QUORUM_UNREACHABLE", message));
    };

    tasks.forEach((task) => {
      withTimeout(task, timeoutMs).then(
        (value) => {
          if (settled) return;
          successes.push(value);
          doneCount++;
          // Early-resolve: any value with an agreeing partner decides it.
          for (const candidate of successes) {
            let count = 0;
            for (const other of successes) {
              if (equals(candidate, other)) count++;
            }
            if (count >= 2) {
              finishResolve(candidate, count);
              return;
            }
          }
          if (doneCount === tasks.length) {
            finishReject(
              `quorum unreachable: ${successes.length} sources succeeded but none agreed`,
            );
          }
        },
        () => {
          if (settled) return;
          failures++;
          doneCount++;
          const remaining = tasks.length - doneCount;
          if (successes.length + remaining < 2) {
            // Even if every pending leg succeeded, 2 agreeing successes
            // are impossible — fail now instead of waiting out timeouts.
            finishReject(
              `quorum unreachable: at most ${successes.length + remaining} of ${tasks.length} ` +
                `sources can succeed (${failures} failed, ${successes.length} succeeded)`,
            );
          } else if (doneCount === tasks.length) {
            finishReject(
              `quorum unreachable: only ${successes.length} of ${tasks.length} sources succeeded`,
            );
          }
        },
      );
    });
  });
}

interface BreakerState {
  failures: number;
  openedAt: number | null;
  // True while exactly one half-open trial is in flight. Other callers
  // arriving during the trial get CIRCUIT_OPEN instead of running as
  // additional trials.
  halfOpenTrial: boolean;
}

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly states = new Map<string, BreakerState>();

  constructor(threshold: number = CIRCUIT_THRESHOLD, cooldownMs: number = CIRCUIT_COOLDOWN_MS) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  async call<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    let state = this.states.get(key);
    if (!state) {
      state = { failures: 0, openedAt: null, halfOpenTrial: false };
      this.states.set(key, state);
    }
    if (state.openedAt !== null) {
      if (now - state.openedAt < this.cooldownMs) {
        throw new ApiError(
          502,
          "CIRCUIT_OPEN",
          `circuit open for ${key}; retry after cooldown`,
        );
      }
      // Cooldown elapsed: half-open. Exactly ONE caller becomes the trial;
      // the flag is set synchronously before any await, so concurrent
      // callers see it and get CIRCUIT_OPEN instead of running as trials.
      // The breaker is NOT reset here: a failed trial re-opens at once
      // (openedAt = now) instead of counting as 1/threshold.
      if (state.halfOpenTrial) {
        throw new ApiError(
          502,
          "CIRCUIT_OPEN",
          `circuit half-open trial in flight for ${key}; retry after cooldown`,
        );
      }
      state.halfOpenTrial = true;
    }
    try {
      const result = await fn();
      state.failures = 0;
      state.openedAt = null;
      state.halfOpenTrial = false;
      return result;
    } catch (err) {
      if (state.halfOpenTrial) {
        // Trial failed: re-open immediately, do not count toward threshold.
        state.halfOpenTrial = false;
        state.failures = 0;
        state.openedAt = Date.now();
      } else {
        state.failures += 1;
        if (state.failures >= this.threshold) {
          state.openedAt = Date.now();
        }
      }
      throw err;
    }
  }
}
