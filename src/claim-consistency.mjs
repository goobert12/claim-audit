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

const SCALES = {
  hz: ['frequency', 1], khz: ['frequency', 1e3], mhz: ['frequency', 1e6],
  mah: ['charge', 1e-3], ah: ['charge', 1],
  mm: ['length', 1], cm: ['length', 10], in: ['length', 25.4],
  g: ['mass', 1], kg: ['mass', 1000], lb: ['mass', 453.59237], lbs: ['mass', 453.59237],
};
function unitScale(raw) {
  const u = String(raw).toLowerCase().replace(/\s+/g, '').replace('deg', '°');
  if (u === '°c' || u === 'c') return {family: 'temperature', unit: 'c', scale: 1};
  if (u === '°f' || u === 'f') return {family: 'temperature', unit: 'f', scale: 1};
  return SCALES[u] ? {family: SCALES[u][0], unit: u, scale: SCALES[u][1]} : {family: u, unit: u, scale: 1};
}

/** A range written high-to-low ("220-110 V", "12 to 5 V", "55 to -20 C") reads as a typo for low-to-high. */
export function checkRangeOrder(text) {
  const flags = [];
  // The first figure may carry its own unit before "to" or an en/em dash ("50 Hz to 20 kHz", "55 C to -20 C"); before a plain hyphen it
  // would be a subtraction ("10 V - 3 V"), so that form is only read when the unit is written once, after the second figure.
  const re = new RegExp(String.raw`(?<![\w.,/\-])(?<lo>-?${NUM})\s*(?:(?<u1>${RANGE_UNIT})\s*(?:(?:up\s+)?to\b|[–—])|[-–—]|\b(?:up\s+)?to\b)\s*(?<hi>-?${NUM})(?![\d./])\s*(?<u2>${RANGE_UNIT})`, 'gi');
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    let lo = Number(m.groups.lo), hi = Number(m.groups.hi);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    // The two ends may be written in different-sized units of one family ("50 Hz to 20 kHz", "500 g to 1 kg"): compare in a common unit.
    // Found on a real product page: the raw numbers 50 and 20 read as "high to low". Different families, or two temperature scales,
    // are not comparable, so those are left alone.
    if (m.groups.u1) {
      const a = unitScale(m.groups.u1), b = unitScale(m.groups.u2);
      if (!a || !b || a.family !== b.family || (a.family === 'temperature' && a.unit !== b.unit)) continue;
      lo *= a.scale; hi *= b.scale;
    }
    if (lo <= hi) continue;
    // "24V to 12V" with volts on both sides names a conversion (a step-down converter), not a range.
    if (/\d\s*V\s*to\b/i.test(m[0])) continue;
    flags.push({
      kind: 'reversed-range',
      claimText: m[0],
      arithmetic: `${m.groups.lo} to ${m.groups.hi} ${m.groups.u2} runs high to low`,
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
    // A leading count ("2 x 50 W + 100 W (200 W total)") or mixed ratings ("20 W + 20 W RMS, 50 W peak") make a plain sum the
    // wrong comparison. Both were false alarms in an independent review.
    if (/(?:\d\s*[x×]\s*)$/i.test(line.slice(0, expr.index)) || /[x×]/i.test(expr[0]) ||
        /\b(?:peak|max|maximum|rms|rated|continuous|surge|program|music)\b/i.test(line)) continue;
    const parts =[...expr[1].matchAll(new RegExp(NUM, 'g'))].map(x => Number(x[0]));
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

const NUMC = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const numOf = s => Number(String(s).replace(/,/g, ''));
// Words that mean a stated total is not simply the arithmetic of the parts (tax, shipping, optional extras, bonus items).
const NOT_PLAIN_TOTAL = /\$|€|£|\b(?:tax|shipping|plus|extra|bonus|free|optional|add(?:itional)?|excluding|including|approx|up to|max|peak)\b/i;

/** "12 bars at 40 g each, for a total of 600 g": a count times an each-figure against a stated total. */
export function checkEachTotal(text, {tolerance = 0.02} = {}) {
  const flags = [];
  for (const raw of String(text || '').split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/)) {
    const line = raw.trim();
    if (line.length > 300 || NOT_PLAIN_TOTAL.test(line)) continue;
    const m = new RegExp(String.raw`(?<![\d.,])(${NUMC})\s+(?:[A-Za-z-]+\s+){0,3}?(?:at|with|of)\s+(${NUMC})\s*([A-Za-z%]{0,8})\s+each\b([^.]*?)\b(?:total(?:\s+of)?|giving|delivering|for)\s*:?\s*(${NUMC})\s*([A-Za-z%]{0,8})|(?<![\d.,])(${NUMC})\s+(?:[A-Za-z-]+\s+){0,3}?(?:at|with|of)\s+(${NUMC})\s*([A-Za-z%]{0,8})\s+each\b[^.]*?\b(${NUMC})\s*([A-Za-z%]{0,8})\s+(?:in\s+)?total\b`, 'i').exec(line);
    if (!m) continue;
    const [count, each, eachUnit, total, totalUnit] = m[1]
      ? [numOf(m[1]), numOf(m[2]), m[3], numOf(m[5]), m[6]]
      : [numOf(m[7]), numOf(m[8]), m[9], numOf(m[10]), m[11]];
    // Only compare like with like: the total is in the each-figure's unit (or both are unitless counts).
    if ((eachUnit || totalUnit) && eachUnit.toLowerCase() !== totalUnit.toLowerCase()) continue;
    const product = count * each;
    if (!(product > 0) || !(total > 0) || Math.abs(product - total) / Math.max(product, total) <= tolerance) continue;
    flags.push({
      kind: 'each-times-count-mismatch',
      claimText: line,
      arithmetic: `${count} x ${each}${eachUnit ? ' ' + eachUnit : ''} = ${Number(product.toFixed(4))}, but the text states a total of ${total}${totalUnit ? ' ' + totalUnit : ''}`,
      note: 'A count times an each-figure should equal the stated total. Either the count, the each-figure or the total is off.',
      relativeError: Math.abs(product - total) / Math.max(product, total),
    });
  }
  return flags;
}

/** "the set weighs 40 lbs, the bench 35 lbs, and the rack 20 lbs, for a total of 105 lbs": same-unit parts against a stated total. */
export function checkListedSum(text, {tolerance = 0.02} = {}) {
  const flags = [];
  for (const raw of String(text || '').split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/)) {
    const line = raw.trim();
    if (line.length > 300 || NOT_PLAIN_TOTAL.test(line)) continue;
    const t = new RegExp(String.raw`(?:(?:for\s+)?a\s+)?total(?:\s+of)?\s*:?\s*(${NUMC})\s*([A-Za-z%]{1,8})?|(${NUMC})\s*([A-Za-z%]{1,8})?\s+(?:in\s+)?total\b`, 'i').exec(line);
    if (!t) continue;
    const total = numOf(t[1] ?? t[3]);
    const unit = (t[2] ?? t[4] ?? '').toLowerCase();
    const before = line.slice(0, t.index);
    if (/\b(?:each|per|every)\b|\d\s*[x×]\s*\d|[+=]/i.test(before)) continue; // products and explicit sums are other checks
    const parts = [...before.matchAll(new RegExp(String.raw`(?<![\d.,A-Za-z-])(${NUMC})\s*([A-Za-z%]{0,8})`, 'g'))].map(x => ({v: numOf(x[1]), u: x[2].toLowerCase()}));
    if (parts.length < 2 || parts.length > 6) continue;
    // A unit that is not a measurement ('pieces', 'ports', 'lids') is a count word, not a unit: treat the list as counts.
    const MEASURE = /^(?:kg|g|lbs?|oz|mg|w|kw|v|a|ma|wh|kwh|ah|mah|l|ml|mm|cm|m|km|in|ft|mi|hz|khz|%|mins?|minutes?|hrs?|hours?|days?|s)$/;
    if (unit && MEASURE.test(unit)) {
      // weights, volumes, powers: every part must carry the same unit as the total
      if (!parts.every(p => p.u === unit)) continue;
    } else {
      // plain counts: parts are whole numbers followed by words (3 bottles and 5 refills), and the total is a whole number
      if (!parts.every(p => Number.isInteger(p.v) && p.v < 1000) || !Number.isInteger(total)) continue;
      if (/\d/.test(before.replace(new RegExp(String.raw`(?<![\d.,A-Za-z-])(?:${NUMC})`, 'g'), ''))) continue;
    }
    const sum = parts.reduce((a, p) => a + p.v, 0);
    if (!(sum > 0) || Math.abs(sum - total) / Math.max(sum, total) <= tolerance) continue;
    flags.push({
      kind: 'listed-total-mismatch',
      claimText: line,
      arithmetic: `${parts.map(p => p.v).join(' + ')} = ${Number(sum.toFixed(4))}${unit ? ' ' + unit : ''}, but the text states a total of ${total}${unit ? ' ' + unit : ''}`,
      note: 'Listed parts should add up to the stated total. Either the total or one of the parts is off.',
      relativeError: Math.abs(sum - total) / Math.max(sum, total),
    });
  }
  return flags;
}

/**
 * Watt-hours against amp-hours times nominal volts when the figures are not in "V Ah Wh" order: "5000 mAh (37 Wh) battery, 3.7 V nominal".
 * Speaks only when the line holds exactly one capacity, one energy and one VOLTAGE that is called nominal (or the only voltage and no
 * current figure), because USB outputs ("5 V / 2 A") are not the battery voltage.
 */
export function checkChargeVoltEnergy(text, {tolerance = 0.08} = {}) {
  const flags = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length > 300 || /\b(?:output|input|charge|charging|usb|pd|max|peak)\b/i.test(line)) continue;
    const ah = [...line.matchAll(new RegExp(String.raw`(?<![\d.,])(${NUMC})\s*(mAh|Ah)\b`, 'gi'))];
    const wh = [...line.matchAll(new RegExp(String.raw`(?<![\d.,])(${NUMC})\s*Wh\b`, 'gi'))];
    const volts = [...line.matchAll(new RegExp(String.raw`(?<![\d.,])(${NUMC})\s*V(?![A-Za-z])`, 'g'))];
    const amps = [...line.matchAll(new RegExp(String.raw`(?<![\d.,])(${NUMC})\s*A(?![A-Za-z])`, 'g'))];
    if (ah.length !== 1 || wh.length !== 1 || volts.length !== 1 || amps.length) continue;
    const cap = numOf(ah[0][1]) / (ah[0][2].toLowerCase() === 'mah' ? 1000 : 1);
    const derived = cap * numOf(volts[0][1]);
    const stated = numOf(wh[0][1]);
    // "V Ah Wh" in that order is already handled by checkEnergyTriplets.
    if (volts[0].index < ah[0].index && ah[0].index < wh[0].index) continue;
    if (!(derived > 0) || !(stated > 0) || Math.abs(derived - stated) / stated <= tolerance) continue;
    flags.push({
      kind: 'charge-volt-energy-mismatch',
      claimText: line,
      arithmetic: `${ah[0][1]} ${ah[0][2]} x ${volts[0][1]} V = ${Number(derived.toFixed(3))} Wh, but the line states ${wh[0][1]} Wh`,
      note: 'Capacity times voltage should equal the stated watt-hours. One of the three figures is wrong.',
      relativeError: Math.abs(derived - stated) / stated,
    });
  }
  return flags;
}

/**
 * A weight row a thousand times lighter (or heavier) than its sibling weight rows on the same page is most likely a unit typo:
 * "Trail Weight:3.02kg", "Total Weight:3.25kg", "Fast Fly Weight:2.49 g" (a tent cannot weigh 2.49 g). There is no second unit to
 * cross-check, so this compares the page's own rows with each other. Page-level: pass the whole page text.
 */
export function checkWeightOutliers(pageText, {factor = 800} = {}) {
  const rows = [];
  for (const raw of String(pageText || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length > 200) continue;
    const m = new RegExp(String.raw`^(?<label>[^:|\d]{0,60}?\b(?:weight|mass)\b[^:|\d]{0,30})\s*[:|]\s*(?<v>${NUMC})\s*(?<u>kg|g|lbs?|oz)\b`, 'i').exec(line.replace(/^[-•*\s]+/, ''));
    if (!m) continue;
    // per-item, load and rating rows are not the product's own weight
    if (/\b(?:per|max(?:imum)?|capacity|payload|limit|rating|load|take-?off|each|without|excluding|stakes?|pegs?)\b/i.test(m.groups.label)) continue;
    const v = numOf(m.groups.v), u = m.groups.u.toLowerCase();
    const grams = u === 'kg' ? v * 1000 : u === 'g' ? v : u.startsWith('lb') ? v * 453.59237 : v * 28.349523;
    if (grams > 0) rows.push({line, grams, text: `${m.groups.v} ${m.groups.u}`});
  }
  if (rows.length < 3) return [];
  const sorted = rows.map(r => r.grams).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const flags = [];
  for (const r of rows) {
    const ratio = median / r.grams;
    if (ratio < factor && ratio > 1 / factor) continue;
    flags.push({
      kind: 'weight-outlier',
      claimText: r.line,
      arithmetic: `${r.text} is about ${Math.round(Math.max(ratio, 1 / ratio))} times ${ratio > 1 ? 'lighter' : 'heavier'} than the page's other weight rows (typically about ${Math.round(median)} g)`,
      note: 'A weight this far from the product\'s other stated weights is most likely a unit typo (g for kg, or the reverse). There is no second unit on the line to prove it, so check the page.',
      relativeError: Math.min(1, Math.abs(Math.log10(ratio)) / 4),
    });
  }
  return flags;
}

export function checkConsistency(text) {
  return [...checkRangeOrder(text), ...checkPowerTriplet(text), ...checkSumOfParts(text), ...checkCountTimesCapacity(text), ...checkVolumeVsDimensions(text), ...checkWeightVsDensity(text), ...checkEachTotal(text), ...checkListedSum(text), ...checkChargeVoltEnergy(text)];
}
