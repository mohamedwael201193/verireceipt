// Desk Phase D panel: the autonomous Desk agent's escrow-paid purchases
// through the Telegraph engine (Ethereum Sepolia escrow, testnet). Every
// row comes from the committed ledger (desk/ledger/purchases.jsonl); the
// only live action is "Re-hash", which fetches the stored raw bytes via
// /api/receipts/:id/raw and SHA-256s them in this browser. The epoch
// delivery proof shows what the ledger last recorded ("pending" until the
// node records the epoch's block, "error" if the delivery lookup failed,
// "included" once it is in that root); the link re-checks it at the node.
// The Telegraph receipt_hash is plain text; a separately labelled "signal"
// link opens the signal record. The official delivery URL
// (GET /v1/blocks/{epoch}/deliveries/{receipt_hash}) lives on the Epoch
// proof column. Links are plain anchors: the Dashboard renders outside a
// router in its tests, like the rest of the dashboard views.
import { useState } from "react";
import { auditLinks, deliveryStatus, DESK_PURCHASES, DESK_PURCHASES_LOAD_ERROR, formatRecoveredValue, purchaseVerdict, recoveredFromRaw, rehashStoredRaw, summarize, uusdcToUsd, type DeskPurchase, type RehashResult } from "../../lib/deskPurchases";
import { formatDate, shortHash } from "./utils";

function formatValue(p: DeskPurchase): string {
  if (typeof p.value !== "number") return "—";
  return p.value_field === "tvl_usd"
    ? `$${Math.round(p.value).toLocaleString("en-US")}`
    : `${p.value} USD/MWh`;
}

export default function EscrowPurchases({ rows, loadError }: { rows?: DeskPurchase[]; loadError?: string | null }) {
  const resolvedRows = rows ?? DESK_PURCHASES;
  const error = loadError === undefined ? DESK_PURCHASES_LOAD_ERROR : loadError;
  const s = summarize(resolvedRows);
  const [rehash, setRehash] = useState<Record<string, RehashResult | "running">>({});

  async function run(p: DeskPurchase) {
    const key = p.telegraph_receipt.receipt_hash;
    setRehash((m) => ({ ...m, [key]: "running" }));
    const r = await rehashStoredRaw(p);
    setRehash((m) => ({ ...m, [key]: r }));
  }

  return (
    <section aria-label="Desk escrow purchases" style={{ marginTop: 22 }}>
      <div className="view-head">
        <div>
          <div className="kicker">// desk phase d · escrow-paid purchases · telegraph engine · sepolia testnet</div>
          <h2 className="h1-ed" style={{ fontSize: 28 }}>
            Escrow <span className="serif-i">Purchases.</span>
          </h2>
        </div>
      </div>
      <div className="note-line" style={{ marginBottom: 12 }}>
        The Desk agent buys answers on its own: it reads the escrow balance, takes the node&apos;s 402 challenge, signs the
        escrow template (EIP-191) with the operator wallet and calls <code className="mono">POST /engine/v1/ask/774921</code>.
        It then re-derives the node&apos;s signal hash, checks the answer value, and SHA-256s the miner&apos;s stored raw bytes.
        Escrow has no per-call transaction: each call is billed in its epoch&apos;s ledger root once that block is recorded.
        Browser Desk runs above stay direct and unbilled.
      </div>
      {error ? (
        <div className="note-line" role="alert" style={{ marginBottom: 12, color: "var(--err)" }}>
          Escrow Purchases could not load the committed ledger ({error}). The rest of the dashboard is still available.
        </div>
      ) : null}
      <div className="kpi-grid-4">
        <div className="kpi-cell">
          <div className="kpi-lbl">Escrow Purchases</div>
          <div className="kpi-val mono">{s.total}</div>
          <div className="kpi-sub">committed ledger</div>
        </div>
        <div className="kpi-cell">
          <div className="kpi-lbl">Verified End-to-End</div>
          <div className="kpi-val mono" style={{ color: "var(--ok)" }}>{s.verified}</div>
          <div className="kpi-sub">signal hash + value + raw sha256</div>
        </div>
        <div className="kpi-cell">
          <div className="kpi-lbl">Escrow Spend</div>
          <div className="kpi-val mono">{uusdcToUsd(s.spentUusdc)}</div>
          <div className="kpi-sub">Sepolia Test USDC · {s.spentUusdc.toLocaleString("en-US")} μUSDC</div>
        </div>
        <div className="kpi-cell">
          <div className="kpi-lbl">Epochs</div>
          <div className="kpi-val mono">{s.epochs.length ? s.epochs.join(", ") : "—"}</div>
          <div className="kpi-sub">{s.epochsSubtext}</div>
        </div>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        <div className="tbl-wrap">
          <table className="hl-tbl">
            <thead>
              <tr>
                <th>Bought (UTC)</th>
                <th>Mission</th>
                <th>Input</th>
                <th>Answer</th>
                <th>Paid</th>
                <th>Telegraph receipt_hash</th>
                <th>Epoch proof</th>
                <th>VeriReceipt receipt</th>
                <th>raw_response_sha256</th>
                <th>Verdict</th>
                <th>Re-hash</th>
              </tr>
            </thead>
            <tbody>
              {resolvedRows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="mono" style={{ textAlign: "center", padding: 28, color: "var(--muted)" }}>
                    No escrow purchases recorded.
                  </td>
                </tr>
              ) : (
                resolvedRows.map((p) => {
                  const links = auditLinks(p);
                  const rh = rehash[p.telegraph_receipt.receipt_hash];
                  return (
                    <tr key={p.telegraph_receipt.receipt_hash}>
                      <td className="mono" style={{ fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap" }}>{formatDate(p.bought_at)}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{p.title}</td>
                      <td className="mono" style={{ fontSize: 11, color: "var(--soft)" }}>{Object.values(p.params).join(" · ")}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{formatValue(p)}
                        {recoveredFromRaw(p).length ? (
                          <div style={{ marginTop: 4, color: "var(--soft)" }}>
                            {recoveredFromRaw(p).map((f) => (
                              <div key={f.field}>{f.field}: {formatRecoveredValue(f.value)}</div>
                            ))}
                            <div>recovered from hash-verified raw</div>
                          </div>
                        ) : null}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{uusdcToUsd(Number(p.telegraph_receipt.amount_uusdc))} escrow</td>
                      <td className="mono" style={{ fontSize: 11 }} title={p.telegraph_receipt.receipt_hash}>
                        {shortHash(p.telegraph_receipt.receipt_hash)}
                        {" · "}
                        <a href={links.signal} target="_blank" rel="noreferrer">signal</a>
                      </td>
                      <td className="mono" style={{ fontSize: 11 }}>
                        <a href={links.delivery} target="_blank" rel="noreferrer">
                          #{p.telegraph_receipt.epoch_id} · {deliveryStatus(p)}
                        </a>
                      </td>
                      <td className="mono" style={{ fontSize: 11 }}>
                        {p.miner_receipt ? <a href={`/receipts/${p.miner_receipt.receipt_id}`}>{p.miner_receipt.receipt_id}</a> : "—"}
                      </td>
                      <td className="mono" style={{ fontSize: 11, color: "var(--muted)" }} title={p.miner_receipt?.raw_response_sha256 ?? ""}>
                        {shortHash(p.miner_receipt?.raw_response_sha256)}
                      </td>
                      <td>
                        <span className={`badge ${purchaseVerdict(p) === "VERIFIED" ? "b-ok" : "b-warn"}`}>{purchaseVerdict(p)}</span>
                      </td>
                      <td className="mono" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                        {rh === "running" ? (
                          "hashing…"
                        ) : rh?.state === "match" ? (
                          <span style={{ color: "var(--ok)" }}>MATCH · {rh.bytes} B</span>
                        ) : rh?.state === "mismatch" ? (
                          <span style={{ color: "var(--err)" }}>MISMATCH</span>
                        ) : rh?.state === "error" ? (
                          <span style={{ color: "var(--warn)" }}>UNVERIFIED ({rh.message})</span>
                        ) : (
                          <button type="button" className="btn-ghost" style={{ padding: "3px 9px", fontSize: 10 }} onClick={() => void run(p)} disabled={!p.miner_receipt}>
                            Re-hash
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
