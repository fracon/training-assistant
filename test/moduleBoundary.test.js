'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

test('Node 24 loads the CommonJS server and shared ES modules without typeless reparsing', () => {
  const result = spawnSync(process.execPath, ['--trace-warnings', '-e', `
    const assert = require('node:assert/strict');
    assert.equal(typeof require('./src/server').buildServer, 'function');
    assert.equal(typeof require('./src/public/form-state.js'), 'object');
    const weekly = require('./src/public/shared/workout-prompts.js');
    const analysis = require('./src/public/shared/analysis-prompts.js');
    assert.equal(typeof weekly.buildPrompt, 'function');
    assert.equal(typeof analysis.buildAnalysisPrompt, 'function');
    import('./src/public/shared/date.js').then((date) => {
      assert.equal(date.formatDate('2026-10-15', 'pt-BR'), '15/10/2026');
    });
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /MODULE_TYPELESS_PACKAGE_JSON/);
  const root = require('../package.json');
  assert.notEqual(root.type, 'module');
  assert.equal(require('../src/public/shared/package.json').type, 'module');
  const dockerfile = readFileSync(path.join(__dirname, '../Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY src \.\/src/);
  assert.match(dockerfile, /FROM node:24-alpine/);
});
