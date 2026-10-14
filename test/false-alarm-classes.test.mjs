/**
 * Regression tests for false-alarm classes found by auditing 92 real product pages.
 *
 * Each case produced a flag on a CORRECT specification, which is worse than a missed error: a false alarm
 * sitting next to a true finding discredits the true finding. The cases are taken from real page text, and
 * the controls matter as much as the fixes, because a guard that silences everything is not a fix.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkRangeOrder, checkListedSum, checkSumOfParts} from '../src/claim-consistency.mjs';
import {checkClaim} from '../src/claim-arithmetic.mjs';

test('a fraction in a product name is not read as parts of a sum', () => {
  // 1/4W is a wattage rating; the numerator and denominator were taken as list items and compared with the pack count.
  assert.deepEqual(checkListedSum('Resistor Kit - 1/4W (500 total)'), []);
});

test('the fraction guard does not silence a genuine parts list', () => {
  const flags = checkSumOfParts('Battery pack: 50 Wh + 50 Wh (200 Wh total)');
  assert.ok(flags.length > 0, 'a genuine mismatch must still flag');
});

test('a low-voltage hyphen conversion is not a reversed range', () => {
  // "5-3V" is a 5 V supply feeding a 3 V rail, written with a hyphen.
  assert.deepEqual(checkRangeOrder('5-3V'), []);
});

test('a real transposed mains range still flags', () => {
  assert.ok(checkRangeOrder('220-110 V').length > 0, '220-110 V must still flag as high to low');
});

test('the word form of a low-voltage range is still flagged', () => {
  assert.ok(checkRangeOrder('Adjustable output from 5 V up to 3 V.').length > 0);
});

test('a genuine high-to-low range in different unit sizes still flags; a correct one does not', () => {
  assert.ok(checkRangeOrder('50 kHz to 20 Hz').length > 0);
  assert.deepEqual(checkRangeOrder('20 to 50 Hz'), []);
});

test('a zero-volt start of a supply range is not outside any bound', () => {
  const outside = checkClaim('Motor supply voltage: 0 V to 11 V').filter((f) => /outside/.test(f.arithmetic || ''));
  assert.deepEqual(outside, []);
});

test('ordinary controls: a correct density is quiet, an impossible modulus still flags', () => {
  assert.deepEqual(checkClaim('Density: 1.26 g/cm3'), []);
  assert.ok(checkClaim("Young's modulus: 2310 GPa").length > 0);
});
