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
  // No conversion applies -- GPa IS the bounds unit -- so the message must state the range test.
  // This assertion previously required "2310 GPa = 2310 GPa", a tautology, so it locked the defect
  // in rather than catching it.
  assert.match(flags[0].arithmetic, /2310 GPa is outside 0\.001-1220 GPa/);
  assert.doesNotMatch(flags[0].arithmetic, /2310 GPa = 2310 GPa/);
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
  // No conversion applies here: the stated unit IS the bounds unit. Reading "1980 GPa = 1980 GPa"
  // is a tautology, and this assertion used to require exactly that -- locking the defect in rather
  // than catching it. The message must state the range test instead.
  assert.match(flag.arithmetic, /1980 GPa is outside 0\.001-1220 GPa/);
  assert.doesNotMatch(flag.arithmetic, /1980 GPa = 1980 GPa/);
});

test('a conversion that actually happens still shows its working', () => {
  // MPa converts into the GPa bounds unit at x0.001 (UNIT_SCALES), so this exercises the OTHER
  // branch of the ternary that fixed the tautology. 2,000,000 MPa -> 2000 GPa, outside 0.001-1220.
  // My first version of this test used psi, which is not in UNIT_SCALES at all and produced no flag.
  const [flag] = checkClaim('Tensile strength: 2000000 MPa');
  assert.ok(flag, 'a converted value this far out of range should be flagged');
  assert.match(flag.arithmetic, /2000000 MPa = 2000 GPa/, 'the converted value must still be shown');
  assert.match(flag.arithmetic, /which is outside/);
});

test('a density written per area is flagged, because the unit and not the number is wrong', () => {
  // Found on a live filament page: "Density: 1.26 (g/cm2)". The value is a normal plastic density,
  // so the bounds check was silent; the unit had dropped the cube.
  const flags = checkClaim('Density: 1.26 (g/cm2\uff09');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, 'unit-dimension-mismatch');
  assert.match(flags[0].arithmetic, /mass per volume, but 1\.26 is written in g\/cm2/);
  assert.equal(checkClaim('Density 1.26 g/cm\u00b2').length, 1);
  assert.equal(checkClaim('Density: 1250 kg/m2').length, 1);
});

test('correct densities and genuine areal densities are NOT flagged by the dimension check', () => {
  assert.deepEqual(checkClaim('Density: 1.24 g/cm3'), []);
  assert.deepEqual(checkClaim('Density: 1.27 g/cm\u00b3'), []);
  assert.deepEqual(checkClaim('Areal density: 120 g/m2'), []);
  assert.deepEqual(checkClaim('Fabric basis weight density 200 g/m2'), []);
});

test('volts x amp-hours is checked against stated watt-hours, in labelled rows and in compact titles', async () => {
  const {checkEnergyConsistency, checkEnergyTriplets} = await import('../src/claim-arithmetic.mjs');
  // A real mismatch: 48 V x 15 Ah is 720 Wh, not 480.
  assert.equal(checkEnergyTriplets('E-Bike Battery 48V 15Ah 480Wh downtube').length, 1);
  assert.match(checkEnergyTriplets('48V 15Ah 480Wh')[0].arithmetic, /48 V x 15 Ah = 720 Wh, but the title states 480 Wh/);
  assert.equal(checkEnergyConsistency('Nominal Voltage: 48V\nNominal Capacity: 15Ah\nBattery Energy: Approximately 480Wh').length, 1);
  // Normal naming must NOT be flagged: LiFePO4 packs sold as 12V/24V/48V are really 12.8/25.6/51.2 V (6.7% higher).
  for (const ok of ['12V 100Ah 1280Wh', '24V 100Ah 2560Wh', '48V 50Ah 2560Wh', '48V 11.6Ah 556.8Wh', '3.7V 20000mAh 74Wh']) {
    assert.deepEqual(checkEnergyTriplets(ok), [], ok);
  }
  // Ambiguity is left unchecked: two nominal voltages, or a charge voltage, never produce a flag.
  assert.deepEqual(checkEnergyConsistency('Nominal Voltage: 12.8V\nNominal Voltage: 25.6V\nNominal Capacity: 100Ah\nEnergy: 1280Wh'), []);
  assert.deepEqual(checkEnergyConsistency('Nominal Voltage: 12.8V\nCharge Voltage: 14.6V\nNominal Capacity: 100Ah\nEnergy: 1280Wh'), []);
});

test('bugs found by an independent code review stay fixed', () => {
  // A phrase that itself contains the value ("draws 5000 mA") must still be checked; the alias used to consume the number.
  assert.equal(checkClaim('The module draws 5000 mA').length, 1);
  // 'Supply voltage' is mains wording on most products and must not be accused of exceeding a 48 V Eurorack rail.
  assert.deepEqual(checkClaim('Supply voltage: 230 V'), []);
  assert.deepEqual(checkClaim('Supply voltage: 120 V'), []);
  // A hyphen range is read at BOTH ends: the floor and the ceiling can each be impossible.
  assert.equal(checkClaim('Nozzle temperature: 50-250 °C').length, 1);
  assert.equal(checkClaim('Bed temperature: 5-300 °C').length, 1);
  assert.deepEqual(checkClaim('Bed temperature: 60-80 °C'), []);
  // A unit must belong to the property: amps are never a nozzle temperature, even on a long run-on page line.
  assert.deepEqual(checkClaim('Vacuum Nozzles and hoses 1000V Spanner Set 15.5G Sander 5 A charger'), []);
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
    'Young\u2019s modulus 1210 GPa',   // real, published diamond figure along a stiffer crystal direction
  ];
  for (const text of real) {
    assert.deepEqual(checkClaim(text), [], `must not flag real value: ${text}`);
  }
});

test('a real published diamond modulus is not mistaken for a unit error (2026-10-26 fix)', () => {
  // Diamond is published between roughly 1050 and 1220 GPa depending on source and crystal
  // direction (UT Dallas: https://www.utdallas.edu/~son051000/my_publications/Enlai_pra2022.pdf).
  // The bound previously sat at exactly 1200, so a genuine 1210 GPa claim -- inside that real
  // spread, not above it -- was flagged as "physically impossible." A false accusation is worse
  // than a missed one, so the ceiling now sits at 1220, and the explanation says a value just
  // above it falls inside the spread rather than claiming no material can reach it.
  assert.deepEqual(checkClaim('Young\u2019s modulus 1210 GPa'), []);
  assert.deepEqual(checkClaim('Bending modulus 1210 GPa'), []);
  // The actual defect this tool exists for -- a unit label off by 1000x -- must still be caught.
  const flags = checkClaim('Young\u2019s modulus 2435 GPa');
  assert.equal(flags.length, 1);
  assert.doesNotMatch(flags[0].note, /no material exceeds|cannot exceed/i, 'the note must not overclaim beyond the cited spread');
});

test('a plausibility bound (B-96, 2026-10-26) says "no product in this category", not "no material"', () => {
  // nozzleTemperature, currentDraw and friends are product-category guard rails, not physical
  // law -- "no material lies outside this range" is nonsensical for a printer's nozzle ceiling
  // or a module's current draw, since no material is being measured at all.
  const temp = checkClaim('Nozzle temperature 700\u00b0C');
  assert.equal(temp.length, 1);
  assert.match(temp[0].note, /no product in this category/i);
  assert.doesNotMatch(temp[0].note, /no material/i);

  const current = checkClaim('Current draw: 5000 mA');
  assert.equal(current.length, 1);
  assert.match(current[0].note, /no product in this category/i);

  // A genuine physical-law bound must keep saying "no material", unaffected by the change above.
  const modulus = checkClaim('Young\u2019s modulus 2435 GPa');
  assert.match(modulus[0].note, /no material lies outside/i);
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

test('a unit from another family is not read under the property (Pa is not W)', () => {
  assert.equal(checkClaim('Suction Power: 2000 Pa').length, 0);
});
