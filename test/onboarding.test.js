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
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');

const execFileAsync = promisify(execFile);

function findChrome() {
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((candidate) => existsSync(candidate));
}

async function runChromeAtViewport(chrome, url, { width, height, mobile, cookie = null, probeExpression = null }) {
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
    if (cookie) {
      const result = await command('Network.setCookie', { name: 'ta_session', value: cookie, url });
      assert.equal(result.success, true, 'Chrome accepted the authenticated test session cookie.');
      await command('Network.setExtraHTTPHeaders', { headers: { Cookie: `ta_session=${cookie}` } });
    }
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
    const expression = probeExpression
      ? `(async()=>({probe:await (${probeExpression}),viewport:{width:innerWidth,height:innerHeight}}))()`
      : '({result:document.body.dataset.visualResult,error:document.body.dataset.visualError,viewport:{width:innerWidth,height:innerHeight}})';
    const evaluation = await command('Runtime.evaluate', {
      expression,
      awaitPromise: Boolean(probeExpression),
      returnByValue: true,
    });
    const value = evaluation.result?.value;
    assert.ok(value, `Chrome evaluated visual measurements: ${JSON.stringify(evaluation.exceptionDetails ?? {})}`);
    assert.equal(evaluation.exceptionDetails, undefined, `Chrome page probe completed: ${JSON.stringify(evaluation.exceptionDetails ?? {})}`);
    assert.deepEqual(value.viewport, { width, height }, `Chrome returned viewport measurement: ${JSON.stringify(evaluation)}`);
    if (!probeExpression) {
      assert.equal(value.error, undefined, value.error);
      assert.ok(value.result, 'visual measurement script completed');
    }
    if (process.env.ONBOARDING_VISUAL_REPORT === '1') {
      const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(`/tmp/kinesis-onboarding-${width}x${height}.png`, Buffer.from(screenshot.data, 'base64'));
    }
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    const focusEvaluation = await command('Runtime.evaluate', {
      expression: `(()=>{const action=document.querySelector('.onboarding-welcome-slide:not([hidden]) [data-onboarding-action]:not([hidden])');const later=document.getElementById('onboardingLater');action?.focus();const actionOutline=action?getComputedStyle(action).outlineStyle:null;later?.focus();return {actionOutline,laterOutline:later?getComputedStyle(later).outlineStyle:null}})()`,
      returnByValue: true,
    });
    if (focusEvaluation.result?.value) {
      value.keyboardFocusOutline = focusEvaluation.result.value.actionOutline;
      value.laterKeyboardFocusOutline = focusEvaluation.result.value.laterOutline;
    }
    return probeExpression ? value.probe : { ...JSON.parse(value.result), keyboardFocusOutline: value.keyboardFocusOutline };
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
  assert.equal(imageHash, 'a9cdfe175cb3824e451c8ca5ebf25bd5ea965e7192a04c1f219addedb671135b', 'the supplied replacement image is the expected committed binary');
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
        laterStyle:{ fontSize:getComputedStyle(later).fontSize, fontWeight:getComputedStyle(later).fontWeight, color:getComputedStyle(later).color, background:getComputedStyle(later).backgroundColor, shadow:getComputedStyle(later).boxShadow, decoration:getComputedStyle(later).textDecorationLine, outlineStyle:getComputedStyle(later).outlineStyle, outlineWidth:getComputedStyle(later).outlineWidth, minHeight:getComputedStyle(later).minHeight },
        laterBottomGap:dialog.getBoundingClientRect().bottom-later.getBoundingClientRect().bottom,
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
    assert.notEqual(result.laterKeyboardFocusOutline, 'none', 'keyboard-focused dismissal action retains a visible ring');
    assert.equal(result.previewFirst, true);
    assert.equal(result.reopenedFirst, true);
    assert.equal(result.preferencesUntouched, true);
    assert.equal(result.oneDialog, true);
    assert.equal(result.openCount, 2);
    const grouped = new Map();
    for (const sample of result.measurements) {
      const key = `${sample.viewport.width}:${sample.lang}`;
      const expectedGeometry = sample.viewport.width === 1280
        ? { card: [260, 80, 760, 640], stepper: [611.953125, 647.765625, 56.09375, 9.265625] }
        : { card: [16, 102, 358, 640], stepper: [166.953125, 669.765625, 56.09375, 9.265625] };
      assert.deepEqual([sample.card.x, sample.card.y, sample.card.width, sample.card.height], expectedGeometry.card, `approved dialog dimensions remain unchanged for ${key}`);
      assert.deepEqual([sample.stepper.x, sample.stepper.y, sample.stepper.width, sample.stepper.height], expectedGeometry.stepper, `approved stepper position remains unchanged for ${key}`);
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
      assert.ok(Number.parseFloat(sample.laterStyle.fontSize) < 16, `dismiss action text is smaller than carousel navigation (${key})`);
      assert.equal(sample.laterStyle.fontWeight, '500');
      assert.equal(sample.laterStyle.color, 'rgb(139, 129, 114)');
      assert.equal(sample.laterStyle.background, 'rgba(0, 0, 0, 0)');
      assert.equal(sample.laterStyle.shadow, 'none');
      assert.equal(sample.laterStyle.decoration, 'none');
      assert.equal(sample.laterStyle.minHeight, '36px');
      assert.ok(sample.laterBottomGap >= 12 && sample.laterBottomGap <= 16, `dismiss action has approximately 12–16px breathing room beneath it (${key}: ${sample.laterBottomGap}px)`);
      assert.ok(sample.later.width >= 44, `dismiss action retains a generous hit target (${key})`);
      assert.equal(sample.imageLoaded, true);
      assert.equal(sample.imageHashMatches, true);
      assert.equal(sample.media.x, sample.image.x);
      assert.equal(sample.media.y, sample.image.y);
      assert.equal(sample.media.width, sample.image.width);
      assert.equal(sample.media.height, sample.image.height);
      assert.equal(sample.navBackground, 'rgba(0, 0, 0, 0)');
      assert.ok(sample.contentOverflow <= 1, `content fits without clipping (${key} slide ${sample.index + 1}: ${sample.contentOverflow}px)`);
      assert.ok(Math.abs(sample.later.centerX - sample.card.centerX) < 0.5, `Now-not remains visually centered under navigation (${key}: ${sample.later.centerX} vs ${sample.card.centerX})`);
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
        stepperRects: measurements.map(({ stepper }) => ({ x: stepper.x, y: stepper.y, width: stepper.width, height: stepper.height })),
        slides: measurements.map((sample) => ({ slide: sample.index + 1, image: { width: sample.media.width, height: sample.media.height }, contentOverflow: sample.contentOverflow })),
      }));
    }
  }
});

test('the complete authenticated dashboard allows a non-persistent welcome preview for legacy users', async () => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for full-dashboard onboarding validation.');
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });
  try {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: {
      email: 'welcome-preview@example.com', password: 'preview-secret', first_name: 'Preview', last_name: 'Runner',
    } });
    db.prepare("UPDATE users SET onboarding_status = 'legacy' WHERE email = ?").run('welcome-preview@example.com');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {
      email: 'welcome-preview@example.com', password: 'preview-secret',
    } });
    assert.equal(login.statusCode, 200);
    const cookie = [].concat(login.headers['set-cookie'] ?? [])[0].split(';')[0].split('=')[1];
    const cookieHeader = `ta_session=${cookie}`;
    const onboardingResponse = await app.inject({ method: 'GET', url: '/api/onboarding', headers: { cookie: cookieHeader } });
    assert.equal(onboardingResponse.statusCode, 200);
    const before = onboardingResponse.json().onboarding;
    assert.equal(before.status, 'legacy');
    const appUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const probeExpression = `new Promise((resolve,reject)=>{
      const deadline=Date.now()+15000;
      let status=null, initiallyVisible=null;
      fetch('/api/onboarding').then(response=>response.json()).then(payload=>{status=payload.onboarding?.status;});
      const attempt=()=>{
        const preview=document.getElementById('onboardingPreview');
        const modal=document.getElementById('onboardingWelcome');
        const dialog=modal?.querySelector('[role="dialog"]');
        if(preview && modal && status){
          if(initiallyVisible===null) initiallyVisible=!modal.hidden;
          if(modal.hidden) preview.click();
        }
        if(preview && modal && status && !modal.hidden && dialog?.getAttribute('aria-labelledby')==='onboardingWelcomeTitle0'){
          const opened={status,initiallyVisible,focused:document.activeElement.id==='onboardingWelcomeTitle0',backgroundInert:[...document.body.children].filter(node=>node!==modal).every(node=>node.inert),dialogCount:document.querySelectorAll('[role="dialog"]').length};
          document.getElementById('onboardingLater').click();
          requestAnimationFrame(()=>requestAnimationFrame(()=>{
            const closed={hidden:modal.hidden,restoredFocus:document.activeElement===preview,backgroundReleased:!preview.closest('#appView').inert};
            preview.click();
            resolve({opened,closed,reopened:!modal.hidden && dialog.getAttribute('aria-labelledby')==='onboardingWelcomeTitle0',label:preview.textContent.trim()});
          }));
          return;
        }
        if(Date.now()>deadline){reject(new Error('Full dashboard preview timed out: '+JSON.stringify({url:location.href,status,button:Boolean(preview),body:document.body.innerText.slice(0,250)})));return;}
        setTimeout(attempt,100);
      };
      attempt();
    })`;
    const result = await runChromeAtViewport(chrome, appUrl, {
      width: 1280, height: 800, mobile: false, cookie, probeExpression,
    });
    assert.deepEqual(result.opened, {
      status: 'legacy', initiallyVisible: false, focused: true, backgroundInert: true, dialogCount: 1,
    });
    assert.deepEqual(result.closed, { hidden: true, restoredFocus: true, backgroundReleased: true });
    assert.equal(result.reopened, true);
    assert.equal(result.label, 'Preview welcome');
    const after = (await app.inject({ method: 'GET', url: '/api/onboarding', headers: { cookie: cookieHeader } })).json().onboarding;
    assert.deepEqual(after, before, 'preview did not modify status, progress, or presentation preferences');
  } finally {
    await app.close();
    db.close();
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
