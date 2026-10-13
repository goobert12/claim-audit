import test from 'node:test';
import assert from 'node:assert/strict';
import {conversionPairs, convert, checkConversions} from '../src/claim-conversions.mjs';

// Representative lines in the style of a battery specification sheet. Every pair was hand-checked.
const VENDOR_C_PAGE = `
Dimensions: 11.4 x 8.2 x 7.9 in (290 x 208 x 200 mm)
Weight: 31.5 lbs. (14.3 kg)
Charge Temperature Range: 23\u00b0F to 122\u00b0F (-5\u00b0C to 50\u00b0C)
Discharge Temperature Range: -4\u00b0F to 131\u00b0F (-20\u00b0C to 55\u00b0C)
Storage Temperature Range: 14\u00b0F to 140\u00b0F (-10\u00b0C to 60\u00b0C)
Recommended Terminal Torque: 44.3 inch\u00b7lbs / 5 N\u00b7m
Before installing the battery, ensure a clearance of 2.36-4.72 inches (6-12 cm) above the battery, and leave at least 9.84 inches (25 cm) on the side with the busbars.
`;

test('the conversions the page states are found at all', () => {
  const pairs = conversionPairs(VENDOR_C_PAGE);
  assert.ok(pairs.length >= 8, `expected several pairs, found ${pairs.length}: ${JSON.stringify(pairs.map(p => p.raw))}`);
  const kinds = new Set(pairs.map(p => p.kind));
  for (const k of ['dimension-set', 'weight', 'temperature-range', 'torque']) {
    assert.ok(kinds.has(k), `expected to find a ${k} pair`);
  }
});

test('a battery-style spec page is clean: its own conversions agree', () => {
  // every pair was hand-checked. This is the automated version of that procedure,
  // and it must reach the same answer -- a tool that invents a defect here would
  // be worse than the hand-check it replaces.
  const {flags, checked} = checkConversions(VENDOR_C_PAGE);
  assert.deepEqual(flags, [], `must find no defect, got: ${JSON.stringify(flags.map(f => f.arithmetic))}`);
  assert.ok(checked.length >= 8, `should have checked several conversions, did ${checked.length}`);
});

test('exact-by-definition conversions are used, not approximations', () => {
  assert.equal(convert(1, 'in', 'mm'), 25.4);
  assert.equal(convert(25.4, 'mm', 'in'), 1);
  assert.ok(Math.abs(convert(31.5, 'lb', 'kg') - 14.29) < 0.01);
  assert.ok(Math.abs(convert(44.3, 'in-lb', 'n-m') - 5) < 0.01);
  assert.ok(Math.abs(convert(-4, 'f', 'c') - -20) < 0.01);
  assert.ok(Math.abs(convert(131, 'f', 'c') - 55) < 0.01);
});

test('unrelated units convert to null rather than a wrong number', () => {
  assert.equal(convert(5, 'kg', 'mm'), null);
  assert.equal(convert(5, 'in-lb', 'kg'), null);
});

test('a genuine mismatch IS flagged, with both numbers and the arithmetic', () => {
  // The check has to be able to fail, or the clean result above proves nothing.
  const bad = 'Dimensions: 11.4 x 8.2 x 7.9 in (999 x 208 x 200 mm)';
  const {flags} = checkConversions(bad);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].stated, 11.4);
  assert.equal(flags[0].statedOther, 999);
  assert.match(flags[0].arithmetic, /11\.4 in = 289\.56 mm/);
  assert.ok(flags[0].relativeError > 0.02);
});

test('a wrong temperature conversion is caught', () => {
  const bad = 'Charge Temperature Range: 23\u00b0F to 122\u00b0F (-5\u00b0C to 50\u00b0C) and Discharge Temperature Range: -4\u00b0F to 140\u00b0F (-99\u00b0C to 60\u00b0C)';
  const {flags} = checkConversions(bad);
  assert.ok(flags.some(f => f.statedOther === -99), `expected the -99 C figure to be flagged: ${JSON.stringify(flags.map(f => f.arithmetic))}`);
});

test('a whole-degree temperature near zero is NOT flagged, but a genuine one-degree gap still is', () => {
  // 15 F is -9.44 C, so "-9 C" is correct rounding. A relative tolerance called it 4.7% apart.
  assert.deepEqual(checkConversions('Operating temperature: 15°F to 113°F (-9°C to 45°C)').flags, []);
  // 14 F is -10 C, so "-9 C" is a full degree off, which rounding does not explain.
  const {flags} = checkConversions('Operating temperature: 14°F to 113°F (-9°C to 45°C)');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].statedOther, -9);
});

test('a slash or parenthesis range whose first number has no scale is read', () => {
  // "20 - 30 C / 68 - 90 F": the 90 is wrong (30 C is 86 F). Every earlier block needed a scale after EACH number,
  // so this form produced zero checked pairs and zero flags.
  const bad = checkConversions('20 - 30 C / 68 - 90 F');
  assert.equal(bad.checked.length, 2, 'both ends are read, not double counted');
  assert.equal(bad.flags.length, 1);
  assert.equal(bad.flags[0].statedOther, 90);
  for (const ok of ['20 - 30 C / 68 - 86 F', '20-30°C / 68-86°F', '20 - 30 C (68 - 86 F)', '-20 - 55 C / -4 - 131 F', 'Charge 0 - 45 C / 32 - 113 F']) {
    const r = checkConversions(ok);
    assert.equal(r.checked.length, 2, `should be read: ${ok}`);
    assert.deepEqual(r.flags, [], `should not be flagged: ${ok}`);
  }
});

test('a single temperature stated in two scales is read, and only a real mismatch is flagged', () => {
  // Sleeping bags and batteries state one rating this way. 7 of 59 real pages carried it and none were read.
  for (const ok of ['Rating 30\u00b0F (-1\u00b0C)', 'Rating 20\u00b0F / -7\u00b0C', 'Rating 5\u00b0F (-15\u00b0C)', 'Rating 14\u00b0F (-10\u00b0C)']) {
    const r = checkConversions(ok);
    assert.equal(r.checked.length, 1, `should be read: ${ok}`);
    assert.deepEqual(r.flags, [], `should not be flagged: ${ok}`);
  }
  const bad = checkConversions('Rating 30\u00b0F (-5\u00b0C)');
  assert.equal(bad.flags.length, 1);
  assert.equal(bad.flags[0].statedOther, -5);
});

test('the numbers inside a temperature RANGE are not paired with each other as single temperatures', () => {
  const r = checkConversions('Range -4\u00b0F to 131\u00b0F (-20\u00b0C to 55\u00b0C)');
  assert.equal(r.checked.length, 2, 'exactly the two ends of the range');
  assert.deepEqual(r.flags, []);
});

test('a weight in pounds and ounces beside a metric figure is read, and grams are convertible', () => {
  // "4 lb 6.9 oz (2010 g)" is correct; 3 of 59 real pages carried a pounds-and-ounces weight and none were read.
  for (const ok of ['Weight: reg - 4 lb 6.9 oz (2010 g)', 'Weight: 2lbs 8oz (1.13 kg)', 'Weight 5 lb 1 oz / 2.3 kg', 'Weight: 26.9 lbs. (12200 g)']) {
    const r = checkConversions(ok);
    assert.equal(r.checked.length, 1, `should be read: ${ok}`);
    assert.deepEqual(r.flags, [], `should not be flagged: ${ok}`);
  }
  const bad = checkConversions('Weight: 2lbs 8oz (2.5 kg)');
  assert.equal(bad.flags.length, 1);
  assert.match(bad.flags[0].arithmetic, /^2 lb 8 oz = 1\.134 kg, but the page states 2\.5 kg/);
});

test('rounding a page actually does is NOT flagged', () => {
  // "14.3 kg" for 31.5 lb is 31.526 lb: correct to the precision chosen. A tool
  // that flagged this would fire on nearly every honest spec sheet.
  assert.deepEqual(checkConversions('Weight: 31.5 lbs. (14.3 kg)').flags, []);
  assert.deepEqual(checkConversions('Weight: 14.3 kg (31.5 lbs.)').flags, []);
});

test('tolerance is relative and configurable', () => {
  const page = 'Weight: 31.5 lbs. (15.9 kg)';   // about 11% out
  assert.equal(checkConversions(page).flags.length, 1);
  assert.equal(checkConversions(page, {tolerance: 0.5}).flags.length, 0, 'a loose tolerance silences it');
});

test('every checked conversion is reported, not only the failures', () => {
  // The audit has to be able to say WHAT it verified, not just what it found.
  // "No defects" is only meaningful alongside "and here is what was checked".
  const {checked, flags} = checkConversions(VENDOR_C_PAGE);
  assert.equal(flags.length, 0);
  assert.ok(checked.length > 0);
  for (const c of checked) {
    assert.ok(typeof c.stated === 'number');
    assert.ok(typeof c.expected === 'number');
    assert.ok(c.fromUnit && c.toUnit);
  }
});

test('the dimension set is checked element-wise, not as a sum', () => {
  // "11.4 x 8.2 x 7.9 in (290 x 208 x 200 mm)" -- each element converts on its own.
  const {checked} = checkConversions('Dimensions: 11.4 x 8.2 x 7.9 in (290 x 208 x 200 mm)');
  const stated = checked.map(c => c.stated);
  assert.deepEqual(stated.sort((a, b) => a - b), [7.9, 8.2, 11.4]);
});

test('a page with no two-unit statements yields nothing rather than an error', () => {
  assert.deepEqual(conversionPairs('Voltage: 12V\nRated Capacity: 100Ah'), []);
  assert.deepEqual(checkConversions('Voltage: 12V').flags, []);
});
