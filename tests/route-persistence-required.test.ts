import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
const fixture = vi.hoisted(() => {
  const path = `/tmp/verireceipt-route-durability-${process.pid}-${Date.now()}.sqlite`;
  process.env.SQLITE_PATH = path;
  delete process.env.DATABASE_URL;
  return { path };
});
vi.mock("../src/core/storage", async original => ({
  ...await original<typeof import("../src/core/storage")>(), saveReceipt: vi.fn(),
}));
import { closeStorage, saveReceipt } from "../src/core/storage";
import { handleRouteWithRpcs, expectedBlockHeight } from "../src/handlers/optimalRoute";
import { sha256Hex } from "../src/core/receipt";
const unavailable = { status: 502, code: "RECEIPT_PERSIST_FAILED", message: "receipt evidence could not be stored; answer unavailable" };
const servers: Server[] = [];
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const amountOut = 3_200_000_000n;

// Synthetic RPCs are loopback-only test fixtures. Never source or evaluator data.
async function rpcFixture(): Promise<string> {
  const number = expectedBlockHeight(Math.floor(Date.now() / 1000));
  const timestamp = Math.floor(Date.now() / 1000);
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let result: unknown;
      if (body.method === "eth_blockNumber") result = `0x${number.toString(16)}`;
      else if (body.method === "eth_getBlockByNumber") result = { number: `0x${number.toString(16)}`, hash: "0x" + "a".repeat(64), parentHash: "0x" + "b".repeat(64), timestamp: `0x${timestamp.toString(16)}` };
      else if (body.method === "eth_call") {
        const data = String(body.params[0].data);
        result = "0x" + (data.startsWith("0xd06ca61f")
          ? word(32n) + word(2n) + word(1_000_000_000_000_000_000n) + word(amountOut)
          : word(amountOut) + word(1n) + word(0n) + word(100_000n));
      } else throw new Error("unexpected loopback fixture RPC method");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function quote(): Promise<Record<string, unknown>> {
  return handleRouteWithRpcs({ pair: "ETH/USDC" }, await Promise.all([rpcFixture(), rpcFixture(), rpcFixture()]));
}
beforeEach(() => {
  vi.mocked(saveReceipt).mockReset().mockResolvedValue(undefined);
  vi.stubEnv("ROUTE_NO_ROUTE_ENVELOPE", "1");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  })));
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});
afterAll(async () => {
  await closeStorage();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(fixture.path + suffix, { force: true });
});
for (const pair of ["NOT-A-PAIR", "UNLISTED/USDC"]) {
  for (const reason of [new Error("synthetic-private-storage-diagnostic"), Object.assign(new Error("deadline"), { code: "STORAGE_TIMEOUT" }), "untyped storage rejection"]) {
    it(`${pair}: refuses an unpersisted refusal (${String(reason)})`, async () => {
      vi.mocked(saveReceipt).mockRejectedValueOnce(reason);
      const error = await handleRouteWithRpcs({ pair }, []).catch(error => error);
      expect(error).toMatchObject(unavailable);
      expect(error.responseBody).toBeUndefined();
      expect(saveReceipt).toHaveBeenCalledTimes(1);
      expect(console.warn).not.toHaveBeenCalled();
    });
  }
  it(`${pair}: preserves a healthy stored refusal and exact evidence hash`, async () => {
    const error = await handleRouteWithRpcs({ pair }, []).catch(error => error);
    expect(error.status).toBe(400);
    expect(error.responseBody.status).toBe("unavailable");
    const [receipt, evidence] = vi.mocked(saveReceipt).mock.calls[0];
    expect(error.responseBody.receipt).toEqual(receipt);
    expect(receipt.raw_response_sha256).toBe(sha256Hex(evidence!));
  });
}
it("already-aborted refusal cannot skip the write and still carry a receipt", async () => {
  const controller = new AbortController(); controller.abort();
  const signal = controller.signal;
  vi.spyOn(AbortController.prototype, "signal", "get").mockReturnValue(signal);
  const error = await handleRouteWithRpcs({ pair: "UNLISTED/USDC" }, []).catch(error => error);
  expect(error).toMatchObject({ status: 502, code: "ROUTE_DEADLINE" });
  expect(error.responseBody).toBeUndefined();
  expect(saveReceipt).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
});
for (const reason of [new Error("synthetic-private-storage-diagnostic"), Object.assign(new Error("deadline"), { code: "STORAGE_TIMEOUT" }), "untyped storage rejection"]) {
  it(`refuses a successful quote if persistence fails (${String(reason)})`, async () => {
    vi.mocked(saveReceipt).mockRejectedValueOnce(reason);
    const error = await quote().catch(error => error);
    expect(error).toMatchObject(unavailable);
    expect(error.responseBody).toBeUndefined();
    expect(saveReceipt).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });
}
it("keeps the healthy quote value, quorum receipt and exact evidence hash", async () => {
  const result = await quote();
  expect(result.verdict).toBe("verified");
  expect(result.amount_out).toBe(Number(amountOut));
  const [receipt, evidence] = vi.mocked(saveReceipt).mock.calls[0];
  expect(result.receipt).toEqual(receipt);
  expect(receipt.raw_response_sha256).toBe(sha256Hex(evidence!));
  expect(receipt.quorum_votes).toBe("2/3 sources agreed");
});
it("does not resolve a quote before its evidence write resolves", async () => {
  let finish!: () => void;
  vi.mocked(saveReceipt).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  let resolved = false;
  const pending = quote().then(result => { resolved = true; return result; });
  await vi.waitFor(() => expect(saveReceipt).toHaveBeenCalledTimes(1));
  expect(resolved).toBe(false);
  finish();
  expect((await pending).amount_out).toBe(Number(amountOut));
});
it("deadline while refusal storage is pending never returns the late receipted body", async () => {
  let finish!: () => void;
  vi.mocked(saveReceipt).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const error = await handleRouteWithRpcs({ pair: "UNLISTED/USDC" }, [], 1).catch(error => error);
  expect(error).toMatchObject({ status: 502, code: "ROUTE_DEADLINE" });
  expect(error.responseBody).toBeUndefined();
  finish(); await new Promise(resolve => setTimeout(resolve, 5));
  expect(console.warn).not.toHaveBeenCalled();
});
