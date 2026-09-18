'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFileSync } = require('node:fs');

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

test('completed guide presentation supports conclusion, reopen, hide, and reload', async () => {
  const { onboardingPresentation } = await import(pathToFileURL(path.join(__dirname, '../src/public/shared/onboarding.js')));
  const complete = { status: 'active', guideHidden: false, steps: { shoes: true, cycle: true, trainings: true } };
  assert.deepEqual(
    onboardingPresentation(complete),
    { steps: complete.steps, completed: 3, total: 3, complete: true, nextStep: null, guideOpen: false, guideVisible: false, completionVisible: true, reopenVisible: false }
  );
  const reopened = { ...complete, guideOpen: true };
  assert.equal(onboardingPresentation(reopened).guideVisible, true);
  assert.equal(onboardingPresentation(reopened).completionVisible, false);
  const hidden = { ...complete, guideHidden: true, guideOpen: false };
  assert.equal(onboardingPresentation(hidden).guideVisible, false);
  assert.equal(onboardingPresentation(hidden).completionVisible, true);
  assert.equal(onboardingPresentation({ ...hidden }).completed, 3);
});

test('welcome inert targeting excludes the dialog and preserves previously inert elements', async () => {
  const { backgroundInertTargets } = await import(pathToFileURL(path.join(__dirname, '../src/public/shared/onboarding.js')));
  const modal = {};
  const shell = { hasAttribute: () => false };
  const alreadyInert = { hasAttribute: () => true };
  assert.deepEqual(backgroundInertTargets([shell, modal, alreadyInert], modal), [shell]);
});

test('onboarding UI keeps the existing destinations and accessibility hooks', () => {
  const fs = require('node:fs');
  const home = fs.readFileSync(path.join(__dirname, '../src/public/home.html'), 'utf8');
  const homeJs = fs.readFileSync(path.join(__dirname, '../src/public/home.js'), 'utf8');
  assert.match(home, /href="\/shoes\.html"/);
  assert.match(home, /href="\/cycles\.html"/);
  assert.match(home, /href="\/ai-coach\.html"/);
  assert.match(home, /href="\/calendar\.html"/);
  assert.match(home, /aria-labelledby="onboardingWelcomeTitle"/);
  assert.match(home, /onboardingHide/);
  assert.match(home, /onboardingReopenHidden/);
  assert.match(home, /aria-modal="true"/);
  assert.match(homeJs, /const next = response\?\.onboarding/);
  assert.match(homeJs, /event\.key === 'Escape'/);
  assert.match(homeJs, /setAttribute\('inert', ''\)/);
  assert.match(homeJs, /onboardingContinue\?\.focus\(\)/);
  assert.match(home, /onboarding-shoes\.png/);
  assert.match(home, /onboarding-cycle\.png/);
  assert.match(home, /onboarding-plan\.png/);
  for (const asset of ['onboarding-shoes.png', 'onboarding-cycle.png', 'onboarding-plan.png']) {
    assert.ok(require('node:fs').existsSync(path.join(__dirname, '../src/public/assets/onboarding', asset)), `${asset} is committed at the HTML path`);
  }
});

test('result guidance is limited to the first unrecorded workout for new users', async () => {
  const { shouldShowOnboardingResultHint } = await import(pathToFileURL(path.join(__dirname, '../src/public/training-result.js')));
  assert.equal(shouldShowOnboardingResultHint({ status: 'new', firstTrainingId: 4 }, { result_data_source: 'none' }, 4), true);
  assert.equal(shouldShowOnboardingResultHint({ status: 'active', firstTrainingId: 4 }, { result_data_source: 'manual' }, 4), false);
  assert.equal(shouldShowOnboardingResultHint({ status: 'active', firstTrainingId: 4 }, { result_data_source: 'fit_upload' }, 4), false);
  assert.equal(shouldShowOnboardingResultHint({ status: 'active', firstTrainingId: 4 }, { result_data_source: 'none' }, 5), false);
  assert.equal(shouldShowOnboardingResultHint({ status: 'legacy', firstTrainingId: 4 }, { result_data_source: 'none' }, 4), false);
  const css = readFileSync(path.join(__dirname, '../src/public/home.css'), 'utf8');
  assert.doesNotMatch(css, /var\(--surface\)|var\(--wash\)/);
});
