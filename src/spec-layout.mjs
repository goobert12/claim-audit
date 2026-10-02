// Layout detection and value extraction for specification pages, across the
// structurally different forms real pages use.
//
// WHY THIS IS SEPARATE FROM claim-arithmetic.mjs: that module knows what a value
// MEANS. This one knows where a value IS. Keeping them apart matters because the
// failure modes are different -- a wrong bound accuses a company, a wrong
// extraction silently passes a bad value -- and they were being debugged together.
//
// THREE REAL LAYOUTS, from three live captures on 2026-10-01:
//
//   table-separate-unit   Vendor A
//     "Bending modulus -- ISO 178 -- X-Y: 1980 -- Z: -- -- VALUE (unit): GPa"
//     The value and its unit are in different columns.
//
//   table-inline-unit     Vendor B
//     "Dimensional Accuracy: \u00b10.02mm"
//     The unit trails the number on the same line.
//
//   flat-label-value      Vendor C
//     "Weight: 31.5 lbs. (14.3 kg)"
//     Not a table at all: one Label: Value per line, units inline. Confirmed by
//     the capturer rather than inferred.
//
// THE BUG THAT PROMPTED THIS, and it is the worst kind. On a live page the row
// headers read "Bending modulus GPa\u00b7ISO 178" -- the unit immediately after the
// property name, before the test standard. A parser that takes the first number
// after the property name reads the ISO number as the value: ISO 178 becomes
// 178. That does not fail, it does not return null, and it does not look wrong --
// 178 is a plausible modulus in some units, so it is bounds-checked and PASSES.
// A silent wrong value is worse than a missing one.
//
// The lesson encoded here: skip tokens that are identifiers rather than quantities
// (test-standard numbers, model numbers, sizes in a name) before taking a value.

// Units, LONGEST FIRST. Alternation is ordered, so "Ah" must be tried before "A"
// and "lbs" before "lb" -- otherwise "100Ah" reads as 100 A (amps) and "31.5 lbs"
// reads as 31.5 lb with the plural left dangling. Both errors are silent and both
// produce a plausible-looking value that would then be bounds-checked and pass.
//
// The negative lookahead on every unit prevents a partial match swallowing the
// first letter of a longer unit: "100Ah" must not match "A" followed by "h".
const UNIT_PATTERN = [
  'g/cm\u00b3', 'g/cm3', 'kg/m3',
  'in\u00b7lbs', 'in-lbs', 'inch\u00b7lbs', 'inch-lbs',
  'inches', 'inch', 'lbs', 'lb', 'kg',
  'GPa', 'MPa', 'kPa', 'Pa', 'mm', 'cm', 'Ah', 'Wh', 'N\u00b7m', 'N-m',
  'V', 'A', 'W', 'm', '%', '\u00b0C', '\u00b0F',
].join('|');

/** Which of the known layouts does this text use? */
export function detectLayout(text) {
  const src = String(text || '');
  // Only the two forms the capturer confirmed, because only those are decidable
  // from text. A page MENTIONING a standard is not a table, and an earlier version
  // of this function classified a whole Vendor B page as a table because one
  // sentence said "ASTM 638" -- it passed its own test only because the test used a
  // two-line snippet that happened to lack the mention.
  //
  // A table layout requires the column markers, in the same block. Absent those,
  // the honest answer is that value-and-unit are adjacent, which is what both
  // remaining shapes have in common and all a caller needs to read a value.
  if (/\bX\s*-\s*Y\b/i.test(src) && /\bVALUE\s*(?:\(unit\))?\s*:/i.test(src)) return 'table-separate-unit';
  if (/^[A-Z][A-Za-z0-9 ()\/.\u00b0-]{2,40}:\s*\S/m.test(src)) return 'flat-label-value';
  return 'unknown';
}

/**
 * Tokens that look like numbers but are not quantities.
 *
 * "ISO 178" and "ASTM D790" name a test standard. "UL94 V-0" names a rating.
 * "M8 x 1.25 x 12 mm" names a bolt. Reading any of these as the measured value is
 * how the silent-wrong-value bug happens.
 */
const IDENTIFIER_CONTEXT = [
  /\b(?:ISO|ASTM|EN|DIN|JIS|GB|UL|IEC|ANSI|MIL)\s*[A-Z]?\s*$/i,   // immediately before the number
  /\b(?:M|UNC|UNF)\s*$/i,                                          // bolt sizes
  /\bIP\s*$/i,                                                     // ingress rating
  /\bUN\s*$/i,                                                     // UN38.3 transport standard
];

function precededByIdentifier(text, index) {
  const before = text.slice(0, index);
  return IDENTIFIER_CONTEXT.some(re => re.test(before));
}

/**
 * Every number-with-unit on a line, skipping identifiers.
 * Returns candidates in order, so a caller can pick rather than guess.
 */
export function valueCandidates(text) {
  const src = String(text || '');
  // A minus sign is captured only when it is not acting as a range separator:
  // preceded by whitespace, a colon, an opening paren or the start of the line.
  // So "-4\u00b0F" keeps its sign while "5-10 cm" and "80-95 \u00b0C" do not read
  // the second figure as negative.
  // A tolerance sign is a modifier on the value, not part of the value, and it also
  // breaks a naive lookbehind: on "\u00b10.02mm" the character before the 0 is "\u00b1",
  // so a guard against being preceded by a digit/period let the scan walk one
  // character in and match "2mm" -- a silently wrong value, which is the exact
  // class of bug this module exists to prevent. The sign is matched and discarded.
  const re = new RegExp(String.raw`(?:[\u00b1\u2213]|\+\/-\s*)?(?<![\d.])(-?(?:\d+(?:[.,]\d+)?))\s*(${UNIT_PATTERN})(?![A-Za-z])`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    // A leading minus is a range separator, not a sign, when it directly follows a
    // digit with no space -- "5-10" -- which the lookbehind above already blocks.
    if (precededByIdentifier(src, m.index)) continue;
    // Values inside an unclosed parenthesis are secondary: a conversion
    // ("(14.3 kg)") or a component dimension ("(M8 x 1.25 x 12 mm)"). The primary
    // value on the line precedes the paren. Dropping these is conservative on
    // purpose -- missing a value is recoverable, reading a bolt size as the spec
    // value is not.
    const openParen = src.lastIndexOf('(', m.index);
    const closeBefore = src.lastIndexOf(')', m.index);
    if (openParen > closeBefore) continue;
    // Two distinct component-dimension shapes, and they need different signals.
    //
    // 1. A metric thread designation: "M8 x 1.25 x 12 mm" is a bolt's thread and
    //    length. The leading M is the signal, and it is not a digit -- which is
    //    why counting x-separated FIGURES missed it (the preceding text is
    //    "M8 x 1.25 x ", containing one figure and one M-number).
    // 2. A parenthesised chain, "(M8 x 1.25 x 12 mm) x 2", a quantity of
    //    components, already caught by the parenthesis guard above.
    //
    // A genuine product dimension set -- "11.4 x 8.2 x 7.9 in" -- has neither
    // signal, so it survives. That distinction is the whole reason this is two
    // rules instead of one loose one.
    const preceding = src.slice(Math.max(0, m.index - 40), m.index);
    if (/\bM\s*\d+(?:[.,]\d+)?\s*(?:x|\u00d7)/i.test(preceding) && /(?:x|\u00d7)\s*$/i.test(preceding)) continue;
    const chainBefore = /(?:\d+(?:[.,]\d+)?\s*(?:x|\u00d7)\s*){2,}$/i.test(preceding);
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 24);
    const chainAfter = /^\s*(?:x|\u00d7)\s*\d/i.test(after);
    if (chainBefore && chainAfter) continue;
    out.push({
      value: Number(m[1].replace(',', '.')),
      rawValue: m[1],
      unit: m[2],
      unitKey: m[2].toLowerCase(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

/**
 * The value a specification line states, for whichever layout it uses.
 *
 * Preference order, and the reasoning matters more than the code:
 *   1. A value attached to an explicit column marker (X-Y, then VALUE). These are
 *      unambiguous when present; the across-layer figure is chosen over the
 *      between-layer one because that is what a buyer designs with.
 *   2. Otherwise the first non-identifier number after the property name.
 *
 * A unit found in a separate column is preferred over one merely nearby, because
 * "2310 -- Z: -- -- VALUE (unit): GPa" must not pick up a unit from the Z cell.
 */
export function extractSpecValue(text, {propertyEndIndex = null} = {}) {
  const src = String(text || '');
  const layout = detectLayout(src);

  // 1. Explicit column markers.
  const columnMarkers = [
    {re: /\bX\s*-\s*Y\s*:?\s*(-?\d+(?:[.,]\d+)?)/i, name: 'X-Y'},
    {re: /\bVALUE\s*(?:\(unit\))?\s*:?\s*(-?\d+(?:[.,]\d+)?)/i, name: 'VALUE'},
  ];
  for (const marker of columnMarkers) {
    const cm = marker.re.exec(src);
    if (!cm) continue;
    const value = Number(cm[1].replace(',', '.'));
    if (!Number.isFinite(value)) continue;
    // The unit for this row. Prefer an explicit separate unit column; a bare unit
    // elsewhere on the line is the fallback.
    const unitMatch = new RegExp(String.raw`VALUE\s*\(unit\)\s*:?\s*(${UNIT_PATTERN})`, 'i').exec(src)
      ?? new RegExp(String.raw`\b(${UNIT_PATTERN})\s*$`, 'i').exec(src)
      ?? new RegExp(String.raw`\b(${UNIT_PATTERN})\b`, 'i').exec(src);
    if (!unitMatch) continue;
    return {
      value, rawValue: cm[1], unit: unitMatch[1], unitKey: unitMatch[1].toLowerCase(),
      layout, fromColumn: marker.name, unitFromSeparateColumn: true,
      start: cm.index, end: cm.index + cm[0].length,
    };
  }

  // 2. First non-identifier number after the property name.
  const tail = propertyEndIndex === null ? src : src.slice(propertyEndIndex);
  const offset = propertyEndIndex === null ? 0 : propertyEndIndex;
  const cands = valueCandidates(tail);
  if (!cands.length) return null;
  const c = cands[0];
  return {
    value: c.value, rawValue: c.rawValue, unit: c.unit, unitKey: c.unitKey,
    layout, fromColumn: null, unitFromSeparateColumn: false,
    start: offset + c.start, end: offset + c.end,
  };
}
