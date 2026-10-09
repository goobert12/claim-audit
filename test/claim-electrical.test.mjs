import assert from 'node:assert/strict';
import test from 'node:test';
import {checkClaim, propertyFor} from '../src/claim-arithmetic.mjs';

// Electrical specifications, added 2026-10-05 for modular-synth and rack gear.
//
// These tests exist because the first version of the extension was SILENTLY WRONG in a way unit tests
// caught only after the fact: a module's current DRAW and a case's SUPPLY capacity are different
// quantities with different ceilings, and both were mapped to the same property. "Current draw:
// 5000 mA" therefore matched the case ceiling of 10 A, came back in bounds, and produced no flag --
// a checker that is quiet because it compared the wrong two things.
//
// So the split is asserted explicitly below rather than left implicit in the alias order.

test('a module drawing more than any single module plausibly draws is flagged', () => {
  const [flag] = checkClaim('Current draw: 5000 mA');
  assert.ok(flag, 'an implausible module draw must be flagged');
  assert.equal(flag.property, 'currentDraw');
  assert.match(flag.arithmetic, /5000 mA is outside 0-2000 mA/);
});

test('a plausible module draw is NOT flagged', () => {
  // If this ever fails, the check has become unusable: 120 mA is an ordinary Eurorack module.
  assert.deepEqual(checkClaim('Current consumption: 120 mA'), []);
});

test('a real case supply is judged against a case ceiling, not a module ceiling', () => {
  // A case rated per rail. 2000 mA would be absurd for a MODULE and is entirely normal for a SUPPLY,
  // so this must not be flagged. This is the assertion that would have caught the original collision.
  assert.equal(propertyFor('Maximum Output Current: +12V/1800 mA, -12V/1000 mA, +5V/3000 mA'), 'supplyCurrent');
  assert.deepEqual(checkClaim('Maximum Output Current: +12V/1800 mA, -12V/1000 mA, +5V/3000 mA'), []);
});

test('a supply stated in amps converts rather than being read as an implausible number', () => {
  // 3 A must become 3000 mA before comparison. Read as the bare number 3 it would pass silently for
  // the wrong reason, which is the same class of failure as the tautology fixed earlier.
  assert.deepEqual(checkClaim('Maximum output current: 3 A'), []);
});

test('a case supply beyond any published rail capacity is flagged', () => {
  const [flag] = checkClaim('Maximum output current: 20000 mA');
  assert.ok(flag, 'a supply far beyond any real case should be flagged');
  assert.equal(flag.property, 'supplyCurrent');
});
