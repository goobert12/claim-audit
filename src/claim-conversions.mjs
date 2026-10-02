// Checks that need no domain knowledge: a page that states the same quantity in
// two unit systems and gets the conversion wrong.
//
// WHY THIS INSTEAD OF MORE BOUNDS. Extending PROPERTY_BOUNDS to batteries would
// mean inventing physical ranges for voltage, current, capacity and torque, and a
// wrong bound is a false accusation with arithmetic behind it -- harder to argue
// with than a plain mistake. But a page that writes "11.4 in (290 mm)" has already
// committed to a testable relationship: the two numbers must agree.
//
// So this module is domain-independent by construction. It compares a page against
// itself, which means it works on a battery sheet, a filament sheet, or a
// cookbook, and it can never be wrong about the material -- only about the
// arithmetic, which is decidable.
//
// Written after a battery-style specification page was found to state many quantities
// twice, in two unit systems, and every one of them had to be hand-checked. That
// hand-check is the exact procedure this automates.

/** Exact conversion factors. Exact by definition, so the tolerance is only rounding. */
const CONVERSIONS = Object.freeze({
  mmPerIn: 25.4,
  gPerLb: 453.59237,
  kgPerLb: 0.45359237,
  cmPerIn: 2.54,
  mmPerCm: 10,
  nmPerInLb: 0.112984829,
});

const round = (v, dp) => Number(v.toFixed(dp));

/**
 * Find pairs where a page states one quantity in two unit systems, typically as
 * "A unit1 (B unit2)" or "A unit1 to B unit1".
 *
 * Returns candidate pairs with the conversion that relates them, WITHOUT judging
 * them. Judging is a separate step so the extraction can be inspected on its own.
 */
export function conversionPairs(text) {
  const src = String(text || '');
  const pairs = [];

  // Length: "11.4 x 8.2 x 7.9 in (290 x 208 x 200 mm)" -- element-wise.
  const dims = /((?:\d+(?:\.\d+)?\s*(?:x|\u00d7)\s*)+\d+(?:\.\d+)?)\s*(in|inches|cm|mm)\s*\(([^)]+)\)/gi;
  let m;
  while ((m = dims.exec(src)) !== null) {
    const left = m[1].split(/\s*(?:x|\u00d7)\s*/i).map(Number);
    const right = m[3].split(/\s*(?:x|\u00d7)\s*/i).map(s => Number(String(s).replace(/[^\d.]/g, '')));
    const rightUnitMatch = /(mm|cm|in|inches)\b/i.exec(m[3]);
    if (!rightUnitMatch || left.length !== right.length) continue;
    const from = m[2].toLowerCase();
    const to = rightUnitMatch[1].toLowerCase();
    for (let i = 0; i < left.length; i += 1) {
      if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) continue;
      pairs.push({
        kind: 'dimension-set',
        indexInSet: i,
        stated: left[i], fromUnit: from,
        statedOther: right[i], toUnit: to,
        raw: m[0],
      });
    }
  }

  // Temperature ranges: "-4\u00b0F to 131\u00b0F (-20\u00b0C to 55\u00b0C)".
  const temps = /(-?\d+(?:\.\d+)?)\s*\u00b0?\s*([FC])\s*(?:to|-|\u2013)\s*(-?\d+(?:\.\d+)?)\s*\u00b0?\s*\2\s*\((-?\d+(?:\.\d+)?)\s*\u00b0?\s*([FC])\s*(?:to|-|\u2013)\s*(-?\d+(?:\.\d+)?)\s*\u00b0?\s*\5\s*\)/gi;
  while ((m = temps.exec(src)) !== null) {
    pairs.push({
      kind: 'temperature-range',
      stated: Number(m[1]), fromUnit: m[2].toUpperCase(),
      statedOther: Number(m[4]), toUnit: m[5].toUpperCase(),
      statedHigh: Number(m[3]), statedHighOther: Number(m[6]),
      raw: m[0],
    });
  }

  // Torque: "44.3 inch\u00b7lbs / 5 N\u00b7m".
  const torque = /(\d+(?:\.\d+)?)\s*(?:inch[\u00b7\s-]*l(?:bs?|bf)|in[\u00b7\s-]*lbs?)\s*\/\s*(\d+(?:\.\d+)?)\s*N[\u00b7\s-]*m/gi;
  while ((m = torque.exec(src)) !== null) {
    pairs.push({
      kind: 'torque',
      stated: Number(m[1]), fromUnit: 'in-lb',
      statedOther: Number(m[2]), toUnit: 'N-m',
      raw: m[0],
    });
  }

  // Weight: "31.5 lbs. (14.3 kg)".
  const weight = /(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\.?\s*\((\d+(?:\.\d+)?)\s*(kg|g)\)/gi;
  while ((m = weight.exec(src)) !== null) {
    pairs.push({
      kind: 'weight',
      stated: Number(m[1]), fromUnit: 'lb',
      statedOther: Number(m[2]), toUnit: m[3].toLowerCase(),
      raw: m[0],
    });
  }

  // Plain length: "9.84 inches (25 cm)".
  const len = /(\d+(?:\.\d+)?)\s*(in(?:ches)?|mm|cm)\s*\((\d+(?:\.\d+)?)\s*(mm|cm|in(?:ches)?)\)/gi;
  while ((m = len.exec(src)) !== null) {
    pairs.push({
      kind: 'length',
      stated: Number(m[1]), fromUnit: m[2].toLowerCase().replace('inches', 'in'),
      statedOther: Number(m[3]), toUnit: m[4].toLowerCase().replace('inches', 'in'),
      raw: m[0],
    });
  }

  return pairs;
}

/** Convert a value between the units this module knows. Returns null if unrelated. */
export function convert(value, fromUnit, toUnit) {
  const f = String(fromUnit).toLowerCase().replace('inches', 'in');
  const t = String(toUnit).toLowerCase().replace('inches', 'in');
  if (f === t) return value;
  if (f === 'in' && t === 'mm') return value * CONVERSIONS.mmPerIn;
  if (f === 'mm' && t === 'in') return value / CONVERSIONS.mmPerIn;
  if (f === 'lb' && t === 'kg') return value * CONVERSIONS.kgPerLb;
  if (f === 'kg' && t === 'lb') return value / CONVERSIONS.kgPerLb;
  if (f === 'f' && t === 'c') return (value - 32) * 5 / 9;
  if (f === 'c' && t === 'f') return value * 9 / 5 + 32;
  if (f === 'in-lb' && t === 'n-m') return value * CONVERSIONS.nmPerInLb;
  if (f === 'n-m' && t === 'in-lb') return value / CONVERSIONS.nmPerInLb;
  return null;
}

/**
 * Check every two-unit statement on a page against its own conversion.
 *
 * `tolerance` is relative, because published figures are rounded: a page writing
 * "31.5 lbs (14.3 kg)" is correct to the precision it chose, and 14.3 kg is 31.526
 * lbs. The default accommodates the rounding a page actually does rather than
 * demanding more precision than a spec sheet offers.
 */
export function checkConversions(text, {tolerance = 0.02} = {}) {
  const flags = [];
  const checked = [];

  for (const pair of conversionPairs(text)) {
    const expected = convert(pair.stated, pair.fromUnit, pair.toUnit);
    if (expected === null || !Number.isFinite(expected)) continue;

    const checks = pair.kind === 'temperature-range'
      ? [[pair.stated, pair.statedOther], [pair.statedHigh, pair.statedHighOther]]
      : [[pair.stated, pair.statedOther]];

    for (const [a, b] of checks) {
      const exp = Array.isArray(expected) ? expected : convert(a, pair.fromUnit, pair.toUnit);
      if (exp === null || !Number.isFinite(exp)) continue;
      const scale = Math.max(Math.abs(exp), Math.abs(b), 1e-9);
      const relError = Math.abs(exp - b) / scale;
      const record = {
        kind: 'unit-conversion',
        conversionKind: pair.kind,
        stated: a, fromUnit: pair.fromUnit,
        statedOther: b, toUnit: pair.toUnit,
        expected: round(exp, 4),
        relativeError: Number(relError.toFixed(5)),
        raw: pair.raw,
      };
      checked.push(record);
      if (relError > tolerance) {
        flags.push({
          ...record,
          flagKind: 'conversion-mismatch',
          arithmetic: `${a} ${pair.fromUnit} = ${round(exp, 4)} ${pair.toUnit}, but the page states ${b} ${pair.toUnit} (${(relError * 100).toFixed(1)}% apart)`,
          note: 'The page states this quantity in two unit systems and they disagree. One of the two figures is wrong; both being rounded is not enough to explain this gap.',
        });
      }
    }
  }
  return {flags, checked};
}
