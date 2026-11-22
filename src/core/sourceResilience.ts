// Source-evidence resilience, not an authority to retry or change upstream URLs.
// load() must already enforce its own whole-read timeout and byte/concurrency caps.
import { SourceReadError } from "./boundedSource";
interface Observation { raw: string; fetchedAt: string }
interface Options {
  sourceIds: readonly string[];
  now?: () => number;
  failureThreshold?: number;
  openMs?: number;
  maxAgeMs?: number;
  maxEntries?: number;
  maxBytes?: number;
}
interface Read {
  sourceId: string;
  url: string;
  load: () => Promise<Observation>;
  validate: (raw: string) => boolean;
}
export interface ResilientObservation extends Observation {
  cacheMode: "live" | "last_known_good";
  cacheAgeMs: number;
  servedAt: string;
}
interface Circuit { failures: number; openUntil: number; probing: boolean }
interface Entry extends Observation { bytes: number }
interface Overlap { pending: number; newestAt: number; keyBytes: number }
export class ResilientSources {
  private readonly circuits = new Map<string, Circuit>();
  private readonly cache = new Map<string, Entry>();
  private bytes = 0;
  private readonly overlaps = new Map<string, Overlap>();
  private overlapBytes = 0;
  private readonly now: () => number;
  private readonly threshold: number;
  private readonly openMs: number;
  private readonly maxAge: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  constructor(options: Options) {
    if (!options.sourceIds.length || options.sourceIds.length > 16 || options.sourceIds.some(id => !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) || new Set(options.sourceIds).size !== options.sourceIds.length) throw new Error("Invalid fixed source registry");
    const bounded = (value: number, maximum: number) => {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid source resilience bound");
      return value;
    };
    this.now = options.now ?? (() => Date.now());
    this.threshold = bounded(options.failureThreshold ?? 3, 10);
    this.openMs = bounded(options.openMs ?? 30_000, 30_000);
    this.maxAge = bounded(options.maxAgeMs ?? 30_000, 30_000);
    this.maxEntries = bounded(options.maxEntries ?? 64, 64);
    this.maxBytes = bounded(options.maxBytes ?? 4 * 1024 * 1024, 4 * 1024 * 1024);
    for (const id of options.sourceIds) this.circuits.set(id, { failures: 0, openUntil: 0, probing: false });
  }
  private age(value: Observation, servedAt: number): number {
    const observed = Date.parse(value.fetchedAt), age = servedAt - observed;
    if (!Number.isFinite(observed) || !Number.isFinite(age) || age < 0 || age > this.maxAge) throw new SourceReadError("SOURCE_INVALID_TIME");
    return age;
  }
  private remove(key: string): void {
    const entry = this.cache.get(key);
    if (entry) { this.bytes -= entry.bytes; this.cache.delete(key); }
  }
  // Retain ordering only while same-key loads overlap. Never evict active state.
  // Separate metadata bounds reuse maxEntries/maxBytes; pressure skips dispatch.
  private begin(key: string): Overlap | undefined {
    const active = this.overlaps.get(key);
    if (active) { active.pending++; return active; }
    const keyBytes = Buffer.byteLength(key, "utf8");
    if (this.overlaps.size >= this.maxEntries || this.overlapBytes + keyBytes > this.maxBytes) return;
    const retained = this.cache.get(key);
    const next = { pending: 1, newestAt: retained ? Date.parse(retained.fetchedAt) : -Infinity, keyBytes };
    this.overlaps.set(key, next); this.overlapBytes += keyBytes;
    return next;
  }
  private end(key: string, overlap: Overlap): void {
    if (--overlap.pending === 0) {
      this.overlaps.delete(key); this.overlapBytes -= overlap.keyBytes;
    }
  }
  private put(key: string, value: Observation): void {
    // A late older read must not replace or invalidate newer retained evidence.
    const current = this.cache.get(key);
    if (current && Date.parse(value.fetchedAt) < Date.parse(current.fetchedAt)) return;
    const bytes = Buffer.byteLength(key, "utf8") + Buffer.byteLength(value.raw, "utf8");
    // An equal/newer valid observation supersedes the entry even if too large.
    this.remove(key);
    if (bytes > this.maxBytes) return;
    while (this.cache.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.remove(this.cache.keys().next().value!);
    this.cache.set(key, { raw: value.raw, fetchedAt: value.fetchedAt, bytes }); this.bytes += bytes;
  }
  private fallback(key: string, request: Read, error: unknown): ResilientObservation {
    const entry = this.cache.get(key);
    if (entry) {
      try {
        if (request.validate(entry.raw) !== true) throw new SourceReadError("SOURCE_INVALID_BODY");
        const servedAt = this.now();
        const age = this.age(entry, servedAt);
        this.cache.delete(key); this.cache.set(key, entry);
        return { raw: entry.raw, fetchedAt: entry.fetchedAt, cacheMode: "last_known_good", cacheAgeMs: age, servedAt: new Date(servedAt).toISOString() };
      } catch { this.remove(key); }
    }
    throw error;
  }
  async read(request: Read): Promise<ResilientObservation> {
    const circuit = this.circuits.get(request.sourceId);
    if (!circuit) throw new SourceReadError("SOURCE_NOT_CONFIGURED");
    const key = request.sourceId + "\0" + request.url;
    if (circuit.openUntil && (this.now() < circuit.openUntil || circuit.probing)) return this.fallback(key, request, new SourceReadError("SOURCE_CIRCUIT_OPEN"));
    const overlap = this.begin(key);
    if (!overlap) return this.fallback(key, request, new SourceReadError("SOURCE_BUSY"));
    const probe = Boolean(circuit.openUntil);
    if (probe) circuit.probing = true;
    try {
      const value = await request.load();
      if (request.validate(value.raw) !== true) throw new SourceReadError("SOURCE_INVALID_BODY");
      const servedAt = this.now();
      const age = this.age(value, servedAt);
      circuit.failures = 0; circuit.openUntil = 0;
      const observedAt = Date.parse(value.fetchedAt);
      if (observedAt >= overlap.newestAt) {
        overlap.newestAt = observedAt;
        this.put(key, value);
      }
      return { raw: value.raw, fetchedAt: value.fetchedAt, cacheMode: "live", cacheAgeMs: age, servedAt: new Date(servedAt).toISOString() };
    } catch (error) {
      // A rejected query is not proof that unrelated requests to the provider fail.
      if (error instanceof SourceReadError && error.httpStatus === 400) throw error;
      // Local pool pressure is not evidence of a provider outage.
      if (error instanceof SourceReadError && error.code === "SOURCE_BUSY") return this.fallback(key, request, error);
      circuit.failures = Math.min(this.threshold, circuit.failures + 1);
      if (probe || circuit.failures >= this.threshold) circuit.openUntil = this.now() + this.openMs;
      return this.fallback(key, request, error);
    } finally { this.end(key, overlap); if (probe) circuit.probing = false; }
  }
}
