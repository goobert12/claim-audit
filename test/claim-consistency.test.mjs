import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkRangeOrder, checkPowerTriplet, checkSumOfParts, checkVolumeVsDimensions, checkWeightVsDensity, checkConsistency,
} from '../src/claim-consistency.mjs';
import {checkConversions} from '../src/claim-conversions.mjs';

// ---- reversed range -------------------------------------------------------------------------------------

test('a range written high to low is flagged; low to high and negatives are not', () => {
  assert.equal(checkRangeOrder('Input voltage: 220-110 V AC').length, 1);
  assert.equal(checkRangeOrder('AC input range: 240 to 100 V').length, 1);
  assert.equal(checkRangeOrder('Operating temperature: 55 °C to -20 °C').length, 1);
  assert.equal(checkRangeOrder('Input voltage: 100-240 V AC').length, 0);
  assert.equal(checkRangeOrder('Operating temperature: -20 °C to 55 °C').length, 0);
  assert.equal(checkRangeOrder('Charge current: 2-5A').length, 0);
});

test('a conversion direction ("24V to 12V") and a subtraction are not ranges', () => {
  assert.equal(checkRangeOrder('Step-down converter 24V to 12V').length, 0, 'found on a real product page');
  assert.equal(checkRangeOrder('Drop of 10 V - 3 V under load').length, 0);
});

// ---- power cannot exceed volts x amps ---------------------------------------------------------------------

test('watts above volts x amps are flagged; the harmless direction and multi-profile lines are not', () => {
  assert.equal(checkPowerTriplet('Laptop power adapter: 20 V, 3.25 A, 90 W').length, 1);
  assert.equal(checkPowerTriplet('Drone motor: 11.1 V, 2.0 A, 30 W').length, 1);
  assert.equal(checkPowerTriplet('Drip coffee maker: 120 V, 10 A, 1500 W').length, 1);
  // watts BELOW volts x amps is normal (power factor, efficiency, rated-vs-max current)
  assert.equal(checkPowerTriplet('Mini refrigerator: 120 V, 1.5 A, 150 W').length, 0);
  assert.equal(checkPowerTriplet('Charger: 20 V, 3.25 A, 65 W').length, 0);
});

test('real-page false alarms stay quiet: USB profile lists, "max", "up to"', () => {
  assert.equal(checkPowerTriplet('USB-C Output x2 - 100W max, 5V, 2.4A').length, 0);
  assert.equal(checkPowerTriplet('USB-A Fast Charge x2 - 18W max, 5V, 2.4A/9V, 2A/12V, 1.5A').length, 0);
  assert.equal(checkPowerTriplet('Vulcan - 48V 5500W with Solar and AC/DC Charge (Up to 100A)').length, 0);
  assert.equal(checkPowerTriplet('250W max. : Output : 12 V DC, 20 A').length, 0);
});

// ---- total vs sum of parts --------------------------------------------------------------------------------

test('a total that is not the sum of its parts is flagged', () => {
  assert.equal(checkSumOfParts('Shipping weight: 14.2 lbs. Contents: 5.0 lbs + 2.8 lbs + 3.5 lbs').length, 1);
  assert.equal(checkSumOfParts('Trail mix total weight: 32 oz. Ingredients: 12 oz + 8 oz + 6 oz').length, 1);
  assert.equal(checkSumOfParts('Build cost: $482. Parts: $210 + $140 + $96').length, 1);
  assert.equal(checkSumOfParts('Shipping weight: 11.3 lbs. Contents: 5.0 lbs + 2.8 lbs + 3.5 lbs').length, 0);
  assert.equal(checkSumOfParts('Build cost: $446. Parts: $210 + $140 + $96').length, 0);
});

test('a colour code is not a sum', () => {
  assert.equal(checkSumOfParts('Aurora Gold(D9A63A+9675CD)').length, 0, 'found on a real product page');
});

// ---- volume and weight cannot exceed what the size allows ---------------------------------------------------

test('a volume larger than its own box is flagged; a smaller one is not', () => {
  assert.equal(checkVolumeVsDimensions('Dimensions: 12 x 8 x 6 in. Volume: 620 cu in').length, 1);
  assert.equal(checkVolumeVsDimensions('Bin capacity: 20 L. Dimensions: 12 x 10 x 6 in').length, 1);
  assert.equal(checkVolumeVsDimensions('Dimensions: 12 x 8 x 6 in. Volume: 500 cu in').length, 0);
  assert.equal(checkVolumeVsDimensions('Dimensions: 12 x 10 x 6 in. Capacity: 10 L').length, 0);
});

test('a weight above size x density is flagged; a lighter one (hollow) is not', () => {
  assert.equal(checkWeightVsDensity('Aluminum block: 6 x 4 x 2 in. Density: 0.098 lb/in³. Weight: 5.6 lbs').length, 1);
  assert.equal(checkWeightVsDensity('Aluminum block: 6 x 4 x 2 in. Density: 0.098 lb/in³. Weight: 4.6 lbs').length, 0);
  assert.equal(checkWeightVsDensity('Hollow frame: 6 x 4 x 2 in. Density: 0.098 lb/in³. Weight: 2.0 lbs').length, 0);
});

test('checkConsistency runs every rule and stays silent on an ordinary spec row', () => {
  assert.equal(checkConsistency('Weight: 26.9 lbs (12.2 kg)').length, 0);
  assert.equal(checkConsistency('Input voltage: 220-110 V AC').length, 1);
});

// ---- the everyday conversions that were missed entirely --------------------------------------------------

test('oz/g, psi/bar, miles/km, gallons/litres and feet/metres are checked', () => {
  for (const wrong of ['Net weight: 8 oz (200 g)', 'Max pressure: 150 psi (15 bar)', 'Driving range: 250 miles (450 km)', 'Capacity: 5 gallons (15 litres)', 'Height: 10 ft (4 m)']) {
    assert.equal(checkConversions(wrong).flags.length, 1, `missed: ${wrong}`);
  }
  for (const right of ['Net weight: 8 oz (227 g)', 'Max pressure: 150 psi (10.3 bar)', 'Driving range: 250 miles (402 km)', 'Capacity: 5 gallons (18.9 litres)', 'Height: 10 ft (3 m)']) {
    assert.equal(checkConversions(right).flags.length, 0, `false alarm: ${right}`);
  }
});

test('a gallon matches either the US or the UK gallon', () => {
  assert.equal(checkConversions('Tank: 10 gallons (45.5 litres)').flags.length, 0, 'UK gallon');
  assert.equal(checkConversions('Tank: 10 gallons (37.9 litres)').flags.length, 0, 'US gallon');
  assert.equal(checkConversions('Tank: 10 gallons (60 litres)').flags.length, 1);
});

test('the ounces of a compound weight are not a stand-alone oz/g pair', () => {
  assert.equal(checkConversions('Weight: 4 lb 10.4 oz (2110 g)').flags.length, 0, 'found on a real page: 4 lb 10.4 oz is 2110 g');
  assert.equal(checkConversions('Weight: 4 lb 10.4 oz (2500 g)').flags.length, 1, 'the compound check still catches a wrong figure');
});

// Multi-battery rows written independently of the rules, 2026-10-13.
test('a pack count in front multiplies the energy: correct multi-battery rows are quiet', async () => {
  const {checkEnergyTriplets} = await import('../src/claim-arithmetic.mjs');
  assert.equal(checkEnergyTriplets('Battery: 4 x 12 V 100 Ah (4800 Wh total)').length, 0, 'was a false alarm');
  assert.equal(checkEnergyTriplets('Capacity: 3 x 25.6 V 100 Ah (7680 Wh)').length, 0, 'was a false alarm');
  assert.equal(checkEnergyTriplets('Battery: 4 x 12 V 100 Ah (5760 Wh total)').length, 1, 'a wrong total is still caught');
});

test('a count times a unit capacity is compared with the stated total', () => {
  assert.equal(checkConsistency('Expandable: 2 x 1024 Wh (2400 Wh maximum)').length, 1);
  assert.equal(checkConsistency('Expandable: 2 x 1024 Wh (2048 Wh maximum)').length, 0);
});

test('a reversed range with a bare F or C is flagged', () => {
  assert.equal(checkConsistency('Charge Temperature: 113-32 F (45-0 C)').length >= 1, true);
  assert.equal(checkConsistency('Charge Temperature: 32-113 F (0-45 C)').length, 0);
});

// ---- false alarms found by an independent review of the checker, 2026-10-13 (exact lines) -------------------

test('ranges whose ends use different-sized units of one family are compared in a common unit', () => {
  for (const ok of ['Frequency response: 80 Hz to 16 kHz', 'Capacity: 5000 mAh to 10 Ah', 'Length: 200 mm to 30 cm', 'Weight: 500 g to 1 kg',
                    'Battery: 1000 mAh to 2 Ah', 'Its frequency response extends from 50 Hz to 20 kHz at -10 dB', 'Frequency Response: 60 Hz – 20 kHz']) {
    assert.equal(checkRangeOrder(ok).length, 0, `false alarm: ${ok}`);
  }
  // still caught when the converted ends really are reversed
  assert.equal(checkRangeOrder('Frequency response: 20 kHz to 50 Hz').length, 1);
  assert.equal(checkRangeOrder('Capacity: 10 Ah to 5000 mAh').length, 1);
  assert.equal(checkRangeOrder('Weight: 2 kg to 500 g').length, 1);
});

test('a leading count, or mixed ratings, make a plain sum the wrong comparison', () => {
  assert.equal(checkSumOfParts('Output power: 2 x 50 W + 100 W (200 W total)').length, 0);
  assert.equal(checkSumOfParts('Speakers: 20 W + 20 W (RMS), 50 W peak').length, 0);
  assert.equal(checkSumOfParts('Shipping weight: 14.2 lbs. Contents: 5.0 lbs + 2.8 lbs + 3.5 lbs').length, 1, 'a plain wrong total is still caught');
});

test('a round nominal figure beside an exact imperial one is marketing rounding, not a finding', () => {
  for (const ok of ['Pressure: 3000 PSI (200 bar)', 'Range: 300 miles (500 km)', 'Fuel: 50 gal (200 L)']) {
    assert.equal(checkConversions(ok).flags.length, 0, `false alarm: ${ok}`);
  }
  // but a large gap on a round figure is still caught, and so is a gap on a non-round one
  assert.equal(checkConversions('Range: 250 miles (450 km)').flags.length, 1);
  assert.equal(checkConversions('Pressure: 3000 PSI (230 bar)').flags.length, 1);
  assert.equal(checkConversions('Range: 301 miles (500 km)').flags.length, 0, 'within 6% on a nominal side');
  assert.equal(checkConversions('Range: 123 miles (260 km)').flags.length, 1, '123 mi is 198 km: neither side is nominal and the gap is large');
});

// ---- prose arithmetic, found missing by a test set of sentence-style errors (2026-10-13) --------------------

import {checkEachTotal, checkListedSum, checkChargeVoltEnergy} from '../src/claim-consistency.mjs';

test('a count times an each-figure is compared with the stated total', () => {
  assert.equal(checkEachTotal('Each box contains 12 bars at 40 g each, for a total of 600 g per box.').length, 1);
  assert.equal(checkEachTotal('The multi-pack offers 6 rolls per pack at 120 sheets each, for 600 sheets total.').length, 1);
  assert.equal(checkEachTotal('This hub has 6 ports at 18 W each, delivering 120 W total.').length, 1);
  assert.equal(checkEachTotal('Each box contains 12 bars at 40 g each, for a total of 480 g per box.').length, 0);
  // totals that legitimately differ from count x each: tax, shipping, extras, prices
  assert.equal(checkEachTotal('Buy 3 cables at 10 each, total 35 with shipping.').length, 0);
  assert.equal(checkEachTotal('Pack of 4 at $12 each, total $60 after tax.').length, 0);
});

test('listed same-unit parts and listed counts are compared with the stated total', () => {
  assert.equal(checkListedSum('The gym set weighs 40 lbs, the bench 35 lbs, and the rack 20 lbs, for a total of 105 lbs.').length, 1);
  assert.equal(checkListedSum('The gym set weighs 40 lbs, the bench 35 lbs, and the rack 20 lbs, for a total of 95 lbs.').length, 0);
  assert.equal(checkListedSum('The starter kit includes 3 bottles and 5 refills, giving you 10 pieces in total.').length, 1);
  assert.equal(checkListedSum('The starter kit includes 3 bottles and 5 refills, giving you 8 pieces in total.').length, 0);
  // mixed units, optional extras and ranges are left alone
  assert.equal(checkListedSum('Includes 3 bottles and 5 refills plus a free pouch, 10 pieces in total.').length, 0);
  assert.equal(checkListedSum('Runs 5 hours on low and 100 minutes on high, 7 hours in total.').length, 0);
});

test('capacity times nominal voltage against watt-hours when the figures are not in V-Ah-Wh order', () => {
  assert.equal(checkChargeVoltEnergy('5000 mAh (37 Wh) battery, 3.7 V nominal.').length, 1);
  assert.equal(checkChargeVoltEnergy('20000 mAh (74 Wh) battery, 3.7 V nominal.').length, 0);
  assert.equal(checkChargeVoltEnergy('500 Wh capacity at 50 V, rated 5 Ah.').length, 1);
  // USB outputs and charging figures are not the battery voltage
  assert.equal(checkChargeVoltEnergy('20000 mAh 74 Wh, 5 V / 2 A USB output').length, 0);
  assert.equal(checkChargeVoltEnergy('Battery: 12 V 100 Ah 1280 Wh').length, 0, 'V Ah Wh order belongs to the triplet check');
});

test('"from 5 V up to 3 V" is a reversed range; "from 3 V up to 5 V" is not', () => {
  assert.equal(checkRangeOrder('Adjustable output from 5 V up to 3 V.').length, 1);
  assert.equal(checkRangeOrder('Adjustable output from 3 V up to 5 V.').length, 0);
});

test('kg/g, litres/ml and fluid ounces/ml are checked, with thousands commas and "about"', () => {
  assert.equal(checkConversions('1.5 kg (150 g) total weight').flags.length, 1);
  assert.equal(checkConversions('1.5 kg (1500 g) total weight').flags.length, 0);
  assert.equal(checkConversions('The water bottle holds 24 oz (about 1,000 ml).').flags.length, 1);
  assert.equal(checkConversions('The water bottle holds 24 oz (about 710 ml).').flags.length, 0);
  assert.equal(checkConversions('The kettle boils 1.7 litres (about 100 fl oz) of water.').flags.length, 1);
  assert.equal(checkConversions('The kettle boils 1.7 litres (about 57 fl oz) of water.').flags.length, 0);
  assert.equal(checkConversions('Capacity 2 litres (2,000 ml)').flags.length, 0);
});
