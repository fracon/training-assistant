'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { tmpdir } = require('node:os');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { createHash } = require('node:crypto');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { buildFitFile } = require('./helpers/buildFitFile');

const execFileAsync = promisify(execFile);

function findChrome() {
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((candidate) => existsSync(candidate));
}

async function runChromeAtViewport(chrome, url, { width, height, mobile, cookie = null, probeExpression = null, focusSelector = null, verifyTabNextSelector = null, verifyTabFollowingSelector = null, screenshotSuffix = '', keyboardActivateMenuItem = false, clickMenuItemAndFollowNavigation = false, verifyUserMenuTabOrder = false, keyboardFocusValidation = false, keyboardFocusLanguage = null }) {
  const portServer = createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const debugPort = portServer.address().port;
  portServer.close();
  await once(portServer, 'close');
  const profileDirectory = mkdtempSync(`${tmpdir()}/kinesis-onboarding-cdp-`);
  const processHandle = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-allow-origins=*', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDirectory}`, 'about:blank',
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
    if (keyboardFocusValidation) {
      if (keyboardFocusLanguage) {
        await command('Runtime.evaluate', {
          expression: `new Promise((resolve,reject)=>{const end=Date.now()+12000;const attempt=()=>{const button=document.querySelector('.lang-switch [data-lang="${keyboardFocusLanguage}"]');if(button){button.click();const wait=()=>document.documentElement.lang==="${keyboardFocusLanguage}"?resolve(true):(Date.now()>end?reject(new Error('Keyboard focus validation language switch timed out')):setTimeout(wait,40));wait();return}if(Date.now()>end){reject(new Error('Keyboard focus validation language button did not mount'));return}setTimeout(attempt,40)};attempt()})`,
          awaitPromise: true,
          returnByValue: true,
        });
      }
      const keyboardFocusState = {};
      const validatePlatformList = async ({ name, trigger, dialog, item, count, activateIndex = 1 }) => {
        await command('Runtime.evaluate', {
          expression: `new Promise((resolve,reject)=>{const end=Date.now()+12000;const attempt=()=>{const trigger=document.querySelector(${JSON.stringify(trigger)});const dialog=document.querySelector(${JSON.stringify(dialog)});const close=dialog?.querySelector(${JSON.stringify(`[data-${name === 'creation' ? 'workout-create-close' : 'import-help-close'}`)});if(trigger&&dialog&&close){trigger.focus();trigger.click();if(!dialog.hidden){close.focus();if(document.activeElement===close){resolve(true);return}}}if(Date.now()>end){reject(new Error(${JSON.stringify(`${name} guide did not open with focusable close control`)}));return}setTimeout(attempt,40)};attempt()})`,
          awaitPromise: true,
          returnByValue: true,
        });
        const focused = [];
        for (let index = 0; index < count; index += 1) {
          await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, text: '\t', unmodifiedText: '\t' });
          await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
          const current = await command('Runtime.evaluate', {
            expression: `(()=>{const element=document.activeElement;const style=getComputedStyle(element);return {id:element?.dataset?.${name === 'creation' ? 'workoutCreatePlatform' : 'providerId'}??element?.id,pressed:element?.getAttribute('aria-pressed'),outlineStyle:style.outlineStyle,outlineWidth:style.outlineWidth,outlineOffset:style.outlineOffset,outlineColor:style.outlineColor,rect:{left:element?.getBoundingClientRect().left,right:element?.getBoundingClientRect().right,top:element?.getBoundingClientRect().top,bottom:element?.getBoundingClientRect().bottom}}})()`,
            returnByValue: true,
          });
          focused.push(current.result?.value);
          if (index === activateIndex) {
            await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Space', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
            await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Space', code: 'Space', windowsVirtualKeyCode: 32 });
            await command('Runtime.evaluate', {
              expression: `new Promise((resolve,reject)=>{const end=Date.now()+2000;const wait=()=>document.querySelector(${JSON.stringify(item)}[aria-pressed="true"]:focus-visible)?resolve(true):(Date.now()>end?reject(new Error(${JSON.stringify(`${name} keyboard activation did not preserve focus`)})):setTimeout(wait,20));wait()})`,
              awaitPromise: true,
              returnByValue: true,
            });
          }
        }
        await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        const closed = await command('Runtime.evaluate', {
          expression: `({hidden:document.querySelector(${JSON.stringify(dialog)})?.hidden,restored:document.activeElement===document.querySelector(${JSON.stringify(trigger)}),selected:document.querySelectorAll(${JSON.stringify(`${dialog} ${item}[aria-pressed="true"]`)}).length,overflow:document.documentElement.scrollWidth<=innerWidth})`,
          returnByValue: true,
        });
        keyboardFocusState[name] = { focused, closed: closed.result?.value };
      };
      await validatePlatformList({ name: 'creation', trigger: '#workoutCreationBtn', dialog: '#workoutCreationDialog', item: '[data-workout-create-platform]', count: 8 });
      await validatePlatformList({ name: 'import', trigger: '#importHelpBtn', dialog: '#importHelpDialog', item: '[data-provider-id]', count: 7 });
      await command('Runtime.evaluate', { expression: `window.__keyboardFocusValidation=${JSON.stringify(keyboardFocusState)}`, returnByValue: true });
    }
    if (keyboardActivateMenuItem) {
      await command('Runtime.evaluate', {
        expression: `new Promise((resolve,reject)=>{const end=Date.now()+12000;let opened=false;const attempt=()=>{const badge=document.querySelector('#userBadge');const item=document.querySelector('#userSetupGuide');const dropdown=document.querySelector('#userDropdown');if(document.body.classList.contains('shell-mounted')&&badge&&item&&!badge.hidden){if(!opened){window.__setupGuideEventCount=0;document.addEventListener('kinesis:open-setup-guide',()=>window.__setupGuideEventCount++);badge.click();opened=true}if(dropdown&&!dropdown.classList.contains('hidden')){item.focus();resolve(true);return}}if(Date.now()>end){reject(new Error('Authenticated shell menu did not mount')) ;return}setTimeout(attempt,50)};attempt()})`,
        awaitPromise: true,
        returnByValue: true,
      });
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await command('Runtime.evaluate', { expression: `window.__setupGuideKeyboardState={focus:document.activeElement?.id,menuOpen:!document.getElementById('userDropdown')?.classList.contains('hidden'),guideHidden:document.getElementById('onboardingGuide')?.hidden,eventCount:window.__setupGuideEventCount,url:location.href}`, returnByValue: true });
    }
    if (clickMenuItemAndFollowNavigation) {
      const navigation = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Setup guide menu navigation timed out.')), 15000);
        const listener = (event) => {
          const message = JSON.parse(event.data);
          if (message.method !== 'Page.frameNavigated' || message.params.frame.parentId) return;
          if (!message.params.frame.url.includes('/home.html?')) return;
          clearTimeout(timer);
          socket.removeEventListener('message', listener);
          resolve();
        };
        socket.addEventListener('message', listener);
      });
      const nextLoad = new Promise((resolve) => {
        const listener = (event) => {
          if (JSON.parse(event.data).method !== 'Page.loadEventFired') return;
          socket.removeEventListener('message', listener);
          resolve();
        };
        socket.addEventListener('message', listener);
      });
      await command('Runtime.evaluate', {
        expression: `new Promise((resolve,reject)=>{const end=Date.now()+12000;let opened=false;const attempt=()=>{const badge=document.querySelector('#userBadge');const item=document.querySelector('#userSetupGuide');const dropdown=document.querySelector('#userDropdown');if(document.body.classList.contains('shell-mounted')&&badge&&item&&!badge.hidden){if(!opened){badge.click();opened=true}if(dropdown&&!dropdown.classList.contains('hidden')){item.click();resolve(true);return}}if(Date.now()>end){reject(new Error('Authenticated shell menu did not mount')) ;return}setTimeout(attempt,50)};attempt()})`,
        awaitPromise: true,
        returnByValue: true,
      });
      await Promise.race([navigation, delay(16000).then(() => { throw new Error('Dashboard navigation timed out.'); })]);
      await Promise.race([nextLoad, delay(15000).then(() => { throw new Error('Dashboard reload timed out.'); })]);
    }
    if (verifyUserMenuTabOrder) {
      await command('Runtime.evaluate', {
        expression: `new Promise((resolve,reject)=>{const end=Date.now()+12000;const attempt=()=>{const badge=document.getElementById('userBadge');const dropdown=document.getElementById('userDropdown');if(document.body.classList.contains('shell-mounted')&&badge&&!badge.hidden&&dropdown){badge.click();badge.focus();resolve(true);return}if(Date.now()>end){reject(new Error('User menu did not mount for keyboard-order validation')) ;return}setTimeout(attempt,50)};attempt()})`,
        awaitPromise: true,
        returnByValue: true,
      });
      const tabOrder = [];
      for (let index = 0; index < 3; index += 1) {
        await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        const focus = await command('Runtime.evaluate', { expression: 'document.activeElement?.id', returnByValue: true });
        tabOrder.push(focus.result?.value ?? null);
      }
      await command('Runtime.evaluate', { expression: `window.__userMenuTabOrder=${JSON.stringify(tabOrder)}`, returnByValue: true });
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    }
    const expression = probeExpression
      ? `(async()=>({probe:await (${probeExpression}),viewport:{width:innerWidth,height:innerHeight},userMenuTabOrder:window.__userMenuTabOrder??null}))()`
      : '({result:document.body.dataset.visualResult,error:document.body.dataset.visualError,viewport:{width:innerWidth,height:innerHeight},userMenuTabOrder:window.__userMenuTabOrder??null})';
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
      writeFileSync(`/tmp/kinesis-onboarding-${width}x${height}${screenshotSuffix}.png`, Buffer.from(screenshot.data, 'base64'));
    }
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    const focusEvaluation = await command('Runtime.evaluate', {
      expression: focusSelector
        ? `(()=>{const tabActiveElementId=document.activeElement?.id;const control=document.querySelector(${JSON.stringify(focusSelector)});control?.focus();return {tabActiveElementId,actionOutline:control?getComputedStyle(control).outlineStyle:null,actionVisible:control?.matches(':focus-visible')??false}})()`
        : `(()=>{const tabActiveElementId=document.activeElement?.id;const action=document.querySelector('.onboarding-welcome-slide:not([hidden]) [data-onboarding-action]:not([hidden])');const later=document.getElementById('onboardingLater');action?.focus();const actionOutline=action?getComputedStyle(action).outlineStyle:null;later?.focus();return {tabActiveElementId,actionOutline,laterOutline:later?getComputedStyle(later).outlineStyle:null}})()`,
      returnByValue: true,
    });
    if (focusEvaluation.result?.value) {
      value.keyboardFocusOutline = focusEvaluation.result.value.actionOutline;
      value.keyboardFocusVisible = focusEvaluation.result.value.actionVisible;
      value.laterKeyboardFocusOutline = focusEvaluation.result.value.laterOutline;
      value.tabActiveElementId = focusEvaluation.result.value.tabActiveElementId;
    }
    if (verifyTabNextSelector) {
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      const nextFocus = await command('Runtime.evaluate', {
        expression: `document.activeElement.matches(${JSON.stringify(verifyTabNextSelector)})`,
        returnByValue: true,
      });
      value.keyboardNextMatches = nextFocus.result?.value === true;
      if (verifyTabFollowingSelector) {
        await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        const followingFocus = await command('Runtime.evaluate', {
          expression: `document.activeElement.matches(${JSON.stringify(verifyTabFollowingSelector)})`,
          returnByValue: true,
        });
        value.keyboardFollowingMatches = followingFocus.result?.value === true;
      }
    }
    if (probeExpression) {
      Object.assign(value.probe, {
        keyboardFocusOutline: value.keyboardFocusOutline,
        keyboardFocusVisible: value.keyboardFocusVisible,
        tabActiveElementId: value.tabActiveElementId,
        keyboardNextMatches: value.keyboardNextMatches,
        keyboardFollowingMatches: value.keyboardFollowingMatches,
        userMenuTabOrder: value.userMenuTabOrder,
      });
      return value.probe;
    }
    return { ...JSON.parse(value.result), keyboardFocusOutline: value.keyboardFocusOutline, keyboardFocusVisible: value.keyboardFocusVisible, tabActiveElementId: value.tabActiveElementId, keyboardNextMatches: value.keyboardNextMatches, keyboardFollowingMatches: value.keyboardFollowingMatches };
  } finally {
    try { socket?.close(); } catch {}
    processHandle.kill();
    await Promise.race([once(processHandle, 'close'), delay(2000)]);
    rmSync(profileDirectory, { recursive: true, force: true });
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
  assert.equal(module.shouldShowWelcome({ status: 'unknown' }), false);
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

test('welcome session opens for new accounts and explicit guide requests suppress it for this visit', async () => {
  const { createWelcomeSession } = await import(pathToFileURL(path.join(__dirname, '../src/public/shared/onboarding.js')));
  const session = createWelcomeSession();
  const fresh = { status: 'new', welcomeDismissed: false, guideHidden: false };
  assert.equal(session.slide, 0);
  assert.equal(session.ensureAutomatic(fresh), true, 'a new account receives the automatic welcome');
  assert.equal(session.ensureAutomatic({ status: 'active' }), false, 'the persisted dismissal transitions the account out of first-visit status');
  assert.equal(session.ensureAutomatic({ status: 'active', welcomeDismissed: false }), false, 'existing accounts never receive the automatic modal');
  session.setSlide(2, 3);
  assert.equal(session.slide, 2, 'the automatic welcome retains carousel navigation state');
  session.suppressAutomatic();
  assert.equal(session.ensureAutomatic(fresh), false);
  assert.equal(fresh.status, 'new');
  assert.equal(fresh.welcomeDismissed, false);
  const nextVisit = createWelcomeSession();
  assert.equal(nextVisit.ensureAutomatic(fresh), true, 'the in-memory suppression does not persist across a new page visit');
});

test('guide presentation keeps completed and hidden onboarding out of layout until explicitly requested', async () => {
  const { onboardingPresentation } = await import(pathToFileURL(path.join(__dirname, '../src/public/shared/onboarding.js')));
  const complete = { status: 'active', guideHidden: false, steps: { shoes: true, cycle: true, trainings: true } };
  assert.deepEqual(
    onboardingPresentation(complete),
    { steps: complete.steps, completed: 3, total: 3, complete: true, nextStep: null, guideVisible: false }
  );
  assert.equal(onboardingPresentation(complete, true).guideVisible, true, 'completed users can open the checklist on demand');
  const hidden = { status: 'active', guideHidden: true, steps: { shoes: true, cycle: false, trainings: false } };
  assert.equal(onboardingPresentation(hidden).guideVisible, false);
  assert.equal(onboardingPresentation(hidden, true).guideVisible, true, 'opening hidden guidance is transient');
  const existing = { status: 'active', guideHidden: false, steps: { shoes: true, cycle: false, trainings: true } };
  assert.equal(onboardingPresentation(existing).guideVisible, true, 'active incomplete accounts see the checklist when not hidden');
  assert.equal(onboardingPresentation(existing, true).guideVisible, true);
  assert.equal(onboardingPresentation(existing, true).completed, 2);
});

test('the transient setup-guide URL signal is consumed while preserving query and hash', async () => {
  const { consumeSetupGuideSignal } = await import(pathToFileURL(path.join(__dirname, '../src/public/shared/onboarding.js')));
  const replacements = [];
  assert.equal(consumeSetupGuideSignal('https://kinesis.test/home.html?keep=one&openSetupGuide=1&also=two#cycle', (url) => replacements.push(url)), true);
  assert.deepEqual(replacements, ['/home.html?keep=one&also=two#cycle']);
  assert.equal(consumeSetupGuideSignal('https://kinesis.test/home.html?keep=one#cycle', (url) => replacements.push(url)), false);
  assert.equal(consumeSetupGuideSignal('https://kinesis.test/home.html?openSetupGuide=0', (url) => replacements.push(url)), false);
  assert.equal(replacements.length, 1, 'refreshing the cleaned URL cannot reopen the guide');
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
  assert.match(home, /id="onboardingTitle"[^>]*tabindex="-1"/);
  assert.match(home, /id="onboardingEyebrow"[^>]*data-i18n="home\.onboarding\.nextStep"/);
  assert.doesNotMatch(home, /onboardingComplete|onboardingReopen|onboarding-reopen-bar/);
  assert.doesNotMatch(home, /onboardingPreview|Preview welcome|Testar boas-vindas/);
  assert.match(home, /aria-modal="true"/);
  assert.match(homeJs, /const next = response\?\.onboarding/);
  assert.match(homeJs, /renderOnboardingStepStates\(onboardingGuide, progress\.steps, progress\.nextStep\)/);
  assert.match(homeJs, /consumeSetupGuideSignal\(window\.location\.href/);
  assert.match(homeJs, /kinesis:open-setup-guide/);
  assert.match(homeJs, /guideExplicitlyOpen/);
  const homeCss = fs.readFileSync(path.join(__dirname, '../src/public/home.css'), 'utf8');
  assert.doesNotMatch(homeCss, /\.onboarding-complete\s*\{|\.onboarding-reopen-bar/);
  assert.doesNotMatch(homeCss, /onboarding-preview-tools/);
  for (const locale of ['en', 'pt']) {
    const messages = JSON.parse(fs.readFileSync(path.join(__dirname, `../src/public/locales/${locale}.json`), 'utf8'));
    assert.equal(messages.home.onboarding.previewWelcome, undefined);
    assert.equal(messages.home.onboarding.reopen, undefined);
    assert.equal(messages.home.onboarding.completeTitle, undefined);
    assert.equal(messages.home.onboarding.completeText, undefined);
    assert.equal(messages.home.onboarding.completeToast, undefined);
  }
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
  assert.equal(en.home.onboarding.nextStep, 'Next step');
  assert.equal(pt.home.onboarding.nextStep, 'Próxima etapa');
  assert.equal(en.home.onboarding.setupComplete, 'Setup complete');
  assert.equal(pt.home.onboarding.setupComplete, 'Configuração concluída');
});

test('browser CSS makes the hidden onboarding guide and welcome modal actually invisible', () => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for onboarding browser validation.');
  const css = readFileSync(path.join(__dirname, '../src/public/home.css'), 'utf8');
  const onboardingCss = css.slice(css.indexOf('.onboarding-guide {'), css.indexOf('/* ── Hero Banner'));
  const html = `<!doctype html><style>${onboardingCss}</style>
    <section id="onboardingGuide" class="onboarding-guide" hidden></section>
    <div id="onboardingWelcome" class="onboarding-welcome" hidden></div>
    <script>document.body.dataset.hiddenDisplays = ['onboardingGuide','onboardingWelcome']
      .map((id) => getComputedStyle(document.getElementById(id)).display).join(',');</script>`;
  const profile = mkdtempSync(`${tmpdir()}/kinesis-onboarding-chrome-`);
  const output = execFileSync(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', `--user-data-dir=${profile}`, '--dump-dom',
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  ], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
  assert.match(output, /data-hidden-displays="none,none"/);
});

test('dashboard onboarding cards render accessible states and aligned actions in English and Portuguese', async () => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for dashboard onboarding visual validation.');
  const root = path.join(__dirname, '..');
  const publicDir = path.join(root, 'src/public');
  const home = readFileSync(path.join(publicDir, 'home.html'), 'utf8');
  const sectionStart = home.indexOf('<section id="onboardingGuide"');
  const sectionEnd = home.indexOf('</section>', sectionStart) + '</section>'.length;
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart, 'the real dashboard onboarding section exists');
  const guideMarkup = home.slice(sectionStart, sectionEnd).replace(' class="onboarding-guide card-section" hidden', ' class="onboarding-guide card-section"');
  const locales = {
    en: JSON.parse(readFileSync(path.join(publicDir, 'locales/en.json'), 'utf8')),
    pt: JSON.parse(readFileSync(path.join(publicDir, 'locales/pt.json'), 'utf8')),
  };
  const browserScript = `
    import { renderOnboardingStepStates } from '/shared/onboarding.js';
    import { applyTranslations, translate } from '/shared/i18n.js';
    const locales=${JSON.stringify(locales)};
    const guide=document.getElementById('onboardingGuide');
    const cards=[...guide.querySelectorAll('[data-onboarding-step]')];
    const states=[
      {steps:{shoes:false,cycle:false,trainings:false},next:'shoes'},
      {steps:{shoes:true,cycle:false,trainings:false},next:'cycle'},
      {steps:{shoes:true,cycle:true,trainings:false},next:'trainings'},
      {steps:{shoes:true,cycle:true,trainings:true},next:null},
    ];
    const samples=[];
    function rect(element){const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};}
    function visible(element){return !element.closest('[hidden]')&&getComputedStyle(element).display!=='none'&&element.getClientRects().length>0;}
    function measure(lang,count,state){
      const messages=locales[lang];
      applyTranslations(guide,messages);
      document.getElementById('onboardingProgress').textContent=translate(messages,'home.onboarding.progress',{completed:count});
      renderOnboardingStepStates(guide,state.steps,state.next);
      const states=cards.map((card)=>{
        const key=card.dataset.onboardingStep;
        const done=state.steps[key];
        const next=state.next===key;
        const completeBadge=card.querySelector('[data-onboarding-complete]');
        const nextBadge=card.querySelector('[data-onboarding-next]');
        const actions=card.querySelector('[data-onboarding-actions]');
        const links=[...actions.querySelectorAll('a')];
        const body=card.querySelector('.onboarding-step-body');
        return{
          key,done,next,card:rect(card),image:rect(card.querySelector('img')),body:rect(body),actionArea:rect(actions),actionAreaHidden:actions.hidden,
          links:links.map((link)=>{const style=getComputedStyle(link);const label=link.querySelector('span');const icon=link.querySelector('svg');return{href:new URL(link.href).pathname,classes:[...link.classList],rect:rect(link),label:rect(label),icon:rect(icon),iconHidden:icon.getAttribute('aria-hidden'),iconFocusable:icon.getAttribute('focusable'),iconTabIndex:icon.getAttribute('tabindex'),iconStroke:getComputedStyle(icon).stroke,color:style.color,background:style.backgroundColor,borderStyle:style.borderStyle,borderWidth:style.borderWidth,shadow:style.boxShadow,decoration:style.textDecorationLine,fontWeight:style.fontWeight}}),
          completeBadge:{hidden:completeBadge.hidden,text:completeBadge.innerText.trim(),rect:rect(completeBadge),color:getComputedStyle(completeBadge).color,opacity:getComputedStyle(completeBadge).opacity,description:card.getAttribute('aria-describedby'),iconHidden:completeBadge.querySelector('svg').getAttribute('aria-hidden')},
          nextBadge:{hidden:nextBadge.hidden,text:nextBadge.innerText.trim(),color:getComputedStyle(nextBadge).color},
          ariaCurrent:card.getAttribute('aria-current'),ariaDescribedBy:card.getAttribute('aria-describedby'),borderColor:getComputedStyle(card).borderTopColor,opacity:getComputedStyle(card).opacity,imageFilter:getComputedStyle(card.querySelector('img')).filter,
          actionX:links.filter(visible).map((link)=>rect(link).x-body.getBoundingClientRect().x-getComputedStyle(body).paddingLeft.replace('px','')),
        };
      });
      const sheet=[...document.styleSheets].find((candidate)=>candidate.href?.endsWith('/home.css'));
      const actionRules=[...(sheet?.cssRules??[])].filter((rule)=>rule.selectorText?.split(',').some((selector)=>selector.trim()==='.onboarding-step-action:visited'));
      const visitedRule=actionRules.some((rule)=>rule.style.color==='var(--accent-deep)'&&rule.style.textDecoration==='none'&&rule.style.backgroundColor==='transparent'&&rule.style.borderStyle==='none');
      const selectors=[...(sheet?.cssRules??[])].map((rule)=>rule.selectorText??'').join(',');
      const explicitStates=['link','visited','hover','focus-visible','active'].every((state)=>selectors.includes('.onboarding-step-action:'+state));
      const focusTarget=guide.querySelector('[data-onboarding-actions]:not([hidden]) a[href="/ai-coach.html"]')??document.getElementById('onboardingHide');
      focusTarget.focus({preventScroll:true});
      const focus={matches:focusTarget.matches(':focus-visible'),outline:getComputedStyle(focusTarget).outlineStyle};
      return{lang,count,progress:document.getElementById('onboardingProgress').textContent,listRole:guide.querySelector('.onboarding-steps').getAttribute('role'),listItemCount:cards.filter((card)=>card.getAttribute('role')==='listitem').length,cards:states,visitedRule,explicitStates,
        hide:{color:getComputedStyle(document.getElementById('onboardingHide')).color,background:getComputedStyle(document.getElementById('onboardingHide')).backgroundColor,fontWeight:getComputedStyle(document.getElementById('onboardingHide')).fontWeight},focus,
        scrollWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth};
    }
    window.__onboardingVisual=()=>{
      for(const lang of ['en','pt']) states.forEach((state,count)=>samples.push(measure(lang,count,state)));
      measure('pt',2,states[2]);
      window.scrollTo(0,0);
      document.body.dataset.visualResult=JSON.stringify({samples});
    };
    try{window.__onboardingVisual();}catch(error){document.body.dataset.visualError=error.stack||String(error);}
  `;
  const documentHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/shared/shell.css"><link rel="stylesheet" href="/home.css"></head><body><main id="appView"><div class="home-page">${guideMarkup}</div></main><script>window.addEventListener('error',event=>{document.body.dataset.visualError=event.message});window.addEventListener('unhandledrejection',event=>{document.body.dataset.visualError=String(event.reason)});</script><script type="module">${browserScript}</script></body></html>`;
  const server = createServer((request, response) => {
    const requestPath = decodeURIComponent((request.url || '/').split('?')[0]);
    const relative = requestPath === '/' ? null : requestPath.replace(/^\/+/, '');
    try {
      const body = relative ? readFileSync(path.join(publicDir, relative)) : documentHtml;
      const type = relative?.endsWith('.css') ? 'text/css' : relative?.endsWith('.js') ? 'text/javascript' : relative?.endsWith('.json') ? 'application/json' : 'text/html';
      response.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const results = [];
  try {
    for (const [width, height] of [[1280, 800], [390, 844]]) {
      results.push(await runChromeAtViewport(chrome, `http://127.0.0.1:${port}/`, {
        width, height, mobile: width < 600, focusSelector: '#onboardingHide', verifyTabNextSelector: 'a[href="/ai-coach.html"]', verifyTabFollowingSelector: 'a[href="/calendar.html"]', screenshotSuffix: '-dashboard',
      }));
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
  for (const browserResult of results) {
    const samples = browserResult.samples;
    assert.equal(samples.length, 8, 'four derived progress states were tested in both locales');
    for (const sample of samples) {
      const expectedProgress = sample.lang === 'pt' ? `${sample.count} de 3 etapas` : `${sample.count} of 3 steps`;
      assert.equal(sample.progress, expectedProgress);
      assert.equal(sample.listRole, 'list');
      assert.equal(sample.listItemCount, 3);
      assert.equal(sample.visitedRule, true, 'dashboard CSS explicitly styles visited onboarding links');
      assert.equal(sample.explicitStates, true, 'link, visited, hover, focus-visible, and active states are explicitly styled');
      assert.ok(sample.cards.every((card) => card.opacity === '1'), 'pending and completed cards do not use disabled-looking opacity');
      const allActions = sample.cards.flatMap((card) => card.links);
      assert.ok(allActions.every((link) => link.classes.includes('onboarding-step-action')), 'every onboarding destination uses the one shared action class');
      assert.ok(allActions.every((link) => !link.classes.includes('onboarding-step-action-primary') && !link.classes.includes('onboarding-step-action-text')), 'filled and text-only action variants are gone');
      assert.deepEqual(allActions.map((link) => link.href), ['/shoes.html','/cycles.html','/ai-coach.html','/calendar.html']);
      assert.ok(allActions.every((link) => link.background === 'rgba(0, 0, 0, 0)' && link.borderStyle === 'none' && link.borderWidth === '0px' && link.shadow === 'none'), 'actions have a transparent, borderless, shadowless resting style');
      assert.ok(allActions.every((link) => link.decoration === 'none'), 'actions never use native link underlining');
      assert.ok(allActions.every((link) => link.iconHidden === 'true' && link.iconFocusable === 'false' && link.iconTabIndex === null), 'the trailing chevrons are decorative and not focusable');
      assert.ok(allActions.every((link) => link.icon.x >= link.label.right - 0.5 && link.icon.y + link.icon.height / 2 >= link.rect.y && link.icon.y + link.icon.height / 2 <= link.rect.bottom), 'each chevron follows its label and is vertically centered');
      assert.ok(allActions.every((link) => link.iconStroke === link.color), 'chevrons follow the action text via currentColor');
      assert.ok(allActions.every((link) => !link.visible || link.rect.height >= 40), 'every available action keeps a comfortable pointer target');
      assert.ok(allActions.every((link) => link.color === 'rgb(76, 110, 81)'), 'all action colors use the Kinesis green token, never native purple or blue');
      assert.ok(sample.cards.every((card) => card.actionX.length === 0 || card.actionX.every((x) => Math.abs(x - card.actionX[0]) < 0.5)), 'each card action stack shares its left edge');
      const alignedActionOffsets = sample.cards.flatMap((card) => card.actionX.slice(0, 1));
      assert.ok(alignedActionOffsets.every((x) => Math.abs(x - alignedActionOffsets[0]) < 0.5), 'all card primary actions share the same left alignment');
      assert.ok(sample.scrollWidth <= sample.viewportWidth, 'dashboard guide has no horizontal overflow');
      assert.notEqual(sample.hide.color, 'rgb(111, 0, 255)', 'hide guide uses the theme, not browser link styling');
      assert.equal(sample.hide.background, 'rgba(0, 0, 0, 0)');
      assert.equal(sample.hide.fontWeight, '500');
      const expectedCompleted = ['shoes', 'cycle', 'trainings'].slice(0, sample.count);
      const expectedNext = ['shoes', 'cycle', 'trainings'][sample.count] ?? null;
      assert.deepEqual(sample.cards.filter((card) => card.done).map((card) => card.key), expectedCompleted);
      assert.deepEqual(sample.cards.filter((card) => card.next).map((card) => card.key), expectedNext ? [expectedNext] : []);
      for (const card of sample.cards) {
        assert.equal(card.completeBadge.hidden, !card.done);
        assert.equal(card.completeBadge.iconHidden, 'true');
        assert.equal(card.completeBadge.opacity, '1');
        if (card.done) {
          assert.ok(Math.abs(card.completeBadge.rect.x - card.card.x - 11.4) < 1.5, 'completion badge sits consistently over the card image');
          assert.ok(Math.abs(card.completeBadge.rect.y - card.card.y - 11.4) < 1.5, 'completion badge is placed consistently at the image start');
        }
        assert.equal(card.completeBadge.text, sample.lang === 'pt' ? 'Concluído' : 'Completed');
        assert.equal(card.completeBadge.description, card.done ? `onboarding${card.key[0].toUpperCase()}${card.key.slice(1)}Complete` : null);
        assert.equal(card.actionAreaHidden, card.done);
        assert.equal(card.links.every((link) => link.rect.height >= 36 || !link.visible), true, 'visible action targets retain a comfortable click area');
        assert.equal(card.ariaDescribedBy, card.done ? card.completeBadge.description : null);
        assert.ok(card.links.every((link) => link.visible !== card.done), 'completed step actions disappear from both pointer and keyboard interaction');
        assert.equal(card.nextBadge.hidden, !card.next);
        assert.equal(card.nextBadge.text, sample.lang === 'pt' ? 'Próximo' : 'Next');
        assert.equal(card.ariaCurrent, card.next ? 'step' : 'false');
        assert.ok(card.links.every((link) => link.decoration === 'none'));
        assert.ok(card.links.every((link) => ['rgb(76, 110, 81)','rgb(253, 251, 246)','rgb(139, 129, 114)'].includes(link.color)), 'onboarding links use theme colors rather than native blue or purple');
        if (card.next) {
          assert.equal(card.borderColor, 'rgb(111, 144, 112)');
          assert.equal(card.nextBadge.color, 'rgb(76, 110, 81)');
        }
      }
      const workoutCard = sample.cards[2];
      assert.equal(workoutCard.links[0].href, '/ai-coach.html');
      assert.equal(workoutCard.links[1].href, '/calendar.html');
      assert.ok(Math.abs(workoutCard.links[0].rect.x - workoutCard.links[1].rect.x) < 0.5, 'AI Coach and spreadsheet actions align on the same left axis');
      assert.equal(workoutCard.links[1].classes.includes('onboarding-step-action-secondary'), true, 'spreadsheet import is a subtle secondary in the shared action family');
      assert.equal(workoutCard.links[1].fontWeight, '500');
      if (sample.viewportWidth >= 760) {
        assert.ok(Math.abs(sample.cards[0].card.height - sample.cards[1].card.height) < 0.5);
        assert.ok(Math.abs(sample.cards[1].card.height - sample.cards[2].card.height) < 0.5, 'cards have equal height within their desktop row');
        const visibleActionBottoms = sample.cards.filter((card) => !card.actionAreaHidden).map((card) => card.actionArea.bottom);
        assert.ok(visibleActionBottoms.length < 2 || Math.max(...visibleActionBottoms) - Math.min(...visibleActionBottoms) < 1, 'visible action areas align along the bottom of the card bodies');
      }
    }
    assert.ok(browserResult.keyboardFocusVisible && browserResult.keyboardFocusOutline !== 'none', 'Chrome shows a visible ring after keyboard navigation reaches an onboarding action');
    assert.equal(browserResult.keyboardNextMatches, true, 'Tab after the hide control skips actions for the two completed steps and reaches AI Coach');
    assert.equal(browserResult.keyboardFollowingMatches, true, 'the following Tab advances from AI Coach to spreadsheet import');
  }
  if (process.env.ONBOARDING_VISUAL_REPORT === '1') {
    results.forEach((result) => console.log(JSON.stringify(result.samples.find((sample) => sample.lang === 'pt' && sample.count === 2))));
  }
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
    import { createWelcomeSession, updateOnboardingDialogA11y, trapOnboardingFocus, visibleOnboardingFocusableElements } from '/shared/onboarding.js';
    const locales = ${JSON.stringify({ en: en.home.onboarding, pt: pt.home.onboarding })};
    const modal = document.getElementById('onboardingWelcome');
    const dialog = modal.querySelector('[role="dialog"]');
    const slides = [...modal.querySelectorAll('[data-onboarding-welcome-slide]')];
    const previous = document.getElementById('onboardingPrevious');
    const next = document.getElementById('onboardingNext');
    const dots = [...modal.querySelectorAll('[data-onboarding-slide-control]')];
    const later = document.getElementById('onboardingLater');
    const session = createWelcomeSession();
    const openedAutomatically = session.ensureAutomatic({ status: 'new' });
    modal.hidden = !openedAutomatically;
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
      if (!openedAutomatically) throw new Error('A new account should automatically open the welcome dialog.');
      for (const lang of ['en','pt']) for (let index=0; index<3; index+=1) measureSlide(index, lang);
      document.body.dataset.visualResult = JSON.stringify({ measurements, openedAutomatically, oneDialog:document.querySelectorAll('[role="dialog"]').length === 1 });
    };
    try { window.__run(); } catch (error) { document.body.dataset.visualError = error.stack || String(error); }
  `;
  const documentHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/home.css"></head><body><main id="appView"></main>${versionedModal}<script>window.addEventListener('error',event=>{document.body.dataset.visualError=event.message});window.addEventListener('unhandledrejection',event=>{document.body.dataset.visualError=String(event.reason)});</script><script type="module">${browserScript}</script></body></html>`;
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
    assert.equal(result.openedAutomatically, true);
    assert.equal(result.oneDialog, true);
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

test('a new account gets the real automatic welcome and Not now persists dismissal in Chrome', async () => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for first-visit welcome validation.');
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });
  try {
    const registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: {
      email: 'welcome-first-visit@example.com', password: 'welcome-secret', first_name: 'New', last_name: 'Runner',
    } });
    assert.equal(registration.statusCode, 201);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {
      email: 'welcome-first-visit@example.com', password: 'welcome-secret',
    } });
    assert.equal(login.statusCode, 200);
    const cookie = [].concat(login.headers['set-cookie'] ?? [])[0].split(';')[0].split('=')[1];
    const cookieHeader = `ta_session=${cookie}`;
    const before = (await app.inject({ method: 'GET', url: '/api/onboarding', headers: { cookie: cookieHeader } })).json().onboarding;
    assert.equal(before.status, 'new');
    const appUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const probeExpression = `new Promise(async(resolve,reject)=>{
      const deadline=Date.now()+15000;
      const wait=async(predicate)=>{while(Date.now()<deadline){if(await predicate())return true;await new Promise(r=>setTimeout(r,60))}throw new Error('First-visit welcome transition timed out')};
      try{
        const modal=document.getElementById('onboardingWelcome');const dialog=modal.querySelector('[role="dialog"]');
        await wait(()=>document.body.classList.contains('shell-mounted')&&!modal.hidden&&document.activeElement.id==='onboardingWelcomeTitle0');
        const opened={visible:!modal.hidden,focused:document.activeElement.id,backgroundInert:[...document.body.children].filter(node=>node!==modal).every(node=>node.inert),dialogCount:document.querySelectorAll('[role="dialog"]').length,previewAbsent:!document.getElementById('onboardingPreview')};
        document.getElementById('onboardingLater').click();
        await wait(async()=>modal.hidden&&(await fetch('/api/onboarding').then(response=>response.json())).onboarding?.status==='active');
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const closed={hidden:modal.hidden,backgroundReleased:[...document.body.children].filter(node=>node!==modal).every(node=>!node.inert),guideVisible:!document.getElementById('onboardingGuide').hidden};
        const saved=(await fetch('/api/onboarding').then(response=>response.json())).onboarding;
        resolve({opened,closed,status:saved.status});
      }catch(error){reject(error)}
    })`;
    const result = await runChromeAtViewport(chrome, appUrl, {
      width: 1280, height: 800, mobile: false, cookie, probeExpression,
    });
    assert.deepEqual(result.opened, { visible: true, focused: 'onboardingWelcomeTitle0', backgroundInert: true, dialogCount: 1, previewAbsent: true });
    assert.deepEqual(result.closed, { hidden: true, backgroundReleased: true, guideVisible: true });
    assert.equal(result.status, 'active', 'Not now persists the presentation preference by transitioning a first-visit account to active');
    const after = (await app.inject({ method: 'GET', url: '/api/onboarding', headers: { cookie: cookieHeader } })).json().onboarding;
    assert.equal(after.status, 'active', 'the persisted state suppresses welcome on return');
    assert.deepEqual(after.steps, before.steps, 'welcome dismissal never marks setup steps complete');
    const reload = await runChromeAtViewport(chrome, appUrl, {
      width: 390, height: 844, mobile: true, cookie,
      probeExpression: `new Promise((resolve,reject)=>{const end=Date.now()+15000;const check=async()=>{const modal=document.getElementById('onboardingWelcome');const state=await fetch('/api/onboarding').then(r=>r.json()).catch(()=>null);if(modal&&state?.onboarding?.status==='active'&&document.body.classList.contains('shell-mounted')){await new Promise(r=>setTimeout(r,100));resolve({hidden:modal.hidden,status:state.onboarding.status,guideVisible:!document.getElementById('onboardingGuide').hidden});return}if(Date.now()>end){reject(new Error('Dismissed welcome reopened after reload'));return}setTimeout(check,60)};check()})`,
    });
    assert.equal(reload.hidden, true);
    assert.equal(reload.status, 'active');
    assert.equal(reload.guideVisible, true);
  } finally {
    await app.close();
    db.close();
  }
});

test('authenticated setup guide menu handles visible, hidden, completed, and existing onboarding in Chrome', async () => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for authenticated setup-guide navigation validation.');
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false, unsplashFetch: async () => { throw new Error('Disable external hero requests in browser verification.'); } });

  async function account({ email, language, status, hidden, steps = {} }) {
    const registered = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email, password: 'setup-guide-secret', first_name: 'Setup', last_name: 'Runner', preferred_lang: language },
    });
    assert.equal(registered.statusCode, 201);
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
    db.prepare('UPDATE users SET onboarding_status = ?, onboarding_guide_hidden = ? WHERE id = ?')
      .run(status, hidden ? 1 : 0, userId);
    const cycleId = `guide-cycle-${userId}`;
    if (steps.shoes) {
      db.prepare('INSERT INTO shoes (id, user_id, brand, model) VALUES (?, ?, ?, ?)')
        .run(`guide-shoe-${userId}`, userId, 'Kinesis', 'Guide shoe');
    }
    if (steps.cycle) {
      db.prepare('INSERT INTO training_cycles (id, user_id, objective, status) VALUES (?, ?, ?, ?)')
        .run(cycleId, userId, 'Guide test cycle', 'active');
    }
    if (steps.trainings) {
      db.prepare('INSERT INTO trainings (user_id, training_cycle_id, dia, tipo, treino) VALUES (?, ?, ?, ?, ?)')
        .run(userId, steps.cycle ? cycleId : null, '2026-09-20', 'Run', 'Guide test workout');
    }
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email, password: 'setup-guide-secret' },
    });
    assert.equal(login.statusCode, 200);
    const cookie = [].concat(login.headers['set-cookie'] ?? [])[0].split(';')[0].split('=')[1];
    return { cookie, userId };
  }

  const visible = await account({ email: 'guide-visible@example.com', language: 'pt-BR', status: 'active', hidden: false });
  const hidden = await account({ email: 'guide-hidden@example.com', language: 'en-US', status: 'active', hidden: true, steps: { shoes: true } });
  const complete = await account({ email: 'guide-complete@example.com', language: 'en-US', status: 'active', hidden: false, steps: { shoes: true, cycle: true, trainings: true } });
  const existing = await account({ email: 'guide-existing@example.com', language: 'en-US', status: 'active', hidden: true, steps: { shoes: true } });
  const firstVisit = await account({ email: 'guide-first-visit@example.com', language: 'en-US', status: 'new', hidden: false });

  const appUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const waitForGuide = (expectedText, expectedProgress, extra = '') => `new Promise((resolve,reject)=>{
    const deadline=Date.now()+15000;
    const check=async()=>{
      const guide=document.getElementById('onboardingGuide');
      const title=document.getElementById('onboardingTitle');
      const item=document.getElementById('userSetupGuide');
      const modal=document.getElementById('onboardingWelcome');
      if(guide&&title&&item&&!document.getElementById('userBadge').hidden&&document.body.classList.contains('shell-mounted')){
        const payload=await fetch('/api/onboarding').then(response=>response.json()).catch(()=>null);
        const ready=payload?.onboarding&&${JSON.stringify(expectedText)}===item.innerText.trim()&&${JSON.stringify(expectedProgress)}===document.getElementById('onboardingProgress').innerText.trim()${extra};
        if(ready){resolve(true);return}
      }
      if(Date.now()>deadline){reject(new Error('Setup guide UI timed out: '+JSON.stringify({url:location.href,guide:guide?.hidden,title:title?.innerText,item:item?.innerText,progress:document.getElementById('onboardingProgress')?.innerText,keyboard:window.__setupGuideKeyboardState,body:document.body.innerText.slice(0,300)})));return}
      setTimeout(check,60);
    };
    check();
  })`;

  try {
    const visibleProbe = `new Promise(async(resolve,reject)=>{
      try{await (${waitForGuide('Guia de configuração','0 de 3 etapas', '&& !guide.hidden && modal.hidden')});
        const guide=document.getElementById('onboardingGuide');const title=document.getElementById('onboardingTitle');const item=document.getElementById('userSetupGuide');
        const home=[...document.querySelector('.home-page').children].filter(node=>!node.hidden&&getComputedStyle(node).display!=='none');
        const rect=(node)=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}};
        resolve({visible:!guide.hidden,focused:title===document.activeElement,progress:document.getElementById('onboardingProgress').innerText.trim(),eyebrow:document.getElementById('onboardingEyebrow').textContent.trim(),setupGuideLabel:item.innerText.trim(),firstVisibleChildren:home.slice(0,2).map(node=>node.className),removed:['onboardingComplete','onboardingReopen','onboardingReopenHidden','onboardingReopenBar'].every(id=>!document.getElementById(id)),previewAbsent:!document.getElementById('onboardingPreview'),cycleTop:rect(document.querySelector('.dashboard-grid > .card-section:first-child')).y,guideRect:rect(guide),welcomeHidden:document.getElementById('onboardingWelcome').hidden,scrollWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth});
      }catch(error){reject(error)}
    })`;
    const visibleResult = await runChromeAtViewport(chrome, appUrl.replace(/\/$/, '') + '/home.html', {
      width: 1280, height: 800, mobile: false, cookie: visible.cookie, probeExpression: visibleProbe, screenshotSuffix: '-setup-visible', verifyUserMenuTabOrder: true,
    });
    assert.equal(visibleResult.visible, true);
    assert.equal(visibleResult.focused, false, 'normal dashboard presentation does not steal focus');
    assert.equal(visibleResult.progress, '0 de 3 etapas');
    assert.equal(visibleResult.setupGuideLabel, 'Guia de configuração');
    assert.equal(visibleResult.eyebrow, 'Próxima etapa', 'incomplete Portuguese guide uses the next-step label');
    assert.deepEqual(visibleResult.userMenuTabOrder, ['userSetupGuide', 'userChangePassword', 'userPreferences']);
    assert.deepEqual(visibleResult.firstVisibleChildren, ['hero', 'onboarding-guide card-section'], 'an incomplete, unhidden checklist remains directly beneath the hero');
    assert.equal(visibleResult.removed, true);
    assert.equal(visibleResult.previewAbsent, true);
    assert.equal(visibleResult.welcomeHidden, true, 'active accounts do not get the first-visit welcome modal');
    assert.ok(visibleResult.scrollWidth <= visibleResult.viewportWidth);

    const hiddenProbe = `new Promise(async(resolve,reject)=>{
      try{await (${waitForGuide('Setup guide','1 of 3 steps', '&& !guide.hidden && modal.hidden')});
        await new Promise(resolve=>setTimeout(resolve,500));
        const before=await fetch('/api/onboarding').then(response=>response.json());const item=document.getElementById('userSetupGuide');
        const guideRect=document.getElementById('onboardingGuide').getBoundingClientRect();const scrollArea=document.querySelector('.main-content').getBoundingClientRect();
        resolve({visible:!document.getElementById('onboardingGuide').hidden,focused:document.activeElement.id,keyboardState:window.__setupGuideKeyboardState,progress:document.getElementById('onboardingProgress').innerText.trim(),eyebrow:document.getElementById('onboardingEyebrow').textContent.trim(),setupGuideLabel:item.innerText.trim(),menuClosed:document.getElementById('userDropdown').classList.contains('hidden'),welcomeHidden:document.getElementById('onboardingWelcome').hidden,guideHidden:before.onboarding.guideHidden,status:before.onboarding.status,completed:[...document.querySelectorAll('[data-onboarding-complete]')].filter(node=>!node.hidden).length,scrollTop:document.querySelector('.main-content').scrollTop,guideTop:guideRect.top,guideBottom:guideRect.bottom,scrollAreaTop:scrollArea.top,scrollAreaBottom:scrollArea.bottom,scrollWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth});
      }catch(error){reject(error)}
    })`;
    const hiddenResult = await runChromeAtViewport(chrome, appUrl.replace(/\/$/, '') + '/home.html', {
      width: 390, height: 844, mobile: true, cookie: hidden.cookie, probeExpression: hiddenProbe, keyboardActivateMenuItem: true, focusSelector: '#onboardingTitle', screenshotSuffix: '-setup-hidden-open',
    });
    assert.equal(hiddenResult.visible, true);
    assert.equal(hiddenResult.focused, 'onboardingTitle', 'keyboard activation moves focus only after revealing the title');
    assert.equal(hiddenResult.progress, '1 of 3 steps');
    assert.equal(hiddenResult.eyebrow, 'Next step', 'incomplete English guide uses the next-step label');
    assert.equal(hiddenResult.setupGuideLabel, 'Setup guide');
    assert.equal(hiddenResult.menuClosed, true);
    assert.equal(hiddenResult.welcomeHidden, true);
    assert.equal(hiddenResult.guideHidden, true, 'opening from the menu does not mutate the saved hidden preference');
    assert.equal(hiddenResult.status, 'active');
    assert.equal(hiddenResult.completed, 1);
    assert.ok(hiddenResult.scrollTop > 0 || (hiddenResult.guideTop >= hiddenResult.scrollAreaTop && hiddenResult.guideBottom <= hiddenResult.scrollAreaBottom), 'the mobile dashboard scrolls the guide into view or leaves it fully visible');
    assert.ok(hiddenResult.scrollWidth <= hiddenResult.viewportWidth);
    assert.equal(hiddenResult.tabActiveElementId, 'onboardingHide', 'Tab from the focused guide title enters the visible checklist controls');

    const firstVisitProbe = `new Promise(async(resolve,reject)=>{
      try{await (${waitForGuide('Setup guide','0 of 3 steps', '&& !guide.hidden && modal.hidden')});
        const before=await fetch('/api/onboarding').then(response=>response.json());
        const after=await fetch('/api/onboarding').then(response=>response.json());
        resolve({visible:!document.getElementById('onboardingGuide').hidden,focused:document.activeElement.id,welcomeHidden:document.getElementById('onboardingWelcome').hidden,statusBefore:before.onboarding.status,statusAfter:after.onboarding.status,unchanged:JSON.stringify(before.onboarding)===JSON.stringify(after.onboarding),url:location.pathname+location.search+location.hash,menuClosed:document.getElementById('userDropdown').classList.contains('hidden')});
      }catch(error){reject(error)}
    })`;
    const firstVisitResult = await runChromeAtViewport(chrome, appUrl.replace(/\/$/, '') + '/shoes.html?keep=new#first', {
      width: 1280, height: 800, mobile: false, cookie: firstVisit.cookie, probeExpression: firstVisitProbe, clickMenuItemAndFollowNavigation: true, focusSelector: '#onboardingTitle', screenshotSuffix: '-setup-new-user',
    });
    assert.equal(firstVisitResult.visible, true);
    assert.equal(firstVisitResult.focused, 'onboardingTitle');
    assert.equal(firstVisitResult.welcomeHidden, true, 'explicit guide navigation does not trigger first-visit welcome');
    assert.equal(firstVisitResult.statusBefore, 'new');
    assert.equal(firstVisitResult.statusAfter, 'new', 'opening the guide does not activate or dismiss the welcome preference');
    assert.equal(firstVisitResult.unchanged, true);
    assert.equal(firstVisitResult.url, '/home.html?keep=new#first');
    assert.equal(firstVisitResult.menuClosed, true);

    const completeProbe = `new Promise(async(resolve,reject)=>{
      const wait=async(predicate)=>{const end=Date.now()+15000;while(Date.now()<end){if(await predicate())return true;await new Promise(r=>setTimeout(r,60))}throw new Error('Onboarding transition timed out')};
      try{
        const guide=document.getElementById('onboardingGuide');const modal=document.getElementById('onboardingWelcome');
        await wait(async()=>document.body.classList.contains('shell-mounted')&&document.getElementById('userSetupGuide')&&modal.hidden);
        await new Promise(r=>setTimeout(r,200));
        const initiallyHidden=guide.hidden;
        const before=await fetch('/api/onboarding').then(response=>response.json());
        const userBefore=await fetch('/api/me').then(response=>response.json());
        document.getElementById('userBadge').click();document.getElementById('userSetupGuide').click();
        await wait(()=>!guide.hidden&&document.activeElement.id==='onboardingTitle');
        const after=await fetch('/api/onboarding').then(response=>response.json());
        const userAfterOpen=await fetch('/api/me').then(response=>response.json());
        const menuClosed=document.getElementById('userDropdown').classList.contains('hidden');
        const completeCount=[...document.querySelectorAll('[data-onboarding-complete]')].filter(node=>!node.hidden).length;
        const allActionsHidden=[...document.querySelectorAll('[data-onboarding-actions]')].every(node=>node.hidden);
        const eyebrow=document.getElementById('onboardingEyebrow');const completeEnglish=eyebrow.textContent.trim();
        document.querySelector('.lang-switch [data-lang="pt-BR"]').click();
        await wait(()=>document.documentElement.lang==='pt-BR'&&eyebrow.textContent.trim()==='Configuração concluída');
        const completePortuguese=eyebrow.textContent.trim();
        document.querySelector('.lang-switch [data-lang="en-US"]').click();
        await wait(()=>document.documentElement.lang==='en-US'&&eyebrow.textContent.trim()==='Setup complete');
        const completeEnglishAfterToggle=eyebrow.textContent.trim();
        document.getElementById('onboardingHide').click();
        await wait(()=>guide.hidden&&document.activeElement.id==='userBadge');
        const afterHide=await fetch('/api/onboarding').then(response=>response.json());
        const userAfter=await fetch('/api/me').then(response=>response.json());
        const home=[...document.querySelector('.home-page').children].filter(node=>!node.hidden&&getComputedStyle(node).display!=='none');
        resolve({initiallyHidden,focus:'onboardingTitle',progress:document.getElementById('onboardingProgress').innerText.trim(),eyebrows:{english:completeEnglish,portuguese:completePortuguese,englishAfterToggle:completeEnglishAfterToggle},completeCount,allActionsHidden,menuClosed,welcomeStayedHidden:modal.hidden,unchangedByOpen:JSON.stringify(before.onboarding)===JSON.stringify(after.onboarding)&&before.onboarding.status===after.onboarding.status,preferencesUnchangedByOpen:userBefore.user.preferred_lang===userAfterOpen.user.preferred_lang&&userBefore.user.distance_unit===userAfterOpen.user.distance_unit&&userBefore.user.temperature_unit===userAfterOpen.user.temperature_unit&&userBefore.user.first_day_of_week===userAfterOpen.user.first_day_of_week,threeComplete:after.onboarding.complete,hiddenAfter:guide.hidden,hideFocus:document.activeElement.id,hiddenPreference:afterHide.onboarding.guideHidden,afterHideStatus:afterHide.onboarding.status,preferences:{langBefore:userBefore.user.preferred_lang,langAfter:userAfter.user.preferred_lang},removed:['onboardingComplete','onboardingReopen','onboardingReopenHidden','onboardingReopenBar'].every(id=>!document.getElementById(id)),previewAbsent:!document.getElementById('onboardingPreview'),firstVisibleChildren:home.slice(0,2).map(node=>node.className),cycleTop:document.querySelector('.dashboard-grid > .card-section:first-child').getBoundingClientRect().top,heroBottom:document.getElementById('heroBanner').getBoundingClientRect().bottom,scrollWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth});
      }catch(error){reject(error)}
    })`;
    const completeResult = await runChromeAtViewport(chrome, appUrl.replace(/\/$/, '') + '/home.html', {
      width: 1280, height: 800, mobile: false, cookie: complete.cookie, probeExpression: completeProbe, focusSelector: '#userBadge', screenshotSuffix: '-setup-complete',
    });
    assert.equal(completeResult.initiallyHidden, true, 'completion removes the guide from the dashboard by default');
    assert.equal(completeResult.progress, '3 of 3 steps');
    assert.deepEqual(completeResult.eyebrows, { english: 'Setup complete', portuguese: 'Configuração concluída', englishAfterToggle: 'Setup complete' });
    assert.equal(completeResult.completeCount, 3);
    assert.equal(completeResult.allActionsHidden, true);
    assert.equal(completeResult.menuClosed, true);
    assert.equal(completeResult.welcomeStayedHidden, true, 'the setup-guide menu never opens the welcome modal');
    assert.equal(completeResult.previewAbsent, true);
    assert.equal(completeResult.unchangedByOpen, true, 'opening the guide does not persist onboarding state');
    assert.equal(completeResult.preferencesUnchangedByOpen, true, 'opening the guide does not persist account preferences');
    assert.equal(completeResult.threeComplete, true);
    assert.equal(completeResult.hiddenAfter, true);
    assert.equal(completeResult.hideFocus, 'userBadge', 'hiding the guide returns focus to the stable account menu trigger');
    assert.equal(completeResult.hiddenPreference, true);
    assert.equal(completeResult.afterHideStatus, 'active');
    assert.deepEqual(completeResult.preferences, { langBefore: 'en-US', langAfter: 'en-US' });
    assert.equal(completeResult.removed, true);
    assert.deepEqual(completeResult.firstVisibleChildren, ['hero', 'dashboard-grid vertical']);
    assert.ok(completeResult.cycleTop >= completeResult.heroBottom);
    assert.ok(completeResult.scrollWidth <= completeResult.viewportWidth);

    const completeReloadProbe = `new Promise((resolve,reject)=>{
      const deadline=Date.now()+15000;const check=async()=>{const guide=document.getElementById('onboardingGuide');const modal=document.getElementById('onboardingWelcome');const state=await fetch('/api/onboarding').then(r=>r.json()).catch(()=>null);if(guide&&modal&&state?.onboarding?.complete&&document.body.classList.contains('shell-mounted')){await new Promise(r=>setTimeout(r,120));resolve({guideHidden:guide.hidden,welcomeHidden:modal.hidden,complete:state.onboarding.complete,signalAbsent:!new URL(location.href).searchParams.has('openSetupGuide'),oldCardsAbsent:['onboardingComplete','onboardingReopen','onboardingReopenHidden','onboardingReopenBar'].every(id=>!document.getElementById(id)),scrollWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth});return}if(Date.now()>deadline){reject(new Error('Completed dashboard refresh timed out')) ;return}setTimeout(check,60)};check()})`;
    const completeReload = await runChromeAtViewport(chrome, appUrl.replace(/\/$/, '') + '/home.html', {
      width: 390, height: 844, mobile: true, cookie: complete.cookie, probeExpression: completeReloadProbe, screenshotSuffix: '-setup-complete-reload',
    });
    assert.equal(completeReload.guideHidden, true);
    assert.equal(completeReload.welcomeHidden, true);
    assert.equal(completeReload.complete, true);
    assert.equal(completeReload.signalAbsent, true);
    assert.equal(completeReload.oldCardsAbsent, true);
    assert.ok(completeReload.scrollWidth <= completeReload.viewportWidth);

    const existingProbe = `new Promise(async(resolve,reject)=>{
      const wait=async(predicate)=>{const end=Date.now()+15000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,60))}throw new Error('Existing-account setup guide transition timed out')};
      try{
        await wait(()=>document.body.classList.contains('shell-mounted')&&document.getElementById('userSetupGuide'));
        const modal=document.getElementById('onboardingWelcome');await new Promise(r=>setTimeout(r,150));
        const before=await fetch('/api/onboarding').then(response=>response.json());
        const welcomeInitiallyHidden=modal.hidden;
        document.getElementById('userBadge').click();document.getElementById('userSetupGuide').click();
        await wait(()=>!document.getElementById('onboardingGuide').hidden&&document.activeElement.id==='onboardingTitle'&&!new URL(location.href).searchParams.has('openSetupGuide'));
        const after=await fetch('/api/onboarding').then(response=>response.json());
        const user=await fetch('/api/me').then(response=>response.json());
        const result={url:location.pathname+location.search+location.hash,visible:!document.getElementById('onboardingGuide').hidden,focused:document.activeElement.id,progress:document.getElementById('onboardingProgress').innerText.trim(),welcomeHidden:modal.hidden,welcomeInitiallyHidden,statusBefore:before.onboarding.status,statusAfter:after.onboarding.status,steps:after.onboarding.steps,guideHiddenBefore:before.onboarding.guideHidden,guideHiddenAfter:after.onboarding.guideHidden,unchanged:JSON.stringify(before.onboarding)===JSON.stringify(after.onboarding),userLanguage:user.user.preferred_lang,menuClosed:document.getElementById('userDropdown').classList.contains('hidden'),removed:['onboardingComplete','onboardingReopen','onboardingReopenHidden','onboardingReopenBar'].every(id=>!document.getElementById(id)),scrollWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth};
        resolve(result);
      }catch(error){reject(error)}
    })`;
    const existingUrl = appUrl.replace(/\/$/, '') + '/shoes.html?keep=one&openSetupGuide=0#shoes';
    const existingResult = await runChromeAtViewport(chrome, existingUrl, {
      width: 1280, height: 800, mobile: false, cookie: existing.cookie, probeExpression: existingProbe, clickMenuItemAndFollowNavigation: true, focusSelector: '#onboardingTitle', screenshotSuffix: '-setup-existing',
    });
    assert.equal(existingResult.url, '/home.html?keep=one#shoes', 'the signal is consumed while retaining other URL state and the hash');
    assert.equal(existingResult.visible, true);
    assert.equal(existingResult.focused, 'onboardingTitle');
    assert.equal(existingResult.progress, '1 of 3 steps');
    assert.equal(existingResult.welcomeInitiallyHidden, true);
    assert.equal(existingResult.welcomeHidden, true);
    assert.equal(existingResult.statusBefore, 'active');
    assert.equal(existingResult.statusAfter, 'active');
    assert.deepEqual(existingResult.steps, { shoes: true, cycle: false, trainings: false });
    assert.equal(existingResult.guideHiddenBefore, true);
    assert.equal(existingResult.guideHiddenAfter, true);
    assert.equal(existingResult.unchanged, true);
    assert.equal(existingResult.userLanguage, 'en-US');
    assert.equal(existingResult.menuClosed, true);
    assert.equal(existingResult.removed, true);
    assert.ok(existingResult.scrollWidth <= existingResult.viewportWidth);

    const reloadProbe = `new Promise((resolve,reject)=>{
      const deadline=Date.now()+15000;const check=async()=>{const guide=document.getElementById('onboardingGuide');const modal=document.getElementById('onboardingWelcome');const item=document.getElementById('userSetupGuide');const status=await fetch('/api/onboarding').then(r=>r.json()).catch(()=>null);if(guide&&modal&&item&&status?.onboarding?.status==='active'&&document.body.classList.contains('shell-mounted')){await new Promise(r=>setTimeout(r,150));resolve({guideHidden:guide.hidden,welcomeHidden:modal.hidden,signalAbsent:!new URL(location.href).searchParams.has('openSetupGuide'),status:status.onboarding.status,oldCardsAbsent:['onboardingComplete','onboardingReopen','onboardingReopenHidden','onboardingReopenBar'].every(id=>!document.getElementById(id))});return}if(Date.now()>deadline){reject(new Error('Existing-account refresh timed out')) ;return}setTimeout(check,60)};check()})`;
    const existingReload = await runChromeAtViewport(chrome, appUrl.replace(/\/$/, '') + '/home.html?keep=one#shoes', {
      width: 390, height: 844, mobile: true, cookie: existing.cookie, probeExpression: reloadProbe, screenshotSuffix: '-setup-existing-reload',
    });
    assert.equal(existingReload.guideHidden, true);
    assert.equal(existingReload.welcomeHidden, true);
    assert.equal(existingReload.signalAbsent, true);
    assert.equal(existingReload.status, 'active');
    assert.equal(existingReload.oldCardsAbsent, true);
  } finally {
    await app.close();
    db.close();
  }
});

test('authenticated training-result guidance and feedback shoes render by canonical source in desktop and mobile Chrome', async () => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for authenticated result-page validation.');
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false, unsplashFetch: async () => { throw new Error('No external hero request in browser tests.'); } });
  try {
    const email = 'result-browser@example.com';
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/register', payload: {
      email, password: 'result-browser-secret', first_name: 'Result', last_name: 'Runner', preferred_lang: 'pt-BR',
    } })).statusCode, 201);
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'result-browser-secret' } });
    const cookie = [].concat(login.headers['set-cookie'] ?? [])[0].split(';')[0].split('=')[1];
    db.prepare(`INSERT INTO shoes (id,user_id,brand,model,status) VALUES
      ('result-active',?,'Kinesis','Active','active'), ('result-retired',?,'Kinesis','Retired','retired')`).run(userId, userId);
    db.prepare("INSERT INTO users (email,password_hash) VALUES ('result-foreign@example.com','hash')").run();
    const foreignId = db.prepare("SELECT id FROM users WHERE email='result-foreign@example.com'").get().id;
    db.prepare("INSERT INTO shoes (id,user_id,brand,model,status) VALUES ('result-foreign-retired',?,'Foreign','Shoe','retired')").run(foreignId);
    for (const source of ['none', 'fit_upload', 'manual']) {
      db.prepare(`INSERT INTO trainings (user_id,dia,tipo,treino,result_data_source,feedback_shoe_id,feedback_shoe,
        fit_duration,fit_distance,fit_avg_pace,fit_summary_json) VALUES (?, '2026-09-20','Run','Browser workout',?,
        'result-retired','Kinesis Retired','30:00',5,'6:00',?)`).run(userId, source,
        source === 'fit_upload' ? JSON.stringify({ totals: { durationSeconds: 1800, distanceKm: 5 }, laps: [] }) : null);
    }
    const appUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const probe = `new Promise(async(resolve,reject)=>{
      const deadline=Date.now()+12000;
      const check=async()=>{
        const select=document.getElementById('feedbackShoe');
        const api=await fetch('/api/trainings/'+new URL(location.href).searchParams.get('id')).then(r=>r.json()).catch(()=>null);
        if(select&&api?.training&&document.body.classList.contains('shell-mounted')){
          await new Promise(r=>setTimeout(r,250));
          const initial={source:api.training.result_data_source,hintPresent:Boolean(document.getElementById('onboardingResultHint')),active:[...select.options].some(o=>o.value==='result-active'),retired:[...select.options].find(o=>o.value==='result-retired')?.textContent,retiredDisabled:[...select.options].find(o=>o.value==='result-retired')?.disabled,foreign:[...select.options].some(o=>o.value==='result-foreign-retired'),scrollWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth};
          resolve(initial);return;
        }
        if(Date.now()>deadline){reject(new Error('Authenticated training result page did not finish loading'));return}
        setTimeout(check,50);
      };
      check();
    })`;
    for (const viewport of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      for (const [index, source] of ['none', 'fit_upload', 'manual'].entries()) {
        await app.inject({ method: 'PATCH', url: '/api/users/me/language', headers: { cookie: `ta_session=${cookie}` }, payload: { preferred_lang: 'pt-BR' } });
        const result = await runChromeAtViewport(chrome, `${appUrl}/training-result.html?id=${index + 1}`, {
          ...viewport, cookie, probeExpression: probe, screenshotSuffix: `-result-${source}`,
        });
        assert.equal(result.source, source);
        assert.equal(result.hintPresent, false, `${source} has no redundant result hint`);
        assert.equal(result.active, true);
        assert.equal(result.retired, 'Kinesis Retired (Aposentado)');
        assert.equal(result.retiredDisabled, true);
        assert.equal(result.foreign, false, 'the endpoint and page are scoped to the signed-in user');
        assert.ok(result.scrollWidth <= result.viewportWidth, `${source} page fits ${viewport.width}px`);
      }
    }

  } finally {
    await app.close();
    db.close();
  }
});

test('authenticated result shoe options retranslate live without refetching or changing selection', async () => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for live feedback-shoe language validation.');
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false, unsplashFetch: async () => { throw new Error('No external hero request in browser tests.'); } });
  let shoeListRequests = 0;
  const languageChangeSnapshots = [];
  app.addHook('onRequest', async (request) => {
    if (request.method === 'GET' && request.url === '/api/shoes') shoeListRequests += 1;
  });
  app.addHook('onResponse', async (request) => {
    if (request.method === 'PATCH' && request.url === '/api/users/me/language') {
      languageChangeSnapshots.push({
        trainings: db.prepare('SELECT id, feedback_shoe_id, feedback_shoe, feedback_notas FROM trainings ORDER BY id').all(),
        shoes: db.prepare("SELECT id,mileage FROM shoes WHERE id LIKE 'shoe-language-%' ORDER BY id").all(),
      });
    }
  });
  try {
    const email = 'shoe-language-browser@example.com';
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/register', payload: {
      email, password: 'shoe-language-secret', first_name: 'Shoe', last_name: 'Runner', preferred_lang: 'en-US',
    } })).statusCode, 201);
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'shoe-language-secret' } });
    const cookie = [].concat(login.headers['set-cookie'] ?? [])[0].split(';')[0].split('=')[1];
    db.prepare(`INSERT INTO shoes (id,user_id,brand,model,status,mileage) VALUES
      ('shoe-language-active',?,'Kinesis','Active','active',20),
      ('shoe-language-retired-current',?,'Kinesis','Retired Current','retired',42),
      ('shoe-language-retired-other',?,'Kinesis','Retired Other','retired',18)`).run(userId, userId, userId);
    const retiredId = db.prepare(`INSERT INTO trainings (user_id,dia,tipo,treino,result_data_source,completed,fit_distance,
      feedback_shoe_id,feedback_shoe) VALUES (?, '2026-09-20','Run','Retired association','none',1,5,
      'shoe-language-retired-current','Kinesis Retired Current')`).run(userId).lastInsertRowid;
    const activeId = db.prepare(`INSERT INTO trainings (user_id,dia,tipo,treino,result_data_source,completed,fit_distance)
      VALUES (?, '2026-09-20','Run','New active selection','none',1,5)`).run(userId).lastInsertRowid;
    const legacyId = db.prepare(`INSERT INTO trainings (user_id,dia,tipo,treino,result_data_source,feedback_shoe)
      VALUES (?, '2026-09-20','Run','Legacy shoe label','none','Historical shoe label')`).run(userId).lastInsertRowid;
    const appUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const probe = (id, mode) => `new Promise(async(resolve,reject)=>{
      const wait=async(predicate,label='UI')=>{const end=Date.now()+12000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,50))}throw new Error('Shoe language '+label+' timed out: '+JSON.stringify({ready:document.body.classList.contains('shell-mounted'),lang:document.documentElement.lang,select:!!document.getElementById('feedbackShoe'),options:document.getElementById('feedbackShoe')?.options.length,errors:document.body.innerText.slice(0,400)}))};
      try{
        await wait(()=>document.body.classList.contains('shell-mounted')&&document.getElementById('feedbackShoe')?.options.length>1,'options');
        const select=document.getElementById('feedbackShoe');
        const retired=()=>[...select.options].find(option=>option.value==='shoe-language-retired-current');
        const before={value:select.value,retiredText:retired()?.textContent.trim()??null,retiredDisabled:retired()?.disabled??null,
          otherRetiredPresent:[...select.options].some(option=>option.value==='shoe-language-retired-other'),
          legacyLabel:[...select.options].find(option=>option.dataset.legacyLabel==='true')?.textContent.trim()??null,
          legacySelected:select.selectedOptions[0]?.dataset.legacyLabel==='true',
          placeholder:select.options[0]?.textContent.trim()};
        if('${mode}'==='active'){
          select.value='shoe-language-active';select.dispatchEvent(new Event('change',{bubbles:true}));
        }
        const selectedBefore=select.value;
        const savedBefore=await fetch('/api/trainings/${id}').then(r=>r.json());
        document.querySelector('.lang-switch [data-lang="pt-BR"]').click();
        await wait(()=>document.documentElement.lang==='pt-BR','Portuguese switch');
        const portuguese=retired()?.textContent.trim()??null;
        const valueInPortuguese=select.value;
        document.querySelector('.lang-switch [data-lang="en-US"]').click();
        await wait(()=>document.documentElement.lang==='en-US','English switch back');
        const englishAgain=retired()?.textContent.trim()??null;
        const selectionAfter=select.value;
        const activeElementAfterLanguage=document.activeElement?.id;
        const savedAfter=await fetch('/api/trainings/${id}').then(r=>r.json());
        const feedbackPayload='${mode}'==='active' ? {feedback_shoe_id:select.value} : {feedback_notas:'preserve existing retired association'};
        const saveResponse=await fetch('/api/trainings/${id}',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(feedbackPayload)});
        const saved=await saveResponse.json();
        if(!saveResponse.ok)throw new Error('Saving after language switch failed: '+JSON.stringify(saved));
        select.focus();
        const focused=document.activeElement===select;
        resolve({lang:document.documentElement.lang,before,selectedBefore,portuguese,valueInPortuguese,englishAgain,selectionAfter,
          activeElementAfterLanguage,focused,savedBefore:savedBefore.training,savedAfterLanguages:savedAfter.training,
          saved:saved.training,disabledRetired:retired()?.disabled??null,placeholder:select.options[0]?.textContent.trim(),
          legacySelected:select.selectedOptions[0]?.dataset.legacyLabel==='true',scrollWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth});
      }catch(error){reject(error)}
    })`;
    const cases = [
      { id: retiredId, mode: 'retired', width: 1280, height: 800 },
      { id: activeId, mode: 'active', width: 390, height: 844 },
      { id: legacyId, mode: 'active', width: 1280, height: 800 },
    ];
    for (const scenario of cases) {
      const shoeMileageBefore = db.prepare("SELECT id,mileage FROM shoes WHERE id LIKE 'shoe-language-%' ORDER BY id").all();
      const feedbackBefore = db.prepare('SELECT id,feedback_shoe_id,feedback_shoe,feedback_notas FROM trainings WHERE id=?').get(scenario.id);
      const requestCountBefore = shoeListRequests;
      const languageSnapshotCountBefore = languageChangeSnapshots.length;
      const result = await runChromeAtViewport(chrome, `${appUrl}/training-result.html?id=${scenario.id}`, {
        width: scenario.width, height: scenario.height, mobile: scenario.width < 600, cookie,
        probeExpression: probe(scenario.id, scenario.mode), verifyTabNextSelector: '#feedbackWeather',
        screenshotSuffix: `-shoe-language-${scenario.mode}-${scenario.width}`,
      });
      assert.equal(result.lang, 'en-US');
      assert.equal(result.before.placeholder, '–');
      const expectedRetiredLabel = scenario.mode === 'retired';
      assert.equal(result.portuguese, expectedRetiredLabel ? 'Kinesis Retired Current (Aposentado)' : null);
      assert.equal(result.englishAgain, expectedRetiredLabel ? 'Kinesis Retired Current (Retired)' : null);
      assert.equal(result.disabledRetired, expectedRetiredLabel ? true : null);
      assert.equal(result.before.otherRetiredPresent, false);
      assert.equal(result.focused, true);
      assert.equal(result.keyboardNextMatches, true, `the focused shoe select keeps its normal next Tab target (${result.tabActiveElementId})`);
      const expectedSelection = scenario.mode === 'retired' ? 'shoe-language-retired-current' : 'shoe-language-active';
      assert.equal(result.selectedBefore, expectedSelection);
      assert.equal(result.valueInPortuguese, expectedSelection);
      assert.equal(result.selectionAfter, expectedSelection, 'language changes preserve the current choice');
      assert.ok(result.scrollWidth <= result.viewportWidth);
      assert.deepEqual(result.savedAfterLanguages, result.savedBefore,
        'changing language does not change persisted training feedback');
      const languageSnapshots = languageChangeSnapshots.slice(languageSnapshotCountBefore);
      assert.equal(languageSnapshots.length, 2, 'both live language changes completed their preference request');
      for (const snapshot of languageSnapshots) {
        assert.deepEqual(snapshot.shoes, shoeMileageBefore, 'changing language does not change shoe mileage');
        assert.deepEqual(snapshot.trainings.find((training) => training.id === scenario.id), feedbackBefore,
          'changing language does not change this training feedback');
      }
      assert.equal(shoeListRequests - requestCountBefore, 1, 'one initial list request and no refetches on language changes');
      assert.equal(result.saved.feedback_shoe_id, scenario.mode === 'retired' ? 'shoe-language-retired-current' : 'shoe-language-active');
      if (scenario.id === legacyId) {
        assert.equal(result.before.legacyLabel, 'Historical shoe label');
        assert.equal(result.before.legacySelected, true, 'the legacy label remains selected before a replacement is chosen');
        assert.equal(result.legacySelected, false, 'the explicit active selection replaces the non-owned legacy label');
      }
    }
  } finally {
    try { await app.close(); } catch {}
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

test('authenticated workout creation guide is independent, localized, and non-mutating', async () => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for workout creation guide validation.');
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false, unsplashFetch: async () => { throw new Error('No external hero request in browser tests.'); } });
  try {
    const email = 'creation-guide-browser@example.com';
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'creation-guide-secret', first_name: 'Guide', last_name: 'Runner', preferred_lang: 'en-US' } });
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'creation-guide-secret' } });
    const cookie = [].concat(login.headers['set-cookie'] ?? [])[0].split(';')[0].split('=')[1];
    const trainingId = db.prepare("INSERT INTO trainings (user_id,dia,tipo,treino,result_data_source) VALUES (?, '2026-09-20','Run','Creation guide','none')").run(userId).lastInsertRowid;
    const appUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const probe = `new Promise(async(resolve,reject)=>{try{
      const wait=async(predicate)=>{const end=Date.now()+12000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,50))}throw new Error('creation guide did not become ready')};
      await wait(()=>document.body.classList.contains('shell-mounted')&&document.getElementById('workoutCreationBtn'));
      if(new URL(location.href).searchParams.get('collapsed')==='1'){
        document.getElementById('sidebarToggle').click();
        await wait(()=>document.querySelector('.app-shell')?.classList.contains('collapsed'));
      }
      const before=await fetch('/api/trainings/${trainingId}').then(r=>r.json());
      const trigger=document.getElementById('workoutCreationBtn'); trigger.focus(); trigger.click();
      await wait(()=>document.getElementById('workoutCreationDialog')?.hidden===false);
      const dialog=document.getElementById('workoutCreationDialog');
      const header=document.querySelector('.session-header');
      const plannedCard=document.querySelector('.planned-card');
      const cardRect=plannedCard.getBoundingClientRect();
      const titleRect=plannedCard.querySelector('h2').getBoundingClientRect();
      const actionsRect=document.querySelector('.planned-card .session-actions').getBoundingClientRect();
      const helpRect=trigger.getBoundingClientRect();
      const deleteRect=document.getElementById('deleteTrainingBtn').getBoundingClientRect();
      const initial={hidden:dialog.hidden,focus:document.activeElement?.getAttribute('data-workout-create-close'),platforms:dialog.querySelectorAll('[data-workout-create-platform]').length,garmin:document.querySelector('[data-workout-create-title]').textContent,importHidden:document.getElementById('importHelpDialog').hidden,overflow:document.documentElement.scrollWidth<=innerWidth,sidebarCollapsed:document.querySelector('.app-shell')?.classList.contains('collapsed'),headerContainsActions:header.contains(trigger)||header.contains(document.getElementById('deleteTrainingBtn')),cardContainsActions:plannedCard.contains(trigger)&&plannedCard.contains(document.getElementById('deleteTrainingBtn')),cardRect:{left:cardRect.left,right:cardRect.right,top:cardRect.top,bottom:cardRect.bottom},titleRect:{left:titleRect.left,right:titleRect.right,top:titleRect.top,bottom:titleRect.bottom},actionsRect:{left:actionsRect.left,right:actionsRect.right,top:actionsRect.top,bottom:actionsRect.bottom},headerRect:{left:header.getBoundingClientRect().left,right:header.getBoundingClientRect().right},helpRect:{left:helpRect.left,right:helpRect.right,top:helpRect.top,bottom:helpRect.bottom},deleteRect:{left:deleteRect.left,right:deleteRect.right,top:deleteRect.top,bottom:deleteRect.bottom},ordered:helpRect.right<=deleteRect.left,stacked:actionsRect.top>=titleRect.bottom};
      dialog.querySelector('[data-workout-create-platform="xiaomi"]').click();
      const xiaomi={status:dialog.querySelector('[data-workout-create-status]').textContent, fallback:dialog.querySelector('[data-workout-create-steps]').textContent};
      document.querySelector('.lang-switch [data-lang="pt-BR"]')?.click();
      await new Promise(r=>setTimeout(r,120));
      const portuguese={title:dialog.querySelector('[data-workout-create-title]').textContent, fallback:dialog.querySelector('[data-workout-create-steps]').textContent,selected:dialog.querySelector('[data-workout-create-platform="xiaomi"]').getAttribute('aria-pressed'),overflow:document.documentElement.scrollWidth<=innerWidth};
      document.querySelector('[data-workout-create-close]').click();
      const after=await fetch('/api/trainings/${trainingId}').then(r=>r.json());
      resolve({initial,xiaomi,portuguese,restored:document.activeElement===trigger,unchanged:JSON.stringify(before.training)===JSON.stringify(after.training)});
    }catch(error){reject(error)}})`;
    const viewports = [390, 560, 600, 640, 641, 650, 700, 768, 800, 1280].map((width) => ({ width, height: width === 390 ? 844 : 800, mobile: width < 600 }));
    for (const viewport of viewports) {
      const result = await runChromeAtViewport(chrome, `${appUrl}/training-result.html?id=${trainingId}`, { ...viewport, cookie, probeExpression: probe, screenshotSuffix: `-creation-guide-${viewport.width}` });
      assert.equal(result.initial.hidden, false);
      assert.equal(result.initial.focus, '');
      assert.equal(result.initial.platforms, 8);
      assert.match(result.initial.garmin, /Garmin/);
      assert.equal(result.initial.importHidden, true);
      assert.equal(result.initial.overflow, true);
      assert.equal(result.initial.sidebarCollapsed, false);
      assert.equal(result.initial.headerContainsActions, false);
      assert.equal(result.initial.cardContainsActions, true);
      assert.ok(result.initial.cardRect.left <= result.initial.titleRect.left && result.initial.titleRect.right <= result.initial.cardRect.right);
      assert.ok(result.initial.cardRect.left <= result.initial.actionsRect.left && result.initial.actionsRect.right <= result.initial.cardRect.right);
      assert.ok(result.initial.titleRect.bottom <= result.initial.actionsRect.top || result.initial.actionsRect.bottom <= result.initial.titleRect.top || result.initial.titleRect.right <= result.initial.actionsRect.left || result.initial.actionsRect.right <= result.initial.titleRect.left, 'title and actions do not overlap');
      assert.ok(result.initial.helpRect.right <= result.initial.deleteRect.left, 'help action precedes delete action without overlap');
      assert.ok(result.initial.helpRect.right > result.initial.helpRect.left);
      assert.ok(result.initial.deleteRect.right > result.initial.deleteRect.left);
      assert.ok(result.initial.helpRect.bottom > result.initial.helpRect.top);
      assert.match(result.xiaomi.status, /Model|modelo/i);
      assert.match(result.portuguese.fallback, /Não foi possível/);
      assert.equal(result.portuguese.selected, 'true');
      assert.equal(result.portuguese.overflow, true);
      assert.equal(result.restored, true);
      assert.equal(result.unchanged, true);
    }
    const collapsed = await runChromeAtViewport(chrome, `${appUrl}/training-result.html?id=${trainingId}&collapsed=1`, { width: 641, height: 800, mobile: false, cookie, probeExpression: probe, screenshotSuffix: '-creation-guide-collapsed' });
    assert.equal(collapsed.initial.sidebarCollapsed, true);
    assert.equal(collapsed.initial.overflow, true);
    assert.equal(collapsed.initial.cardContainsActions, true);
    assert.ok(collapsed.initial.cardRect.left <= collapsed.initial.actionsRect.left && collapsed.initial.actionsRect.right <= collapsed.initial.cardRect.right);
  } finally {
    await app.close();
    db.close();
  }
});

test('workout creation guide localizes while training data is still loading', async () => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for delayed initialization validation.');
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false, unsplashFetch: async () => { throw new Error('No external hero request in browser tests.'); } });
  let delayedTrainingId = null;
  let delayedTrainingRequest = true;
  app.addHook('onRequest', async (request) => {
    if (delayedTrainingRequest && delayedTrainingId !== null && request.method === 'GET' && request.url === `/api/trainings/${delayedTrainingId}`) {
      delayedTrainingRequest = false;
      await delay(2500);
    }
  });
  try {
    const email = 'creation-guide-delayed@example.com';
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'creation-guide-delayed-secret', first_name: 'Delayed', last_name: 'Runner', preferred_lang: 'en-US' } });
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'creation-guide-delayed-secret' } });
    const cookie = [].concat(login.headers['set-cookie'] ?? [])[0].split(';')[0].split('=')[1];
    const trainingId = db.prepare("INSERT INTO trainings (user_id,dia,tipo,treino,result_data_source) VALUES (?, '2026-09-20','Run','Delayed creation guide','none')").run(userId).lastInsertRowid;
    delayedTrainingId = trainingId;
    const appUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const probe = `new Promise(async(resolve,reject)=>{try{
      const wait=async(predicate,label)=>{const end=Date.now()+12000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,40))}throw new Error(label||'delayed creation guide did not become ready')};
      await wait(()=>document.body.classList.contains('shell-mounted')&&document.getElementById('workoutCreationBtn'),'shell and trigger');
      const errors=[]; window.addEventListener('error',event=>errors.push(event.message)); window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
      const trigger=document.getElementById('workoutCreationBtn'); trigger.focus(); trigger.click();
      await wait(()=>document.getElementById('workoutCreationDialog')?.hidden===false,'guide open');
      const dialog=document.getElementById('workoutCreationDialog');
      dialog.querySelector('[data-workout-create-platform="xiaomi"]').click();
      const selectedBefore=dialog.querySelector('[data-workout-create-platform="xiaomi"]').getAttribute('aria-pressed');
      document.querySelector('.lang-switch [data-lang="pt-BR"]').click();
      await wait(()=>document.documentElement.lang==='pt-BR','Portuguese switch');
      const during={title:dialog.querySelector('[data-workout-create-title]').textContent,description:dialog.querySelector('[data-workout-create-description]').textContent,status:dialog.querySelector('[data-workout-create-status]').textContent,steps:dialog.querySelector('[data-workout-create-steps]').textContent,note:dialog.querySelector('[data-workout-create-note]').textContent,link:dialog.querySelector('[data-workout-create-source]').textContent,platformsLabel:dialog.querySelector('[data-workout-create-platforms]').getAttribute('aria-label'),selected:dialog.querySelector('[data-workout-create-platform="xiaomi"]').getAttribute('aria-pressed'),open:!dialog.hidden};
      await new Promise(r=>setTimeout(r,2800));
      await wait(()=>document.getElementById('status')?.textContent==='','training load');
      const afterLoad={title:dialog.querySelector('[data-workout-create-title]').textContent,selected:dialog.querySelector('[data-workout-create-platform="xiaomi"]').getAttribute('aria-pressed'),open:!dialog.hidden};
      document.querySelector('.lang-switch [data-lang="en-US"]').click();
      await wait(()=>document.documentElement.lang==='en-US','English switch back');
      const final={title:dialog.querySelector('[data-workout-create-title]').textContent,description:dialog.querySelector('[data-workout-create-description]').textContent,selected:dialog.querySelector('[data-workout-create-platform="xiaomi"]').getAttribute('aria-pressed'),open:!dialog.hidden};
      dialog.querySelector('[data-workout-create-close]').click();
      resolve({during,afterLoad,final,selectedBefore,restored:document.activeElement===trigger,errors});
    }catch(error){reject(error)}})`;
    const result = await runChromeAtViewport(chrome, `${appUrl}/training-result.html?id=${trainingId}`, {
      width: 1280, height: 800, mobile: false, cookie, probeExpression: probe, screenshotSuffix: '-creation-guide-delayed',
    });
    assert.equal(result.selectedBefore, 'true');
    assert.match(result.during.title, /Xiaomi|Mi Fitness/);
    assert.match(result.during.description, /^Siga as instruções da sua plataforma/);
    assert.match(result.during.status, /Depende do modelo/);
    assert.match(result.during.steps, /Não foi possível confirmar/);
    assert.match(result.during.note, /informações oficiais/);
    assert.match(result.during.link, /Saiba mais/);
    assert.equal(result.during.platformsLabel, 'Plataformas de treino');
    assert.equal(result.during.selected, 'true');
    assert.equal(result.during.open, true);
    assert.deepEqual(result.afterLoad, { title: 'Xiaomi / Mi Fitness', selected: 'true', open: true });
    assert.match(result.final.title, /Xiaomi|Mi Fitness/);
    assert.match(result.final.description, /^Follow the instructions for your platform/);
    assert.equal(result.final.selected, 'true');
    assert.equal(result.final.open, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.restored, true);
  } finally {
    try { await app.close(); } catch {}
    db.close();
  }
});

test('creation and import platform guides keep a visible keyboard focus ring', async () => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for platform focus validation.');
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false, unsplashFetch: async () => { throw new Error('No external hero request in browser tests.'); } });
  try {
    const email = 'platform-focus-browser@example.com';
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'platform-focus-secret', first_name: 'Focus', last_name: 'Runner', preferred_lang: 'en-US' } });
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'platform-focus-secret' } });
    const cookie = [].concat(login.headers['set-cookie'] ?? [])[0].split(';')[0].split('=')[1];
    const trainingId = db.prepare("INSERT INTO trainings (user_id,dia,tipo,treino,result_data_source) VALUES (?, '2026-09-20','Run','Platform focus','none')").run(userId).lastInsertRowid;
    const appUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    for (const viewport of [
      { width: 1280, height: 800, mobile: false, language: null },
      { width: 390, height: 844, mobile: true, language: 'pt-BR' },
    ]) {
      const result = await runChromeAtViewport(chrome, `${appUrl}/training-result.html?id=${trainingId}`, {
        ...viewport,
        cookie,
        keyboardFocusValidation: true,
        keyboardFocusLanguage: viewport.language,
        probeExpression: 'window.__keyboardFocusValidation',
        screenshotSuffix: `-platform-focus-${viewport.width}`,
      });
      for (const guide of ['creation', 'import']) {
        assert.equal(result[guide].focused.length, guide === 'creation' ? 8 : 7);
        assert.equal(result[guide].focused[0].pressed, 'true', `${guide} starts with the selected platform focused: ${JSON.stringify(result[guide].focused[0])}`);
        assert.ok(result[guide].focused.some((entry) => entry.pressed === 'false'), `${guide} visits an unselected platform`);
        for (const entry of result[guide].focused) {
          assert.notEqual(entry.outlineStyle, 'none', `${guide} focus is visibly outlined for ${entry.id}`);
          assert.ok(Number.parseFloat(entry.outlineWidth) >= 2, `${guide} focus outline is at least 2px for ${entry.id}`);
          assert.ok(Number.parseFloat(entry.outlineOffset) >= 2, `${guide} focus outline has an offset for ${entry.id}`);
          assert.notEqual(entry.outlineColor, 'rgba(0, 0, 0, 0)', `${guide} focus outline has a visible color for ${entry.id}`);
          assert.ok(entry.rect.right >= entry.rect.left && entry.rect.bottom >= entry.rect.top);
        }
        assert.equal(result[guide].closed.hidden, true);
        assert.equal(result[guide].closed.restored, true);
        assert.equal(result[guide].closed.selected, 1);
        assert.equal(result[guide].closed.overflow, true);
      }
    }
  } finally {
    try { await app.close(); } catch {}
    db.close();
  }
});
