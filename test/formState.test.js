'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isSubmittable, isAttachedFitFile } = require('../src/public/form-state.js');

const validState = () => ({
  file: { name: 'treino.fit' },
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

test('isSubmittable accepts a state with an attached fit file', () => {
  assert.equal(isSubmittable(validState()), true);
  assert.equal(isSubmittable({ file: { name: 'WORKOUT.FiT' } }), true);
});

test('isSubmittable rejects missing or malformed state objects', () => {
  assert.equal(isSubmittable(null), false);
  assert.equal(isSubmittable(undefined), false);
  assert.equal(isSubmittable({}), false);
});

test('isSubmittable requires a file with a .fit extension', () => {
  assert.equal(isSubmittable({ ...validState(), file: null }), false);
  assert.equal(isSubmittable({ ...validState(), file: undefined }), false);
  assert.equal(isSubmittable({ ...validState(), file: {} }), false);
  assert.equal(isSubmittable({ ...validState(), file: { name: 'run.txt' } }), false);
});
