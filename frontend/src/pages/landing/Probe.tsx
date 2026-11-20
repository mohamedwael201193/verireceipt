// Terminal probe card — "Your turn. What are we verifying, or probing?"
//
// The design's probe was simulated: the trap was a string check on the
// payload, and "verification" hashed a canned string. This port sends the
// user's payload to the LIVE endpoint, renders the actual response (or
// the actual 422 error body), and verifies the receipt with THE ONE
// verifier (see VerifyBadge / src/lib/verifyReceipt.ts — stored raw
// bytes first, live re-check while the miner does not serve them).
// Copy curl builds a real GET curl.
import { useRef, useState } from "react";
import { ApiError, assertValidParam } from "../../lib/api";
import { ReceiptCard } from "../../components/ReceiptCard";
import { INTENTS, PRESETS, TRAP_PRESETS, type IntentKey } from "./data";
import { callLive, type AnyResponse } from "./calls";
import { curlFor, errorMessage, hlJSON } from "./utils";
import { endpointForIntent } from "../../lib/verifyReceipt";
import { copyText } from "./toast";
import { VerifyBadge } from "./VerifyBadge";

const CHIP_PRESETS: { id: string; label: string; key: IntentKey; trap: boolean }[] = [
  { id: "tx", label: "TX: Block 26454869", key: "tx", trap: false },
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
  // The intent the DISPLAYED run used — the badge must verify the run
  // shown, not the currently selected intent (changing the select after
  // a run must not retarget the badge to a different endpoint).
  const [intentUsed, setIntentUsed] = useState<IntentKey | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // Request-id guard: two rapid runs must not race — a stale response
  // (e.g. the first chip's) must never overwrite the newest run's
  // receipt, or the VerifyBadge could verify the wrong run's receipt
  // against the displayed one.
  const reqRef = useRef(0);

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
    // Client-side param validation BEFORE any fetch: an oversize (or
    // empty / non-string) param is a FORM error, exactly like malformed
    // JSON above — the same assertValidParam the lib runs, surfaced here
    // instead of as an INVALID_PARAM error pane after a zero-fetch throw.
    // A genuine server-side 400 still renders as the error pane.
    try {
      for (const [name, value] of Object.entries(params)) assertValidParam(value, name);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : errorMessage(err));
      return;
    }
    setFormError(null);
    const id = ++reqRef.current;
    setLoading(true);
    setData(null);
    setError(null);
    setMs(null);
    setParamsUsed(params);
    setIntentUsed(key);
    const t0 = performance.now();
    try {
      const res = await callLive(key, params);
      if (reqRef.current !== id) return;
      setData(res);
      setMs(Math.round(performance.now() - t0));
    } catch (err) {
      if (reqRef.current !== id) return;
      setError(err instanceof ApiError ? err : new ApiError(errorMessage(err), 0));
      setMs(Math.round(performance.now() - t0));
    } finally {
      if (reqRef.current === id) setLoading(false);
    }
  }

  function applyPreset(key: IntentKey, trap: boolean) {
    setIntent(key);
    setForce422(trap);
    const p = trap ? TRAP_PRESETS[key] : PRESETS[key];
    setPayload(JSON.stringify(p));
    void run(key, JSON.stringify(p));
  }

  // Mid-run guard (J2 R2 M2): the select/mode buttons are disabled while
  // loading, but a programmatic change dispatch (native setter +
  // dispatchEvent) bypasses `disabled` and used to retarget the run
  // mid-flight — the VerifyBadge was then built from the NEW intent
  // with the OLD run's params. A no-op while loading closes it; real
  // users cannot reach this path without devtools.
  function onIntentChange(key: IntentKey) {
    if (loading) return;
    setIntent(key);
    const p = force422 ? TRAP_PRESETS[key] : PRESETS[key];
    setPayload(JSON.stringify(p));
  }

  function onModeChange(trap: boolean) {
    if (loading) return;
    setForce422(trap);
    const p = trap ? TRAP_PRESETS[intent] : PRESETS[intent];
    setPayload(JSON.stringify(p));
  }

  const jsonBody: unknown = error
    ? { error: error.message, code: error.code ?? null, status: error.status }
    : data;

  // The badge verifies the DISPLAYED run: the endpoint of the intent
  // that run used (intentUsed), never the currently selected intent.
  const badgeEndpoint = intentUsed ? endpointForIntent(intentUsed) : undefined;

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
                disabled={loading}
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
              disabled={loading}
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
              disabled={loading}
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
                disabled={loading}
                onClick={() => onModeChange(false)}
                aria-pressed={!force422}
              >
                200 OK
              </button>
              <button
                type="button"
                className={`micro-btn${force422 ? " active" : ""}`}
                style={{ padding: "4px 10px", fontSize: 11 }}
                disabled={loading}
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
              {loading ? "Running…" : "Run live probe →"}
            </button>
            <button
              type="button"
              className="mono"
              style={{ fontSize: 12, textDecoration: "underline", textUnderlineOffset: 4 }}
              onClick={() => {
                // Copy the DISPLAYED run's params (paramsUsed), not the
                // payload box: the box stays editable after a run, so
                // copying from it could produce a curl that does not
                // match the displayed receipt. Before any run,
                // paramsUsed is null and the box is the source.
                const p =
                  paramsUsed ??
                  (() => {
                    try {
                      return JSON.parse(payload) as Record<string, string>;
                    } catch {
                      // Payload is not valid JSON — copy the curl for the preset instead.
                      return force422 ? TRAP_PRESETS[intent] : PRESETS[intent];
                    }
                  })();
                void copyText(curlFor(intent, p));
              }}
            >
              Copy curl
            </button>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>// live endpoint · receipted response</span>
          </div>

          {(data || error) && !loading && (
            <div id="pr-out" style={{ border: "1px solid var(--border)", borderRadius: 10, background: "#0B0B0C", overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.09)", display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 11.5 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className={`badge ${error ? "b-warn" : "b-ok"}`}>
                    {error ? `${error.status || "ERR"} ${error.status === 422 ? "UNPROCESSABLE" : "ERROR"}` : "200 OK"}
                  </span>
                  <span style={{ color: "#8F8E8A" }}>
                    {ms ?? "—"} ms ·{" "}
                    {error ? (error.status === 422 ? "unbilled refusal" : "error") : "live response"}
                  </span>
                </div>
              </div>
              <pre style={{ padding: 14, fontSize: 12, lineHeight: 1.65, color: "#F3F2EE" }} dangerouslySetInnerHTML={{ __html: hlJSON(jsonBody) }} />
              {data && (
                <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                  <ReceiptCard receipt={data.receipt} />
                  {paramsUsed && badgeEndpoint && (
                    <VerifyBadge receipt={data.receipt} endpoint={badgeEndpoint} data={data} />
                  )}
                </div>
              )}
              {error && (
                <div style={{ padding: "0 14px 14px", fontSize: 12, color: "#8F8E8A", lineHeight: 1.6 }}>
                  {error.status === 422
                    ? "The oracle refused this input instead of guessing — no receipt is issued for a refusal."
                    : "The live call failed — no receipt was issued for a failed call."}
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
