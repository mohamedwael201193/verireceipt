import { useRef, useState } from "react";
import { inspectResearchReport, type InspectedResearchReport } from "../lib/researchReport";
import "./research.css";
import "./research-flow.css";
import historicalRun from "../../../docs/research-evidence/tesla-2024-10q-20261121.json";
import reconciliation from "../../../docs/research-evidence/tesla-2024-10q-20261121-delivery.json";

const DOCS = "https://github.com/mohamedwael201193/verireceipt";
const BREAKS = [
  { id: "identity", title: "Wrong company", detail: "The source CIK must match the frozen research question." },
  { id: "history", title: "Missing history page", detail: "Every overlapping SEC history page must be accounted for." },
  { id: "bytes", title: "Changed source bytes", detail: "A changed stored page must not pass its committed SHA256." },
  { id: "time", title: "Stale answer", detail: "Evidence must be fetched after the policy and inside its age limit." },
] as const;
export default function Research() {
  const [workspace, setWorkspace] = useState<"prepare" | "inspect" | "lab">("prepare");
  const [cik, setCik] = useState("320193");
  const [year, setYear] = useState(String(new Date().getUTCFullYear() - 1));
  const [form, setForm] = useState("10-Q");
  const [minimum, setMinimum] = useState("3");
  const [prepared, setPrepared] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [copyNote, setCopyNote] = useState("");
  const [broken, setBroken] = useState<string[]>([]);
  const [report, setReport] = useState<InspectedResearchReport | null>(null);
  const [reportError, setReportError] = useState("");
  const uploadSequence = useRef(0);
  async function readReport(file?: File) {
    const sequence = ++uploadSequence.current;
    setReport(null); setReportError("");
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error("Report must be under 2 MB.");
      const parsed = inspectResearchReport(await file.text());
      if (sequence === uploadSequence.current) setReport(parsed);
    } catch { if (sequence === uploadSequence.current) setReportError("Cannot inspect this file. Use an unmodified research-run-v1 report.json under 2 MB; this viewer does not authenticate it."); }
  }
  function prepare() {
    setPrepared(null); setError(""); setCopyNote("");
    if (!/^[1-9][0-9]{0,9}$/.test(cik) || cik.trim() !== cik) { setError("Use a CIK of 1–10 digits, no leading zeros or company-name guessing."); return; }
    if (!/^\d{4}$/.test(year) || Number(year) < 1994 || Number(year) >= new Date().getUTCFullYear()) { setError("Choose a completed calendar year from 1994 onward."); return; }
    if (!/^[0-9]{1,4}$/.test(minimum) || Number(minimum) < 1 || Number(minimum) > 1000) { setError("Minimum count must be an integer from 1 to 1000."); return; }
    setPrepared(JSON.stringify({ cik, year: Number(year), form, minimum_count: Number(minimum) }, null, 2));
  }
  const edit = (setter: (v: string) => void, value: string) => { setter(value); setPrepared(null); setCopyNote(""); setError(""); };
  async function copy() {
    if (!prepared) return;
    try { await navigator.clipboard.writeText(prepared); setCopyNote("Input copied. Nothing purchased."); }
    catch { setCopyNote("Copy unavailable. Select and copy the JSON below."); }
  }
  return <main className="rp-page">
    <header className="rp-hero">
      <div className="rp-eyebrow">FILING-COVERAGE RESEARCH / SEPOLIA TESTNET</div>
      <h1>A precise question.<br /><span>An answer you can inspect.</span></h1>
      <p>Turn an exact SEC filing question into a source-backed research appendix. See a real recorded run, then prepare your own question or explore the evidence tools.</p>
      <div className="rp-mode">PREPARATION + LAB ONLY <span>No wallet. No purchase. No live verification on this page.</span></div>
    </header>
    <section className="rp-case" aria-labelledby="rp-case-title">
      <div className="rp-case-top"><span className="rp-eyebrow">RECORDED PAID RUN / NOVEMBER 21, 2026</span><span className="rp-case-network">DIRECT · RELATED-PARTY · TESTNET</span></div>
      <div className="rp-case-grid">
        <div><h2 id="rp-case-title">Did Tesla file at least three exact 10-Qs in calendar 2024?</h2><p>The criterion was fixed before the paid request. The CLI recounted the stored SEC evidence and produced a filing-coverage appendix, not an investment recommendation.</p></div>
        <dl className="rp-case-result"><div><dt>Recorded result</dt><dd>{historicalRun.result.status}</dd></div><div><dt>Exact 10-Q filings</dt><dd>{historicalRun.result.observed_count} <small>/ minimum {historicalRun.plan.minimum_count}</small></dd></div><div><dt>Recorded cost</dt><dd>{(Number(historicalRun.testnet_amount_uusdc) / 1_000_000).toLocaleString("en-US", { style: "currency", currency: "USD" })} <small>test USDC</small></dd></div></dl>
      </div>
      <div className="rp-evidence-links" aria-label="Historical run evidence">
        <a href={historicalRun.evidence_urls.signal} target="_blank" rel="noreferrer">Inspect paid signal ↗</a>
        <a href={reconciliation.source_url} target="_blank" rel="noreferrer">Block 33 delivery record ↗</a>
        <a href={historicalRun.evidence_urls.sec_submissions} target="_blank" rel="noreferrer">SEC source ↗</a>
      </div>
      <p className="rp-case-note">Historical evidence, not a live check. The run recorded pending delivery; a separate later record reports inclusion in block 33. No local Merkle walk or finalized-settlement claim.</p>
      <details className="rp-details"><summary>See the three filings and the proof boundaries</summary>
        <div className="rp-filing-list">{historicalRun.result.rows.map(row => <a key={row.accession} href={row.source_url} target="_blank" rel="noreferrer"><span>{row.filing_date} · {row.form}</span><span>{row.accession} ↗</span></a>)}</div>
        <p>31 recorded checks passed at run time: 23 research/receipt checks and 8 signal/raw checks. This page displays the saved record; it does not rerun those checks.</p>
        <p>A free rehearsal had already returned 3. The outcome was not blind. The plan hash was not independently timestamped. This is not independent adoption, ranked routing, customer revenue or whole-mission acceptance.</p>
        <p>No time or money saving has been measured. You can obtain the same SEC files and count the exact forms and calendar dates without Telegraph.</p>
      </details>
    </section>
    <section className="rp-tools" aria-labelledby="rp-tools-title">
      <div className="rp-tools-head"><div><div className="rp-eyebrow">YOUR NEXT STEP</div><h2 id="rp-tools-title">Choose a research tool</h2></div><p>Everything below stays local to this page. Buying and independent recounting happen in the reviewed CLI.</p></div>
      <div className="rp-tool-tabs" role="tablist" aria-label="Research tools">{([
        { id: "prepare", title: "Prepare a question", detail: "Create input for the CLI" },
        { id: "inspect", title: "Inspect a saved report", detail: "Read an unverified local file" },
        { id: "lab", title: "Explore failure cases", detail: "Try the synthetic lab" },
      ] as const).map((tool, index) => <button key={tool.id} type="button" id={`rp-tab-${tool.id}`} role="tab" tabIndex={workspace === tool.id ? 0 : -1} aria-selected={workspace === tool.id} aria-controls={`rp-panel-${tool.id}`} onKeyDown={event => { const keys = ["prepare", "inspect", "lab"] as const; const current = keys.indexOf(tool.id); const next = event.key === "ArrowRight" ? (current + 1) % 3 : event.key === "ArrowLeft" ? (current + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : -1; if (next < 0) return; event.preventDefault(); setWorkspace(keys[next]); document.getElementById(`rp-tab-${keys[next]}`)?.focus(); }} onClick={() => setWorkspace(tool.id)}><span>0{index + 1}</span><span><b>{tool.title}</b><small>{tool.detail}</small></span></button>)}</div>
    </section>
    <div id="rp-panel-prepare" role="tabpanel" aria-labelledby="rp-tab-prepare" hidden={workspace !== "prepare"}>
    <section className="rp-section" aria-labelledby="rp-question">
      <div className="rp-section-head"><span>01</span><div><h2 id="rp-question">Define the research question</h2><p>Does this CIK have at least your chosen number of exact-form filings in a completed calendar year?</p></div></div>
      <form onSubmit={event => { event.preventDefault(); prepare(); }}>
        <div className="rp-fields">
          <label>SEC CIK<input value={cik} inputMode="numeric" maxLength={11} onChange={event => edit(setCik, event.target.value)} aria-describedby="rp-cik-note" /></label>
          <label>Calendar filing year<input value={year} inputMode="numeric" maxLength={4} onChange={event => edit(setYear, event.target.value)} /></label>
          <label>Exact form<select value={form} onChange={event => edit(setForm, event.target.value)}><option>10-Q</option><option>10-K</option><option>8-K</option></select></label>
          <label>Minimum count<input value={minimum} inputMode="numeric" maxLength={4} onChange={event => edit(setMinimum, event.target.value)} /></label>
        </div>
        <p id="rp-cik-note" className="rp-muted">CIK avoids name ambiguity. The criterion is yours, not a rule about legal reporting compliance. Amendments are excluded; calendar filing date is not fiscal reporting period.</p>
        <button className="rp-primary" type="submit">Prepare input <span aria-hidden="true">↗</span></button>
        {error && <p className="rp-error" role="alert">{error}</p>}
      </form>
      {prepared && <div className="rp-prepared" aria-live="polite">
        <div className="rp-output-head"><h3>Input ready, not a frozen policy or paid result</h3><button type="button" onClick={() => void copy()}>Copy input JSON</button></div>
        <pre tabIndex={0}>{prepared}</pre>{copyNote && <p role="status">{copyNote}</p>}
        <p>Save this as <code>research-input.json</code>. The local CLI creates the timestamped plan/hash before any key is loaded or purchase is made. Inspect it, then explicitly choose whether to buy on Sepolia.</p>
      </div>}
    </section>
    <details className="rp-details rp-cli-details"><summary>How to run the CLI, costs and prerequisites</summary>
    <section className="rp-section" aria-labelledby="rp-contract">
      <div className="rp-section-head"><span aria-hidden="true">CLI</span><div><h2 id="rp-contract">The evidence contract</h2><p>This is the intended CLI sequence, not a progress indicator for this browser.</p></div></div>
      <ol className="rp-pipeline">
        <li><b>Freeze</b><span>CIK, year, form, criterion, freshness and testnet cost cap.</span></li>
        <li><b>Buy once</b><span>Direct escrow ask. Reserve spend before signing; no automatic paid retry.</span></li>
        <li><b>Recount</b><span>Hash-check main + history bytes. Independently filter exact form and calendar dates.</span></li>
        <li><b>Explain</b><span>SUPPORTED, NOT_SUPPORTED or HOLD, with the source trail and limitations.</span></li>
      </ol>
      <div className="rp-terminal"><div>LOCAL CLI / NO BROWSER PAYMENT</div><pre tabIndex={0}>{`cd desk\nmkdir -p research-runs\nnpm run research -- plan research-input.json research-runs/my-question\n# Inspect the new plan before using your approved testnet account.\nnpm run research -- buy research-runs/my-question`}</pre></div>
      <p className="rp-muted">Requires the reviewed research CLI, dependencies, a dedicated Sepolia payer with an existing testnet escrow balance, and secure environment configuration. No key belongs in this page or in a command. One call is capped at $0.01 test USDC; the daily cap is $2 test USDC, subject to remaining recorded spend and reservations. A plan does not authorize spending.</p>
    </section>
    </details>
    </div>
    <div id="rp-panel-inspect" role="tabpanel" aria-labelledby="rp-tab-inspect" hidden={workspace !== "inspect"}>
    <section className="rp-section" aria-labelledby="rp-debugger">
      <div className="rp-section-head"><span>02</span><div><h2 id="rp-debugger">Inspect a saved run</h2><p>Bring the CLI's report.json into your research workflow. This is a local evidence debugger, not another paid call.</p></div></div>
      <label className="rp-upload">Choose a saved report.json<input type="file" accept="application/json,.json" onChange={event => void readReport(event.target.files?.[0])} /></label>
      <p className="rp-muted">File contents stay in this page's memory. No upload, storage or live evidence request is made by this inspector. A file can be edited: its status is a claim, not authenticated proof.</p>
      {reportError && <p className="rp-error" role="alert">{reportError}</p>}
      {report && <div className="rp-saved" aria-live="polite">
        <div className="rp-mode">UNVERIFIED LOCAL FILE / NOT LIVE VERIFICATION</div>
        <h3>File reports: {report.status}</h3><p>CIK {report.cik} · {report.form} · calendar {report.year}. Delivery reports: {report.delivery}, not a verification by this viewer.</p>
        <p>Reported criterion: at least {report.minimum_count}. Reported count: {report.status !== "HOLD" && report.checks.every(x => x.ok) ? report.count ?? "missing" : "withheld because the file reports HOLD or a failed check"}. Nothing is recounted here.</p><p>{report.reason}</p><p className="rp-hash">Plan hash reported: {report.plan_hash}</p>
        <p>{report.checks.filter(x => !x.ok).length} reported failures of {report.checks.length} reported checks. {report.status !== "HOLD" && report.checks.some(x => !x.ok) ? "The claimed success conflicts with failed checks. Treat it as HOLD until independently checked." : "Inspect the underlying source and node records before relying on this report."}</p>
        <ul className="rp-checks">{report.checks.map((check, index) => <li key={index} className={check.ok ? "" : "rp-check-failed"}><span>{check.ok ? "REPORTED PASS" : "REPORTED FAIL"}</span>{check.name}</li>)}</ul>
      </div>}
    </section>
    </div>
    <div id="rp-panel-lab" role="tabpanel" aria-labelledby="rp-tab-lab" hidden={workspace !== "lab"}>
    <section className="rp-section rp-lab" aria-labelledby="rp-lab-title">
      <div className="rp-section-head"><span>03</span><div><h2 id="rp-lab-title">Break the evidence</h2><p>Local synthetic lab. These four switches illustrate failure gates, not execution of the production verifier.</p></div></div>
      <div className="rp-lab-layout"><div className="rp-switches">{BREAKS.map(item => <label key={item.id}>
        <input type="checkbox" checked={broken.includes(item.id)} onChange={() => setBroken(old => old.includes(item.id) ? old.filter(x => x !== item.id) : [...old, item.id])} />
        <span><b>{item.title}</b><small>{item.detail}</small></span>
      </label>)}</div><div className={`rp-verdict ${broken.length ? "rp-hold" : "rp-supported"}`} role="status" aria-live="polite">
        <span>SIMULATION / NOT A RECEIPT</span><strong>{broken.length ? "HOLD" : "SUPPORTED"}</strong>
        <p>{broken.length ? `${broken.length} illustrated evidence gate${broken.length === 1 ? " fails" : "s fail"}. An unverifiable count must not become a confident claim.` : "The synthetic fixture passes its four illustrated gates. This says nothing about your CIK or any real paid answer."}</p>
        <button type="button" onClick={() => setBroken([])}>Reset lab</button>
      </div></div>
    </section>
    </div>
    <section className="rp-section rp-limits" aria-labelledby="rp-limits-title"><h2 id="rp-limits-title">A useful appendix, with honest boundaries</h2>
      <div className="rp-columns"><div><h3>What the CLI produces</h3><p>The frozen criterion, exact filing count when checks pass, a dated accession table, matching SEC document links, source checks and recorded testnet cost. A failed criterion is a valid research result.</p></div><div><h3>What it does not prove</h3><p>No investment recommendation, filing-compliance verdict, audited document contents, independent adoption or ranked routing. Stored-byte integrity is not independent source truth. Pending delivery is not settlement.</p></div></div>
      <a href={DOCS} target="_blank" rel="noreferrer">Repository + reviewed run instructions ↗</a><p className="rp-muted">VeriReceipt is a Telegraph hackathon entry with prize incentives. The browser tools do not complete a paid mission or establish an accepted judging result.</p>
    </section>
  </main>;
}
