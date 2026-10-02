import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mechanicalClaims, sentenceSpans, looksLikeClaim, signalKinds,
  validateCapture, buildInventory,
} from '../src/claim-inventory.mjs';

const PAGE = `
Welcome to Acme 3D Printing. We offer the fastest turnaround in the region.

Our FDM service holds a tolerance of ±0.1 mm on all parts.
We are ISO 9001 certified and every order ships within 24 hours.
Maximum build volume is 300 x 300 x 400 mm.
We never charge setup fees.
Our team has over 20 years of combined experience.
Thanks for visiting, and please call us.
`;

const GOOD = {
  pageText: PAGE,
  sourceUrl: 'https://acme.example/services',
  capturedAt: '2026-10-01',
  notCaptured: 'nothing observed',
  capturedBy: 'the-capturer',
};

test('claims are found by their signal: numeric, absolute, certification, comparative', () => {
  const claims = mechanicalClaims(PAGE);
  const texts = claims.map(c => c.text);
  assert.ok(texts.some(t => /tolerance of ±0\.1 mm/.test(t)), 'numeric spec must be found');
  assert.ok(texts.some(t => /ISO 9001 certified/.test(t)), 'certification must be found');
  assert.ok(texts.some(t => /never charge setup fees/.test(t)), 'absolute must be found');
  assert.ok(texts.some(t => /fastest turnaround/.test(t)), 'comparative must be found');
  assert.ok(texts.some(t => /over 20 years/.test(t)), 'experience claim must be found');
});

test('pure pleasantries are not emitted as claims', () => {
  const texts = mechanicalClaims(PAGE).map(c => c.text);
  assert.equal(texts.some(t => /Thanks for visiting/.test(t)), false);
  assert.equal(texts.some(t => /please call us/.test(t)), false);
});

test('every claim carries the literal wording and an offset into the capture', () => {
  // Without this a reader cannot check whether the claim was read correctly out
  // of the page, which is the whole product.
  for (const c of mechanicalClaims(PAGE)) {
    assert.equal(typeof c.exactWording, 'string');
    assert.ok(c.exactWording.length > 0);
    assert.equal(typeof c.start, 'number');
    assert.ok(PAGE.includes(c.text.slice(0, 30)), `claim text must appear in the page: ${c.text}`);
  }
});

test('the offset actually points at the claim, so it is traceable', () => {
  const claims = mechanicalClaims(PAGE);
  const target = claims.find(c => /tolerance of/.test(c.text));
  assert.ok(target);
  // The page contains the claim at or very near the recorded offset.
  const window = PAGE.slice(target.start, target.start + target.text.length + 5);
  assert.ok(window.includes('tolerance of'), `offset ${target.start} should land on the claim, got: ${window.slice(0, 60)}`);
});

test('duplicate wording is emitted once, so a repeated tagline does not inflate the count', () => {
  const doubled = `${PAGE}\nWe are ISO 9001 certified and every order ships within 24 hours.\n`;
  const claims = mechanicalClaims(doubled);
  const iso = claims.filter(c => /ISO 9001 certified/.test(c.text));
  assert.equal(iso.length, 1, 'identical claim text must not be counted twice');
});

test('a single recognisable signal is enough; a bare sentence is not', () => {
  // looksLikeClaim is now purely a signal question; length is the caller's
  // decision. It once applied its own floor internally as well, which silently
  // overrode the caller and dropped short spec rows.
  assert.equal(looksLikeClaim('We are a company that does things.'), false, 'no signal at all');
  assert.equal(looksLikeClaim('Every order ships within 24 hours.'), true, 'numeric signal');
  assert.equal(looksLikeClaim('We never charge a setup fee.'), true, 'absolute signal');
  assert.equal(looksLikeClaim('We have no order minimums.'), true, 'negated absolute signal');
  assert.deepEqual(signalKinds('ISO 9001 certified, 24 hour turnaround, never late').sort(),
    ['absolute', 'certification', 'numeric']);
});

test('the length floor refuses fragments but KEEPS terse spec rows', () => {
  // The bug this pins: "Volume: 0.80 L" is 14 characters and was dropped by a
  // 15-character floor before its numeric signal was consulted, so the single
  // most auditable line on a real product page was invisible to the tool
  // auditing it. Signal is checked first; a short span survives if it reads as a
  // spec statement rather than a fragment.
  assert.equal(looksLikeClaim('Volume: 0.80 L'), true, 'the signal is present');
  const claims = mechanicalClaims('Density: 1.25 g/cm\u00b3\nVolume: 0.80 L\nNo minimums.');
  const texts = claims.map(c => c.text);
  assert.ok(texts.includes('Volume: 0.80 L'), `volume row must be kept, got ${JSON.stringify(texts)}`);
  assert.ok(texts.includes('Density: 1.25 g/cm\u00b3'), 'density row must be kept');
  assert.equal(texts.includes('No minimums.'), false, 'a bare fragment is still refused');
});

test('an explicit floor still applies to long-form prose', () => {
  const claims = mechanicalClaims('Ships in 24 hours.\nEvery order ships within 24 hours flat.', {minLength: 30});
  assert.deepEqual(claims.map(c => c.text), ['Every order ships within 24 hours flat.'], 'only the span meeting the floor survives when neither is a spec row');
});

test('a decimal point does NOT end a sentence: the misquote bug', () => {
  // This shipped once and produced a report quoting the page as saying
  // "holds a tolerance of ±0." -- a misquote, in a product whose entire value is
  // fidelity to the source. Pinned so it cannot return.
  const page = 'Our FDM service holds a tolerance of \u00b10.1 mm on all parts.\nFilament is 1.75 mm diameter.';
  const texts = sentenceSpans(page).map(s => s.text);
  assert.ok(texts.some(t => t.includes('\u00b10.1 mm on all parts')), `tolerance must stay whole, got: ${JSON.stringify(texts)}`);
  assert.equal(texts.some(t => /tolerance of \u00b10\.$/.test(t)), false, 'must not truncate at the decimal');
  assert.ok(texts.some(t => t.includes('1.75 mm diameter')), 'version-style decimal must stay whole');
});

test('ellipses and version numbers do not split a sentence', () => {
  const page = 'Python 3.9.1 is supported.\nWait for it... then continue.';
  const texts = sentenceSpans(page).map(s => s.text);
  assert.ok(texts.some(t => t.includes('Python 3.9.1')), `version must stay whole: ${JSON.stringify(texts)}`);
  assert.ok(texts.some(t => t.includes('then continue')), 'text after an ellipsis on the same line stays in the span');
});

test('common abbreviations do not end a sentence', () => {
  const texts = sentenceSpans('We support many materials, e.g. PLA and PETG, on all machines.').map(s => s.text);
  assert.equal(texts.length, 1, `e.g. must not split: ${JSON.stringify(texts)}`);
});

test('a line break always ends a span, punctuation or not', () => {
  // Captured pages separate spec rows and list items with newlines and often no
  // punctuation at all.
  const texts = sentenceSpans('Tolerance: \u00b10.1 mm\nLead time: 24 hours\nMaterial: PLA').map(s => s.text);
  assert.deepEqual(texts, ['Tolerance: \u00b10.1 mm', 'Lead time: 24 hours', 'Material: PLA']);
});

test('sentence spans keep a usable offset even after normalisation', () => {
  const spans = sentenceSpans(PAGE);
  assert.ok(spans.length > 5);
  for (const s of spans) {
    assert.ok(s.start >= 0 && s.start < PAGE.length);
    assert.equal(s.text, s.text.replace(/\s+/g, ' '), 'span text must be whitespace-normalised');
  }
});

// ---- capture validation: the part that must refuse rather than warn --------

test('an incomplete capture is REFUSED, not audited with a caveat', () => {
  // A report that silently hides a retrieval gap would accuse a page of not
  // saying something it may well say, inside an image or a widget.
  const noGap = {...GOOD, notCaptured: undefined};
  const r = buildInventory(noGap);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(p => /notCaptured/.test(p)));
});

test('a missing date is refused: a claim is about a page as it was on a date', () => {
  const r = buildInventory({...GOOD, capturedAt: undefined});
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(p => /capturedAt/.test(p)));
});

test('a missing or non-URL source is refused', () => {
  assert.equal(buildInventory({...GOOD, sourceUrl: undefined}).ok, false);
  assert.equal(buildInventory({...GOOD, sourceUrl: 'acme.example'}).ok, false);
});

test('a near-empty capture is refused rather than producing a clean-looking empty audit', () => {
  // The dangerous outcome is "0 claims found", which reads as "your page is
  // fine" when it actually means "we did not get the page".
  const r = buildInventory({...GOOD, pageText: 'Loading…'});
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(p => /too short/.test(p)));
});

test('"nothing observed" is an acceptable gap statement, absence is not', () => {
  assert.equal(buildInventory({...GOOD, notCaptured: 'nothing observed'}).ok, true);
  assert.equal(buildInventory({...GOOD, notCaptured: ''}).ok, true, 'empty string is an explicit statement');
  assert.equal(buildInventory({...GOOD, notCaptured: null}).ok, false);
});

test('the inventory records how much text was actually read', () => {
  const r = buildInventory(GOOD);
  assert.equal(r.ok, true);
  assert.equal(r.coverage.charactersRead, PAGE.length);
  assert.equal(r.coverage.claimsFound, r.claims.length);
  assert.equal(r.coverage.gapStatement, 'nothing observed');
  assert.equal(r.sourceUrl, GOOD.sourceUrl);
  assert.equal(r.capturedAt, GOOD.capturedAt);
});

test('validateCapture returns every problem at once, not just the first', () => {
  const problems = validateCapture({pageText: '', sourceUrl: 'nope'});
  assert.ok(problems.length >= 4, `expected several problems, got ${problems.length}`);
});
