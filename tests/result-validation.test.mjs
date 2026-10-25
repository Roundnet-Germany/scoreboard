import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validatedSetsOf, validationStateOf, newNonce, validationStatusOf } from '../js/resultValidation.js';

// Runs without the emulator: npm run test:unit
const sets = (...pairs) => Object.fromEntries(pairs.map(([a, b], i) => [`set_${i + 1}`, { team_a_score: a, team_b_score: b }]));
const FINISHED = { active_set: 2, score: sets([15, 10], [15, 8]) };

describe('validatedSetsOf', () => {
  test('sets up to the active one, scores as numbers', () => {
    assert.deepEqual(validatedSetsOf({ active_set: 2, score: sets(['15', 10], [15, '8']) }), [[15, 10], [15, 8]]);
  });

  test('a next set opened after the end (0-0) is not part of the result', () => {
    assert.deepEqual(validatedSetsOf({ active_set: 3, score: sets([15, 10], [15, 8], [0, 0]) }), [[15, 10], [15, 8]]);
  });

  test('stops at the first missing set, like RoundnetFranceConnect', () => {
    assert.deepEqual(validatedSetsOf({ active_set: 3, score: { set_1: { team_a_score: 15, team_b_score: 10 }, set_3: { team_a_score: 15 } } }), [[15, 10]]);
  });
});

describe('validationStateOf', () => {
  test('match over, nothing validated -> can validate', () => {
    const state = validationStateOf(FINISHED, true);
    assert.equal(state.canValidate, true);
    assert.equal(state.validated, false);
  });

  test('match not over -> cannot validate', () => {
    assert.equal(validationStateOf(FINISHED, false).canValidate, false);
  });

  test('validated for this exact score -> validated, the answer only with the same nonce', () => {
    const match = { ...FINISHED, result_validated: { nonce: 'abc', sets: [[15, 10], [15, 8]] } };
    assert.equal(validationStateOf(match, true).validated, true);
    assert.equal(validationStateOf(match, true).canValidate, false);
    assert.equal(validationStateOf({ ...match, rfc_result: { nonce: 'other', status: 'recorded' } }, true).answer, null);
    assert.equal(validationStateOf({ ...match, rfc_result: { nonce: 'abc', status: 'recorded' } }, true).answer.status, 'recorded');
  });

  test('a validation for another score (corrected since) is stale', () => {
    const match = { ...FINISHED, result_validated: { nonce: 'abc', sets: [[15, 10], [14, 8]] } };
    const state = validationStateOf(match, true);
    assert.equal(state.validated, false);
    assert.equal(state.canValidate, true);
  });
});

describe('newNonce', () => {
  test('8 hex digits', () => {
    assert.equal(newNonce(() => 0xabc), '00000abc');
    assert.match(newNonce(), /^[0-9a-f]{8}$/);
  });
});

describe('validationStatusOf', () => {
  const validated = { validated: true };

  test('nothing to say before a validation', () => {
    assert.equal(validationStatusOf({ validated: false }), null);
  });

  test('waiting, then just validated without an answer; recorded with next courts; refused', () => {
    assert.equal(validationStatusOf({ ...validated, answer: null }).tone, 'pending');
    assert.equal(validationStatusOf({ ...validated, answer: null }, {}, { waiting: false }).text, 'Result validated');
    assert.deepEqual(
      validationStatusOf({ ...validated, answer: { status: 'recorded', next: { team_a: 'TERRAIN 4', team_b: 'TERMINE' } } }, { a: 'Lyon', b: 'Paris' }),
      { text: 'Result recorded · Lyon: TERRAIN 4 · Paris: TERMINE', tone: 'positive' },
    );
    assert.equal(validationStatusOf({ ...validated, answer: { status: 'rejected', message: 'AUTRES EQUIPES' } }).tone, 'negative');
    // An answer always wins over the waiting window
    assert.equal(validationStatusOf({ ...validated, answer: { status: 'recorded' } }, {}, { waiting: false }).tone, 'positive');
  });
});
