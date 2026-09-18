'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('onboarding progress exposes three data-derived steps', async () => {
  const module = await import(pathToFileURL(path.join(__dirname, '../src/public/shared/onboarding.js')));
  assert.deepEqual(module.calculateOnboardingProgress({ shoes: true, cycle: false, trainings: false }), {
    steps: { shoes: true, cycle: false, trainings: false }, completed: 1, total: 3, complete: false, nextStep: 'cycle',
  });
  assert.equal(module.calculateOnboardingProgress({ steps: { shoes: true, cycle: true, trainings: true } }).complete, true);
  assert.equal(module.shouldShowWelcome({ status: 'new' }), true);
  assert.equal(module.shouldShowWelcome({ status: 'active' }), false);
  assert.equal(module.shouldShowWelcome({ status: 'legacy' }), false);
  assert.equal(module.isNewUserOnboarding({ status: 'active' }), true);
  assert.equal(module.isNewUserOnboarding({ status: 'legacy' }), false);
});

test('onboarding UI keeps the existing destinations and accessibility hooks', () => {
  const fs = require('node:fs');
  const home = fs.readFileSync(path.join(__dirname, '../src/public/home.html'), 'utf8');
  assert.match(home, /href="\/shoes\.html"/);
  assert.match(home, /href="\/cycles\.html"/);
  assert.match(home, /href="\/ai-coach\.html"/);
  assert.match(home, /href="\/calendar\.html"/);
  assert.match(home, /aria-labelledby="onboardingWelcomeTitle"/);
  assert.match(home, /onboardingHide/);
  assert.match(home, /onboardingReopenHidden/);
});
