import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { COINGECKO_APPROVAL } from '../src/handlers/financeWired';

it('tracked source never carries personal transport identifiers', () => {
 const marker = ['wa', 'mid'].join('');
 const encodedPrefix = ['HB', 'gM'].join('');
 const files = execFileSync('git', ['ls-files', '-z']).toString().split('\0').filter(Boolean);
 const offending = files.filter(path => {
  const body = readFileSync(path).toString();
  const privateMinute = ['00', '27', '23'].join(':');
  return body.includes(marker + '.') || body.includes(encodedPrefix) || body.includes(privateMinute);
 });
 expect(offending).toEqual([]);
});
it('risk reference stays opaque and preserves the acceptance timestamp and scope', () => {
 expect(COINGECKO_APPROVAL.ownerRiskAcceptance).toEqual({
  sourceReference: 'owner-risk-acceptance-2026-11-23',
  acceptedAt: '2026-11-23',
  scope: 'testnet-hackathon',
 });
});
