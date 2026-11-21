import { useRef, useState } from "react";
import { inspectResearchReport, type InspectedResearchReport } from "../lib/researchReport";
import "./research.css";

const DOCS = "https://github.com/mohamedwael201193/verireceipt";
const BREAKS = [
  { id: "identity", title: "Wrong company", detail: "The source CIK must match the frozen research question." },
  { id: "history", title: "Missing history page", detail: "Every overlapping SEC history page must be accounted for." },
  { id: "bytes", title: "Changed source bytes", detail: "A changed stored page must not pass its committed SHA256." },
  { id: "time", title: "Stale answer", detail: "Evidence must be fetched after the policy and inside its age limit." },
] as const;
export default function Research() {
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
      <div className="rp-eyebrow">MISSION 13 / RESEARCH WORKFLOW</div>
      <h1>Ask a precise question.<br /><span>Make the evidence earn its answer.</span></h1>
      <p>A filing-coverage appendix for a researcher, not another isolated API response. Fix a criterion before buying, recount the stored SEC evidence, then support the claim or hold it.</p>
      <div className="rp-mode">PREPARATION + LAB ONLY <span>No wallet. No purchase. No live verification on this page.</span></div>
    </header>
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
    <section className="rp-section" aria-labelledby="rp-contract">
      <div className="rp-section-head"><span>02</span><div><h2 id="rp-contract">The evidence contract</h2><p>This is the intended CLI sequence, not a progress indicator for this browser.</p></div></div>
      <ol className="rp-pipeline">
        <li><b>Freeze</b><span>CIK, year, form, criterion, freshness and testnet cost cap.</span></li>
        <li><b>Buy once</b><span>Direct escrow ask. Reserve spend before signing; no automatic paid retry.</span></li>
        <li><b>Recount</b><span>Hash-check main + history bytes. Independently filter exact form and calendar dates.</span></li>
        <li><b>Explain</b><span>SUPPORTED, NOT_SUPPORTED or HOLD, with the source trail and limitations.</span></li>
      </ol>
      <div className="rp-terminal"><div>LOCAL CLI / NO BROWSER PAYMENT</div><pre tabIndex={0}>{`cd desk\nmkdir -p research-runs\nnpm run research -- plan research-input.json research-runs/my-question\n# Inspect the new plan before using your approved testnet account.\nnpm run research -- buy research-runs/my-question`}</pre></div>
      <p className="rp-muted">Requires the reviewed research CLI, dependencies, a dedicated Sepolia payer with an existing testnet escrow balance, and secure environment configuration. No key belongs in this page or in a command. One call is capped at $0.01 test USDC; the daily cap is $2 test USDC, subject to remaining recorded spend and reservations. A plan does not authorize spending.</p>
    </section>
    <section className="rp-section" aria-labelledby="rp-debugger">
      <div className="rp-section-head"><span>03</span><div><h2 id="rp-debugger">Inspect a saved run</h2><p>Bring the CLI's report.json into your research workflow. This is a local evidence debugger, not another paid call.</p></div></div>
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
    <section className="rp-section rp-lab" aria-labelledby="rp-lab-title">
      <div className="rp-section-head"><span>04</span><div><h2 id="rp-lab-title">Break the evidence</h2><p>Local synthetic lab. These four switches illustrate failure gates, not execution of the production verifier.</p></div></div>
      <div className="rp-lab-layout"><div className="rp-switches">{BREAKS.map(item => <label key={item.id}>
        <input type="checkbox" checked={broken.includes(item.id)} onChange={() => setBroken(old => old.includes(item.id) ? old.filter(x => x !== item.id) : [...old, item.id])} />
        <span><b>{item.title}</b><small>{item.detail}</small></span>
      </label>)}</div><div className={`rp-verdict ${broken.length ? "rp-hold" : "rp-supported"}`} role="status" aria-live="polite">
        <span>SIMULATION / NOT A RECEIPT</span><strong>{broken.length ? "HOLD" : "SUPPORTED"}</strong>
        <p>{broken.length ? `${broken.length} illustrated evidence gate${broken.length === 1 ? " fails" : "s fail"}. An unverifiable count must not become a confident claim.` : "The synthetic fixture passes its four illustrated gates. This says nothing about your CIK or any real paid answer."}</p>
        <button type="button" onClick={() => setBroken([])}>Reset lab</button>
      </div></div>
    </section>
    <section className="rp-section rp-limits" aria-labelledby="rp-limits-title"><h2 id="rp-limits-title">A useful appendix, with honest boundaries</h2>
      <div className="rp-columns"><div><h3>What the CLI produces</h3><p>The frozen criterion, exact filing count when checks pass, a dated accession table, matching SEC document links, source checks and recorded testnet cost. A failed criterion is a valid research result.</p></div><div><h3>What it does not prove</h3><p>No investment recommendation, filing-compliance verdict, audited document contents, independent adoption or ranked routing. Stored-byte integrity is not independent source truth. Pending delivery is not settlement.</p></div></div>
      <a href={DOCS} target="_blank" rel="noreferrer">Repository + reviewed run instructions ↗</a><p className="rp-muted">VeriReceipt is a Telegraph hackathon entry with prize incentives. This page is not a demonstration of a completed paid mission or an accepted judging result.</p>
    </section>
  </main>;
}
