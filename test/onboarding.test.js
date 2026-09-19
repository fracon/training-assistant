'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { existsSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { tmpdir } = require('node:os');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { createHash } = require('node:crypto');

const execFileAsync = promisify(execFile);

function findChrome() {
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((candidate) => existsSync(candidate));
}

async function runChromeAtViewport(chrome, url, { width, height, mobile }) {
  const portServer = createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const debugPort = portServer.address().port;
  portServer.close();
  await once(portServer, 'close');
  const processHandle = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-allow-origins=*', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${mkdtempSync(`${tmpdir()}/kinesis-onboarding-cdp-`)}`, 'about:blank',
  ], { stdio: 'ignore' });
  let socket;
  try {
    const debugUrl = `http://127.0.0.1:${debugPort}`;
    let versionResponse;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        versionResponse = await fetch(`${debugUrl}/json/version`);
        if (versionResponse.ok) break;
      } catch {}
      await delay(50);
    }
    assert.ok(versionResponse?.ok, 'Chrome DevTools endpoint became available.');
    const targetResponse = await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' });
    assert.equal(targetResponse.ok, true, 'Chrome created a page target.');
    const target = await targetResponse.json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let commandId = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++commandId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    await command('Page.enable');
    await command('Runtime.enable');
    await command('Network.enable');
    await command('Network.setCacheDisabled', { cacheDisabled: true });
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    const loaded = new Promise((resolve) => {
      const listener = (event) => {
        const message = JSON.parse(event.data);
        if (message.method === 'Page.loadEventFired') {
          socket.removeEventListener('message', listener);
          resolve();
        }
      };
      socket.addEventListener('message', listener);
    });
    await command('Page.navigate', { url });
    await Promise.race([loaded, delay(15000).then(() => { throw new Error('Chrome page load timed out.'); })]);
    const evaluation = await command('Runtime.evaluate', {
      expression: '({result:document.body.dataset.visualResult,error:document.body.dataset.visualError,viewport:{width:innerWidth,height:innerHeight}})',
      returnByValue: true,
    });
    const value = evaluation.result?.value;
    assert.ok(value, `Chrome evaluated visual measurements: ${JSON.stringify(evaluation.exceptionDetails ?? {})}`);
    assert.equal(evaluation.exceptionDetails, undefined, `Chrome page probe completed: ${JSON.stringify(evaluation.exceptionDetails ?? {})}`);
    assert.deepEqual(value.viewport, { width, height }, `Chrome returned viewport measurement: ${JSON.stringify(evaluation)}`);
    assert.equal(value.error, undefined, value.error);
    assert.ok(value.result, 'visual measurement script completed');
    if (process.env.ONBOARDING_VISUAL_REPORT === '1') {
      const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(`/tmp/kinesis-onboarding-${width}x${height}.png`, Buffer.from(screenshot.data, 'base64'));
    }
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    const focusEvaluation = await command('Runtime.evaluate', {
      expression: `(()=>{const action=document.querySelector('.onboarding-welcome-slide:not([hidden]) [data-onboarding-action]:not([hidden])');action?.focus();return action?getComputedStyle(action).outlineStyle:null})()`,
      returnByValue: true,
    });
    if (focusEvaluation.result?.value) value.keyboardFocusOutline = focusEvaluation.result.value;
    return { ...JSON.parse(value.result), keyboardFocusOutline: value.keyboardFocusOutline };
  } finally {
    try { socket?.close(); } catch {}
    processHandle.kill();
    await Promise.race([once(processHandle, 'close'), delay(2000)]);
  }
}

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

test('temporary welcome preview is available across account states and never mutates persisted presentation', async () => {
  const { createWelcomePreviewSession } = await import(pathToFileURL(path.join(__dirname, '../src/public/shared/onboarding.js')));
  const session = createWelcomePreviewSession();
  const persisted = {
    new: { status: 'new', welcomeDismissed: false, guideHidden: false, steps: { shoes: false, cycle: false, trainings: false } },
    legacy: { status: 'legacy', welcomeDismissed: true, guideHidden: true, steps: { shoes: true, cycle: false, trainings: false } },
    completed: { status: 'active', welcomeDismissed: true, guideHidden: false, steps: { shoes: true, cycle: true, trainings: true } },
  };
  const snapshots = structuredClone(persisted);
  for (const onboarding of Object.values(persisted)) {
    session.openPreview();
    assert.equal(session.mode, 'preview');
    assert.equal(session.slide, 0);
    assert.equal(session.ensureAutomatic(onboarding), true);
    session.setSlide(2, 3);
    assert.equal(session.slide, 2);
    session.close();
    assert.equal(session.ensureAutomatic(onboarding), false);
  }
  assert.deepEqual(persisted, snapshots);
  assert.equal(session.openPreview(), undefined);
  assert.equal(session.slide, 0, 'every preview opens on slide one');
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
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for onboarding browser validation.');
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

test('real welcome markup keeps carousel geometry stable on desktop and mobile with cache-busted assets', async () => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for onboarding visual validation.');
  const root = path.join(__dirname, '..');
  const publicDir = path.join(root, 'src/public');
  const home = readFileSync(path.join(publicDir, 'home.html'), 'utf8');
  const modalStart = home.indexOf('<div id="onboardingWelcome"');
  const modalEnd = home.indexOf('\n  <script src=', modalStart);
  assert.ok(modalStart >= 0 && modalEnd > modalStart, 'the real welcome dialog markup is embedded in the browser fixture');
  const imagePath = path.join(publicDir, 'assets/onboarding/onboarding-shoes.png');
  const imageHash = createHash('sha256').update(readFileSync(imagePath)).digest('hex');
  const previousImage = execFileSync('git', ['show', 'HEAD:src/public/assets/onboarding/onboarding-shoes.png'], { maxBuffer: 10 * 1024 * 1024 });
  assert.notEqual(imageHash, createHash('sha256').update(previousImage).digest('hex'), 'the supplied replacement image is a real binary change');
  const versionedModal = home.slice(modalStart, modalEnd)
    .replace(' class="onboarding-welcome" hidden', ' class="onboarding-welcome"')
    .replaceAll('/assets/onboarding/', `/assets/onboarding/?unused=`)
    .replace(/\/assets\/onboarding\/\?unused=(onboarding-[^"?]+\.png)/g, `/assets/onboarding/$1?v=${imageHash}`);
  const en = JSON.parse(readFileSync(path.join(publicDir, 'locales/en.json'), 'utf8'));
  const pt = JSON.parse(readFileSync(path.join(publicDir, 'locales/pt.json'), 'utf8'));
  const browserScript = `
    import { createWelcomePreviewSession, updateOnboardingDialogA11y, trapOnboardingFocus, visibleOnboardingFocusableElements } from '/shared/onboarding.js';
    const locales = ${JSON.stringify({ en: en.home.onboarding, pt: pt.home.onboarding })};
    const modal = document.getElementById('onboardingWelcome');
    const dialog = modal.querySelector('[role="dialog"]');
    const slides = [...modal.querySelectorAll('[data-onboarding-welcome-slide]')];
    const previous = document.getElementById('onboardingPrevious');
    const next = document.getElementById('onboardingNext');
    const dots = [...modal.querySelectorAll('[data-onboarding-slide-control]')];
    const preview = document.getElementById('onboardingPreview');
    const later = document.getElementById('onboardingLater');
    const session = createWelcomePreviewSession();
    const storedPrefs = { status: 'legacy', welcomeDismissed: true, guideHidden: true, steps: { shoes: true, cycle: true, trainings: true } };
    const persistedBefore = JSON.stringify(storedPrefs);
    let openCount = 0;
    preview.addEventListener('click', () => { openCount += 1; session.openPreview(); modal.hidden = false; render(0, 'en'); });
    later.addEventListener('click', () => { session.close(); modal.hidden = true; });
    function text(key, lang) { return locales[lang][key.split('.').pop()]; }
    function render(index, lang) {
      slides.forEach((slide, i) => { slide.hidden = i !== index; slide.setAttribute('aria-hidden', String(i !== index)); });
      previous.hidden = index === 0;
      next.hidden = index === 2;
      document.getElementById('onboardingPlanPrerequisite').hidden = index !== 2;
      document.querySelector('.onboarding-welcome-action-secondary').hidden = true;
      dots.forEach((dot, i) => dot.setAttribute('aria-current', i === index ? 'step' : 'false'));
      modal.querySelectorAll('[data-i18n]').forEach((element) => {
        const key = element.dataset.i18n;
        const translated = locales[lang][key.split('.').pop()];
        if (translated) element.textContent = translated.replace('{current}', String(index + 1)).replace('{total}', '3');
      });
      updateOnboardingDialogA11y(dialog, slides[index]);
      slides[index].querySelector('h2').focus();
    }
    const measurements = [];
    function measureSlide(index, lang) {
      session.setSlide(index, 3);
      render(index, lang);
      const rect = (element) => { const r = element.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, centerX:r.x+r.width/2, right:r.right, bottom:r.bottom }; };
      const slide = slides[index];
      const content = slide.querySelector('.onboarding-welcome-content');
      const image = slide.querySelector('img');
      const media = slide.querySelector('.onboarding-welcome-media');
      const title = slide.querySelector('h2');
      const action = [...slide.querySelectorAll('[data-onboarding-action]')].find((element) => !element.hidden);
      title.focus();
      const shiftTab = new KeyboardEvent('keydown', { key:'Tab', shiftKey:true, cancelable:true });
      trapOnboardingFocus(shiftTab, dialog, title);
      const focusWrappedFromTitle = shiftTab.defaultPrevented && document.activeElement === later;
      const currentImage = image.currentSrc;
      const accessibleRefsAreActive = dialog.getAttribute('aria-labelledby') === title.id
        && dialog.getAttribute('aria-describedby') === slide.querySelector('[id^="onboardingWelcomeDescription"]').id;
      const visibleFilledActions = [...modal.querySelectorAll('.onboarding-welcome-slide:not([hidden]) .btn-primary')].length;
      measurements.push({
        index, lang, viewport:{ width:innerWidth, height:innerHeight }, card:rect(dialog), stepper:rect(modal.querySelector('.onboarding-welcome-indicators')),
        media:rect(media), image:rect(image), content:rect(content), footer:rect(modal.querySelector('.onboarding-welcome-footer')),
        later:rect(later), title:rect(title), titleOutline:getComputedStyle(title).outlineStyle,
        actionDecoration:getComputedStyle(action).textDecorationLine,
        contentOverflow:content.scrollHeight-content.clientHeight,
        imageLoaded:image.complete && image.naturalWidth>0, imageCurrentSrc:currentImage,
        imageHashMatches:currentImage.includes('v=${imageHash}'), nextHidden:next.hidden, previousHidden:previous.hidden,
        nextDisplay:getComputedStyle(next).display, previousDisplay:getComputedStyle(previous).display,
        hiddenSecondaryFocusable:visibleOnboardingFocusableElements(dialog).includes(document.querySelector('.onboarding-welcome-action-secondary')),
        focusWrappedFromTitle,
        accessibleRefsAreActive, visibleFilledActions,
        navBackground:getComputedStyle(next).backgroundColor,
      });
    }
    window.__run = () => {
      for (const lang of ['en','pt']) for (let index=0; index<3; index+=1) measureSlide(index, lang);
      preview.click();
      const previewFirst = session.mode === 'preview' && session.slide === 0 && !modal.hidden;
      later.click();
      preview.click();
      const reopenedFirst = session.mode === 'preview' && session.slide === 0 && !modal.hidden && openCount === 2;
      const preferencesUntouched = JSON.stringify(storedPrefs) === persistedBefore;
      document.body.dataset.visualResult = JSON.stringify({ measurements, previewFirst, reopenedFirst, preferencesUntouched, openCount, oneDialog:document.querySelectorAll('[role="dialog"]').length === 1 });
    };
    try { window.__run(); } catch (error) { document.body.dataset.visualError = error.stack || String(error); }
  `;
  const documentHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/home.css"></head><body><main id="appView"><button id="onboardingPreview" data-i18n="home.onboarding.previewWelcome">Preview welcome</button></main>${versionedModal}<script>window.addEventListener('error',event=>{document.body.dataset.visualError=event.message});window.addEventListener('unhandledrejection',event=>{document.body.dataset.visualError=String(event.reason)});</script><script type="module">${browserScript}</script></body></html>`;
  const requests = [];
  const server = createServer((request, response) => {
    const requestPath = decodeURIComponent((request.url || '/').split('?')[0]);
    if (requestPath.startsWith('/assets/onboarding/')) requests.push(request.url);
    const relative = requestPath === '/' ? null : requestPath.replace(/^\//, '');
    try {
      const body = relative ? readFileSync(path.join(publicDir, relative)) : documentHtml;
      const type = requestPath.endsWith('.css') ? 'text/css' : requestPath.endsWith('.js') ? 'text/javascript' : requestPath.endsWith('.png') ? 'image/png' : 'text/html';
      response.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store, max-age=0' });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const browserResults = [];
  try {
    for (const [width, height] of [[1280, 800], [390, 844]]) {
      browserResults.push(await runChromeAtViewport(chrome, `http://127.0.0.1:${port}/`, {
        width, height, mobile: width < 600,
      }));
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
  assert.ok(requests.some((url) => url.includes(`/onboarding-shoes.png?v=${imageHash}`)), 'Chrome loaded the changed shoe illustration via a cache-busted URL');
  for (const result of browserResults) {
    assert.notEqual(result.keyboardFocusOutline, 'none', 'keyboard-focused primary action retains a visible ring');
    assert.equal(result.previewFirst, true);
    assert.equal(result.reopenedFirst, true);
    assert.equal(result.preferencesUntouched, true);
    assert.equal(result.oneDialog, true);
    assert.equal(result.openCount, 2);
    const grouped = new Map();
    for (const sample of result.measurements) {
      const key = `${sample.viewport.width}:${sample.lang}`;
      const prior = grouped.get(key) ?? [];
      prior.push(sample);
      grouped.set(key, prior);
      assert.equal(sample.stepper.centerX, sample.card.centerX, `stepper centered for ${key} slide ${sample.index + 1}`);
      assert.equal(sample.nextHidden, sample.index === 2);
      assert.equal(sample.previousHidden, sample.index === 0);
      assert.equal(sample.previousDisplay === 'none', sample.index === 0);
      assert.equal(sample.nextDisplay === 'none', sample.index === 2);
      assert.equal(sample.hiddenSecondaryFocusable, false);
      assert.equal(sample.focusWrappedFromTitle, true);
      assert.equal(sample.accessibleRefsAreActive, true);
      assert.equal(sample.visibleFilledActions, 1);
      assert.equal(sample.titleOutline, 'none');
      assert.equal(sample.actionDecoration, 'none');
      assert.equal(sample.imageLoaded, true);
      assert.equal(sample.imageHashMatches, true);
      assert.equal(sample.media.x, sample.image.x);
      assert.equal(sample.media.y, sample.image.y);
      assert.equal(sample.media.width, sample.image.width);
      assert.equal(sample.media.height, sample.image.height);
      assert.equal(sample.navBackground, 'rgba(0, 0, 0, 0)');
      assert.ok(sample.contentOverflow <= 1, `content fits without clipping (${key} slide ${sample.index + 1}: ${sample.contentOverflow}px)`);
      assert.ok(sample.later.centerX === sample.card.centerX, `Now-not centered under navigation (${key})`);
    }
    for (const [key, samples] of grouped) {
      const first = samples[0];
      for (const sample of samples.slice(1)) {
        assert.deepEqual(sample.card, first.card, `dialog dimensions stable for ${key}`);
        assert.deepEqual(sample.stepper, first.stepper, `stepper position stable for ${key}`);
        assert.deepEqual(sample.media, first.media, `image pane stable for ${key}`);
        assert.deepEqual(sample.content, first.content, `content pane stable for ${key}`);
        assert.deepEqual(sample.footer, first.footer, `footer stable for ${key}`);
      }
    }
  }
  if (process.env.ONBOARDING_VISUAL_REPORT === '1') {
    for (const result of browserResults) {
      const measurements = result.measurements.filter((sample) => sample.lang === 'en');
      const first = measurements[0];
      console.log(JSON.stringify({
        viewport: first.viewport,
        dialog: { width: first.card.width, height: first.card.height, left: first.card.x, top: first.card.y },
        stepperCenters: measurements.map((sample) => sample.stepper.centerX),
        slides: measurements.map((sample) => ({ slide: sample.index + 1, image: { width: sample.media.width, height: sample.media.height }, contentOverflow: sample.contentOverflow })),
      }));
    }
  }
});

test('browser dialog a11y follows the active slide and traps Shift+Tab from its title', async () => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for onboarding focus validation.');
  const root = path.join(__dirname, '..');
  const server = createServer((request, response) => {
    const requested = decodeURIComponent((request.url || '/').split('?')[0]);
    const relative = requested === '/' ? 'test/onboarding-a11y.html' : requested.replace(/^\/+/, '');
    if (relative.includes('..')) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const file = readFileSync(path.join(root, relative));
      const type = relative.endsWith('.js') ? 'text/javascript' : 'text/html';
      response.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
      response.end(file);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  let output;
  try {
    const result = await execFileAsync(chrome, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', `--user-data-dir=${mkdtempSync(`${tmpdir()}/kinesis-onboarding-a11y-`)}`,
      '--virtual-time-budget=3000', '--dump-dom',
      `http://127.0.0.1:${port}/test/onboarding-a11y.html`,
    ], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    output = result.stdout;
  } finally {
    server.close();
    await once(server, 'close');
  }
  assert.match(output, /data-a11y-result="pass"/);
});
