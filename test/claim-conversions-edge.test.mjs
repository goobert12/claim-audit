import test from 'node:test';
import assert from 'node:assert/strict';
import {conversionPairs, checkConversions} from '../src/claim-conversions.mjs';

// Edge cases around checkConversions, each asserting behaviour read directly out
// of src/claim-conversions.mjs. Only node:test, node:assert/strict and the module
// under test are used.

test('unusual spacing: no spaces at all between figures and units is still read', () => {
  // The dimension and length regexes use \s* everywhere, so zero spacing is fine.
  const r = checkConversions('Dimensions: 11.4x8.2x7.9in(290x208x200mm)');
  assert.equal(r.checked.length, 3);
  assert.deepEqual(r.flags, []);
});

test('unusual spacing: tabs and newlines between figures and units are tolerated', () => {
  // \s matches tabs and newlines, so a sheet that tab-separates columns still works.
  const weight = checkConversions('Weight:\t31.5\tlbs.\t(14.3\tkg)');
  assert.equal(weight.checked.length, 1);
  assert.deepEqual(weight.flags, []);

  const dims = checkConversions('Dimensions: 11.4 x\n8.2 x 7.9 in (290 x 208 x 200 mm)');
  assert.equal(dims.checked.length, 3);
  assert.deepEqual(dims.flags, []);
});

test('mixed-case unit letters are normalised before comparing', () => {
  // Every unit capture carries the /i flag and is lowercased before use.
  const dims = checkConversions('Dimensions: 11.4 X 8.2 X 7.9 IN (290 X 208 X 200 MM)');
  assert.equal(dims.checked.length, 3);
  assert.deepEqual(dims.flags, []);
  assert.equal(dims.checked[0].fromUnit, 'in');
  assert.equal(dims.checked[0].toUnit, 'mm');

  const weight = checkConversions('Weight: 31.5 LBS (14.3 KG)');
  assert.equal(weight.checked.length, 1);
  assert.deepEqual(weight.flags, []);
  assert.equal(weight.checked[0].toUnit, 'kg');
});

test('a single negative temperature at the Fahrenheit/Celsius crossover is exact', () => {
  // -40 F and -40 C are the same temperature, so the pair must not be flagged.
  const r = checkConversions('Rating -40\u00b0F (-40\u00b0C)');
  assert.equal(r.checked.length, 1);
  assert.deepEqual(r.flags, []);
  assert.equal(r.checked[0].expected, -40);
});

test('a negative-temperature range with bare first scales is checked at both ends', () => {
  // -20 C = -4 F and -10 C = 14 F, so this range is correct end to end.
  const ok = checkConversions('Storage -20 - -10 C / -4 - 14 F');
  assert.equal(ok.checked.length, 2);
  assert.deepEqual(ok.flags, []);

  // 20 F beside -10 C (which is 14 F) is a full six degrees off and must flag.
  const bad = checkConversions('Storage -20 - -10 C / -4 - 20 F');
  assert.equal(bad.flags.length, 1);
  assert.equal(bad.flags[0].stated, -10);
  assert.equal(bad.flags[0].statedOther, 20);
});

test('a very small length is checked and not flagged', () => {
  // 0.01 in is exactly 0.254 mm; the leading-digit pattern still matches.
  const r = checkConversions('Thickness: 0.01 in (0.254 mm)');
  assert.equal(r.checked.length, 1);
  assert.deepEqual(r.flags, []);
  assert.equal(r.checked[0].expected, 0.254);
});

test('a very large length is checked and not flagged', () => {
  // 10000 in is exactly 254000 mm; large values are not dropped.
  const r = checkConversions('Span: 10000 in (254000 mm)');
  assert.equal(r.checked.length, 1);
  assert.deepEqual(r.flags, []);
  assert.equal(r.checked[0].expected, 254000);
});

test('the same statement twice is checked twice, and only the wrong copy is flagged', () => {
  // 9.84 in is 249.936 mm, so 250 mm is fine but 300 mm is not. Both are
  // extracted independently; the good one must stay clean.
  const r = checkConversions('Side A: 9.84 in (250 mm)\nSide B: 9.84 in (300 mm)');
  assert.equal(r.checked.length, 2);
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0].stated, 9.84);
  assert.equal(r.flags[0].statedOther, 300);
});

test('text full of numbers and units but no paired statement yields no checks', () => {
  // Units here (V, Ah, cycles, %, a lone C) have no second unit system beside
  // them, so nothing is a conversion pair and nothing is checked.
  const text = 'Charging voltage 14.6 V, float 13.6 V, 100 Ah, 2000 cycles at 80% depth of discharge, 25 \u00b0C ambient';
  assert.deepEqual(conversionPairs(text), []);
  const r = checkConversions(text);
  assert.equal(r.checked.length, 0);
  assert.deepEqual(r.flags, []);
});

test('a figure inside half its last written digit is not flagged, beyond it is', () => {
  // 1.5 in is 38.1 mm. Half of the last written digit of "1.5" is 0.05 in =
  // 1.27 mm, so 39 mm (0.9 mm away) is explained by rounding and 40 mm (1.9 mm
  // away) is not.
  const within = checkConversions('Thickness: 1.5 in (39 mm)');
  assert.deepEqual(within.flags, []);
  const beyond = checkConversions('Thickness: 1.5 in (40 mm)');
  assert.equal(beyond.flags.length, 1);
  assert.equal(beyond.flags[0].statedOther, 40);
});

test('torque stated in inch-pounds and newton-metres is checked', () => {
  // 44.3 in-lb is 5.005 N-m, close enough to the stated 5 N-m.
  const good = checkConversions('Torque: 44.3 inch\u00b7lbs / 5 N\u00b7m');
  assert.equal(good.checked.length, 1);
  assert.deepEqual(good.flags, []);

  // 10 in-lb is 1.13 N-m, not 5 N-m.
  const bad = checkConversions('Torque: 10 inch\u00b7lbs / 5 N\u00b7m');
  assert.equal(bad.flags.length, 1);
  assert.equal(bad.flags[0].stated, 10);
});

test('the spellings "in" and "inches" are equivalent', () => {
  const abbr = checkConversions('Length: 9.84 in (250 mm)');
  const full = checkConversions('Length: 9.84 inches (250 mm)');
  assert.equal(abbr.checked.length, 1);
  assert.equal(full.checked.length, 1);
  assert.deepEqual(abbr.flags, []);
  assert.deepEqual(full.flags, []);
  assert.equal(full.checked[0].fromUnit, 'in');
});

test('a stated zero has no rounding allowance, so a wrong partner figure is flagged', () => {
  // 0 C is 32 F. A zero figure has no relative precision, so it must not widen the allowance and let "50 F" pass.
  assert.equal(checkConversions('0 C (50 F)').flags.length, 1);
  assert.equal(checkConversions('0 in (500 mm)').flags.length, 1);
  assert.deepEqual(checkConversions('0 C (32 F)').flags, []);
  assert.deepEqual(checkConversions('0 in (0 mm)').flags, []);
});

test('inches and centimetres, millimetres and centimetres, kilograms and grams are all converted', () => {
  // convert() had no cm, mm-to-cm or kg-to-g branch, so "9.84 inches (25 cm)" was silently skipped and a wrong "20 cm" passed.
  assert.equal(checkConversions('9.84 inches (25 cm)').checked.length, 1);
  assert.deepEqual(checkConversions('9.84 inches (25 cm)').flags, []);
  assert.equal(checkConversions('9.84 inches (20 cm)').flags.length, 1);
  assert.deepEqual(checkConversions('Weight: 2.5 lb (1.13 kg)').flags, []);
});

test('a fraction of an inch is one number, not its denominator', () => {
  assert.equal(checkConversions('Chuck Size: 1/2 in (13 mm)').flags.length, 0);
  assert.equal(checkConversions('Pipe: 1-1/4 in (32 mm)').flags.length, 0);
  assert.equal(checkConversions('Chuck Size: 1/2 in (30 mm)').flags.length, 1);
});

test('whole-degree temperatures: a gap that rounding of both figures explains is not flagged, a larger one is', () => {
  // A true 20.3 C prints as 20 C and as 69 F, so that pair is consistent; 70 F cannot go with 20 C.
  assert.equal(checkConversions('Operating temperature: 20°C (70°F)').flags.length, 1);
  assert.equal(checkConversions('Operating temperature: 20°C (69°F)').flags.length, 0);
  // -10 C is 14 F; 15 F is within the combined rounding of both whole-degree figures.
  assert.equal(checkConversions('Operating temperature: -10°C (15°F)').flags.length, 0);
  assert.equal(checkConversions('Operating temperature: -10°C (17°F)').flags.length, 1);
});
