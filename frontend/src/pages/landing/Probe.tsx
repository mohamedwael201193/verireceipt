// Terminal probe card — "Your turn. What are we verifying, or probing?"
//
// The design's probe was simulated: the trap was a string check on the
// payload, and "verification" hashed a canned string. This port sends the
// user's payload to the LIVE endpoint, renders the actual response (or
// the actual 422 error body), and verifies the receipt with a real
// SHA-256 recompute (see VerifyBadge). Copy curl builds a real GET curl.
import { useState } from "react";
import { ApiError } from "../../lib/api";
import { ReceiptCard } from "../../components/ReceiptCard";
import { INTENTS, PRESETS, TRAP_PRESETS, type IntentKey } from "./data";
import { callLive, type AnyResponse } from "./calls";
import { apiUrlFor, curlFor, errorMessage, hlJSON } from "./utils";
import { copyText } from "./toast";
import { VerifyBadge } from "./VerifyBadge";

const CHIP_PRESETS: { id: string; label: string; key: IntentKey; trap: boolean }[] = [
  { id: "tx", label: "TX: Block 15725067", key: "tx", trap: false },
  { id: "sec", label: "SEC: AAPL 10-K", key: "sec", trap: false },
  { id: "tvl", label: "TVL: aave-v3", key: "tvl", trap: false },
  { id: "route", label: "Route: 1 ETH → USDC", key: "route", trap: false },
  { id: "grid", label: "Grid: CAISO NP15", key: "grid", trap: false },
  { id: "trap", label: "422 Trap: Future Grid", key: "grid", trap: true },
];

export function Probe() {
  const [intent, setIntent] = useState<IntentKey>("tx");
  const [payload, setPayload] = useState(() => JSON.stringify(PRESETS.tx));
  const [force422, setForce422] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<AnyResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [ms, setMs] = useState<number | null>(null);
  const [paramsUsed, setParamsUsed] = useState<Record<string, string> | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function run(key: IntentKey, rawPayload: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawPayload);
    } catch {
      setFormError("Payload is not valid JSON — fix it and run again.");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setFormError("Payload must be a JSON object of query parameters.");
      return;
    }
    const params = parsed as Record<string, string>;
    setFormError(null);
    setLoading(true);
    setData(null);
    setError(null);
    setMs(null);
    setParamsUsed(params);
    const t0 = performance.now();
    try {
      const res = await callLive(key, params);
      setData(res);
      setMs(Math.round(performance.now() - t0));
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(errorMessage(err), 0));
      setMs(Math.round(performance.now() - t0));
    } finally {
      setLoading(false);
    }
  }

  function applyPreset(key: IntentKey, trap: boolean) {
    setIntent(key);
    setForce422(trap);
    const p = trap ? TRAP_PRESETS[key] : PRESETS[key];
    setPayload(JSON.stringify(p));
    void run(key, JSON.stringify(p));
  }

  function onIntentChange(key: IntentKey) {
    setIntent(key);
    const p = force422 ? TRAP_PRESETS[key] : PRESETS[key];
    setPayload(JSON.stringify(p));
  }

  function onModeChange(trap: boolean) {
    setForce422(trap);
    const p = trap ? TRAP_PRESETS[intent] : PRESETS[intent];
    setPayload(JSON.stringify(p));
  }

  const jsonBody: unknown = error
    ? { error: error.message, code: error.code ?? null, status: error.status }
    : data;

  return (
    <section id="probe" className="sec-pad" style={{ paddingTop: 32 }}>
      <div className="term-card">
        <h2 className="sec-h2" style={{ marginBottom: 28 }}>
          Your turn.{" "}
          <span className="it">
            What are
            <br />
            we verifying, or probing?
          </span>
        </h2>

        <div className="mono" style={{ maxWidth: 820, display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 12.5, color: "var(--muted)" }}>$ probe-verireceipt</div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {CHIP_PRESETS.map((c) => (
              <button
                key={c.id}
                type="button"
                className="btn-pill-ghost mono"
                style={{
                  padding: "5px 11px",
                  fontSize: 11,
                  ...(c.trap ? { borderColor: "rgba(245,158,11,0.5)", color: "var(--warn)" } : {}),
                }}
                onClick={() => applyPreset(c.key, c.trap)}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div className="term-row">
            <label htmlFor="pr-sel" style={{ fontSize: 12.5, color: "var(--soft)" }}>
              <span style={{ color: "var(--accent)" }}>?</span> intent
            </label>
            <select
              id="pr-sel"
              className="term-input"
              value={intent}
              onChange={(e) => onIntentChange(e.target.value as IntentKey)}
            >
              {INTENTS.map((it) => (
                <option key={it.key} value={it.key}>
                  {it.name}
                </option>
              ))}
            </select>
          </div>

          <div className="term-row">
            <label htmlFor="pr-inp" style={{ fontSize: 12.5, color: "var(--soft)" }}>
              <span style={{ color: "var(--accent)" }}>?</span> payload
            </label>
            <input
              id="pr-inp"
              type="text"
              className="term-input"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              aria-label="Payload JSON"
              spellCheck={false}
            />
          </div>

          <div className="term-row">
            <span style={{ fontSize: 12.5, color: "var(--soft)" }}>
              <span style={{ color: "var(--accent)" }}>?</span> response mode
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className={`micro-btn${!force422 ? " active" : ""}`}
                style={{ padding: "4px 10px", fontSize: 11 }}
                onClick={() => onModeChange(false)}
                aria-pressed={!force422}
              >
                200 OK
              </button>
              <button
                type="button"
                className={`micro-btn${force422 ? " active" : ""}`}
                style={{ padding: "4px 10px", fontSize: 11 }}
                onClick={() => onModeChange(true)}
                aria-pressed={force422}
              >
                422 Refusal
              </button>
            </div>
          </div>

          {formError && (
            <div role="alert" style={{ fontSize: 12, color: "var(--bad)" }}>
              {formError}
            </div>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14, paddingTop: 4 }}>
            <button
              type="button"
              className="btn-solid-accent"
              style={{ padding: "11px 22px", fontSize: 13 }}
              disabled={loading}
              onClick={() => void run(intent, payload)}
            >
              {loading ? "Verifying…" : "Verify SHA-256 →"}
            </button>
            <button
              type="button"
              className="mono"
              style={{ fontSize: 12, textDecoration: "underline", textUnderlineOffset: 4 }}
              onClick={() => {
                try {
                  const p = JSON.parse(payload) as Record<string, string>;
                  void copyText(curlFor(intent, p));
                } catch {
                  // Payload is not valid JSON — copy the curl for the preset instead.
                  void copyText(curlFor(intent, force422 ? TRAP_PRESETS[intent] : PRESETS[intent]));
                }
              }}
            >
              Copy curl
            </button>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>// live crypto.subtle.digest(&apos;SHA-256&apos;)</span>
          </div>

          {(data || error) && !loading && (
            <div id="pr-out" style={{ border: "1px solid var(--border)", borderRadius: 10, background: "#0B0B0C", overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.09)", display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 11.5 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className={`badge ${error ? "b-warn" : "b-ok"}`}>
                    {error ? `${error.status || "ERR"} ${error.status === 422 ? "UNPROCESSABLE" : "ERROR"}` : "200 OK"}
                  </span>
                  <span style={{ color: "#8F8E8A" }}>
                    {ms ?? "—"} ms · {error ? "unbilled refusal" : "live response"}
                  </span>
                </div>
              </div>
              <pre style={{ padding: 14, fontSize: 12, lineHeight: 1.65, color: "#F3F2EE" }} dangerouslySetInnerHTML={{ __html: hlJSON(jsonBody) }} />
              {data && (
                <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                  <ReceiptCard receipt={data.receipt} />
                  {paramsUsed && <VerifyBadge url={apiUrlFor(intent, paramsUsed)} />}
                </div>
              )}
              {error && (
                <div style={{ padding: "0 14px 14px", fontSize: 12, color: "#8F8E8A", lineHeight: 1.6 }}>
                  The oracle refused this input instead of guessing — no receipt is issued for a refusal.
                </div>
              )}
            </div>
          )}
          {loading && (
            <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "#0B0B0C", padding: 14, fontSize: 12, color: "#8F8E8A" }}>
              // querying the live endpoint…
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
