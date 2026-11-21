#!/usr/bin/env python3
"""Regenerate src/handlers/edgarFormTypes.ts — the closed SEC EDGAR form vocabulary.

Sources (round 9: the UNION of both):
  1. the "Form Type" column of every EDGAR full-index form.gz,
     https://www.sec.gov/Archives/edgar/full-index/<YYYY>/QTR<n>/form.gz,
     for every quarter 1993Q1 .. the current quarter;
  2. every `form` value in the live submissions data, i.e. the bulk file
     https://www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip
     (one data.sec.gov/submissions JSON per filer plus every history page).
SEC requires a descriptive User-Agent: set SEC_USER_AGENT in the environment.

  SEC_USER_AGENT="Name contact@example.com" python3 scripts/build-edgar-forms.py \
      [--cache DIR] [--submissions-zip FILE | --submissions-cache FILE] \
      [--last-year 2026] [--retrieved YYYY-MM-DD]

--submissions-zip scans a downloaded submissions.zip and writes the form
counts to --submissions-cache (default <cache>/submissions-forms.json);
--submissions-cache alone re-uses that file, so a re-run is byte-identical.

--cache keeps one JSON per quarter ({url, header, forms: {form: count}}) so a
re-run does not re-download. The form column is the first field of each
data line split on runs of 2+ spaces. form.idx truncates the column at 15
characters; a 15-character full-index value that the submissions data never
uses verbatim is resolved to the one submissions form it prefixes, or
dropped if there is not exactly one candidate.
"""
import argparse, collections, datetime, gzip, json, os, re, sys, time, urllib.request

# form.idx truncates the Form Type column at 15 characters. A 15-character
# full-index value that the submissions data never uses verbatim is
# resolved to the ONE submissions form it is a prefix of; with no or more
# than one candidate it is dropped (refused, never guessed).
SUBMISSIONS_URL = 'https://www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip'

HEADER = '''// GENERATED DATA — closed SEC EDGAR form-type vocabulary (A1 round 9).
//
// Source: the UNION of
//  (1) the "Form Type" column of every SEC EDGAR full-index file
//      https://www.sec.gov/Archives/edgar/full-index/<YYYY>/QTR<n>/form.gz
//      for all {quarters} quarters 1993Q1..{last}Q4 ({index_forms} distinct values), and
//  (2) every `form` value in the live submissions data, the bulk file
//      {subs_url}
//      (Last-Modified {subs_lm}; {subs_files} filer and history-page JSONs,
//      {subs_forms} distinct values),
// retrieved {retrieved} (Africa/Cairo).
// form.idx truncates the column at 15 characters; each truncated value was
// resolved to the single submissions form it prefixes: {truncations}.
// Every other entry is copied verbatim. {entries} entries, amendments ("X/A")
// listed separately exactly as EDGAR records them.
// Regenerate with scripts/build-edgar-forms.py; never hand-edit.

export const EDGAR_FORM_TYPES_SOURCE = {{
  source: 'SEC EDGAR full-index form.gz (Form Type column), all quarters 1993Q1..{last}Q4, UNION live submissions data (bulk submissions.zip)',
  retrieved: '{retrieved}',
  quarters: {quarters},
  submissions_last_modified: '{subs_lm}',
  entries: {entries},
}} as const;

export const EDGAR_FORM_TYPES: readonly string[] = [
'''


def quarter(ua, y, q, cache):
    fn = os.path.join(cache, f'{y}Q{q}.json') if cache else None
    if fn and os.path.exists(fn):
        return json.load(open(fn))['forms']
    u = f'https://www.sec.gov/Archives/edgar/full-index/{y}/QTR{q}/form.gz'
    try:
        b = urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': ua}), timeout=120).read()
    except urllib.error.HTTPError as e:
        if e.code in (403, 404):  # quarter not published yet
            return None
        raise
    lines = gzip.decompress(b).decode('latin-1').split('\n')
    start = next(i for i, l in enumerate(lines) if l.startswith('---')) + 1
    c = collections.Counter()
    for l in lines[start:]:
        if len(l) < 12:
            continue
        c[re.split(r'\s{2,}', l.strip())[0]] += 1
    if fn:
        os.makedirs(cache, exist_ok=True)
        json.dump({'url': u, 'header': lines[start - 2], 'forms': c}, open(fn, 'w'))
    time.sleep(0.2)
    return c


def submissions_forms(zip_path, cache_path):
    if zip_path:
        import zipfile
        z = zipfile.ZipFile(zip_path)
        c, n = collections.Counter(), 0
        for inf in z.infolist():
            d = json.loads(z.read(inf))
            blk = d['filings']['recent'] if '-submissions-' not in inf.filename else d
            c.update(blk.get('form', []))
            n += 1
        lm = os.environ.get('SUBMISSIONS_LAST_MODIFIED', 'unknown')
        data = {'url': SUBMISSIONS_URL, 'last_modified': lm, 'files': n, 'forms': dict(sorted(c.items()))}
        with open(cache_path, 'w') as fh:
            json.dump(data, fh, indent=0, sort_keys=True)
        return data
    return json.load(open(cache_path))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache')
    ap.add_argument('--last-year', type=int, default=datetime.date.today().year)
    ap.add_argument('--retrieved', default=datetime.date.today().isoformat())
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'src', 'handlers', 'edgarFormTypes.ts'))
    ap.add_argument('--submissions-zip')
    ap.add_argument('--submissions-cache')
    a = ap.parse_args()
    subs_cache = a.submissions_cache or (os.path.join(a.cache, 'submissions-forms.json') if a.cache else None)
    if not subs_cache:
        sys.exit('--submissions-cache (or --cache) is required')
    ua = os.environ.get('SEC_USER_AGENT', '')
    if not ua and not a.cache:
        sys.exit('SEC_USER_AGENT is required')
    union, quarters = set(), 0
    for y in range(1993, a.last_year + 1):
        for q in (1, 2, 3, 4):
            forms = quarter(ua, y, q, a.cache)
            quarters += 1  # an unpublished quarter is still a quarter scanned
            if forms:
                union.update(forms)
    subs = submissions_forms(a.submissions_zip, subs_cache)
    sforms = set(subs['forms'])
    out, truncs = set(sforms), []
    for f in sorted(union):
        if len(f) == 15 and f not in sforms:
            cands = sorted(x for x in sforms if x.startswith(f))
            truncs.append(f'"{f}" -> ' + (f'"{cands[0]}"' if len(cands) == 1 else 'DROPPED'))
            if len(cands) == 1:
                out.add(cands[0])
            continue
        out.add(f)
    forms = sorted(out)
    with open(a.out, 'w') as fh:
        fh.write(HEADER.format(quarters=quarters, last=a.last_year, retrieved=a.retrieved, entries=len(forms),
                               index_forms=len(union), subs_url=subs['url'], subs_lm=subs['last_modified'],
                               subs_files=subs['files'], subs_forms=len(sforms),
                               truncations='; '.join(truncs) or 'none'))
        for f in forms:
            fh.write('  ' + json.dumps(f) + ',\n')
        fh.write('];\n')
    print(f'{len(forms)} forms from {quarters} quarters -> {a.out}')


if __name__ == '__main__':
    main()
