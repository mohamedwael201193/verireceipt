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

export async function quorum2of3<T>(
  tasks: Array<() => Promise<T>>,
  equals: (a: T, b: T) => boolean,
  timeoutMs: number = TIMEOUT_MS,
): Promise<{ value: T; votes: string }> {
  const settled = await Promise.allSettled(
    tasks.map((task) => withTimeout(task, timeoutMs)),
  );
  const successes: T[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") successes.push(result.value);
  }
  if (successes.length < 2) {
    throw new ApiError(
      502,
      "QUORUM_UNREACHABLE",
      `quorum unreachable: only ${successes.length} of ${tasks.length} sources succeeded`,
    );
  }
  // First value (in task order) that has at least one equal partner wins.
  for (let i = 0; i < successes.length; i++) {
    let count = 1;
    for (let j = 0; j < successes.length; j++) {
      if (j !== i && equals(successes[i], successes[j])) count++;
    }
    if (count >= 2) {
      return { value: successes[i], votes: `${count}/${tasks.length} sources agreed` };
    }
  }
  throw new ApiError(
    502,
    "QUORUM_UNREACHABLE",
    `quorum unreachable: ${successes.length} sources succeeded but none agreed`,
  );
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
