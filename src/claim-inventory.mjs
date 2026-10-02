// Turn a saved page into a claim inventory.
//
// INPUT: a plain-text capture of a real page, plus a note of what did NOT come
// through in the text. That note is not optional: a claim inside an image or a
// widget is invisible to this tool, and reporting it as "unsupported" when the
// page does support it would be the exact failure this product exists to catch.
//
// OUTPUT: one record per concrete, checkable claim, with the exact wording it was
// drawn from. A claim that cannot be tied to specific wording in the capture is
// not emitted -- inferring a claim the page does not make is the same class of
// error as misquoting it.
//
// This module is pure and injectable so it can be tested without a model. The
// model call does the reading; everything else is deterministic.

/** Claims worth auditing: numeric, absolute, comparative, or certification-shaped. */
const CLAIM_SIGNALS = Object.freeze([
  // Word boundaries matter here. Without them "ANSI" matches inside "density" and
  // a spec line gets reported as a certification claim -- noticed because a
  // Density line was tagged [certification] in a real inventory.
  {kind: 'certification', re: /\b(?:ISO|ASTM|UL|CE|RoHS|FDA|ANSI|IEC|ASME)[\s-]?[\dA-Z-]*/},
  // Units must not require preceding whitespace, and \s* rather than \s? because
  // a capture can separate the number and its unit with more than one space.
  // An earlier version silently skipped "Volume: 0.80 L" -- the very claim the
  // first audit was about -- because the space was followed by a line ending.
  {kind: 'numeric', re: /\d+(?:\.\d+)?\s*(?:%|mm|cm|µm|um|micron|m(?![a-z])|in(?![a-z])|inch|inches|°C|°F|C(?![a-z])|F(?![a-z])|hours?|hrs?|days?|weeks?|years?|g(?![a-z])|kg|g\/cm|lbs?|ml|L(?![a-z])|litre|liter|EUR|USD|\$|€)/i},
  {kind: 'absolute', re: /\b(always|never|all|every|guaranteed?|certified|unlimited|free|fastest|largest|best|only)\b|\bno\s+(?:\w+\s+){0,2}(?:fees|limits|minimums|minimum|setup|hidden)\b/i},
  {kind: 'comparative', re: /\b(faster|cheaper|stronger|better|superior|leading|industry[- ]standard|highest|lowest)\b/i},
]);

/**
 * Does this text carry claim-shaped language?
 *
 * NO length logic here, deliberately. An earlier version applied its own floor
 * internally as well as in the caller, so the caller's setting was silently
 * overridden and short spec rows were dropped with no signal that it happened.
 * Length is the caller's decision; this function answers one question the same
 * way every time.
 */
export function looksLikeClaim(sentence) {
  const text = String(sentence || '').trim();
  if (!text) return false;
  return CLAIM_SIGNALS.some(s => s.re.test(text));
}

export function signalKinds(sentence) {
  return CLAIM_SIGNALS.filter(s => s.re.test(String(sentence || ''))).map(s => s.kind);
}

/**
 * Split a captured page into candidate sentences, keeping the offset so every
 * claim can be traced back to a position in the capture.
 *
 * THE DECIMAL BUG, kept as a warning because it produced a misquote in the
 * deliverable. A naive split on [.!?] cuts "holds a tolerance of ±0.1 mm" into
 * "holds a tolerance of ±0." and "1 mm", so the report would have quoted the page
 * as saying something it does not say. In a product whose entire value is "every
 * claim traced to a real source", a misquote is the worst possible defect, and it
 * would have been introduced by the very component meant to guarantee fidelity.
 *
 * So a period only ends a sentence when it is NOT:
 *   - inside a number        (0.1, 1.75, version 3.9)
 *   - part of a known abbreviation (e.g., i.e., approx., vs.)
 *   - an ellipsis
 * A line break always ends a span, because captured pages separate spec rows and
 * list items with newlines and often no punctuation at all.
 */
const ABBREVIATIONS = /\b(?:e\.g|i\.e|approx|vs|etc|Inc|Ltd|Co|Corp|Dr|Mr|Ms|St|No)\.?$/i;

export function sentenceSpans(text) {
  const src = String(text || '');
  const spans = [];
  let start = 0;
  let i = 0;

  const push = (from, to) => {
    const raw = src.slice(from, to);
    if (!raw.trim()) return;
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    spans.push({
      text: raw.trim().replace(/\s+/g, ' '),
      start: from + lead,
      end: to - trail,
    });
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { push(start, i); i += 1; start = i; continue; }

    if (ch === '.' || ch === '!' || ch === '?') {
      // Ellipsis: consume the run and do not end the sentence there.
      if (ch === '.' && src[i + 1] === '.') { i += 1; while (src[i] === '.') i += 1; continue; }

      const before = src.slice(start, i);
      const prevCh = src[i - 1];
      const nextCh = src[i + 1];

      // A period between two digits is a decimal point, not a full stop.
      if (ch === '.' && /\d/.test(prevCh || '') && /\d/.test(nextCh || '')) { i += 1; continue; }
      // A period inside a version-like token (3.9.1) is the same case.
      if (ch === '.' && /\d/.test(nextCh || '') && /\d/.test(src[i + 2] || '')) { i += 1; continue; }
      // Known abbreviation: keep going.
      if (ch === '.' && ABBREVIATIONS.test(before.trimEnd())) { i += 1; continue; }

      // Otherwise it ends the sentence if what follows looks like a new one, or
      // if we are at the end of the capture.
      const restIsBreak = nextCh === undefined || /\s/.test(nextCh);
      if (restIsBreak) { push(start, i + 1); i += 1; start = i; continue; }
    }
    i += 1;
  }
  push(start, src.length);
  return spans;
}

/**
 * Pull out claims the page makes, WITHOUT a model.
 *
 * This is the mechanical pre-pass: it finds sentences carrying claim-shaped
 * language. The model's job is then narrower -- decide whether each is a real
 * assertion about the business and phrase it as a claim -- which is far more
 * reliable than asking it to find claims in a whole page unsupervised.
 *
 * Deterministic on purpose: the inventory can be re-derived and diffed, so a
 * change in the findings means a change in the page, not model variance.
 *
 * THE LENGTH FLOOR WAS 25 AND THAT WAS WRONG. A real capture's most auditable
 * lines are terse spec rows -- "Volume: 0.80 L" is 15 characters, "Density:
 * 1.25 g/cm3" is 21 -- and a floor tuned for prose silently dropped the very
 * claims the first audit was about. The floor still exists, because fragments
 * like "No minimums." are noise, but it is set where spec rows survive.
 */
export function mechanicalClaims(pageText, {minLength = 15, limit = 120} = {}) {
  const out = [];
  const seen = new Set();
  for (const span of sentenceSpans(pageText)) {
    // Signal FIRST, length second.
    //
    // The order matters and got this wrong once: "Volume: 0.80 L" is 14
    // characters and was dropped by a 15-character floor *before* its numeric
    // signal was ever consulted -- so the single most auditable line on the page
    // was invisible to the tool auditing it. Terse spec rows are exactly what an
    // audit needs; a floor tuned on prose is the wrong instrument.
    //
    // A shorter span is therefore kept if it reads like a spec statement rather
    // than a fragment. The fragment guard is what actually separates
    // "Volume: 0.80 L" from "No minimums."
    if (span.text.length < Math.min(minLength, 8)) continue;
    if (span.text.length < minLength && !/[:=]/.test(span.text)) continue;
    if (!looksLikeClaim(span.text)) continue;
    const key = span.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      text: span.text,
      start: span.start,
      signals: signalKinds(span.text),
      // Every claim must carry the literal wording it came from. Without this a
      // reader cannot check whether the claim was read correctly out of the page.
      exactWording: span.text,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * A capture is only usable if we know its provenance and its gaps.
 *
 * Refuses rather than warns, because a report that silently hides a retrieval
 * gap is worse than no report: it would accuse a page of not saying something
 * that the page may well say, inside an image or a widget.
 */
export function validateCapture({pageText, sourceUrl, capturedAt, notCaptured}) {
  const problems = [];
  if (!pageText || String(pageText).trim().length < 200) {
    problems.push('page text is missing or too short to audit (under 200 characters)');
  }
  if (!sourceUrl || !/^https?:\/\//i.test(String(sourceUrl))) problems.push('sourceUrl missing or not an http(s) URL');
  if (!capturedAt) problems.push('capturedAt missing -- a claim is about a page as it was on a date');
  if (notCaptured === undefined || notCaptured === null) {
    problems.push('notCaptured missing -- state what did NOT come through, or state "nothing observed"');
  }
  return problems;
}

/**
 * Build the inventory. Pure; returns the claims plus the coverage caveat that
 * must travel with every report.
 */
export function buildInventory({pageText, sourceUrl, capturedAt, notCaptured, capturedBy}, opts = {}) {
  const problems = validateCapture({pageText, sourceUrl, capturedAt, notCaptured});
  if (problems.length) return {ok: false, problems};

  const claims = mechanicalClaims(pageText, opts);
  return {
    ok: true,
    sourceUrl,
    capturedAt,
    capturedBy: capturedBy || 'unknown',
    notCaptured: String(notCaptured),
    // The honest denominator: how much text was actually read.
    coverage: {
      charactersRead: String(pageText).length,
      claimsFound: claims.length,
      gapStatement: String(notCaptured),
    },
    claims,
  };
}
