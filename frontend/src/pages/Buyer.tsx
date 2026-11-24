import { useEffect, useState } from 'react';
import './buyer.css';
import { validateBuyerPreview as validPlan, validateSavedBuyer, validateBuyerJob, verifyBuyerPreview, verifiedFilingCount, type SavedBuyer as Saved, type BuyerJob as Job } from '../lib/buyerView';
const KEY = 'vr-ranked-filing-buyer-v1';
async function api(path: string, body?: unknown) { const r = await fetch('/api/v1/buyer/' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) }); if (!r.ok) {
    const code = await r.json().then(x => x.code).catch(() => null);
    throw new Error(r.status === 404 ? 'Hosted buyer is disabled, expired or unavailable. No purchase was retried.' : `${code ?? 'Request unavailable'}. No paid retry was made.`);
} return r.json(); }
function save(s: Saved) { sessionStorage.setItem(KEY, JSON.stringify(s)); if (sessionStorage.getItem(KEY) !== JSON.stringify(s))
    throw new Error('Recovery storage failed. Purchase blocked.'); }
export default function Buyer() {
    const [cik, setCik] = useState('320193'), [year, setYear] = useState(String(new Date().getUTCFullYear() - 1)), [saved, setSaved] = useState<Saved | null>(null), [job, setJob] = useState<Job | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [access, setAccess] = useState(''), [authorized, setAuthorized] = useState(false), [recovery, setRecovery] = useState<'checking' | 'empty' | 'ready' | 'unverified'>('checking');
    async function read(s: Saved) { setJob(null); await verifyBuyerPreview(s.plan); const j = await api('jobs/' + s.plan.id); validateBuyerJob(j, s); await verifyBuyerPreview(j.plan); setJob(j); setAuthorized(true); }
    useEffect(() => { let cancelled = false; setBusy(true); void (async () => { try {
        const raw = sessionStorage.getItem(KEY);
        if (raw === null) {
            setRecovery('empty');
            return;
        }
        setRecovery('unverified');
        const s = JSON.parse(raw);
        validateSavedBuyer(s);
        await verifyBuyerPreview(s.plan);
        if (cancelled)
            return;
        setSaved(s);
        setRecovery('ready');
        setCik(s.plan.input.cik);
        setYear(String(s.plan.input.year));
        if (s.attempted)
            await read(s);
    }
    catch {
        if (!cancelled) {
            setRecovery('unverified');
            setError('Could not verify recovery. The prior charge may be unknown. No paid retry was made.');
        }
    }
    finally {
        if (!cancelled)
            setBusy(false);
    } })(); return () => { cancelled = true; }; }, []);
    async function authorize() {setBusy(true);setError('');try{await api('session',{access});setAccess('');setAuthorized(true);setNotice('Operator session authorized. Preview does not arm or purchase.');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
    async function preview() { if (recovery === 'checking' || recovery === 'unverified') return; setError(''); setNotice(''); setBusy(true); try {
        if (!/^[1-9][0-9]{0,9}$/.test(cik) || !/^\d{4}$/.test(year) || Number(year) < 1994 || Number(year) >= new Date().getUTCFullYear())
            throw new Error('Use a canonical CIK and a completed calendar year from 1994 onward.');
        await api('session');
        const { plan } = await api('plans', { cik, year: Number(year) });
        validPlan(plan);
        await verifyBuyerPreview(plan);
        if (plan.input.cik !== cik || plan.input.year !== Number(year))
            throw new Error('Preview input mismatch.');
        const s = { plan, attempted: false };
        save(s);
        setSaved(s);
        setRecovery('ready');
        setJob(null);
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    async function buy() { if (!saved || saved.attempted)
        return; setError(''); setBusy(true); try {
        validPlan(saved.plan);
        await verifyBuyerPreview(saved.plan);
        if (Date.parse(saved.plan.expires_at) <= Date.now())
            throw new Error('Preview expired. Prepare a new preview before choosing to buy.');
        const s = { ...saved, attempted: true };
        save(s);
        setSaved(s);
        const accepted = await api('plans/' + s.plan.id + '/buy', { plan_hash: s.plan.plan_hash });
        if (accepted.job_id !== s.plan.id || typeof accepted.reused !== 'boolean')
            throw new Error('Unrecognized acceptance. Recover this same job with Check result; do not buy again.');
        await read(s);
        setNotice('Request accepted. Use Check result to read progress. It never buys again.');
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    async function check() { if (!saved)
        return; setBusy(true); setError(''); try {
        await read(saved);
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    async function delivery() { if (!saved)
        return; setBusy(true); setError(''); try {
        await api('jobs/' + saved.plan.id + '/delivery', {});
        await read(saved);
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    function clear() { if (busy)
        return; try {
        sessionStorage.removeItem(KEY);
        setSaved(null);
        setRecovery('empty');
        setJob(null);
        setError('');
        setNotice('Recovery record cleared in this tab only. Existing jobs are not cancelled or refunded.');
    }
    catch {
        setError('Cannot clear recovery storage.');
    } }
    const r = job?.result, g = r?.record, checks = [...(g?.node_checks ?? []), ...(g?.miner_checks ?? []), ...(g?.source_verification?.checks ?? [])], pending = job && ['reserved', 'signing'].includes(job.state);
    return <main className="buyer-page"><header className="buyer-hero"><span className="buyer-kicker">RANKED FILING GATE / SEPOLIA TESTNET</span><h1>A narrow question.<br /><em>Evidence before confidence.</em></h1><p>Did this issuer file at least three exact Form 10-Qs in the selected calendar year? One operator-sponsored ranked request, checked against SEC source data.</p><div className="buyer-badge">TESTNET ONLY <span>0.01 test USDC per request · 2 test USDC daily service cap</span></div></header>
 <section className="buyer-card" aria-label="Operator access"><h2>Closed one-shot operator run</h2><p>Operator access is required before preview. The server must separately arm the exact plan; no browser action can arm or reset it. Read-only recovery uses your existing owner cookie after purchases close.</p>{!authorized && <><label>Operator access token<input type="password" autoComplete="off" value={access} onChange={e=>setAccess(e.target.value)} disabled={busy}/></label><button onClick={()=>void authorize()} disabled={busy || !/^[a-f0-9]{64}$/.test(access)}>Authorize operator session</button></>}</section>
 <div className="buyer-columns"><section className="buyer-card"><span className="buyer-kicker">01 / PREPARE</span><h2>Exact filing coverage</h2><p>Exact 10-Q only. No amendments, company-name guessing, investment advice or unsupported questions.</p><label>SEC CIK<input value={cik} onChange={e => setCik(e.target.value)} disabled={!!saved || busy} inputMode="numeric"/></label><label>Completed calendar year<input value={year} onChange={e => setYear(e.target.value)} disabled={!!saved || busy} inputMode="numeric"/></label><button onClick={() => void preview()} disabled={busy || !!saved || recovery === 'checking' || recovery === 'unverified'}>Prepare free preview</button><small>Preparing never signs or purchases. Preview expires after 10 minutes.</small></section>
 <section className="buyer-card buyer-preview"><span className="buyer-kicker">02 / REVIEW BEFORE BUYING</span><h2>{saved ? 'Your frozen terms' : recovery === 'empty' ? 'Nothing purchased' : recovery === 'checking' ? 'Checking recovery' : 'Recovery on HOLD'}</h2>{saved ? <><dl><div><dt>Question</dt><dd>CIK {saved.plan.input.cik} · calendar {saved.plan.input.year} · exact 10-Q</dd></div><div><dt>Rule</dt><dd>Verified filing count ≥ 3</dd></div><div><dt>Maximum authorization</dt><dd className="buyer-price">0.01 <small>test USDC</small></dd></div><div><dt>Routing / network</dt><dd>Network-ranked auto / Ethereum Sepolia</dd></div><div><dt>Preview expiry</dt><dd>{new Date(saved.plan.expires_at).toLocaleString()}</dd></div></dl><details><summary>Frozen policy, task and preview hashes</summary><p>Policy <code>{saved.plan.policy_hash}</code></p><p>Task <code>{saved.plan.task_hash}</code></p><p>Plan <code>{saved.plan.plan_hash}</code></p></details><button className="buyer-primary" disabled={busy || saved.attempted} onClick={() => void buy()}>{saved.attempted ? 'Purchase attempted, no automatic retry' : 'Buy once for 0.01 test USDC'}</button><button className="buyer-secondary" onClick={() => void check()} disabled={busy || !saved.attempted}>Check result, read only</button><a className="buyer-result-jump" href="#buyer-result" hidden={!job}>View result below</a><button className="buyer-link" onClick={clear} disabled={busy || (saved.attempted && job?.state !== 'complete')}>Clear this tab's recovery record</button></> : <p className="buyer-empty">{recovery === 'empty' ? 'Your exact question, fixed rule, policy hashes, cost and expiry appear here before you choose to buy.' : recovery === 'checking' ? "Checking this tab's saved recovery record before making a purchase claim." : 'A previous request may exist. Its charge is unknown while recovery cannot be verified. No new preview or paid retry will be started.'}</p>}<small>Dedicated operator-sponsored payer. No browser wallet or key. Related-party testnet activity, not independent adoption, revenue or mainnet use.</small></section></div>
 {error && <div role="alert" className="buyer-alert">HOLD · {error}</div>}{notice && <p role="status" className="buyer-note">{notice}</p>}{busy && <p role="status">Checking. No automatic paid retry.</p>}
 {job && <section id="buyer-result" className="buyer-card buyer-result"><span className="buyer-kicker">03 / SERVER-VERIFIED RESULT</span><h2>{g?.outcome ?? (pending ? 'Pending verification' : 'HOLD')} <small>{job.state}</small></h2><p>{g ? 'Server-checked evidence for the frozen question. This browser checks result bindings, not independent source authenticity.' : 'No verified answer is available yet. An uncertain outcome is not a free retry or refund.'}</p><div className="buyer-result-grid"><div><span>{verifiedFilingCount(r) ? 'Verified exact 10-Q count' : 'Returned count (not verified)'}</span><strong>{typeof g?.value === 'number' ? g.value : 'Not verified'}</strong></div><div><span>Node-reported charge</span><strong>{job.state === 'planned' ? 'Not purchased' : r?.charge?.status === 'receipt' ? '0.01 test USDC' : r?.charge?.status === 'not_signed' ? 'Not signed' : 'Unknown, up to 0.01 test USDC'}</strong></div><div><span>Delivery at purchase</span><strong>{g?.delivery_status ?? 'Not established'}</strong></div></div><p>No charge display proves final settlement. Merkle proofs are shape-checked only, not walked.</p>{g?.reasons?.map((x: string, i: number) => <p key={i}>{x}</p>)}<details><summary>Inspect {checks.length} source and receipt checks</summary><ul>{checks.map((c: any, i: number) => <li key={i}>{c.ok ? 'PASS' : 'HOLD'} · {c.name}: {c.detail}</li>)}</ul></details><div className="buyer-actions"><a href={'/api/v1/buyer/jobs/' + job.id + '/evidence'} download>Download full private evidence</a><button onClick={() => void delivery()} disabled={busy || job.state !== 'complete' || r?.charge?.status !== 'receipt'}>Check delivery, read only</button></div>{job.followups?.map((f: any, i: number) => <p key={i}>Delivery follow-up: {f.status}. No paid retry; no finality claim.</p>)}<small>{job.state === 'planned' ? 'Preview access ends' : 'Private payload access ends'} {new Date(job.expires_at).toLocaleString()}{job.state === 'planned' ? '.' : ', 24 hours after reservation.'} Application cleanup is not forensic erasure.</small></section>}
 <footer className="buyer-foot">Separate from the dashboard's direct, unbilled probes and the older direct research flow. PASS is advisory filing-coverage evidence only. Missing or contradictory evidence stays HOLD.</footer></main>;
}
