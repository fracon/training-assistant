'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { existsSync, mkdtempSync, readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { tmpdir } = require('node:os');

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

test('welcome carousel moves one slide at a time and gates workout actions on an active cycle', async () => {
  const { onboardingPlanActions, onboardingSlideNavigation } = await import(pathToFileURL(path.join(__dirname, '../src/public/shared/onboarding.js')));
  assert.deepEqual(onboardingSlideNavigation(0), { current: 0, previous: 0, next: 1, isFirst: true, isLast: false });
  assert.deepEqual(onboardingSlideNavigation(1), { current: 1, previous: 0, next: 2, isFirst: false, isLast: false });
  assert.deepEqual(onboardingSlideNavigation(2), { current: 2, previous: 1, next: 2, isFirst: false, isLast: true });
  assert.equal(onboardingSlideNavigation(-1).current, 0);
  assert.equal(onboardingSlideNavigation(99).current, 2);
  assert.deepEqual(onboardingPlanActions(false), {
    primaryHref: '/cycles.html', primaryKey: 'planCycleAction', secondaryHref: null,
  });
  assert.deepEqual(onboardingPlanActions(true), {
    primaryHref: '/ai-coach.html', primaryKey: 'aiAction', secondaryHref: '/calendar.html',
  });
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
  assert.match(home, /aria-labelledby="onboardingWelcomeTitle0"/);
  assert.match(home, /onboardingHide/);
  assert.match(home, /onboardingReopenHidden/);
  assert.match(home, /aria-modal="true"/);
  assert.match(homeJs, /const next = response\?\.onboarding/);
  assert.match(homeJs, /event\.key === 'Escape'/);
  assert.match(homeJs, /setAttribute\('inert', ''\)/);
  assert.match(homeJs, /focusWelcomeTitle\(\)/);
  const slides = [...home.matchAll(/<article class="onboarding-welcome-slide" data-onboarding-welcome-slide="(\d+)"[\s\S]*?<\/article>/g)];
  assert.equal(slides.length, 3);
  for (const [index, asset] of ['onboarding-shoes.png', 'onboarding-cycle.png', 'onboarding-plan.png'].entries()) {
    assert.match(slides[index][0], new RegExp(`/assets/onboarding/${asset}`));
  }
  assert.match(home, /id="onboardingPrevious"[^>]*hidden/);
  assert.match(home, /id="onboardingNext"/);
  assert.equal((home.match(/data-onboarding-slide-control=/g) || []).length, 3);
  assert.match(homeJs, /event\.currentTarget\.getAttribute\('href'\)/);
  assert.match(homeJs, /window\.location\.href = destination/);
  for (const asset of ['onboarding-shoes.png', 'onboarding-cycle.png', 'onboarding-plan.png']) {
    assert.ok(require('node:fs').existsSync(path.join(__dirname, '../src/public/assets/onboarding', asset)), `${asset} is committed at the HTML path`);
  }
});

test('welcome carousel copy is translated and action labels match their destinations', () => {
  const en = JSON.parse(readFileSync(path.join(__dirname, '../src/public/locales/en.json'), 'utf8'));
  const pt = JSON.parse(readFileSync(path.join(__dirname, '../src/public/locales/pt.json'), 'utf8'));
  assert.equal(en.home.onboarding.shoesAction, 'Add my shoes');
  assert.equal(pt.home.onboarding.shoesAction, 'Cadastrar meus tênis');
  assert.equal(en.home.onboarding.stepProgress, '{current} of {total}');
  assert.equal(pt.home.onboarding.stepProgress, '{current} de {total}');
  assert.equal(en.home.onboarding.planTitle, 'Add workouts to your calendar');
  assert.equal(pt.home.onboarding.planTitle, 'Adicione treinos ao calendário');
  assert.equal(en.home.onboarding.planCycleAction, 'Create my cycle first');
  assert.equal(pt.home.onboarding.planCycleAction, 'Criar meu ciclo primeiro');
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

test('browser CSS makes every hidden onboarding root actually invisible', () => {
  const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((candidate) => existsSync(candidate));
  if (!chrome) return;
  const css = readFileSync(path.join(__dirname, '../src/public/home.css'), 'utf8');
  const onboardingCss = css.slice(css.indexOf('.onboarding-guide,'), css.indexOf('/* ── Hero Banner'));
  const html = `<!doctype html><style>${onboardingCss}</style>
    <section id="onboardingGuide" class="onboarding-guide" hidden></section>
    <section id="onboardingComplete" class="onboarding-complete" hidden></section>
    <div id="onboardingReopenBar" class="onboarding-reopen-bar" hidden></div>
    <div id="onboardingWelcome" class="onboarding-welcome" hidden></div>
    <script>document.body.dataset.hiddenDisplays = ['onboardingGuide','onboardingComplete','onboardingReopenBar','onboardingWelcome']
      .map((id) => getComputedStyle(document.getElementById(id)).display).join(',');</script>`;
  const profile = mkdtempSync(`${tmpdir()}/kinesis-onboarding-chrome-`);
  const output = execFileSync(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', `--user-data-dir=${profile}`, '--dump-dom',
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  ], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
  assert.match(output, /data-hidden-displays="none,none,none,none"/);
});
