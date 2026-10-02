import test from 'node:test';
import assert from 'node:assert/strict';
import {detectLayout, valueCandidates, extractSpecValue} from '../src/spec-layout.mjs';

// Real lines from three live captures, 2026-10-01.

// --- the silent-wrong-value bug ------------------------------------------

test('the row-header bug: "Bending modulus GPa\u00b7ISO 178" must NOT read ISO 178 as the value', () => {
  // The live page writes the unit immediately after the property name, before the
  // test standard. A parser taking the first number after the name reads 178.
  // That does not fail and does not look wrong -- 178 is a plausible figure -- so
  // it would be bounds-checked and PASS. A silent wrong value is worse than none.
  const header = 'Bending modulus GPa\u00b7ISO 178';
  const cands = valueCandidates('ISO 178');
  assert.deepEqual(cands, [], 'a test-standard number is an identifier, not a quantity');

  const extracted = extractSpecValue(header);
  assert.equal(extracted, null, 'with no real value present it must return null, not 178');
});

test('the same line WITH a real value reads the value, not the standard', () => {
  const line = 'Bending modulus GPa\u00b7ISO 178 \u2014 X-Y: 1980';
  const ex = extractSpecValue(line);
  assert.equal(ex.value, 1980);
  assert.equal(ex.unit, 'GPa');
  assert.equal(ex.fromColumn, 'X-Y');
});

test('identifiers that look like quantities are skipped in every form', () => {
  for (const ident of ['ISO 527', 'ASTM D790', 'UL 94', 'IEC 60112', 'M8 x 1.25 x 12 mm', 'IP 67']) {
    const cands = valueCandidates(ident);
    assert.equal(cands.length, 0, `"${ident}" must yield no quantity, got ${JSON.stringify(cands)}`);
  }
});

test('a bolt size after the identifier guard is not mistaken for a measurement', () => {
  const cands = valueCandidates('Terminal Bolts (M8 x 1.25 x 12 mm) x 2');
  // The "12 mm" is a bolt dimension; the guard drops it. This is deliberately
  // conservative: missing a value is recoverable, inventing one is not.
  assert.ok(cands.every(c => !(c.value === 12 && c.unitKey === 'mm')), `bolt size must not be read as the spec value: ${JSON.stringify(cands)}`);
});

// --- layout detection across three real pages -----------------------------

test('a page that merely MENTIONS a standard is not classified as a table', () => {
  // The real bug: a whole Vendor B page was classified as a table because one
  // sentence said "tested using ASTM 638". The snippet-based test passed because it
  // lacked the mention. Detection now requires the column markers themselves.
  const mentionsStandard = 'Dimensional Accuracy: \u00b10.02mm\nAll materials are tested using ASTM 638 and D790 or ISO 527-1.';
  assert.equal(detectLayout(mentionsStandard), 'flat-label-value');

  const realTable = 'Bending modulus \u2014 ISO 178 \u2014 X-Y: 1980 \u2014 Z: \u2014 \u2014 VALUE (unit): GPa';
  assert.equal(detectLayout(realTable), 'table-separate-unit');
});

test('the two decidable layouts are distinguished where the markup actually differs', () => {
  const vendorA = 'Bending modulus \u2014 ISO 178 \u2014 X-Y: 1980 \u2014 Z: \u2014 \u2014 VALUE (unit): GPa';
  const vendorC = 'Weight: 31.5 lbs. (14.3 kg)\nVoltage: 12V\nRated Capacity: 100Ah';

  assert.equal(detectLayout(vendorA), 'table-separate-unit');
  assert.equal(detectLayout(vendorC), 'flat-label-value');

  // Vendor B is honestly indistinguishable from flat label:value in text:
  // "Dimensional Accuracy: \u00b10.02mm" and "Voltage: 12V" have the same shape.
  // The capturer confirmed the live Vendor A and Vendor C structures explicitly, and
  // for Vendor B the distinction does not change how a value is read -- both
  // take the number adjacent to its unit. Claiming a reliable 3-way split would
  // assert a capability the text does not support.
  const vendorB = 'Dimensional Accuracy: \u00b10.02mm\nLength: 327.4m (1.75mm) or 123.4m (2.85mm)';
  assert.equal(detectLayout(vendorB), 'flat-label-value');
});

test('table-with-separate-unit: value and unit both come from the table columns', () => {
  const ex = extractSpecValue('Bending modulus \u2014 ISO 178 \u2014 X-Y: 1980 \u2014 Z: \u2014 \u2014 VALUE (unit): GPa');
  assert.equal(ex.value, 1980);
  assert.equal(ex.unit, 'GPa');
  assert.equal(ex.layout, 'table-separate-unit');
  assert.equal(ex.fromColumn, 'X-Y');
});

test('table-with-separate-unit: the Z column is not taken when X-Y is present', () => {
  const ex = extractSpecValue("Young's modulus \u2014 ISO 527 \u2014 X-Y: 2310 \u2014 Z: 2080 \u2014 VALUE (unit): GPa");
  assert.equal(ex.value, 2310, 'across-layer is the figure a buyer designs with');
});

test('table-with-inline-unit: the inline unit is read', () => {
  const ex = extractSpecValue('Dimensional Accuracy: \u00b10.02mm');
  assert.equal(ex.value, 0.02);
  assert.equal(ex.unit, 'mm');
});

test('table-with-inline-unit: a unit in a parenthesis belonging to the variant is handled', () => {
  const ex = extractSpecValue('Length: 327.4m (1.75mm) or 123.4m (2.85mm)');
  assert.equal(ex.value, 327.4);
  assert.equal(ex.unit, 'm');
});

test('flat-label-value: flat label-value lines read inline units', () => {
  for (const [line, value, unit] of [
    ['Weight: 31.5 lbs. (14.3 kg)', 31.5, 'lbs.'],
    ['Voltage: 12V', 12, 'V'],
    ['Rated Capacity: 100Ah', 100, 'Ah'],
    ['Maximum Charge Current: 100A', 100, 'A'],
    ['Peak Discharge Current: 245A@30s', 245, 'A'],
  ]) {
    const ex = extractSpecValue(line);
    assert.ok(ex, `should extract from "${line}"`);
    assert.equal(ex.value, value, `value of "${line}"`);
    assert.equal(ex.unit.toLowerCase().replace(/\.$/, ''), unit.toLowerCase().replace(/\.$/, ''), `unit of "${line}"`);
  }
});

test('flat-label-value: a temperature range starts at the lower bound', () => {
  const ex = extractSpecValue('Charge Temperature Range: -4\u00b0F to 131\u00b0F (-20\u00b0C to 55\u00b0C)');
  assert.equal(ex.value, -4, 'the range is anchored at its lower bound');
  assert.equal(ex.unit, '\u00b0F');
});

test('an unknown layout returns a value rather than refusing outright', () => {
  // Refusing to read a page because its layout is unfamiliar would be a false
  // negative on every new site. The value is returned; the layout says "unknown"
  // so a caller can decide how much to trust the column attribution.
  const ex = extractSpecValue('Some spec: 42 kg');
  assert.equal(ex.value, 42);
  assert.equal(ex.unit, 'kg');
});

test('a line with no number returns null rather than guessing', () => {
  assert.equal(extractSpecValue('Housing Material: PC/ABS'), null);
  assert.equal(extractSpecValue('Communication Protocol: Bluetooth'), null);
});

test('every candidate carries its offsets, so an extraction can be audited', () => {
  const line = 'Weight: 31.5 lbs. (14.3 kg)';
  for (const c of valueCandidates(line)) {
    assert.equal(typeof c.start, 'number');
    assert.ok(line.slice(c.start).startsWith(c.rawValue), `offset must land on the value: ${c.rawValue}`);
  }
});
