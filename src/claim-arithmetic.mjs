// Arithmetic and dimensional sanity checks over a claim inventory.
//
// WHY THIS EXISTS: two kinds of manual finding motivated it -- a modulus printed in
// the wrong unit, and a volume figure wrongly accused of being copied. The first was
// correct and the second was not, and the difference between them was whether anyone
// recomputed the figures.
//
// So the checks that caught both are encoded here. A finding from this module is a
// FLAG FOR A HUMAN, never a verdict: every check below can be defeated by a value
// that is unusual but real, and an audit that accuses a supplier wrongly is worse
// than no audit. Each flag carries its own arithmetic so a reader can falsify it.
//
// Pure module. No I/O, no model, no network.

/**
 * Physical ranges a value must fall inside to be believable, keyed by the
 * property names that appear on real specification sheets.
 *
 * These are deliberately GENEROUS. A range that is too tight produces false
 * accusations; a range spanning all real materials still catches a unit that is
 * wrong by a factor of a thousand, which is the defect actually observed.
 * `diamond` and `steel` are recorded so the reasoning is inspectable rather than
 * a bare number.
 */
export const PROPERTY_BOUNDS = Object.freeze({
  density: {min: 0.05, max: 25, unit: 'g/cm3', because: 'aerogels to osmium; nothing printed is outside this'},
  youngsModulus: {min: 0.001, max: 1200, unit: 'GPa', because: 'soft elastomers to diamond (1050-1200 GPa); no material exceeds this'},
  bendingModulus: {min: 0.001, max: 1200, unit: 'GPa', because: 'same ceiling as Young\u2019s modulus; flexural modulus cannot exceed the stiffest known solid'},
  tensileStrength: {min: 0.001, max: 10, unit: 'GPa', because: 'gels to the strongest steels and fibres'},
  elongationAtBreak: {min: 0, max: 1500, unit: '%', because: 'brittle ceramics to highly extensible elastomers'},
  nozzleTemperature: {min: 100, max: 500, unit: '\u00b0C', because: 'below 100 nothing melts, above 500 no FDM machine operates'},
  bedTemperature: {min: 0, max: 250, unit: '\u00b0C', because: 'room temperature to near the limit of heated beds'},
  annealingTemperature: {min: 20, max: 300, unit: '\u00b0C', because: 'below ambient is meaningless, above 300 destroys most polymers'},
});

/** How a property is named on real pages, mapped to the bounds key. */
const PROPERTY_ALIASES = Object.freeze([
  // The apostrophe class is not decoration: a live page wrote "Young\u2019s modulus"
  // with a curly apostrophe and a straight-quote-only pattern failed to match it,
  // silently returning null and skipping the check entirely. A checker that passes
  // a bad value because it did not recognise the property name is worse than no
  // checker, because it looks like a pass.
  [/young[\u2019'\u02bc]?s?\s+modulus|modulus of elasticity|tensile modulus/i, 'youngsModulus'],
  [/bending\s+modulus|flexural\s+modulus|flexural\s+strength/i, 'bendingModulus'],
  [/tensile\s+strength|ultimate\s+tensile/i, 'tensileStrength'],
  [/elongation(?:\s+at\s+break)?/i, 'elongationAtBreak'],
  [/density/i, 'density'],
  [/nozzle|extrusion\s+temperature|print\s+temperature/i, 'nozzleTemperature'],
  [/\bbed\b|build\s+plate|heat\s*bed/i, 'bedTemperature'],
  [/anneal/i, 'annealingTemperature'],
]);

/** Units as written on pages, mapped to a canonical form and a scale to the bounds unit. */
const UNIT_SCALES = Object.freeze({
  'gpa': {canonical: 'GPa', toBoundsUnit: 1},
  'mpa': {canonical: 'MPa', toBoundsUnit: 0.001},
  'kpa': {canonical: 'kPa', toBoundsUnit: 0.000001},
  'pa': {canonical: 'Pa', toBoundsUnit: 1e-9},
  'g/cm3': {canonical: 'g/cm3', toBoundsUnit: 1},
  'g/cm\u00b3': {canonical: 'g/cm3', toBoundsUnit: 1},
  'kg/m3': {canonical: 'kg/m3', toBoundsUnit: 0.001},
  '%': {canonical: '%', toBoundsUnit: 1},
  '\u00b0c': {canonical: '\u00b0C', toBoundsUnit: 1},
  'c': {canonical: '\u00b0C', toBoundsUnit: 1},
  '\u00b0f': {canonical: '\u00b0F', toBoundsUnit: null}, // handled separately
});

export function propertyFor(text) {
  for (const [re, key] of PROPERTY_ALIASES) if (re.test(String(text || ''))) return key;
  return null;
}

/**
 * The measurement a specification line is actually stating.
 *
 * Real pages write "Recommended Extrusion Temperatures: 215\u00b110\u00b0C" and
 * "BED: 80-95 \u00b0C". A naive scan of such a line picks the WRONG number and
 * even the wrong sign: it read the tolerance 10 as the temperature, and read the
 * hyphen in 80-95 as a minus sign to get -105.
 *
 * So the primary value is the first number appearing AFTER the property name, and
 * only that number is returned. A tolerance or a range upper bound is a modifier,
 * not the stated value, and a hyphen preceded by a digit is a range separator
 * rather than a negative sign.
 */
export function primaryMeasurement(claimText) {
  const text = String(claimText || '');
  const property = propertyFor(text);
  if (!property) return null;

  // Where does the property name end? Search for the earliest alias that matches.
  let after = 0;
  for (const [re, key] of PROPERTY_ALIASES) {
    if (key !== property) continue;
    const m = re.exec(text);
    if (m) { after = m.index + m[0].length; break; }
  }
  const tail = text.slice(after);

  // A tolerance is the case that breaks a naive "number then unit" scan. On
  // "215\u00b110\u00b0C" the unit follows the SECOND number, so a simple pattern
  // skips the 215 entirely and reports the tolerance of 10 as the stated value --
  // which for a nozzle temperature is outside any usable range and produced a
  // false flag. A specification's primary value is the BASE, not its tolerance.
  //
  // So the base is matched first, allowing a following \u00b1 or range separator.
  const withModifier = new RegExp(
    String.raw`(\d+(?:[.,]\d+)?)\s*(?:\u00b1|\+/-|to)\s*\d+(?:[.,]\d+)?\s*(GPa|MPa|kPa|Pa|g/cm3|g/cm\u00b3|kg/m3|%|\u00b0C|\u00b0F|L\b)`, 'i');
  const bare = new RegExp(
    String.raw`(\d+(?:[.,]\d+)?)\s*(GPa|MPa|kPa|Pa|g/cm3|g/cm\u00b3|kg/m3|%|\u00b0C|\u00b0F|L\b)`, 'i');

  const mMod = withModifier.exec(tail);
  const mBare = bare.exec(tail);
  // Prefer the base of a tolerance when it appears before the bare match.
  const m = mMod && (!mBare || mMod.index <= mBare.index) ? mMod : mBare;

  if (m) {
    // A range states two values. "230-250 °C" and "80-95 °C" are both usable
    // figures, and reporting the UPPER bound as *the* value is wrong in a way that
    // matters: a value just inside the top of a range would pass a check that the
    // lower bound should fail, and vice versa. The range is recorded as a range,
    // and the lower bound is used for the bounds check because violating the floor
    // is the failure that ruins material.
    const afterMatch = tail.slice(m.index + m[0].length);
    const rangeMatch = /^\s*[-\u2013\u2014]\s*(\d+(?:[.,]\d+)?)\s*(?:GPa|MPa|kPa|Pa|g\/cm3|g\/cm\u00b3|kg\/m3|%|\u00b0C|\u00b0F|L\b)/i.exec(afterMatch);
    const value = Number(m[1].replace(',', '.'));
    const rangeValue = rangeMatch ? Number(rangeMatch[1].replace(',', '.')) : null;
    return typeof buildResult === 'function'
      ? buildResult({m, value, rangeValue, tail, after, scale: UNIT_SCALES[m[2].toLowerCase()]})
      : {
          value, rawValue: m[1], unit: m[2], unitKey: m[2].toLowerCase(),
          start: after + m.index, end: after + m.index + m[0].length,
          trailing: tail.slice(m.index + m[0].length).trim().slice(0, 60),
          scale: UNIT_SCALES[m[2].toLowerCase()],
          rangeValue,
        };
  }

  // FALLBACK: a specification TABLE, where the value and its unit are in
  // different columns.
  //
  // This is not hypothetical. A real product page presented its properties as
  // "-- ISO 178 -- X-Y: 1980 -- Z: -- -- VALUE (unit): GPa", and a simple
  // number-then-unit scan returned null for every row, so the arithmetic checker
  // could not see the very table the original finding was about. That finding
  // existed only because a human did it by hand. A checker blind to its target's
  // own format is not a checker.
  //
  // A column-aware read is required, not a looser regex. Scanning for the first
  // number on such a line picks the TEST STANDARD number -- "ISO 178" gave 178,
  // "ISO 527" gave 527 -- which is worse than returning null, because a wrong
  // value is silently checked against the bounds and passes.
  //
  // The unit comes from a bare unit token, preferring one at the end of the line
  // or introduced by "VALUE (unit)".
  const unitTail = /VALUE\s*\(unit\)\s*:?\s*([A-Za-z%\u00b0\/\u00b2\u00b3]+)\s*$/i.exec(text);
  const unitAny = unitTail ?? /\b(GPa|MPa|kPa|Pa|g\/cm3|g\/cm\u00b3|kg\/m3|%|\u00b0C|\u00b0F)\b/i.exec(text);
  if (!unitAny) return null;
  const rawUnit = unitTail ? unitTail[1] : unitAny[1];
  const fu = rawUnit.toLowerCase();
  if (!UNIT_SCALES[fu]) return null;

  // Which column holds the value? Prefer the across-layer figure, because that is
  // the one a buyer designing a part will use. "VALUE:" alone means a
  // single-column property such as density.
  const columnPatterns = [
    /\bX\s*-\s*Y\s*:?\s*(-?\d+(?:[.,]\d+)?)/i,
    /\bVALUE\s*(?:\(unit\))?\s*:?\s*(-?\d+(?:[.,]\d+)?)/i,
    /\bX\s*:?\s*(-?\d+(?:[.,]\d+)?)/i,
  ];
  for (const cp of columnPatterns) {
    const cm = cp.exec(text);
    if (!cm) continue;
    const v = Number(cm[1].replace(',', '.'));
    if (!Number.isFinite(v)) continue;
    return {
      value: v, rawValue: cm[1], unit: rawUnit, unitKey: fu,
      start: cm.index, end: cm.index + cm[0].length,
      trailing: text.slice(cm.index + cm[0].length).trim().slice(0, 60),
      scale: UNIT_SCALES[fu],
      unitFromSeparateColumn: true,
      valueFromColumn: cm[0].split(':')[0].trim(),
      rangeValue: null,
    };
  }
  return null;
}
const NUM = String.raw`(-?\d+(?:[.,]\d+)?)`;

/**
 * Find "number + unit" pairs anywhere in a piece of text, with their offsets.
 * Handles the cases real pages use: "2310 GPa", "0.80 L", "50 mm/s", "240\u00b110 \u00b0C".
 */
export function measurements(text) {
  const src = String(text || '');
  const out = [];
  const re = new RegExp(`${NUM}\\s*(GPa|MPa|kPa|Pa|g/cm3|g/cm\\u00b3|kg/m3|%|\\u00b0C|\\u00b0F|L\\b)`, 'gi');
  let m;
  while ((m = re.exec(src)) !== null) {
    const raw = m[1];
    const value = Number(raw.replace(',', '.'));
    if (!Number.isFinite(value)) continue;
    const unitKey = m[2].toLowerCase();
    out.push({value, rawValue: raw, unit: m[2], unitKey, start: m.index, end: m.index + m[0].length});
  }
  return out;
}

/**
 * Flag a value that cannot be physically true in the unit it is stated in.
 *
 * This is the check built for a modulus published in the wrong unit (for example 2310 GPa). It only speaks
 * when the number is outside the range of ALL known materials, because that is
 * the case where a wrong unit is the only remaining explanation.
 */
export function checkBounds(claimText, propertyKey = propertyFor(claimText)) {
  if (!propertyKey) return [];
  const bounds = PROPERTY_BOUNDS[propertyKey];
  if (!bounds) return [];
  const m = primaryMeasurement(claimText);
  if (!m) return [];

  // Fahrenheit and Celsius are not related by a scale factor -- their zero points
  // differ -- so the conversion happens here rather than through UNIT_SCALES.
  // An earlier version looked the scale up FIRST, found null for Fahrenheit, and
  // returned without ever converting, so a Fahrenheit figure was never checked at
  // all. Silent non-checking is the worst outcome available, because it reads as
  // a pass.
  let inBoundsUnit;
  if (m.unitKey === '\u00b0f') inBoundsUnit = (m.value - 32) * 5 / 9;
  else if (m.unitKey === '\u00b0c') inBoundsUnit = m.value;
  else {
    const scale = UNIT_SCALES[m.unitKey];
    if (!scale || scale.toBoundsUnit === null) return [];
    inBoundsUnit = m.value * scale.toBoundsUnit;
  }
  if (!Number.isFinite(inBoundsUnit)) return [];
  // A negative temperature has a genuine absolute-vs-gauge ambiguity this module
  // cannot resolve, so it stays silent rather than guessing.
  if (/temperature/i.test(propertyKey) && m.value < 0) return [];

  if (inBoundsUnit < bounds.min || inBoundsUnit > bounds.max) {
    return [{
      kind: 'value-outside-physical-range',
      property: propertyKey,
      value: m.value,
      statedUnit: m.unit,
      interpretedAs: `${inBoundsUnit} ${bounds.unit}`,
      bounds,
      claimText,
      // The arithmetic travels with the flag so a human can falsify it.
      arithmetic: `${m.value} ${m.unit} = ${inBoundsUnit} ${bounds.unit}, which is outside ${bounds.min}-${bounds.max} ${bounds.unit}`,
      note: `No material lies outside this range (${bounds.because}). The value is most likely stated in a different unit than the label says.`,
    }];
  }
  return [];
}

/**
 * Compare a stated property against a value derived from two other stated
 * properties. This is the check that caught my own false accusation -- it
 * recomputes rather than reasons.
 */
export function checkDerived({stated, derived, property, formula, tolerance = 0.02}) {
  const a = Number(stated);
  const b = Number(derived);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return [];
  const relError = Math.abs(a - b) / Math.abs(a);
  if (relError <= tolerance) return [];
  return [{
    kind: 'derived-value-mismatch',
    property,
    stated: a,
    derived: b,
    formula,
    relativeError: Number(relError.toFixed(4)),
    arithmetic: `${formula} gives ${b}, but the page states ${a} (${(relError * 100).toFixed(1)}% apart)`,
    note: 'Either the stated value is wrong, or one of the inputs to the formula is. Both are worth a human look; neither is proven by this flag.',
  }];
}

/**
 * Cross-property consistency: a stated strain cannot exceed what a stated stress
 * can drive through a stated modulus.
 *
 * This is the argument that made the modulus finding decisive without needing any
 * external reference: it uses only figures the page itself publishes.
 */
export function checkStrainConsistency({strength, strengthUnit = 'MPa', modulus, modulusUnit = 'GPa', elongationPct}) {
  const flags = [];
  const stressMPa = strength * (UNIT_SCALES[strengthUnit.toLowerCase()]?.toBoundsUnit ?? 1) / 0.001;
  const modMPa = modulus * (UNIT_SCALES[modulusUnit.toLowerCase()]?.toBoundsUnit ?? 1) / 0.001;
  if (!Number.isFinite(stressMPa) || !Number.isFinite(modMPa) || modMPa === 0) return flags;
  const strainPct = (stressMPa / modMPa) * 100;
  if (Number.isFinite(elongationPct) && elongationPct > 0 && strainPct > 0) {
    const ratio = elongationPct / strainPct;
    // A specimen cannot reach a strain that its stress is far too small to drive.
    if (ratio > 50) {
      flags.push({
        kind: 'strain-exceeds-what-strength-can-drive',
        arithmetic: `strength ${strength} ${strengthUnit} / modulus ${modulus} ${modulusUnit} drives only ${strainPct.toExponential(2)}% strain, but elongation at break is stated as ${elongationPct}% -- ${ratio.toFixed(0)}x larger`,
        note: 'A specimen cannot reach a strain its strength is too small to produce. The modulus unit is the most likely error, because the strength and elongation figures are consistent with each other.',
        ratio: Number(ratio.toFixed(1)),
      });
    }
  }
  return flags;
}

/** Run every applicable check over one claim's text. */
export function checkClaim(claimText) {
  const property = propertyFor(claimText);
  return [...checkBounds(claimText, property)];
}
