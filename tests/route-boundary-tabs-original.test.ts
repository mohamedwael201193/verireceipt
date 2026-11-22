import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/core/storage', () => ({
  saveReceipt: vi.fn(async () => { throw new Error('original-local-storage-boundary'); }),
}));
import { saveReceipt } from '../src/core/storage';
import { PAIR_REGISTRY, classifyPair, handleRouteWithRpcs, parsePair } from '../src/handlers/optimalRoute';

// Independently derived only from our own registry and parser's advertised
// ASCII boundary-space/tab behavior. No historical request is an input.
// Local unit controls only: no network, quote, DB or production receipt write.
const noNetwork = vi.fn(async () => { throw new Error('original-local-network-boundary'); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', noNetwork);
  vi.stubEnv('ROUTE_NO_ROUTE_ENVELOPE', '1');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('original own-registry route ASCII boundary controls', () => {
  PAIR_REGISTRY.forEach((spec, index) => {
    const [sell, buy] = spec.pair.toLowerCase().split('/');
    for (const separator of ['/', '-', '->']) {
      const raw = `${sell}${separator}${buy}`;
      it(`registry index ${index}, separator ${separator}: ordinary spaces remain recognized`, () => {
        expect(parsePair(`  ${raw}  `)).toBe(spec);
        expect(classifyPair(`  ${raw}  `)).toEqual({ kind: 'registered', spec });
      });
      it(`registry index ${index}, separator ${separator}: advertised outer tabs reach the same entry`, () => {
        expect(parsePair(` \t${raw}\t `)).toBe(spec);
        expect(classifyPair(` \t${raw}\t `)).toEqual({ kind: 'registered', spec });
      });
    }
    it(`registry index ${index}: token-address identity stays exact`, () => {
      expect(parsePair(`${spec.sellToken.toLowerCase()}/${spec.buyToken}`)).toBe(spec);
    });
    for (const control of ['\n', '\r', '\0']) {
      it(`registry index ${index}: other boundary control ${control.charCodeAt(0)} stays malformed`, () => {
        expect(parsePair(`${control}${sell}/${buy}${control}`)).toBeNull();
        expect(classifyPair(`${control}${sell}/${buy}${control}`)).toEqual({ kind: 'malformed' });
      });
    }
    it(`registry index ${index}: embedded tab stays malformed`, () => {
      expect(parsePair(`${sell}\t/${buy}`)).toBeNull();
      expect(classifyPair(`${sell}\t/${buy}`)).toEqual({ kind: 'malformed' });
    });
    it(`registry index ${index}: recognized boundary input reaches the local RPC configuration guard, not refusal persistence`, async () => {
      const raw = `\t${spec.sellToken.toLowerCase()}->${spec.buyToken.toLowerCase()}\t`;
      await expect(handleRouteWithRpcs({ pair: raw }, [])).rejects.toMatchObject({ status: 502, code: 'RPC_CONFIG' });
      expect(saveReceipt).not.toHaveBeenCalled();
      expect(noNetwork).not.toHaveBeenCalled();
    });
  });
  const unlisted = 'ORIGINALUNITA/ORIGINALUNITB';
  it('the original unlisted token pair is not a registered route', () => {
    expect(classifyPair(unlisted)).toMatchObject({ kind: 'no-route', reason: 'unknown-token' });
  });
  for (const edges of [['\t', ''], ['', '\t'], [' \t', '\t ']]) {
    it(`the same original unlisted tokens keep their classification after permitted boundary trim ${JSON.stringify(edges)}`, () => {
      expect(classifyPair(edges[0] + unlisted + edges[1])).toMatchObject({ kind: 'no-route', reason: 'unknown-token' });
    });
  }
});
