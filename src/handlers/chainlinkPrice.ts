/** Strict Ethereum ABI parsers for an identity-verified Chainlink USD proxy.
 * No feed address, provider or route is enabled by this module. */
function words(raw: string, count: number): bigint[] { if (!new RegExp('^0x[0-9a-fA-F]{' + (count * 64) + '}$').test(raw))
    throw new Error('invalid ABI words'); return Array.from({ length: count }, (_, i) => BigInt('0x' + raw.slice(2 + i * 64, 66 + i * 64))); }
export interface ChainlinkRound {
    roundId: string;
    answerRaw: string;
    decimals: number;
    priceUsd: number;
    startedAt: string;
    updatedAt: string;
    answeredInRound: string;
}
export function parseFeedDecimals(raw: string): number { const n = words(raw, 1)[0]; if (n > 18n)
    throw new Error('unsupported feed decimals'); return Number(n); }
export function parseFeedDescription(raw: string, expectedSymbol: string): string {
    if (!/^0x[0-9a-fA-F]+$/.test(raw) || raw.length > 4098 || (raw.length - 2) % 64 !== 0)
        throw new Error('invalid ABI description');
    const bytes = Buffer.from(raw.slice(2), 'hex');
    if (bytes.length < 64)
        throw new Error('short ABI string');
    const offset = BigInt('0x' + bytes.subarray(0, 32).toString('hex'));
    if (offset !== 32n)
        throw new Error('invalid ABI string offset');
    const length = BigInt('0x' + bytes.subarray(32, 64).toString('hex'));
    if (length > 128n || 64 + Number(length) > bytes.length)
        throw new Error('invalid ABI string length');
    const text = bytes.subarray(64, 64 + Number(length)).toString('utf8');
    if (text !== `${expectedSymbol} / USD`)
        throw new Error('feed description does not match requested USD asset');
    return text;
}
export function parseChainlinkRound(raw: string, decimals: number, maxAgeMs: number, now = Date.now()): ChainlinkRound {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0)
        throw new Error('invalid feed freshness/decimals policy');
    const [roundId, answerUnsigned, started, updated, answered] = words(raw, 5);
    const answer = answerUnsigned >= (1n << 255n) ? answerUnsigned - (1n << 256n) : answerUnsigned;
    if (roundId === 0n || roundId >= (1n << 80n) || answered >= (1n << 80n) || answered < roundId || answer <= 0n || started === 0n || updated < started || updated > BigInt(Math.floor((now + 30000) / 1000)) || now - Number(updated) * 1000 > maxAgeMs)
        throw new Error('stale, incomplete, nonpositive or invalid feed round');
    const scale = 10n ** BigInt(decimals);
    const value = Number(answer / scale) + Number(answer % scale) / Number(scale);
    if (!Number.isFinite(value) || value < .0001 || value > 1e7)
        throw new Error('USD price outside canonical common range');
    return { roundId: roundId.toString(), answerRaw: answer.toString(), decimals, priceUsd: value, startedAt: new Date(Number(started) * 1000).toISOString(), updatedAt: new Date(Number(updated) * 1000).toISOString(), answeredInRound: answered.toString() };
}
