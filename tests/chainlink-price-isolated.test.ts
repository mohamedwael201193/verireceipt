import { it, expect } from 'vitest';
import { parseChainlinkRound, parseFeedDecimals, parseFeedDescription } from '../src/handlers/chainlinkPrice';
const word = (n: bigint) => BigInt.asUintN(256, n).toString(16).padStart(64, '0');
const abi = (xs: bigint[]) => '0x' + xs.map(word).join('');
const now = Date.parse('2026-11-22T12:00:00Z');
const t = BigInt(now / 1000);
const base = [10n, 123456789n, t - 30n, t - 10n, 10n];
it('reads feed decimals and positive timestamped price without hardcoded precision', () => { expect(parseFeedDecimals(abi([8n]))).toBe(8); const r = parseChainlinkRound(abi(base), 6, 60000, now); expect(r.priceUsd).toBe(123.456789); expect(r.answerRaw).toBe('123456789'); expect(r.roundId).toBe('10'); });
it('refuses negative, zero, stale, future and incomplete rounds', () => { for (const fields of [[10n, -1n, t - 30n, t - 10n, 10n], [10n, 0n, t - 30n, t - 10n, 10n], [10n, 123n, t - 120n, t - 100n, 10n], [10n, 123n, t, t + 40n, 10n], [10n, 123n, t - 30n, t - 10n, 9n], [0n, 123n, t - 30n, t - 10n, 0n]])
    expect(() => parseChainlinkRound(abi(fields), 2, 60000, now)).toThrow(); });
it('strict ABI sizes and bounds reject malformed provider responses', () => { expect(() => parseFeedDecimals('0x12')).toThrow(); expect(() => parseFeedDecimals(abi([255n]))).toThrow(); expect(() => parseChainlinkRound(abi([...base, 0n]), 8, 60000, now)).toThrow(); expect(() => parseChainlinkRound(abi(base), 19, 60000, now)).toThrow(); });
it('description must bind exact requested symbol and USD quote', () => { function str(s: string) { const b = Buffer.from(s); return abi([32n, BigInt(b.length)]) + b.toString('hex').padEnd(Math.ceil(b.length / 32) * 64, '0'); } expect(parseFeedDescription(str('BTC / USD'), 'BTC')).toBe('BTC / USD'); for (const s of ['ETH / USD', 'BTC / ETH', 'BTC/USD'])
    expect(() => parseFeedDescription(str(s), 'BTC')).toThrow(); });
