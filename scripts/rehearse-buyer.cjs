// Offline rehearsal only. Never loads a wallet, key or network transport.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Fastify = require('fastify');
const { registerBuyer } = require('../dist/buyer/routes');
const { BuyerStore } = require('../dist/buyer/store');
const compiled = require('../dist/buyer-runtime.cjs');
const payer = '0x' + '22'.repeat(20);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buyer-rehearsal-'));
const store = new BuyerStore(path.join(root, 'authority.sqlite'), payer);
const counters = { executions: 0, checkpoints: 0, signerInvocations: 0, signaturesProduced: 0, paidTransportCalls: 0, syntheticLedgerReads: 0, syntheticChallenges: 0, api: [] };
// Default-deny is installed before the app or runtime is exercised.
globalThis.fetch = async () => { throw new Error('Offline rehearsal refuses external fetch'); };
const challenge = fs.readFileSync(path.resolve(__dirname, '../desk/tests/fixtures/challenge-774921.json'), 'utf8').replaceAll('/v1/ask/774921', '/v1/ask');
const transport = async (input, init) => {
  const url = String(input), method = (init?.method || 'GET').toUpperCase();
  if (new Headers(init?.headers).has('X-PAYMENT')) { counters.paidTransportCalls++; throw new Error('No paid transport permitted'); }
  if (method === 'GET' && url === 'https://devnode.telegraphprotocol.com/v1/ledger/account/' + payer) { counters.syntheticLedgerReads++; return Response.json({ available: '9999999' }); }
  if (method === 'POST' && url === 'https://devnode.telegraphprotocol.com/engine/v1/ask') { counters.syntheticChallenges++; return new Response(challenge, { status: 402 }); }
  throw new Error('Unrecognized offline destination');
};
const runtime = {
  assertConfiguration: () => ({ payer, scratchRoot: root }),
  cleanup: compiled.cleanBuyerScratch,
  makePlan: compiled.makePlan,
  execute: async (plan, options) => {
    counters.executions++;
    return compiled.execute(plan, { ...options, beforeSign: async notice => { await options.beforeSign(notice); counters.checkpoints++; } }, {
      payer: { address: payer, signMessage: async () => { counters.signerInvocations++; throw new Error('DELIBERATE OFFLINE STOP. No signature generated.'); } }, transport
    });
  },
  followup: async () => { throw new Error('No receipt exists in this no-sign rehearsal'); }
};
const app = Fastify();
registerBuyer(app, { enabled: true, runtime, store });
const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/state') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ...counters, durableJobs: store.db.prepare('SELECT id,state,reserved_at IS NOT NULL AS reserved,signed_at IS NOT NULL AS checkpoint FROM buyer_jobs').all() })); return; }
    if (request.method !== 'POST' || request.url !== '/bridge') { response.writeHead(404).end(); return; }
    let data = ''; for await (const chunk of request) { data += chunk; if (data.length > 100000) throw new Error('Oversized bridge request'); }
    const incoming = JSON.parse(data);
    if (!incoming.url.startsWith('/v1/buyer/')) throw new Error('Not a buyer route');
    counters.api.push({ method: incoming.method, url: incoming.url });
    const result = await app.inject({ method: incoming.method, url: incoming.url, headers: incoming.headers, ...(incoming.payload === undefined ? {} : { payload: incoming.payload }) });
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ status: result.statusCode, headers: result.headers, body: result.body }));
  } catch (error) { response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(error.message) })); }
});
app.ready().then(() => server.listen(8771, '127.0.0.1', () => console.log('SYNTHETIC no-sign rehearsal bridge ready on loopback 8771')));
async function close() { server.close(); await app.close(); fs.rmSync(root, { recursive: true, force: true }); process.exit(0); }
process.on('SIGTERM', close); process.on('SIGINT', close);
