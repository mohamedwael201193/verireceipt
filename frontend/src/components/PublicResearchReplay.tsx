import { useEffect, useRef, useState } from 'react';
import { verifyPublishedSource, type BrowserReplay } from '../lib/browserReplay';
export default function PublicResearchReplay() {
  const active = useRef<AbortController | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BrowserReplay | null>(null);
  const [error, setError] = useState('');
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  async function verify() {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setRunning(true); setResult(null); setError('');
    try {
      const replay = await verifyPublishedSource(controller.signal);
      if (active.current === controller) setResult(replay);
    } catch {
      if (active.current === controller) setError('HOLD: verification did not complete. Evidence is unavailable, inconsistent, cancelled or outside this browser verifier\'s limits. No count is claimed. Use the full CLI replay for details.');
    } finally {
      if (active.current === controller) { active.current = null; setRunning(false); }
    }
  }
  return <div className="rp-public-replay">
    <h3>Verify the stored source in your browser</h3>
    <p>Fetch the real receipt and stored SEC bytes now. Your browser checks SHA256, source identity, the history manifest and all three exact-form accessions. No wallet or purchase. Two read-only requests, up to 45 seconds.</p>
    <button className="rp-primary" type="button" disabled={running} onClick={() => void verify()}>{running ? 'Checking public evidence…' : 'Verify real stored evidence'}</button>
    {running && <button className="rp-secondary" type="button" onClick={() => active.current?.abort()}>Cancel verification</button>}
    <div aria-live="polite">
      {error && <p className="rp-error" role="status">{error}</p>}
      {result && <div className="rp-prepared"><h4>PASS: stored-source check only</h4><p>{result.count} exact 10-Q accessions independently recounted for calendar 2024. {result.bytes.toLocaleString('en-US')} stored bytes match the pinned SHA256.</p><p>Checked: <time dateTime={result.checkedAt}>{result.checkedAt}</time>. Historical source, not a fresh filing answer.</p><p className="rp-hash">SHA256: {result.digest}</p><ul>{result.accessions.map(a => <li key={a}>{a}</li>)}</ul></div>}
    </div>
    <p className="rp-muted">This browser check does not validate node signal signatures, payer identity, delivery or settlement. A matching digest proves stored-byte integrity against the published record, not independent SEC truth. It is not the full 33-check CLI replay.</p>
    <details className="rp-details"><summary>Run the full no-wallet judge replay</summary><pre tabIndex={0}>npm --prefix desk run judge:verify</pre><p>From a checked-out repository with desk dependencies installed. Recomputes the public signal and delivery checks as well as the source recount. No key, signing or spending.</p><a href="https://github.com/mohamedwael201193/verireceipt/blob/3b3777046fc75015dbf8341479770c0b779120d7/docs/judge-verification.md" target="_blank" rel="noreferrer">Reproduction instructions ↗</a></details>
  </div>;
}
