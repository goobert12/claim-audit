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
  gPerOz: 28.349523125,
  barPerPsi: 0.0689475729,
  kmPerMi: 1.609344,
  lPerGalUs: 3.785411784,
  lPerGalUk: 4.54609,
  mPerFt: 0.3048,
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

  // A temperature range whose FIRST number carries no scale, written around a slash or in parentheses:
  // "20 - 30 C / 68 - 90 F", "20-30°C / 68-86°F", "20 - 30 C (68 - 86 F)". The earlier blocks all need a scale
  // letter after EACH number, so this common form was invisible: a wrong "90 F" beside "30 C" (30 C is 86 F) passed
  // with zero pairs checked. Named groups are used on purpose: a
  // numeric backreference with too few groups before it is read as an octal escape and silently matches nothing.
  const rangeBareFirst = /(?<![\d.])(?<lo1>-?\d+(?:\.\d+)?)\s*(?:°|deg\.?)?\s*(?:-|–|—|~|to)\s*(?<hi1>-?\d+(?:\.\d+)?)\s*(?:°|deg\.?\s*)?(?<u1>[FC])\b\s*(?:\/|\()\s*(?<lo2>-?\d+(?:\.\d+)?)\s*(?:°|deg\.?)?\s*(?:-|–|—|~|to)\s*(?<hi2>-?\d+(?:\.\d+)?)\s*(?:°|deg\.?\s*)?(?<u2>[FC])\b\)?/gi;
  while ((m = rangeBareFirst.exec(src)) !== null) {
    const g = m.groups;
    if (g.u1.toUpperCase() === g.u2.toUpperCase()) continue;
    pairs.push({
      kind: 'temperature-range',
      stated: Number(g.lo1), fromUnit: g.u1.toUpperCase(),
      statedOther: Number(g.lo2), toUnit: g.u2.toUpperCase(),
      statedHigh: Number(g.hi1), statedHighOther: Number(g.hi2),
      raw: m[0],
    });
  }

  // A SINGLE temperature in two scales: "30\u00b0F (-1\u00b0C)", "20\u00b0F / -7\u00b0C". Sleeping bags, batteries and
  // coolers state one rating this way. 7 of 59 real pages carried it and none were read. The numbers inside a RANGE
  // ("131\u00b0F (-20\u00b0C to 55\u00b0C)") are not single pairs and must not be paired with each other, so a match that sits
  // at the end of an "A to B" or just before a "to B" is skipped.
  const singleTemp = /(-?\d+(?:\.\d+)?)\s*\u00b0?\s*([FC])\b\s*(?:\/|\()\s*(-?\d+(?:\.\d+)?)\s*\u00b0?\s*([FC])\b\)?/gi;
  while ((m = singleTemp.exec(src)) !== null) {
    if (m[2].toUpperCase() === m[4].toUpperCase()) continue;
    const before = src.slice(Math.max(0, m.index - 14), m.index);
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 14);
    if (/(?:\bto|[-\u2013\u2014~])\s*$/i.test(before) || /^\s*(?:\bto\b|[-\u2013\u2014~]\s*-?\d)/i.test(after)) continue;
    pairs.push({
      kind: 'temperature',
      stated: Number(m[1]), fromUnit: m[2].toUpperCase(),
      statedOther: Number(m[3]), toUnit: m[4].toUpperCase(),
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

  // Weight written as pounds AND ounces beside a metric figure: "4 lb 6.9 oz (2010 g)", "2lbs 8oz / 1.13 kg". The plain
  // lb/kg pattern below needs one number before "lb", so a compound weight was never read. Found 2026-10-13 on a real
  // sleeping bag page (3 of 59 pages carried the form). Pounds and ounces are added into pounds first.
  const compound = /(\d+)\s*(?:lbs?|pounds?)\.?\s*(\d+(?:\.\d+)?)\s*(?:oz|ounces?)\.?\s*(?:\(|\/)\s*(\d+(?:\.\d+)?)\s*(kg|g)\b\)?/gi;
  while ((m = compound.exec(src)) !== null) {
    pairs.push({
      kind: 'weight',
      stated: Number(m[1]) + Number(m[2]) / 16, fromUnit: 'lb',
      statedOther: Number(m[3]), toUnit: m[4].toLowerCase(),
      display: `${m[1]} lb ${m[2]} oz`,
      raw: m[0],
    });
  }

  // Everyday pairs: ounces/grams, psi/bar, miles/km, gallons/litres, feet/metres, mph/kmh, as "A unit (B unit)" or "A unit / B unit",
  // in either order. A planted-error test showed all of these kinds going unchecked.
  const EVERYDAY = [
    ['oz', 'ounces?|oz', 'g', 'grams?|g'],
    ['psi', 'psi', 'bar', 'bar'],
    ['mi', 'miles?|mi', 'km', 'kilomet(?:er|re)s?|km'],
    ['gal', 'gal(?:lons?)?', 'l', 'lit(?:er|re)s?|l'],
    ['ft', 'feet|foot|ft', 'm', 'met(?:er|re)s?|m'],
    ['mph', 'mph', 'kmh', 'km/h|kph|kmh'],
  ];
  for (const [uA, reA, uB, reB] of EVERYDAY) {
    for (const [fromU, fromRe, toU, toRe] of [[uA, reA, uB, reB], [uB, reB, uA, reA]]) {
      // (?<!lb...) : "4 lb 10.4 oz (2110 g)" is a compound weight handled above; its ounces are not a stand-alone figure.
      const re = new RegExp(String.raw`(?<![\d.,/])(?<!(?:lbs?|pounds?)\.?\s*)(\d+(?:\.\d+)?)\s*(?:${fromRe})\.?(?![A-Za-z])\s*(?:\(|/|=)\s*(\d+(?:\.\d+)?)\s*(?:${toRe})(?![A-Za-z])\)?`, 'gi');
      while ((m = re.exec(src)) !== null) {
        pairs.push({kind: 'everyday', stated: Number(m[1]), fromUnit: fromU, statedOther: Number(m[2]), toUnit: toU, raw: m[0]});
      }
    }
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
  // A fraction is one number: "1/2 in (13 mm)" and "1-1/4 in (32 mm)" were read as "2 in" and "4 in" and flagged as false alarms.
  const fracVal = s => { const f = /^(?:(\d+)[- ])?(\d+)\/(\d+)$/.exec(s); return f ? Number(f[1] || 0) + Number(f[2]) / Number(f[3]) : Number(s); };
  const len = /(?<![\d.\/])((?:\d+[- ])?\d+\/\d+|\d+(?:\.\d+)?)\s*(in(?:ches)?|mm|cm)\s*\((\d+(?:\.\d+)?)\s*(mm|cm|in(?:ches)?)\)/gi;
  while ((m = len.exec(src)) !== null) {
    pairs.push({
      kind: 'length',
      stated: fracVal(m[1]), fromUnit: m[2].toLowerCase().replace('inches', 'in'),
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
  if (f === 'lb' && t === 'g') return value * CONVERSIONS.kgPerLb * 1000;
  if (f === 'g' && t === 'lb') return value / (CONVERSIONS.kgPerLb * 1000);
  if (f === 'in' && t === 'cm') return value * CONVERSIONS.cmPerIn;
  if (f === 'cm' && t === 'in') return value / CONVERSIONS.cmPerIn;
  if (f === 'cm' && t === 'mm') return value * CONVERSIONS.mmPerCm;
  if (f === 'mm' && t === 'cm') return value / CONVERSIONS.mmPerCm;
  if (f === 'oz' && t === 'g') return value * CONVERSIONS.gPerOz;
  if (f === 'g' && t === 'oz') return value / CONVERSIONS.gPerOz;
  if (f === 'psi' && t === 'bar') return value * CONVERSIONS.barPerPsi;
  if (f === 'bar' && t === 'psi') return value / CONVERSIONS.barPerPsi;
  if (f === 'mi' && t === 'km') return value * CONVERSIONS.kmPerMi;
  if (f === 'km' && t === 'mi') return value / CONVERSIONS.kmPerMi;
  if (f === 'gal' && t === 'l') return value * CONVERSIONS.lPerGalUs;
  if (f === 'l' && t === 'gal') return value / CONVERSIONS.lPerGalUs;
  if (f === 'ft' && t === 'm') return value * CONVERSIONS.mPerFt;
  if (f === 'm' && t === 'ft') return value / CONVERSIONS.mPerFt;
  if (f === 'mph' && t === 'kmh') return value * CONVERSIONS.kmPerMi;
  if (f === 'kmh' && t === 'mph') return value / CONVERSIONS.kmPerMi;
  if (f === 'kg' && t === 'g') return value * 1000;
  if (f === 'g' && t === 'kg') return value / 1000;
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
      let relError = Math.abs(exp - b) / scale;
      // "gallon" is ambiguous (US 3.785 L, UK 4.546 L); a page is right if it matches either, so only flag when it matches neither.
      if (pair.fromUnit === 'gal' || pair.toUnit === 'gal') {
        const ukExp = pair.fromUnit === 'gal' ? a * CONVERSIONS.lPerGalUk : a / CONVERSIONS.lPerGalUk;
        relError = Math.min(relError, Math.abs(ukExp - b) / Math.max(Math.abs(ukExp), Math.abs(b), 1e-9));
      }
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
      // A temperature near zero makes a relative tolerance meaningless: 15 F is -9.44 C, so a page that rounds
      // it to -9 C is correct, yet that is a 4.7% 'error'. A rounded whole-degree figure is within half a degree
      // of the exact conversion, so for temperatures the gap must also exceed that before it is a real mismatch.
      const roundingGap = (pair.kind === 'temperature-range' || pair.kind === 'temperature') ? Math.abs(exp - b) <= 0.55 : false;
      // A figure can only be as precise as it is written: "1.5 lbs" means 1.45 to 1.55, so "(700 g)" (1.54 lb) is
      // consistent with it, yet a flat 2% tolerance called it 2.8% apart. The allowance is half a unit in the last
      // written digit of EITHER figure, as a fraction of that figure. Found 2026-10-13 on a real sleeping bag page, once
      // the tool could finally convert pounds to grams.
      const decimalsOf = x => Math.min(6, (String(x).split('.')[1] || '').length);
      // A figure that is exactly zero has no relative precision, so it contributes no allowance (dividing by a near-zero
      // made the allowance huge and let "0 C (50 F)" pass: 0 C is 32 F). Found 2026-10-13 in a code review.
      const sideAllowance = x => (x === 0 ? 0 : 0.5 * 10 ** -decimalsOf(x) / Math.abs(x));
      const roundingAllowance = Math.max(sideAllowance(a), sideAllowance(b));
      if (relError > Math.max(tolerance, roundingAllowance) && !roundingGap) {
        flags.push({
          ...record,
          flagKind: 'conversion-mismatch',
          arithmetic: `${pair.display ?? `${a} ${pair.fromUnit}`} = ${round(exp, 4)} ${pair.toUnit}, but the page states ${b} ${pair.toUnit} (${(relError * 100).toFixed(1)}% apart)`,
          note: 'The page states this quantity in two unit systems and they disagree by more than rounding to the last written digit explains. One of the two figures is off, unless one of them was truncated instead of rounded (1.77 written as 1.7), so check which before treating it as an error.',
        });
      }
    }
  }
  return {flags, checked};
}
