'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isSubmittable } = require('../src/public/form-state.js');

const validState = () => ({
  rpe: 7,
  notes: 'Dormi bem, pernas leves.',
  file: { name: 'treino.fit' },
});

test('isSubmittable accepts a complete state at the rpe boundaries', () => {
  assert.equal(isSubmittable({ ...validState(), rpe: 1 }), true);
  assert.equal(isSubmittable({ ...validState(), rpe: 10 }), true);
});

test('isSubmittable rejects missing or malformed state objects', () => {
  assert.equal(isSubmittable(null), false);
  assert.equal(isSubmittable(undefined), false);
  assert.equal(isSubmittable({}), false);
});

test('isSubmittable requires an integer rpe between 1 and 10', () => {
  assert.equal(isSubmittable({ ...validState(), rpe: null }), false);
  assert.equal(isSubmittable({ ...validState(), rpe: undefined }), false);
  assert.equal(isSubmittable({ ...validState(), rpe: 0 }), false);
  assert.equal(isSubmittable({ ...validState(), rpe: 11 }), false);
  assert.equal(isSubmittable({ ...validState(), rpe: 7.5 }), false);
  assert.equal(isSubmittable({ ...validState(), rpe: '7' }), false);
});

test('isSubmittable requires non-empty trimmed notes', () => {
  assert.equal(isSubmittable({ ...validState(), notes: '' }), false);
  assert.equal(isSubmittable({ ...validState(), notes: '   \n\t ' }), false);
  assert.equal(isSubmittable({ ...validState(), notes: null }), false);
  assert.equal(isSubmittable({ ...validState(), notes: 42 }), false);
  assert.equal(isSubmittable({ ...validState(), notes: ' ok ' }), true);
});

test('isSubmittable requires an attached file', () => {
  assert.equal(isSubmittable({ ...validState(), file: null }), false);
  assert.equal(isSubmittable({ ...validState(), file: undefined }), false);
});
