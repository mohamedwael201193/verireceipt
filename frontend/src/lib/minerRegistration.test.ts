import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SEPOLIA_PREVIOUS_REGISTRATION_ID,
  SEPOLIA_REGISTER_TX,
  SEPOLIA_REGISTRATION_ID,
  SEPOLIA_YAML_HASH,
  SEPOLIA_YAML_PIN,
  describeNodeListing,
  fetchMinerRegistrationStatus,
} from "./minerRegistration";

// Shape returned by GET https://devnode.telegraphprotocol.com/api/miners/6160
// on 2026-11-21 (trimmed to the fields this module reads).
const liveBody = (over: Record<string, unknown> = {}) => ({
  miner: {
    registration_id: 6160,
    slug: "verireceipt",
    activation_status: "active",
    yaml_hash: "a97b1cb87dbaaba87cf4b15e284352407a4a72c06cc568c47bfe3980e5cba06a",
    rejection_reason: null,
    retrying: false,
    ...over,
  },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("fetchMinerRegistrationStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pins the confirmed updateMiner facts for registration 6160", () => {
    expect(SEPOLIA_REGISTRATION_ID).toBe(6160);
    expect(SEPOLIA_PREVIOUS_REGISTRATION_ID).toBe(6152);
    expect(SEPOLIA_REGISTER_TX).toBe("0x93a5f833726da803d39396e208c5404889e0b64dbeb78519914fe1d18e3c1a8e");
    expect(SEPOLIA_YAML_HASH).toBe("0xa97b1cb87dbaaba87cf4b15e284352407a4a72c06cc568c47bfe3980e5cba06a");
    expect(SEPOLIA_YAML_PIN).toBe("70d7a15ec1fa61569e4a003fd21b8af46a97cfa9");
  });

  it("reads only /api/miners/6160", async () => {
    const fetchMock = vi.fn(async () => json(liveBody()));
    vi.stubGlobal("fetch", fetchMock);
    await fetchMinerRegistrationStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      "https://devnode.telegraphprotocol.com/api/miners/6160",
    );
  });

  it("does not report active when the live node 404s (ingestion pending)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "miner registration not found" }, 404)));
    const status = await fetchMinerRegistrationStatus();
    expect(status.registrationId).toBe(6160);
    expect(status.nodeReportsActive).toBe(false);
    expect(status.nodeByRegistrationId.kind).toBe("not_found");
    expect(describeNodeListing(status.nodeByRegistrationId)).toContain("UNVERIFIED");
    expect(describeNodeListing(status.nodeByRegistrationId)).not.toMatch(/\bactive\b/i);
  });

  it("reports active for the real wrapped node body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(liveBody())));
    const status = await fetchMinerRegistrationStatus();
    expect(status.nodeReportsActive).toBe(true);
    expect(status.nodeByRegistrationId.kind).toBe("active");
    expect(describeNodeListing(status.nodeByRegistrationId)).toBe("active (live Telegraph node)");
  });

  it.each(["pending", "unreachable", "rejected", "superseded", "deregistered"])(
    "treats activation_status %s as not active and surfaces it",
    async (st) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          json(liveBody({ activation_status: st, rejection_reason: st === "rejected" ? "YAML schema validation failed: x" : null })),
        ),
      );
      const status = await fetchMinerRegistrationStatus();
      expect(status.nodeReportsActive).toBe(false);
      expect(status.nodeByRegistrationId.kind).toBe("listed");
      const text = describeNodeListing(status.nodeByRegistrationId);
      expect(text).toContain("not marked active");
      expect(text).toContain(`status: ${st}`);
      if (st === "rejected") expect(text).toContain("YAML schema validation failed");
    },
  );

  it("does not report active when the body belongs to another registration", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(liveBody({ registration_id: 6152 }))));
    const status = await fetchMinerRegistrationStatus();
    expect(status.nodeReportsActive).toBe(false);
    expect(status.nodeByRegistrationId.kind).toBe("listed");
  });

  it("does not report active when the node serves a different yaml_hash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(liveBody({ yaml_hash: "9378d21b3d22a62964c85ec69a44636e0f03491214f6f7fe0414411275deeded" }))));
    const status = await fetchMinerRegistrationStatus();
    expect(status.nodeReportsActive).toBe(false);
    expect(describeNodeListing(status.nodeByRegistrationId)).toContain("unexpected yaml_hash");
  });

  it("treats a bare listed-but-not-active body as not active", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ id: 6160, active: false })));
    const status = await fetchMinerRegistrationStatus();
    expect(status.nodeReportsActive).toBe(false);
    expect(status.nodeByRegistrationId.kind).toBe("listed");
  });

  it("is unreachable (not active) on a network error or 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 503)));
    const s1 = await fetchMinerRegistrationStatus();
    expect(s1.nodeByRegistrationId.kind).toBe("unreachable");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const s2 = await fetchMinerRegistrationStatus();
    expect(s2.nodeByRegistrationId.kind).toBe("unreachable");
    expect(s2.nodeReportsActive).toBe(false);
  });

  // J2 Minor 2 (pc2-xtab-r6): the gate must need the string status AND a
  // matching registration_id AND the pinned yaml_hash. Each body below
  // reported "active" under r6.
  it.each([
    ["boolean active, no activation_status, no hash", { miner: { registration_id: 6160, active: true } }],
    ["boolean is_active, no activation_status", { miner: { registration_id: 6160, is_active: true, yaml_hash: "a97b1cb87dbaaba87cf4b15e284352407a4a72c06cc568c47bfe3980e5cba06a" } }],
    ["activation_status active but yaml_hash missing", liveBody({ yaml_hash: undefined })],
    ["activation_status active but yaml_hash empty", liveBody({ yaml_hash: "" })],
    ["activation_status active but registration_id missing", liveBody({ registration_id: undefined })],
    ["activation_status active but registration_id null", liveBody({ registration_id: null })],
    ["activation_status as a boolean true", liveBody({ activation_status: true })],
  ])("does not report active for %s", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => json(body)));
    const status = await fetchMinerRegistrationStatus();
    expect(status.nodeReportsActive).toBe(false);
    expect(status.nodeByRegistrationId.kind).toBe("listed");
    expect(describeNodeListing(status.nodeByRegistrationId)).toContain("not marked active");
  });

  it("accepts a 0x-prefixed, upper-case yaml_hash that matches the pin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(liveBody({ yaml_hash: "0x" + "a97b1cb87dbaaba87cf4b15e284352407a4a72c06cc568c47bfe3980e5cba06a".toUpperCase() }))),
    );
    const status = await fetchMinerRegistrationStatus();
    expect(status.nodeReportsActive).toBe(true);
  });
});
