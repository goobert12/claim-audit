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
