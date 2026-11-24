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

// Shape returned by GET https://devnode.telegraphprotocol.com/api/miners/6177
// on 2026-11-22 (trimmed to the fields this module reads).
const liveBody = (over: Record<string, unknown> = {}) => ({
  miner: {
    registration_id: 6177,
    slug: "verireceipt",
    activation_status: "active",
    yaml_hash: "abaee05348e6d4374dd7fbf0c9da6a14794dfc372bffdb37b8958d1107b44d7a",
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

  it("pins the confirmed updateMiner facts for registration 6177", () => {
    expect(SEPOLIA_REGISTRATION_ID).toBe(6177);
    expect(SEPOLIA_PREVIOUS_REGISTRATION_ID).toBe(6176);
    expect(SEPOLIA_REGISTER_TX).toBe("0xc6ba683b68ca2e5fec185620085cf76c8e6f31467a62e62f03db82b8b4d1ba74");
    expect(SEPOLIA_YAML_HASH).toBe("0xabaee05348e6d4374dd7fbf0c9da6a14794dfc372bffdb37b8958d1107b44d7a");
    expect(SEPOLIA_YAML_PIN).toBe("d604c5433276e70af9e2d359ce9d096f951f85fa");
  });

  it("reads only /api/miners/6177", async () => {
    const fetchMock = vi.fn(async () => json(liveBody()));
    vi.stubGlobal("fetch", fetchMock);
    await fetchMinerRegistrationStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      "https://devnode.telegraphprotocol.com/api/miners/6177",
    );
  });

  it("does not report active when the live node 404s (ingestion pending)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "miner registration not found" }, 404)));
    const status = await fetchMinerRegistrationStatus();
    expect(status.registrationId).toBe(6177);
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
    vi.stubGlobal("fetch", vi.fn(async () => json({ id: 6177, active: false })));
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
    ["boolean active, no activation_status, no hash", { miner: { registration_id: 6177, active: true } }],
    ["boolean is_active, no activation_status", { miner: { registration_id: 6177, is_active: true, yaml_hash: "abaee05348e6d4374dd7fbf0c9da6a14794dfc372bffdb37b8958d1107b44d7a" } }],
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
      vi.fn(async () => json(liveBody({ yaml_hash: "0x" + "abaee05348e6d4374dd7fbf0c9da6a14794dfc372bffdb37b8958d1107b44d7a".toUpperCase() }))),
    );
    const status = await fetchMinerRegistrationStatus();
    expect(status.nodeReportsActive).toBe(true);
  });
});
