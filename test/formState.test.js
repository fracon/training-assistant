'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isSubmittable,
  isAttachedFitFile,
  isValidRpe,
} = require('../src/public/form-state.js');

const validState = () => ({
  rpe: 3,
  file: { name: 'treino.fit' },
});

test('isValidRpe accepts integers from 1 to 5', () => {
  assert.equal(isValidRpe(1), true);
  assert.equal(isValidRpe(2), true);
  assert.equal(isValidRpe(3), true);
  assert.equal(isValidRpe(4), true);
  assert.equal(isValidRpe(5), true);
});

test('isValidRpe rejects values outside the 1 to 5 range', () => {
  assert.equal(isValidRpe(0), false);
  assert.equal(isValidRpe(6), false);
  assert.equal(isValidRpe(10), false);
  assert.equal(isValidRpe(2.5), false);
  assert.equal(isValidRpe('3'), false);
  assert.equal(isValidRpe(null), false);
  assert.equal(isValidRpe(undefined), false);
});

test('isAttachedFitFile accepts .fit names in any case', () => {
  assert.equal(isAttachedFitFile({ name: 'treino.FIT' }), true);
  assert.equal(isAttachedFitFile({ name: 'treino.fit' }), true);
});

test('isAttachedFitFile rejects non-fit names and malformed files', () => {
  assert.equal(isAttachedFitFile(null), false);
  assert.equal(isAttachedFitFile(undefined), false);
  assert.equal(isAttachedFitFile({}), false);
  assert.equal(isAttachedFitFile({ name: 'treino.txt' }), false);
  assert.equal(isAttachedFitFile({ name: '' }), false);
  assert.equal(isAttachedFitFile({ name: null }), false);
});

test('isSubmittable accepts a state with a valid rpe and fit file at the boundaries', () => {
  assert.equal(isSubmittable({ ...validState(), rpe: 1 }), true);
  assert.equal(isSubmittable({ ...validState(), rpe: 5 }), true);
});

test('isSubmittable rejects missing or malformed state objects', () => {
  assert.equal(isSubmittable(null), false);
  assert.equal(isSubmittable(undefined), false);
  assert.equal(isSubmittable({}), false);
});

test('isSubmittable requires an integer rpe between 1 and 5', () => {
  assert.equal(isSubmittable({ ...validState(), rpe: null }), false);
  assert.equal(isSubmittable({ ...validState(), rpe: undefined }), false);
  assert.equal(isSubmittable({ ...validState(), rpe: 0 }), false);
  assert.equal(isSubmittable({ ...validState(), rpe: 6 }), false);
  assert.equal(isSubmittable({ ...validState(), rpe: 10 }), false);
  assert.equal(isSubmittable({ ...validState(), rpe: 2.5 }), false);
  assert.equal(isSubmittable({ ...validState(), rpe: '3' }), false);
});

test('isSubmittable requires a file with a .fit extension', () => {
  assert.equal(isSubmittable({ ...validState(), file: null }), false);
  assert.equal(isSubmittable({ ...validState(), file: undefined }), false);
  assert.equal(isSubmittable({ ...validState(), file: {} }), false);
  assert.equal(isSubmittable({ ...validState(), file: { name: 'run.txt' } }), false);
});
