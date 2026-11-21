import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('six-endpoint reviewer examples', () => {
  it.each(['../README.md', '../JUDGE.md', 'src/pages/Docs.tsx'])(
    '%s includes a copyable validator query', (file) => {
      const source = readFileSync(file, 'utf8');
      expect(source).toContain('curl "$BASE/v1/validator?validator_index=1"');
    },
  );
  it('the reviewer guide names the limits and malformed-input refusal', () => {
    const guide = readFileSync('../JUDGE.md', 'utf8');
    expect(guide).toContain('The six endpoints');
    expect(guide).not.toContain('The five endpoints');
    expect(guide).toContain('effective_balance` is in gwei, not ETH');
    expect(guide).toContain('validator_index=01');
    expect(guide).toContain('INVALID_VALIDATOR_INDEX');
    expect(guide).toContain('not independent source truth');
  });
});
