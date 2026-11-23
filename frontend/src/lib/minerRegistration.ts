/**
 * Current Sepolia registration 6177: confirmed updateMiner of 6176, block 12194171.
 * Node activation stays live-read and requires the exact id, status and YAML hash.
 * Historical serving IDs are retained for old paid receipts, never rewritten.
 */
import { useLiveQuery, type LiveQueryResult } from "./hooks";
import { DECLARED_INTENTS } from "./minerManifest";

export const SEPOLIA_REGISTRATION_ID = 6177;

/** The intents registration 6177 declares on chain. The 45-intent updateMiner
 * (tx below) landed 2026-11-23, so this now equals the working miner.yaml's
 * DECLARED_INTENTS; kept as a distinct export because it is the on-chain truth. */
export const SEPOLIA_REGISTERED_INTENTS = DECLARED_INTENTS;

export const SEPOLIA_PREVIOUS_REGISTRATION_ID = 6176;
export const SEPOLIA_REGISTER_TX =
  "0xc6ba683b68ca2e5fec185620085cf76c8e6f31467a62e62f03db82b8b4d1ba74";
export const SEPOLIA_REGISTER_BLOCK = 12194171;
export const SEPOLIA_YAML_HASH =
  "0xabaee05348e6d4374dd7fbf0c9da6a14794dfc372bffdb37b8958d1107b44d7a";
export const SEPOLIA_YAML_PIN = "d604c5433276e70af9e2d359ce9d096f951f85fa";
/**
 * Every registration id that has answered paid calls for slug "verireceipt".
 * Telegraph receipts name the registration that served the call, so committed
 * purchases keep their old id after an updateMiner; ids are appended, never
 * rewritten. The current registration is always included.
 */
export const SEPOLIA_SERVING_REGISTRATION_IDS: readonly number[] = Array.from(
  new Set([6152, 6160, 6174, 6176, SEPOLIA_REGISTRATION_ID]), // pin:keep (historical ids)
);
export const SEPOLIA_EXPLORER_TX = `https://sepolia.etherscan.io/tx/${SEPOLIA_REGISTER_TX}`;
export const TELEGRAPH_NODE_BASE = "https://devnode.telegraphprotocol.com";

export type NodeListing =
  | { kind: "active"; raw: unknown }
  | {
      kind: "listed";
      raw: unknown;
      active: false;
      /** Live activation_status (e.g. pending, unreachable, rejected), if any. */
      status?: string;
      rejectionReason?: string;
    }
  | { kind: "not_found" }
  | { kind: "unreachable"; detail: string };

export interface MinerRegistrationStatus {
  registrationId: number;
  previousRegistrationId: number;
  registerTx: string;
  registerBlock: number;
  yamlHash: string;
  yamlPin: string;
  explorerTx: string;
  /** Live Telegraph node read for /api/miners/6177. */
  nodeByRegistrationId: NodeListing;
  /**
   * True only when the live node body for 6177 says activation_status
   * "active" AND carries registration_id 6177 AND the pinned yaml_hash
   * (all three required; no boolean fallbacks). Pending ingestion (404)
   * is not active.
   */
  nodeReportsActive: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The node wraps the record in {"miner": {...}}; accept a bare record too. */
function minerRecord(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  if (isRecord(body.miner)) return body.miner;
  return body;
}

function normHash(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  return s.startsWith("0x") ? s.slice(2) : s;
}

interface ActiveRead {
  active: boolean;
  status?: string;
  rejectionReason?: string;
}

/**
 * Strict activation gate (J2 Minor 2, r7). "active" requires ALL of:
 *   - activation_status is the string "active" (no boolean `active` /
 *     `is_active` fallback — the node's documented field is the string);
 *   - registration_id is present and equals the id that was asked for;
 *   - for 6177, yaml_hash is present and equals the pinned miner.yaml
 *     hash (a missing hash is NOT a pass).
 * Anything else is reported as listed-but-not-active with the reason.
 */
function activeFlag(body: unknown, expectedId: string): ActiveRead {
  const rec = minerRecord(body);
  if (!rec) return { active: false, status: "no miner record in the node response" };
  const reason = typeof rec.rejection_reason === "string" ? rec.rejection_reason : undefined;
  const rid = rec.registration_id;
  if (rid === undefined || rid === null) {
    return { active: false, status: "registration_id missing", rejectionReason: reason };
  }
  if (String(rid) !== expectedId) {
    return {
      active: false,
      status: `registration_id ${String(rid)} != ${expectedId}`,
      rejectionReason: reason,
    };
  }
  const v = rec.activation_status;
  if (typeof v !== "string") {
    return { active: false, status: "activation_status missing", rejectionReason: reason };
  }
  const status = v.trim().toLowerCase();
  if (status !== "active") return { active: false, status, rejectionReason: reason };
  if (expectedId === String(SEPOLIA_REGISTRATION_ID)) {
    const h = normHash(rec.yaml_hash);
    if (h === undefined || h.length === 0) {
      return { active: false, status: "active but yaml_hash missing", rejectionReason: reason };
    }
    if (h !== normHash(SEPOLIA_YAML_HASH)) {
      return { active: false, status: "active with an unexpected yaml_hash", rejectionReason: reason };
    }
  }
  return { active: true, status, rejectionReason: reason };
}

export async function readNodeMiner(
  id: string | number,
  signal?: AbortSignal,
): Promise<NodeListing> {
  const url = `${TELEGRAPH_NODE_BASE}/api/miners/${encodeURIComponent(String(id))}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", signal, headers: { Accept: "application/json" } });
  } catch (err) {
    if (signal?.aborted) throw err;
    const detail = err instanceof Error ? err.message : "network error";
    return { kind: "unreachable", detail };
  }
  if (res.status === 404) return { kind: "not_found" };
  if (!res.ok) {
    return { kind: "unreachable", detail: `HTTP ${res.status}` };
  }
  let raw: unknown = null;
  try {
    raw = await res.json();
  } catch {
    return { kind: "unreachable", detail: "node returned a non-JSON body" };
  }
  if (isRecord(raw) && typeof raw.error === "string" && /not found/i.test(raw.error)) {
    return { kind: "not_found" };
  }
  const flag = activeFlag(raw, String(id));
  if (flag.active === true) return { kind: "active", raw };
  return {
    kind: "listed",
    raw,
    active: false,
    ...(flag.status ? { status: flag.status } : {}),
    ...(flag.rejectionReason ? { rejectionReason: flag.rejectionReason } : {}),
  };
}

export async function fetchMinerRegistrationStatus(
  signal?: AbortSignal,
): Promise<MinerRegistrationStatus> {
  const nodeByRegistrationId = await readNodeMiner(SEPOLIA_REGISTRATION_ID, signal);
  return {
    registrationId: SEPOLIA_REGISTRATION_ID,
    previousRegistrationId: SEPOLIA_PREVIOUS_REGISTRATION_ID,
    registerTx: SEPOLIA_REGISTER_TX,
    registerBlock: SEPOLIA_REGISTER_BLOCK,
    yamlHash: SEPOLIA_YAML_HASH,
    yamlPin: SEPOLIA_YAML_PIN,
    explorerTx: SEPOLIA_EXPLORER_TX,
    nodeByRegistrationId,
    nodeReportsActive: nodeByRegistrationId.kind === "active",
  };
}

export function useMinerRegistration(): LiveQueryResult<MinerRegistrationStatus> {
  return useLiveQuery("miner-registration", (signal) => fetchMinerRegistrationStatus(signal));
}

export function describeNodeListing(listing: NodeListing): string {
  if (listing.kind === "active") return "active (live Telegraph node)";
  if (listing.kind === "listed") {
    const st = listing.status ? ` (status: ${listing.status})` : "";
    const why = listing.rejectionReason ? ` — ${listing.rejectionReason}` : "";
    return `listed on the live Telegraph node, not marked active${st}${why}`;
  }
  if (listing.kind === "not_found") {
    return "not listed yet — node ingestion pending (UNVERIFIED)";
  }
  return `node unreachable (${listing.detail}) — UNVERIFIED`;
}
