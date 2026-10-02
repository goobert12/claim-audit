import test from 'node:test';
import assert from 'node:assert/strict';
import {
  measurements, propertyFor, checkBounds, checkClaim,
  checkDerived, checkStrainConsistency, PROPERTY_BOUNDS, primaryMeasurement,
} from '../src/claim-arithmetic.mjs';

// ---- measurement extraction ---------------------------------------------

test('measurements are found with their units and offsets', () => {
  const ms = measurements('Young\u2019s modulus 2310 GPa and tensile strength 48.20 MPa and elongation 5.10 %');
  assert.deepEqual(ms.map(m => [m.value, m.unit]), [[2310, 'GPa'], [48.20, 'MPa'], [5.10, '%']]);
  for (const m of ms) assert.equal(typeof m.start, 'number');
});

test('comma decimals are read, because European pages write 48,20', () => {
  const ms = measurements('Tensile strength 48,20 MPa');
  assert.equal(ms[0].value, 48.20);
});

test('a tolerance range yields its BASE value, not the tolerance', () => {
  // The bug this pins: "215\u00b110\u00b0C" puts the unit after the SECOND number, so a
  // naive scan reported the tolerance of 10 as the stated temperature -- which is
  // outside any usable range and produced a false flag on a correct page.
  const pm = primaryMeasurement('Recommended Extrusion Temperatures: 215\u00b110\u00b0C');
  assert.equal(pm.value, 215);
  assert.equal(pm.unit, '\u00b0C');
  assert.deepEqual(checkClaim('Recommended Extrusion Temperatures: 215\u00b110\u00b0C'), []);
});

test('the raw scan still sees every number, for a caller that wants the tolerance too', () => {
  const ms = measurements('Recommended Extrusion Temperatures: 215\u00b110\u00b0C');
  assert.deepEqual(ms.map(m => m.value), [10], 'the raw scan is unit-adjacent and finds only the tolerance');
  assert.equal(ms[0].unitKey, '\u00b0c');
});

test('properties are recognised from the many names real pages use', () => {
  assert.equal(propertyFor('Young\u2019s modulus'), 'youngsModulus');
  assert.equal(propertyFor('Modulus of Elasticity'), 'youngsModulus');
  assert.equal(propertyFor('Bending modulus'), 'bendingModulus');
  assert.equal(propertyFor('Flexural modulus'), 'bendingModulus');
  assert.equal(propertyFor('Density'), 'density');
  assert.equal(propertyFor('Recommended nozzle temperature'), 'nozzleTemperature');
  assert.equal(propertyFor('something unrelated'), null);
});

// ---- the check this tool was built around --------------------------------

test('a modulus of 2310 GPa is flagged as physically impossible', () => {
  // This is the class of defect the tool exists for (illustrative value). 2310 GPa is about twice
  // as stiff as diamond, so no material can have it -- the only remaining
  // explanation is that the unit label is wrong.
  const flags = checkClaim('Young\u2019s modulus ISO 527 X-Y: 2310 GPa');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, 'value-outside-physical-range');
  assert.equal(flags[0].property, 'youngsModulus');
  assert.match(flags[0].arithmetic, /2310 GPa = 2310 GPa/);
  assert.match(flags[0].note, /different unit/);
});

test('the same value in MPa passes, which is what makes the flag meaningful', () => {
  // 2310 MPa (2.435 GPa) is an ordinary modulus for polycarbonate. A check that
  // flagged this would be useless, so this test is as important as the one above.
  assert.deepEqual(checkClaim('Young\u2019s modulus ISO 527 X-Y: 2310 MPa'), []);
});

test('the flag carries its own arithmetic so a human can falsify it', () => {
  const [flag] = checkClaim('Bending modulus ISO 178 X-Y: 1980 GPa');
  assert.ok(flag.arithmetic.includes('1980'));
  assert.ok(flag.bounds.because.length > 10, 'the bound must explain itself');
  assert.match(flag.arithmetic, /1980 GPa = 1980 GPa, which is outside/);
});

test('genuine values across real materials are NOT flagged', () => {
  // False accusations are the failure mode that matters most, so the generous
  // ranges are tested against real-world values rather than assumed adequate.
  const real = [
    'Density: 1.25 g/cm\u00b3',
    'Density: 1.27 g/cm\u00b3',
    'Young\u2019s modulus: 2.4 GPa',
    'Young\u2019s modulus: 2400 MPa',
    'Tensile strength: 48.20 MPa',
    'Elongation at break: 5.10 %',
    'Recommended Extrusion Temperatures: 215\u00b110\u00b0C',
    'BED: 80-95 \u00b0C',
    'Young\u2019s modulus 1050 GPa',   // diamond, the ceiling
  ];
  for (const text of real) {
    assert.deepEqual(checkClaim(text), [], `must not flag real value: ${text}`);
  }
});

test('temperatures in Fahrenheit are converted before the range check', () => {
  // 450 F is 232 C, inside the nozzle range; 1100 F is 593 C, outside it. The
  // earlier version returned early because Fahrenheit had no multiplicative scale,
  // so a Fahrenheit figure was never checked at all -- and silent non-checking
  // reads as a pass, which is the worst available outcome.
  assert.deepEqual(checkBounds('nozzle temperature 450\u00b0F', 'nozzleTemperature'), []);
  const flags = checkBounds('nozzle temperature 1100\u00b0F', 'nozzleTemperature');
  assert.equal(flags.length, 1);
  assert.match(flags[0].arithmetic, /593\.3/);
});

test('a negative temperature is left alone rather than guessed at', () => {
  // Absolute vs gauge is genuinely ambiguous here, so silence beats a wrong flag.
  assert.deepEqual(checkBounds('annealing temperature -20 \u00b0C', 'annealingTemperature'), []);
});

test('a property with no bounds produces no flags rather than a default range', () => {
  assert.deepEqual(checkBounds('tensile strength 48.20 MPa', null), []);
  assert.deepEqual(checkClaim('Some claim with 9999 GPa in it and no property name'), []);
});

// ---- derived and cross-property checks -----------------------------------

test('a derived value mismatch is reported with both numbers and the formula', () => {
  const flags = checkDerived({stated: 1.0, derived: 0.8, property: 'mass', formula: 'volume x density'});
  assert.equal(flags.length, 1);
  assert.match(flags[0].arithmetic, /1\b.*0\.8|0\.8.*1/);
  assert.ok(flags[0].relativeError > 0.02);
  assert.deepEqual(checkDerived({stated: 1.0, derived: 1.0, property: 'mass', formula: 'v x d'}), []);
});

test('a derived value inside tolerance is not flagged', () => {
  assert.deepEqual(checkDerived({stated: 1.0, derived: 0.995, property: 'mass', formula: 'v x d'}), []);
});

test('the strain check reproduces the argument that made the modulus finding decisive', () => {
  // Strength 48.20 MPa through a modulus of 2310 GPa drives 0.0021% strain, while
  // the page states 5.10% elongation -- roughly two thousand times more. That gap is the
  // proof, and it uses only figures the page itself publishes.
  const flags = checkStrainConsistency({strength: 48.20, strengthUnit: 'MPa', modulus: 2310, modulusUnit: 'GPa', elongationPct: 5.10});
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, 'strain-exceeds-what-strength-can-drive');
  assert.match(flags[0].arithmetic, /48.2 MPa/);
  assert.match(flags[0].arithmetic, /2310 GPa/);
  assert.ok(flags[0].ratio > 1000);
});

test('the same figures with the modulus in MPa are consistent and not flagged', () => {
  const flags = checkStrainConsistency({strength: 48.20, strengthUnit: 'MPa', modulus: 2310, modulusUnit: 'MPa', elongationPct: 5.10});
  assert.deepEqual(flags, [], 'the reading that reconciles the numbers must stay silent');
});

test('the strain check stays silent when it cannot compute', () => {
  assert.deepEqual(checkStrainConsistency({strength: 0, modulus: 2310, elongationPct: 5.10}), []);
  assert.deepEqual(checkStrainConsistency({strength: 48.20, modulus: 0, elongationPct: 5.10}), []);
  assert.deepEqual(checkStrainConsistency({strength: 48.20, modulus: 2310, elongationPct: 0}), []);
});

test('every bound explains itself, so a range is never a bare unexplained number', () => {
  for (const [key, b] of Object.entries(PROPERTY_BOUNDS)) {
    assert.ok(b.because && b.because.length > 15, `${key} must state why the range is what it is`);
    assert.ok(b.max > b.min, `${key} range inverted`);
    assert.ok(b.unit, `${key} must carry a unit`);
  }
});
