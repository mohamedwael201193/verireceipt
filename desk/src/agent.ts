// The autonomous Desk loop: plan -> check escrow -> buy (escrow, signed by
// the payer key) -> verify end to end -> record. No human step between.
import { DESK_DAILY_CAP_UUSDC, VERIRECEIPT_MINER_ID } from "./constants.js";
import { escrowAskMiner, type Fetch, type Payer, type RawResponse } from "./client.js";
import { appendLedger, readLedger, spentOnUtcDay, type PurchaseRecord } from "./ledger.js";
import { planTasks, type DeskTask } from "./missions.js";
import { verifyPurchase } from "./verify.js";

export interface AgentOptions {
  ledgerFile: string;
  /** Every id the node uses for the VeriReceipt miner (catalogue id + on-chain registration id). */
  minerIds: readonly string[];
  taskIds?: readonly string[];
  now?: () => Date;
  f?: Fetch;
  onRawResponse?: (task: DeskTask, raw: RawResponse) => void;
  log?: (line: string) => void;
}

export async function runDesk(payer: Payer, opts: AgentOptions): Promise<PurchaseRecord[]> {
  const now = (opts.now ?? (() => new Date()))();
  const log = opts.log ?? (() => {});
  const tasks = planTasks(now).filter((t) => !opts.taskIds || opts.taskIds.includes(t.id));
  const out: PurchaseRecord[] = [];
  for (const task of tasks) {
    const spent = spentOnUtcDay(readLedger(opts.ledgerFile), new Date());
    log(`${task.id}: buying ${task.intent} ${JSON.stringify(task.params)} (spent today ${spent} μUSDC)`);
    const paid = await escrowAskMiner(VERIRECEIPT_MINER_ID, { intent: task.intent, params: task.params }, payer, {
      spentTodayUusdc: spent,
      dailyCapUusdc: DESK_DAILY_CAP_UUSDC,
      minerIds: opts.minerIds,
      f: opts.f,
      onRawResponse: (raw) => opts.onRawResponse?.(task, raw),
    });
    const body = paid.body as {
      miner_id?: string; endpoint?: string; result?: Record<string, unknown>; result_shape?: string;
      field_status?: Record<string, string>; duration_ms?: number; signal_hash?: string;
    };
    const signalHash = String(body.signal_hash ?? "");
    const v = /^0x[0-9a-f]{64}$/.test(signalHash)
      ? await verifyPurchase(
          { payer: paid.authorization.from, minerSlug: "verireceipt", signalHash, valueField: task.valueField, engineResult: body.result ?? {}, intent: task.intent },
          opts.f,
        )
      : { verified: false, checks: [{ name: "signal_hash present", ok: false, detail: "no signal_hash in the reply" }], minerReceipt: null, rawSha256: null, rawBytes: null, payloadValue: undefined, intentId: null, request: null, requestParams: null };
    const rec: PurchaseRecord = {
      version: 1,
      task_id: task.id,
      mission: task.mission,
      title: task.title,
      intent: task.intent,
      params: task.params,
      bought_at: new Date(paid.receipt.timestamp * 1000).toISOString(),
      payer: paid.authorization.from,
      miner_catalogue_id: VERIRECEIPT_MINER_ID,
      nonce: paid.authorization.nonce,
      valid_after: paid.authorization.validAfter,
      valid_before: paid.authorization.validBefore,
      quoted_uusdc: paid.quotedUusdc.toString(),
      telegraph_receipt: {
        receipt_hash: paid.receipt.receipt_hash,
        rail: paid.receipt.rail,
        miner: String(paid.receipt.miner),
        amount_uusdc: String(paid.receipt.amount_uusdc),
        epoch_id: paid.receipt.epoch_id,
        settlement: paid.receipt.settlement,
        chain: paid.receipt.chain,
        timestamp: paid.receipt.timestamp,
      },
      signal_hash: signalHash,
      engine: {
        miner_id: String(body.miner_id ?? ""),
        endpoint: String(body.endpoint ?? ""),
        result_shape: String(body.result_shape ?? ""),
        field_status: body.field_status ?? {},
        duration_ms: typeof body.duration_ms === "number" ? body.duration_ms : null,
      },
      value_field: task.valueField,
      value: v.payloadValue ?? null,
      miner_receipt: v.minerReceipt
        ? { receipt_id: v.minerReceipt.receipt_id, raw_response_sha256: v.minerReceipt.raw_response_sha256, upstream_url: v.minerReceipt.upstream_url }
        : null,
      raw_sha256_recomputed: v.rawSha256,
      raw_bytes: v.rawBytes,
      checks: v.checks,
      verdict: v.verified ? "VERIFIED" : "UNVERIFIED",
      delivery_proof: null,
    };
    appendLedger(opts.ledgerFile, rec);
    log(`${task.id}: ${rec.verdict} receipt_hash=${rec.telegraph_receipt.receipt_hash} epoch=${rec.telegraph_receipt.epoch_id} rcpt=${rec.miner_receipt?.receipt_id ?? "-"}`);
    out.push(rec);
  }
  return out;
}
