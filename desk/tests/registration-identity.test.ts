import { expect, it } from 'vitest';
import { VERIRECEIPT_ONCHAIN_MINER_ID, VERIRECEIPT_ONCHAIN_MINER_IDS } from '../src/constants.js';
it('recognizes the current registration and preserves historical paid-receipt identities', () => {
 expect(VERIRECEIPT_ONCHAIN_MINER_ID).toBe('6205');
 expect(VERIRECEIPT_ONCHAIN_MINER_IDS).toEqual(['6152', '6160', '6188', '6196', '6205']);
 expect(VERIRECEIPT_ONCHAIN_MINER_IDS).not.toContain('6189');
});
