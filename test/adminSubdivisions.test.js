'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isKnownAdministrativeAbbreviation,
  resolveAdministrativeSubdivision,
  matchesAdministrativeSubdivision,
} = require('../src/adminSubdivisions');

test('administrative subdivision catalog includes every Brazilian state and the Federal District', () => {
  const codes = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');
  for (const code of codes) {
    assert.equal(resolveAdministrativeSubdivision(code, 'BR')?.code, code);
  }
});

test('administrative subdivision catalog includes every US state and District of Columbia', () => {
  const codes = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ');
  for (const code of codes) {
    assert.equal(resolveAdministrativeSubdivision(code, 'US')?.code, code);
  }
});

test('subdivision abbreviations are country-scoped and unknown codes are not aliases', () => {
  assert.equal(isKnownAdministrativeAbbreviation('SP'), true);
  assert.equal(isKnownAdministrativeAbbreviation(' OR '), true);
  assert.equal(isKnownAdministrativeAbbreviation('ZZ'), false);
  assert.equal(isKnownAdministrativeAbbreviation('Oregon'), false);
  assert.equal(resolveAdministrativeSubdivision('sp', 'BR')?.names.includes('sao paulo'), true);
  assert.equal(resolveAdministrativeSubdivision('OR', 'US')?.names.includes('oregon'), true);
  assert.equal(resolveAdministrativeSubdivision('SP', 'US'), null);
  assert.equal(resolveAdministrativeSubdivision('OR', 'BR'), null);
  assert.equal(resolveAdministrativeSubdivision('ZZ', 'US'), null);
  assert.equal(resolveAdministrativeSubdivision('OR', 'ZZ'), null);
  assert.equal(resolveAdministrativeSubdivision('OR', undefined), null);
  assert.equal(resolveAdministrativeSubdivision(null, 'US'), null);
});

test('subdivision matching normalizes names and rejects unrelated or absent fields', () => {
  const sp = resolveAdministrativeSubdivision('SP', 'BR');
  const dc = resolveAdministrativeSubdivision('DC', 'US');
  assert.equal(matchesAdministrativeSubdivision(['São Paulo'], sp), true);
  assert.equal(matchesAdministrativeSubdivision(['Estado de Sao Paulo'], sp), true);
  assert.equal(matchesAdministrativeSubdivision(['Portland'], sp), false);
  assert.equal(matchesAdministrativeSubdivision(['District of Columbia'], dc), true);
  assert.equal(matchesAdministrativeSubdivision([], sp), false);
  assert.equal(matchesAdministrativeSubdivision(['Oregon'], null), false);
  assert.equal(matchesAdministrativeSubdivision(null, sp), false);
});
