'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const en = require('../src/public/locales/en.json');
const pt = require('../src/public/locales/pt.json');

function keyPaths(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    keyPaths(child, prefix ? `${prefix}.${key}` : key)
  );
}

test('locale files exist for exactly the supported languages', () => {
  assert.ok(en.app.name);
  assert.ok(pt.app.name);
});

test('en.json and pt.json expose identical key structures', () => {
  assert.deepEqual(keyPaths(pt).sort(), keyPaths(en).sort());
});

test('prompt locale data is complete and language-appropriate', () => {
  for (const [lang, messages] of [['en-US', en], ['pt-BR', pt]]) {
    const prompt = messages.prompt;
    assert.equal(prompt.weekdays.length, 7, `${lang} weekdays`);
    assert.equal(prompt.instructions.length, 15, `${lang} instructions`);
    assert.equal(typeof prompt.dayFirst, 'boolean');
    assert.ok(prompt.notInformed);
    assert.ok(prompt.noneReported);
    assert.ok(prompt.lapsFallback);
    assert.ok(prompt.outro);
  }

  assert.equal(en.prompt.weekdays[2], 'Tuesday');
  assert.equal(pt.prompt.weekdays[2], 'terça-feira');
  assert.equal(en.prompt.dayFirst, false);
  assert.equal(pt.prompt.dayFirst, true);
});

test('instructions with sub-bullets carry their bullet lists in both languages', () => {
  for (const messages of [en, pt]) {
    assert.deepEqual(
      messages.prompt.instructions
        .map((item) => (item.bullets ? item.bullets.length : 0))
        .filter(Boolean),
      [4, 5, 3]
    );
  }
});
