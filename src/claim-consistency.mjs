// Checks a page can fail against ITSELF, with no outside reference: a reversed range, watts that exceed volts x amps,
// a total that is not the sum of its listed parts, a volume larger than its own bounding box.
//
// Added 2026-10-13 after a planted-error test (54 deliberately wrong spec lines) showed the checker caught 22 of 54 and
// missed these kinds entirely. Every rule here is deliberately ONE-SIDED where the other side has an innocent explanation:
//   - watts below volts x amps is normal (power factor, efficiency, "max current"), so only watts ABOVE volts x amps is flagged;
//   - a volume below its bounding box is normal (rounded corners, walls), so only a volume ABOVE the box is flagged.
// A rule that cannot be wrong about the direction it flags is worth more than a tighter one that cries wolf.

const NUM = String.raw`\d+(?:\.\d+)?`;
const RANGE_UNIT = String.raw`(?:°\s?[CF]|\bdeg\s?[CF]\b|(?<=\s)[CF](?![A-Za-z])|V(?![A-Za-z])|A(?![A-Za-z])|W(?![A-Za-z])|Hz|kHz|MHz|mm|cm|in(?![A-Za-z])|kg|lbs?|g(?![A-Za-z])|%|psi|bar|L(?![A-Za-z])|mAh|Ah|Wh)`;

/** A range written high-to-low ("220-110 V", "12 to 5 V", "55 to -20 C") reads as a typo for low-to-high. */
export function checkRangeOrder(text) {
  const flags = [];
  // The first figure may carry its own unit only before "to" ("55 C to -20 C"); before a hyphen it would be a subtraction ("10 V - 3 V").
  const re = new RegExp(String.raw`(?<![\w.,/\-])(-?${NUM})\s*(?:(?:${RANGE_UNIT})\s*to\b|[-–—]|\bto\b)\s*(-?${NUM})(?![\d./])\s*(${RANGE_UNIT})`, 'gi');
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const lo = Number(m[1]), hi = Number(m[2]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= hi) continue;
    // "24V to 12V" with volts on both sides names a conversion (a step-down converter), not a range.
    if (/\d\s*V\s*to\b/i.test(m[0])) continue;
    flags.push({
      kind: 'reversed-range',
      claimText: m[0],
      arithmetic: `${m[1]} to ${m[2]} ${m[3]} runs high to low`,
      note: 'A range is normally written low to high. This is probably a transposed figure; either end could be the wrong one.',
      relativeError: (lo - hi) / Math.max(Math.abs(lo), 1e-9),
    });
  }
  return flags;
}

/** Real power can never exceed volts x amps. Flag only watts ABOVE the product (the reverse has innocent causes). */
export function checkPowerTriplet(text, {tolerance = 0.03} = {}) {
  const flags = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.length > 400) continue;
    const grab = (unit) => [...line.matchAll(new RegExp(String.raw`(?<![\d.,])(${NUM})\s*${unit}(?![A-Za-z0-9·])`, 'g'))].map(x => Number(x[1]));
    const volts = grab('V'), amps = grab('A'), watts = grab('W');
    // Exactly one of each (counting every token, including "5V, 2.4A/9V, 2A" profile lists), so it is unambiguous which figures
    // belong together; a range of volts ("100-240 V") means input data.
    if (volts.length !== 1 || amps.length !== 1 || watts.length !== 1) continue;
    if (new RegExp(String.raw`${NUM}\s*[-–—]\s*${NUM}\s*V`).test(line)) continue;
    // Words that mean the figures are not one operating point: a maximum, a peak, a surge, "up to", a negotiated USB-PD profile.
    // (Found on real pages: "100W max, 5V, 2.4A" is one profile of a USB-C port; "5500W (Up to 100A)" mixes an inverter and a charger.)
    if (/\b(?:max|maximum|peak|surge|up to|upto|pd|programmable|input|charger|charging)\b/i.test(line)) continue;
    const product = volts[0] * amps[0];
    if (!(product > 0) || watts[0] <= product * (1 + tolerance)) continue;
    flags.push({
      kind: 'power-exceeds-volts-times-amps',
      claimText: line.trim(),
      arithmetic: `${volts[0]} V x ${amps[0]} A = ${Number(product.toFixed(3))} W, but the line states ${watts[0]} W`,
      note: 'Power cannot exceed volts times amps. Either the wattage is overstated or the voltage/current is understated.',
      relativeError: (watts[0] - product) / watts[0],
    });
  }
  return flags;
}

/** "2 x 1024 Wh (2400 Wh maximum)": a count times a unit capacity against a stated total in the same energy or charge unit. */
export function checkCountTimesCapacity(text, {tolerance = 0.03} = {}) {
  const flags = [];
  const re = new RegExp(String.raw`(?<![\w.])(\d+)\s*[x×]\s*(${NUM})\s*(kWh|Wh|mAh|Ah)\s*[(\[,]?\s*(?:total\s*[:=]?\s*)?(${NUM})\s*(kWh|Wh|mAh|Ah)\b`, 'gi');
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    if (m[3].toLowerCase() !== m[5].toLowerCase()) continue;
    const expected = Number(m[1]) * Number(m[2]), stated = Number(m[4]);
    if (!(expected > 0) || !(stated > 0) || Math.abs(expected - stated) / Math.max(expected, stated) <= tolerance) continue;
    // A pack of N where the page states the PER-UNIT figure beside the count is not a mismatch.
    if (Math.abs(Number(m[2]) - stated) / stated <= tolerance) continue;
    flags.push({
      kind: 'count-times-capacity-mismatch',
      claimText: m[0].trim(),
      arithmetic: `${m[1]} x ${m[2]} ${m[3]} = ${Number(expected.toFixed(3))} ${m[3]}, but the line states ${m[4]} ${m[5]}`,
      note: 'A count times a unit capacity should equal the stated total. Either the count, the capacity or the total is off.',
      relativeError: Math.abs(expected - stated) / Math.max(expected, stated),
    });
  }
  return flags;
}

/** "5.0 + 2.8 + 3.5 lbs" beside a stated total of 14.2 lbs. */
export function checkSumOfParts(text, {tolerance = 0.02} = {}) {
  const flags = [];
  const UNIT = String.raw`(lbs?|oz|kg|g|mAh|Ah|Wh|W|V|A|L|mm|cm|in|ft|%|USD)`;
  for (const raw of String(text || '').split(/\r?\n/)) {
    // "$210 + $140" is read as "210 USD + 140 USD"
    const line = raw.replace(/\$\s?(\d+(?:\.\d+)?)/g, '$1 USD');
    if (line.length > 400) continue;
    // Not inside a word or code ("Aurora Gold(D9A63A+9675CD)" is a colour code, not 63 A + 9675).
    const expr = new RegExp(String.raw`(?<![\w#])((?:${NUM})(?:\s*${UNIT})?(?:\s*\+\s*(?:${NUM})(?:\s*${UNIT})?)+)\s*${UNIT}?(?![\w])`, 'i').exec(line);
    if (!expr) continue;
    const parts = [...expr[1].matchAll(new RegExp(NUM, 'g'))].map(x => Number(x[0]));
    if (parts.length < 2) continue;
    const unit = (expr[1].match(new RegExp(UNIT, 'i')) || expr[0].match(new RegExp(UNIT + '\\s*$', 'i')) || [])[1];
    if (!unit) continue;
    const sum = parts.reduce((a, b) => a + b, 0);
    // Totals: other figures on the line in the same unit that are not themselves a part.
    const rest = line.replace(expr[0], ' ');
    const totals = [...rest.matchAll(new RegExp(String.raw`(?<![\d.])(${NUM})\s*${unit}(?![A-Za-z])`, 'gi'))].map(x => Number(x[1])).filter(t => !parts.includes(t));
    if (totals.length !== 1) continue;
    const t = totals[0];
    if (Math.abs(t - sum) / Math.max(t, sum) <= tolerance) continue;
    flags.push({
      kind: 'total-not-sum-of-parts',
      claimText: line.trim(),
      arithmetic: `${parts.join(' + ')} = ${Number(sum.toFixed(4))} ${unit}, but the line states a total of ${t} ${unit}`,
      note: 'A stated total should equal its listed parts. Either the total or one of the parts is off.',
      relativeError: Math.abs(t - sum) / Math.max(t, sum),
    });
  }
  return flags;
}

const CUBIC_IN = {'cu in': 1, 'in3': 1, 'in³': 1, 'cu ft': 1728, 'ft3': 1728, 'ft³': 1728};
const TO_CU_IN_FROM_L = 61.0237441;
function toCubicInches(value, unit) {
  const u = unit.toLowerCase().replace(/\s+/g, ' ');
  if (u in CUBIC_IN) return value * CUBIC_IN[u];
  if (/^(l|liters?|litres?)$/.test(u)) return value * TO_CU_IN_FROM_L;
  if (/^(cm3|cm³|cc)$/.test(u)) return value * TO_CU_IN_FROM_L / 1000;
  if (/^(m3|m³)$/.test(u)) return value * TO_CU_IN_FROM_L * 1000;
  return null;
}
const toInches = (v, u) => ({in: v, inch: v, inches: v, ft: v * 12, cm: v / 2.54, mm: v / 25.4, m: v / 0.0254})[u.toLowerCase()] ?? null;

/** A stated volume cannot exceed the box the stated dimensions describe. */
export function checkVolumeVsDimensions(text, {tolerance = 0.03} = {}) {
  const flags = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.length > 400) continue;
    const dims = new RegExp(String.raw`(${NUM})\s*(?:x|×)\s*(${NUM})\s*(?:x|×)\s*(${NUM})\s*(inches|inch|in|ft|cm|mm|m)(?![A-Za-z])`, 'i').exec(line);
    const vol = new RegExp(String.raw`(?<![\d.])(${NUM})\s*(cu\.?\s?in|cu\.?\s?ft|in³|ft³|in3|ft3|liters?|litres?|cm³|cm3|m³|m3|L)(?![A-Za-z])`, 'i').exec(line.replace(dims ? dims[0] : '', ' '));
    if (!dims || !vol) continue;
    const e = toInches(1, dims[4]);
    if (e === null) continue;
    const box = Number(dims[1]) * Number(dims[2]) * Number(dims[3]) * e ** 3;
    const stated = toCubicInches(Number(vol[1]), vol[2].replace(/\./g, ''));
    if (stated === null || !(box > 0) || stated <= box * (1 + tolerance)) continue;
    flags.push({
      kind: 'volume-exceeds-dimensions',
      claimText: line.trim(),
      arithmetic: `${dims[1]} x ${dims[2]} x ${dims[3]} ${dims[4]} is about ${Number(box.toFixed(1))} cubic inches, but the line states ${vol[1]} ${vol[2]} (about ${Number(stated.toFixed(1))} cubic inches)`,
      note: 'A volume cannot be larger than the box its own dimensions describe. Either the volume or a dimension is wrong.',
      relativeError: (stated - box) / stated,
    });
  }
  return flags;
}

/** A solid block cannot weigh more than its bounding box times its stated density. (Lighter is normal: hollow, rounded.) */
export function checkWeightVsDensity(text, {tolerance = 0.03} = {}) {
  const flags = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.length > 400) continue;
    const dims = new RegExp(String.raw`(${NUM})\s*(?:x|×)\s*(${NUM})\s*(?:x|×)\s*(${NUM})\s*(inches|inch|in|ft|cm|mm|m)(?![A-Za-z])`, 'i').exec(line);
    const den = new RegExp(String.raw`(${NUM})\s*(lbs?/in(?:3|³)|lbs?/ft(?:3|³)|g/cm(?:3|³)|kg/m(?:3|³)|kg/L)`, 'i').exec(line);
    const wt = new RegExp(String.raw`weight\s*:?\s*(${NUM})\s*(lbs?|kg|g|oz)(?![A-Za-z/])`, 'i').exec(line);
    if (!dims || !den || !wt) continue;
    const inch = toInches(1, dims[4]);
    if (inch === null) continue;
    const boxIn3 = Number(dims[1]) * Number(dims[2]) * Number(dims[3]) * inch ** 3;
    // density to lb per cubic inch
    const d = Number(den[1]), du = den[2].toLowerCase().replace('³', '3');
    const lbPerIn3 = du.startsWith('lb') ? (du.includes('ft') ? d / 1728 : d)
      : du.startsWith('g/cm') ? d * 0.0361273 : du.startsWith('kg/m') ? d * 0.0000361273 : du === 'kg/l' ? d * 0.0361273 : null;
    if (lbPerIn3 === null) continue;
    const w = Number(wt[1]), wu = wt[2].toLowerCase();
    const weightLb = wu.startsWith('lb') ? w : wu === 'kg' ? w * 2.20462262 : wu === 'g' ? w * 0.00220462262 : w / 16;
    const maxLb = boxIn3 * lbPerIn3;
    if (!(maxLb > 0) || weightLb <= maxLb * (1 + tolerance)) continue;
    flags.push({
      kind: 'weight-exceeds-size-times-density',
      claimText: line.trim(),
      arithmetic: `${dims[1]} x ${dims[2]} x ${dims[3]} ${dims[4]} at ${den[1]} ${den[2]} is at most ${Number(maxLb.toFixed(2))} lb, but the line states ${wt[1]} ${wt[2]}`,
      note: 'A solid block cannot weigh more than its size times its density. Either the weight, a dimension or the density is wrong.',
      relativeError: (weightLb - maxLb) / weightLb,
    });
  }
  return flags;
}

export function checkConsistency(text) {
  return [...checkRangeOrder(text), ...checkPowerTriplet(text), ...checkSumOfParts(text), ...checkCountTimesCapacity(text), ...checkVolumeVsDimensions(text), ...checkWeightVsDensity(text)];
}
