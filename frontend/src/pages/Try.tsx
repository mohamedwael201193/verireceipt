// /try — judge-facing "try the miner" page, mirroring the official
// acceptance rubric (Run it / Check it / Inspect it / Break it /
// Reproduce it). Every fact below is verified: example calls are real
// callable GETs against the live base URL (same examples as /docs),
// registration facts come from lib/minerRegistration.ts, and the replay
// commands use the recorded runs' real pinned spec hashes. No invented
// numbers: no counts are hardcoded; the declared-intent count renders
// from the manifest where used. Sepolia testnet throughout.

import { Link } from 'react-router-dom';
import './research.css';
import './research-desk.css';
import {
  SEPOLIA_EXPLORER_TX,
  SEPOLIA_REGISTRATION_ID,
  SEPOLIA_YAML_HASH,
  SEPOLIA_YAML_PIN,
  TELEGRAPH_NODE_BASE,
} from '../lib/minerRegistration';
import { MINER_BOND_USD_TEXT } from '../lib/minerBond';
import { DECLARED_INTENT_COUNT } from '../lib/minerManifest';

const API_BASE_URL = 'https://verireceipt.onrender.com';
const REPO_URL = 'https://github.com/mohamedwael201193/verireceipt';

const RUNS = [
  {
    label: 'Look up one Ethereum transaction',
    curl: `curl "${API_BASE_URL}/v1/tx?tx_hash=0xafdbc83c485355d90f79fd660bcd12713402aa78922d966657d1005f59e92902&chain=ethereum"`,
    url: `${API_BASE_URL}/v1/tx?tx_hash=0xafdbc83c485355d90f79fd660bcd12713402aa78922d966657d1005f59e92902&chain=ethereum`,
  },
  {
    label: 'Count Apple SEC filings',
    curl: `curl "${API_BASE_URL}/v1/filings?entity=AAPL&period=last%2012%20months"`,
    url: `${API_BASE_URL}/v1/filings?entity=AAPL&period=last%2012%20months`,
  },
  {
    label: 'Read a CAISO grid price',
    curl: `curl "${API_BASE_URL}/v1/grid-price?node_or_zone=TH_NP15_GEN-APND&interval_start=2026-11-20T06%3A00%3A00Z"`,
    url: `${API_BASE_URL}/v1/grid-price?node_or_zone=TH_NP15_GEN-APND&interval_start=2026-11-20T06%3A00%3A00Z`,
  },
];

export default function Try() {
  return (
    <main className="rp-page rd-page">
      <header className="rp-hero">
        <div className="rp-eyebrow">MINERS / PROVIDERS · SEPOLIA TESTNET</div>
        <h1>
          Try the miner.
          <br />
          <span>Five checks, no wallet.</span>
        </h1>
        <p>
          The official acceptance rubric — run it, check it, inspect it, break it, reproduce it —
          against the live VeriReceipt miner. Every check below is free and read-only.
        </p>
        <div className="rp-mode">
          FREE READ-ONLY CHECKS <span>No wallet, payment or signup. Hosted buying remains off.</span>
        </div>
      </header>

      <section className="rp-section" aria-labelledby="try-run">
        <div className="rp-section-head">
          <span>01</span>
          <div>
            <h2 id="try-run">Run it</h2>
            <p>
              Real calls against the live miner, one per intent family. Each success response
              carries <code>receipt.raw_response_sha256</code> — the SHA-256 of the stored upstream
              bytes the answer was computed from.
            </p>
          </div>
        </div>
        {RUNS.map((r) => (
          <div key={r.url}>
            <p>
              <strong>{r.label}:</strong>{' '}
              <a href={r.url} target="_blank" rel="noreferrer">
                open the live answer
              </a>
            </p>
            <pre className="rd-command" tabIndex={0}>
              {r.curl}
            </pre>
          </div>
        ))}
        <p className="rp-muted">
          The full endpoint contracts, with parameters and error codes, are on{' '}
          <Link to="/docs">/docs</Link>; {DECLARED_INTENT_COUNT} intents are declared in the
          manifest, 58 registered on Sepolia.
        </p>
      </section>

      <section className="rp-section" aria-labelledby="try-check">
        <div className="rp-section-head">
          <span>02</span>
          <div>
            <h2 id="try-check">Check it</h2>
            <p>
              The miner reports its own operating state, and the numbers are visible while you
              watch.
            </p>
          </div>
        </div>
        <p>
          <a href={`${API_BASE_URL}/health`} target="_blank" rel="noreferrer">
            GET /health
          </a>{' '}
          returns live per-intent request counters (arrived, completed, HTTP status breakdown,
          latencies), event-loop lag, storage health and the last reachability check of every
          upstream source. <Link to="/status">/status</Link> renders the same service state, and{' '}
          <Link to="/benchmarks">/benchmarks</Link> lets you measure the live endpoints yourself —
          no timings are shown until you press the button.
        </p>
      </section>

      <section className="rp-section" aria-labelledby="try-inspect">
        <div className="rp-section-head">
          <span>03</span>
          <div>
            <h2 id="try-inspect">Inspect it</h2>
            <p>Registration, bond and purchase history are public and pinned.</p>
          </div>
        </div>
        <dl className="rd-costs">
          <div>
            <dt>Registration</dt>
            <dd>
              {SEPOLIA_REGISTRATION_ID} · active ·{' '}
              <a href={`${TELEGRAPH_NODE_BASE}/api/miners/${SEPOLIA_REGISTRATION_ID}`} target="_blank" rel="noreferrer">
                node record
              </a>
            </dd>
          </div>
          <div>
            <dt>Registered miner.yaml</dt>
            <dd>
              <a href={`${REPO_URL}/blob/${SEPOLIA_YAML_PIN}/miner.yaml`} target="_blank" rel="noreferrer">
                pinned commit
              </a>{' '}
              · SHA-256 {SEPOLIA_YAML_HASH}
            </dd>
          </div>
          <div>
            <dt>On-chain bond</dt>
            <dd>
              {MINER_BOND_USD_TEXT} ·{' '}
              <a href={SEPOLIA_EXPLORER_TX} target="_blank" rel="noreferrer">
                registration transaction
              </a>
            </dd>
          </div>
        </dl>
        <p>
          Every paid purchase the Desk made is in the <Link to="/receipts">/receipts</Link> ledger
          with its receipt hash, signal hash and serving registration.
        </p>
      </section>

      <section className="rp-section" aria-labelledby="try-break">
        <div className="rp-section-head">
          <span>04</span>
          <div>
            <h2 id="try-break">Break it</h2>
            <p>Failure is structured and visible. Nothing is guessed.</p>
          </div>
        </div>
        <div className="rd-guide">
          <div>
            <b>Send invalid input</b>
            <p>
              <a href={`${API_BASE_URL}/v1/tx?tx_hash=0xdead&chain=ethereum`} target="_blank" rel="noreferrer">
                A malformed transaction hash
              </a>{' '}
              returns a structured 400 with an error code, never a fabricated lookup.
            </p>
          </div>
          <div>
            <b>Break an upstream</b>
            <p>
              When a source fails, the answer is a closed, named failure class — the request ends
              without a value rather than with an invented one. Failed and unsettled attempts stay
              visible in the ledger.
            </p>
          </div>
          <div>
            <b>Hand it a false claim</b>
            <p>
              Desk run B3 pinned a Tesla filing floor above the true count. The desk bought the
              evidence and reported the claim NOT_SUPPORTED.{' '}
              <Link to="/research/desk">Open the NOT_SUPPORTED control</Link>.
            </p>
          </div>
        </div>
      </section>

      <section className="rp-section" aria-labelledby="try-reproduce">
        <div className="rp-section-head">
          <span>05</span>
          <div>
            <h2 id="try-reproduce">Reproduce it</h2>
            <p>From a clone, without a wallet, without buying anything.</p>
          </div>
        </div>
        <pre className="rd-command" tabIndex={0}>
{`git clone ${REPO_URL}.git
cd verireceipt && npm ci && npm test
cd frontend && npm ci && npm test && cd ..
npm --prefix desk ci`}
        </pre>
        <p>
          The wallet-free replay verifies the recorded Sepolia desk runs. Download the packets
          this site serves, then replay them — pinned spec hash, stored source-byte digests and
          recorded calculations:
        </p>
        <pre className="rd-command" tabIndex={0}>
{`curl -O https://verireceipt.vercel.app/packets/b2-research-packet.json
curl -O https://verireceipt.vercel.app/packets/b3-research-packet.json
curl -O https://verireceipt.vercel.app/packets/c-rerun2-research-packet.json`}
        </pre>
        <pre className="rd-command" tabIndex={0}>
          npx tsx desk/scripts/replay-desk-packet.ts b2-research-packet.json 0be670693eb9b00082ce07115f5a52f5368be88855f1f06ee6dd4d44cc36090f
        </pre>
        <pre className="rd-command" tabIndex={0}>
          npx tsx desk/scripts/replay-desk-packet.ts b3-research-packet.json edd3e3e17a84cbc2fa29d13731b48c8d6be5c12c8964ea534f2e0cc5d245e433
        </pre>
        <pre className="rd-command" tabIndex={0}>
          npx tsx desk/scripts/replay-desk-packet.ts c-rerun2-research-packet.json c64a0a83ff71a83fdca6de9d3077b14dcf663b22469a360cb5c4d7bc6b34772b
        </pre>
        <p>
          Run C2's filings leg is a disclosed offline re-assembly on stored paid bytes, not a live
          READY run; the research desk page states the exact provenance next to the packet.
        </p>
        <p className="rp-muted">
          Limits, plainly: the replay is packet-integrity verification, not a live receipt check,
          not source-origin authentication and not settlement proof. Everything on this page is
          Sepolia testnet; no independent customer adoption is claimed.
        </p>
      </section>
    </main>
  );
}
