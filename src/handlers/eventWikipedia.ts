import {withAnswerClass} from "../core/answerClass";
import {unprocessable, upstreamUnavailable} from '../core/errors';
import {eventBody} from './eventSource';
import {envelope, makeReceipt} from '../core/receipt';
import {saveReceipt} from '../core/storage';

const normalize = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\bus\b/g, 'united states').replace(/[^a-z0-9]+/g, ' ').trim();
/** Only a named event or a who-won question is supported, never an arbitrary proposition. */
export function namedEvent(event: string): string {
    const title = event.replace(/\bUS\b/gi, 'United States').replace(/^who won (?:the )?/i, '').replace(/\?$/, '').trim();
    if (/^(?:did|will|has|was|is|would|could|should|does|can)\b/i.test(title) || !/\b(?:19|20)\d{2}\b/.test(title))
        throw unprocessable('EVENT_NOT_FOUND', 'Wikipedia fallback requires an exact dated event title or who-won question; unsupported conditions are refused');
    return title;
}
export function electionWinner(summary: any, expectedTitle: string): {winner: string; sentence: string; sourceUrl: string} {
    if (!/^(?:19|20)\d{2} United States presidential election$/.test(expectedTitle) || Number(expectedTitle.slice(0, 4)) >= new Date().getUTCFullYear())
        throw unprocessable('EVENT_NOT_FOUND', 'Wikipedia fallback currently supports completed past-year United States presidential elections only');
    if (summary.type !== 'standard' || normalize(summary.title ?? '') !== normalize(expectedTitle))
        throw unprocessable('EVENT_NOT_FOUND', 'Wikipedia event identity is not exact');
    const winner = /^(?:Election|Re-election|Second election|First election) of ([A-Z][A-Za-z .'-]{2,70})$/.exec(summary.description ?? '')?.[1];
    const text = typeof summary.extract === 'string' ? summary.extract : '';
    const sentence = text.split(/(?<=[.!?])\s+/).find((s: string) => winner && s.includes(winner) && s.indexOf(winner) < s.indexOf(' defeated ') && !/\b(?:not|never|if|would|could|may|might|expected|projected)\b/i.test(s));
    const sourceUrl = summary.content_urls?.desktop?.page;
    if (!winner || !sentence || typeof sourceUrl !== 'string' || !sourceUrl.startsWith('https://en.wikipedia.org/wiki/'))
        throw unprocessable('EVENT_NOT_FOUND', 'Wikipedia summary does not explicitly establish a supported winner; no outcome is guessed');
    return {winner, sentence, sourceUrl};
}
export async function wikipediaEventOutcome(event: string, primaryBody: string, primaryUrl: string, deadlineAt=Date.now()+2700): Promise<Record<string, unknown>> {
    const title = namedEvent(event);
    const searchUrl = 'https://en.wikipedia.org/w/rest.php/v1/search/page?q=' + encodeURIComponent(title) + '&limit=3';
    const search = await eventBody(searchUrl, deadlineAt);
    const pages = JSON.parse(search.raw).pages;
    if(!Array.isArray(pages))throw upstreamUnavailable('WIKIPEDIA_BAD_PAYLOAD','encyclopedia search response is invalid');
    const matches = Array.isArray(pages) ? pages.filter((p: any) => typeof p.title === 'string' && normalize(p.title) === normalize(title)) : [];
    if (matches.length !== 1 || typeof matches[0].key !== 'string')
        throw unprocessable('EVENT_NOT_FOUND', 'Wikipedia search has no unique exact event-title match');
    const summaryUrl = 'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(matches[0].key);
    const body = await eventBody(summaryUrl, deadlineAt);
    const summary = JSON.parse(body.raw);
    const result = electionWinner(summary, title);
    const evidence = JSON.stringify({event, title: summary.title, winner: result.winner, source_url: result.sourceUrl,
        evidence_sentence: result.sentence, source_policy: 'Single-source Wikipedia summary; exact event title and explicit defeated sentence plus election-winner description; no independent corroboration. outcome yes means the named event completed with the cited winner, not an arbitrary proposition.',
        attribution: 'English Wikipedia contributors, CC BY-SA 4.0, excerpt unchanged',
        raw_bodies: {primary: primaryBody, search: search.raw, summary: body.raw}, source_urls: [primaryUrl, searchUrl, summaryUrl], fetched_at: body.fetchedAt});
    const receipt = makeReceipt('EVENT_OUTCOME_RESOLUTION_GENERAL', summaryUrl, evidence, 'Wikipedia single-source fallback; no independent corroboration');
    receipt.fetched_at = body.fetchedAt;
    try { await saveReceipt(receipt, evidence); }
    catch { throw upstreamUnavailable('RECEIPT_PERSIST_FAILED', 'receipt evidence could not be stored; answer unavailable'); }
    const answer = `${summary.title}: ${result.winner} won. Wikipedia states: "${result.sentence}" Single-source Wikipedia fallback, not independently corroborated. English Wikipedia contributors, CC BY-SA 4.0, excerpt unchanged. ${result.sourceUrl}`;
    return withAnswerClass(envelope('EVENT_OUTCOME_RESOLUTION_GENERAL', {event, outcome:'yes', resolved_yes:true, winner:result.winner, resolved_at:null, sources:[result.sourceUrl]}, receipt,
        {answer, verdict:'verified', confidence:0.75, source:result.sourceUrl + '; single-source Wikipedia; fetched ' + body.fetchedAt}),'EVENT_OUTCOME_RESOLUTION_GENERAL',{outcome:'yes',source:'wikipedia'});
}
