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
      await command('Runtime.evaluate', {
        expression: `new Promise((resolve,reject)=>{const end=Date.now()+12000;const attempt=()=>{const trigger=document.getElementById('feedbackAccordionTrigger');const panel=document.getElementById('feedbackAccordionPanel');if(trigger&&panel&&!panel.hidden){resolve(true);return}if(trigger&&panel)trigger.click();if(Date.now()>end){reject(new Error('Feedback accordion did not open for platform focus validation'));return}setTimeout(attempt,40)};attempt()})`,
        awaitPromise: true,
        returnByValue: true,
      });
      const keyboardFocusState = {};
      const validatePlatformList = async ({ name, trigger, dialog, item, count, activateIndex = 1 }) => {
        await command('Runtime.evaluate', {
          expression: `new Promise((resolve,reject)=>{const end=Date.now()+12000;const attempt=()=>{const trigger=document.querySelector(${JSON.stringify(trigger)});const dialog=document.querySelector(${JSON.stringify(dialog)});const close=dialog?.querySelector(${JSON.stringify(`[data-${name === 'creation' ? 'workout-create-close' : 'import-help-close'}`)});if(trigger&&dialog&&close){trigger.focus();trigger.click();if(!dialog.hidden){close.focus();if(document.activeElement===close){resolve(true);return}}}if(Date.now()>end){reject(new Error(${JSON.stringify(`${name} guide did not open with focusable close control`)}));return}setTimeout(attempt,40)};attempt()})`,
          awaitPromise: true,
          returnByValue: true,
        });
        const isolation = await command('Runtime.evaluate', {
          expression: `(()=>{const dialog=document.querySelector(${JSON.stringify(dialog)});const background=document.getElementById('appView')?.closest('body > *');const outside=document.getElementById('deleteTrainingBtn');document.activeElement?.blur();outside?.focus();outside?.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));const outsideFocusContained=dialog.contains(document.activeElement);document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));const tabInside=dialog.contains(document.activeElement);document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));const shiftTabInside=dialog.contains(document.activeElement);document.activeElement?.blur();return {backgroundInert:Boolean(background?.hasAttribute('inert')),outsideFocusContained,tabInside,shiftTabInside,focusOutsideAfterBlur:!dialog.contains(document.activeElement)}})()`,
          returnByValue: true,
        });
        await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        const escapedFromOutside = await command('Runtime.evaluate', {
          expression: `(()=>{const dialog=document.querySelector(${JSON.stringify(dialog)});const trigger=document.querySelector(${JSON.stringify(trigger)});const background=document.getElementById('appView')?.closest('body > *');return {closed:dialog.hidden,restored:document.activeElement===trigger,backgroundReleased:Boolean(!background?.hasAttribute('inert'))}})()`,
          returnByValue: true,
        });
        await command('Runtime.evaluate', {
          expression: `(()=>{const trigger=document.querySelector(${JSON.stringify(trigger)});trigger.focus();trigger.click();return !document.querySelector(${JSON.stringify(dialog)})?.hidden})()`,
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
          expression: `(()=>{const dialog=document.querySelector(${JSON.stringify(dialog)});const trigger=document.querySelector(${JSON.stringify(trigger)});const background=document.getElementById('appView')?.closest('body > *');trigger.focus();trigger.click();const reopened=!dialog.hidden;const inertWhileReopened=Boolean(background?.hasAttribute('inert'));dialog.querySelector('[data-${name === 'creation' ? 'workout-create-close' : 'import-help-close'}]')?.click();trigger.focus();trigger.click();const backdropOpened=!dialog.hidden;dialog.click();const backdropClosed=dialog.hidden;return {hidden:dialog.hidden,restored:document.activeElement===trigger,reopened,inertWhileReopened,backdropOpened,backdropClosed,backgroundReleased:Boolean(!background?.hasAttribute('inert')),selected:document.querySelectorAll(${JSON.stringify(`${dialog} ${item}[aria-pressed="true"]`)}).length,overflow:document.documentElement.scrollWidth<=innerWidth}})()`,
          returnByValue: true,
        });
        keyboardFocusState[name] = { focused, isolation: isolation.result?.value, escapedFromOutside: escapedFromOutside.result?.value, closed: closed.result?.value };
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
      for (let index = 0; index < 4; index += 1) {
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
        : `(()=>({tabActiveElementId:document.activeElement?.id}))()`,
      returnByValue: true,
    });
    if (focusEvaluation.result?.value) {
      value.keyboardFocusOutline = focusEvaluation.result.value.actionOutline;
      value.keyboardFocusVisible = focusEvaluation.result.value.actionVisible;
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
    rmSync(profileDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const onboardingModule = () => import(pathToFileURL(path.join(__dirname, '../src/public/shared/onboarding.js')));
const tourMediaModule = () => import(pathToFileURL(path.join(__dirname, '../src/public/shared/onboarding-tour-media.js')));
const publicPath = (...parts) => path.join(__dirname, '../src/public', ...parts);

test('onboarding progress exposes three data-derived steps', async () => {
  const module = await onboardingModule();
  assert.deepEqual(module.calculateOnboardingProgress({ shoes: true, cycle: false, trainings: false }), {
    steps: { shoes: true, cycle: false, trainings: false }, completed: 1, total: 3, complete: false, nextStep: 'cycle',
  });
  assert.equal(module.calculateOnboardingProgress({ steps: { shoes: true, cycle: true, trainings: true } }).complete, true);
  assert.equal(module.shouldShowWelcome({ status: 'new' }), true);
  assert.equal(module.shouldShowWelcome({ status: 'active' }), false);
  assert.equal(module.shouldShowWelcome({ status: 'unknown' }), false);
});

test('the tour call to action follows backend progress and needs an active cycle for workouts', async () => {
  const { onboardingNextAction } = await onboardingModule();
  const steps = (shoes, cycle, trainings) => ({ steps: { shoes, cycle, trainings } });
  assert.deepEqual(onboardingNextAction(steps(false, false, false), false), { href: '/shoes.html', key: 'home.onboarding.shoesAction' });
  assert.deepEqual(onboardingNextAction(steps(true, false, false), false), { href: '/cycles.html', key: 'home.onboarding.cycleAction' });
  assert.deepEqual(onboardingNextAction(steps(true, true, false), true), { href: '/ai-coach.html', key: 'home.onboarding.planAction' });
  assert.deepEqual(onboardingNextAction(steps(true, true, false), false), { href: '/cycles.html', key: 'home.onboarding.cycleAction' },
    'without a loaded active cycle the workouts step points to cycle management');
  assert.equal(onboardingNextAction(steps(true, true, true), true), null, 'a complete setup offers no step action');
  assert.deepEqual(onboardingNextAction(null, false), { href: '/shoes.html', key: 'home.onboarding.shoesAction' });
});

test('tour session opens for new accounts, honours explicit requests, and never reopens after closing', async () => {
  const { createTourSession } = await onboardingModule();
  const fresh = { status: 'new' };
  const session = createTourSession();
  assert.equal(session.shouldOpen(fresh), true, 'a new account receives the automatic tour');
  assert.equal(session.shouldOpen({ status: 'active' }), false, 'existing accounts never receive it automatically');
  session.close();
  assert.equal(session.shouldOpen(fresh), false, 'closing suppresses the automatic tour for this visit');
  session.requestExplicit();
  assert.equal(session.explicit, true);
  assert.equal(session.shouldOpen({ status: 'active' }), true, 'the menu opens the tour for any account');
  session.close();
  assert.equal(session.explicit, false);
  assert.equal(session.shouldOpen({ status: 'active' }), false);
  const explicitFirst = createTourSession();
  explicitFirst.requestExplicit();
  explicitFirst.close();
  assert.equal(explicitFirst.shouldOpen(fresh), false, 'closing an explicit tour never reopens it as the automatic welcome');
  assert.equal(createTourSession().shouldOpen(fresh), true, 'the in-memory state does not persist across page visits');
});

test('switching tour language keeps the same scene and relative position', async () => {
  const { mapTourTime } = await onboardingModule();
  const from = [{ start: 0, end: 4 }, { start: 4, end: 10 }, { start: 10, end: 12 }];
  const to = [{ start: 0, end: 5 }, { start: 5, end: 8 }, { start: 8, end: 14 }];
  assert.equal(mapTourTime(from, to, 0), 0);
  assert.equal(mapTourTime(from, to, 2), 2.5, 'half of the first scene maps to half of the first scene');
  assert.equal(mapTourTime(from, to, 7), 6.5, 'half of the second scene maps to half of the second scene');
  assert.equal(mapTourTime(from, to, 99), 14, 'a position beyond the end clamps to the end of the last scene');
  assert.equal(mapTourTime(from, to, Number.NaN), 0);
  assert.equal(mapTourTime(from, to, -3), 0);
  assert.equal(mapTourTime(from, [], 3), 0);
  assert.equal(mapTourTime(null, to, 3), 0);
  assert.equal(mapTourTime([{ start: 2, end: 2 }], to, 2), 0, 'a zero-length scene maps to the target scene start');
  assert.equal(mapTourTime(from, [{ start: 0, end: 6 }], 11), 3, 'a missing target scene reuses the last available one');
});

test('the transient setup-guide URL signal is consumed while preserving query and hash', async () => {
  const { consumeSetupGuideSignal } = await onboardingModule();
  const replacements = [];
  assert.equal(consumeSetupGuideSignal('https://kinesis.test/home.html?keep=one&openSetupGuide=1&also=two#cycle', (url) => replacements.push(url)), true);
  assert.deepEqual(replacements, ['/home.html?keep=one&also=two#cycle']);
  assert.equal(consumeSetupGuideSignal('https://kinesis.test/home.html?keep=one#cycle', (url) => replacements.push(url)), false);
  assert.equal(consumeSetupGuideSignal('https://kinesis.test/home.html?openSetupGuide=0', (url) => replacements.push(url)), false);
  assert.equal(replacements.length, 1, 'refreshing the cleaned URL cannot reopen the tour');
});

test('tour narration, captions and transcript share one localized script in both languages', async () => {
  const { TOUR_SCENES, tourCueKey, tourMediaLanguage } = await onboardingModule();
  const { translate } = await import(pathToFileURL(publicPath('shared/i18n.js')));
  assert.deepEqual(TOUR_SCENES.map((scene) => scene.id), ['intro', 'shoes', 'cycle', 'request', 'calendar', 'watch', 'result', 'insights', 'outro']);
  assert.equal(tourMediaLanguage('pt-BR'), 'pt');
  assert.equal(tourMediaLanguage('en-US'), 'en');
  assert.equal(tourMediaLanguage('fr-FR'), 'en');
  for (const locale of ['en', 'pt']) {
    const messages = JSON.parse(readFileSync(publicPath('locales', `${locale}.json`), 'utf8'));
    const cues = TOUR_SCENES.flatMap((scene) => scene.cues.map((cue) => translate(messages, tourCueKey(cue))));
    for (const cue of cues) assert.ok(cue && !cue.startsWith('home.onboarding'), `${locale} narration cue is translated`);
    assert.deepEqual(Object.keys(messages.home.onboarding.tour.cues).sort(), TOUR_SCENES.flatMap((scene) => scene.cues).sort(), `${locale} has no stale cue`);
    const vtt = readFileSync(publicPath('assets/onboarding/tour', `kinesis-tour-${locale}.vtt`), 'utf8');
    assert.match(vtt, /^WEBVTT\n/);
    const captionText = vtt.split('\n\n').slice(1).filter(Boolean).map((block) => block.split('\n').slice(2).join(' ').trim()).join(' ');
    assert.equal(captionText, cues.join(' '), `${locale} captions are exactly the narration script, in order`);
    for (const stale of ['guideTitle', 'hide', 'nextBadge', 'stepProgress', 'shoesAlt', 'aiAction', 'planCycleAction', 'later', 'progress', 'setupComplete']) {
      assert.equal(messages.home.onboarding[stale], undefined, `${locale} drops the removed checklist/carousel key ${stale}`);
    }
  }
});

test('tour media manifest points to committed, cache-busted video, captions and posters', async () => {
  const { TOUR_MEDIA } = await tourMediaModule();
  const { TOUR_SCENES } = await onboardingModule();
  assert.deepEqual(Object.keys(TOUR_MEDIA), ['pt', 'en']);
  for (const [language, media] of Object.entries(TOUR_MEDIA)) {
    for (const field of ['webm', 'mp4', 'captions', 'poster']) {
      const [file, version] = media[field].split('?v=');
      assert.match(version, /^[0-9a-f]{10}$/, `${language} ${field} carries a content hash`);
      const absolute = publicPath(file.replace(/^\//, ''));
      assert.ok(existsSync(absolute), `${language} ${field} is committed at ${file}`);
      assert.equal(createHash('sha256').update(readFileSync(absolute)).digest('hex').slice(0, 10), version, `${language} ${field} hash matches the file`);
    }
    assert.deepEqual(media.scenes.map((scene) => scene.id), TOUR_SCENES.map((scene) => scene.id));
    media.scenes.forEach((scene, index) => {
      assert.ok(scene.end > scene.start);
      if (index > 0) assert.equal(scene.start, media.scenes[index - 1].end, 'scenes are contiguous');
    });
    assert.ok(Math.abs(media.scenes.at(-1).end - media.duration) < 0.01);
  }
});

test('the dashboard replaces the checklist and slides with one accessible tour dialog', () => {
  const home = readFileSync(publicPath('home.html'), 'utf8');
  const homeJs = readFileSync(publicPath('home.js'), 'utf8');
  const homeCss = readFileSync(publicPath('home.css'), 'utf8');
  assert.doesNotMatch(home, /onboardingGuide|onboardingWelcome|onboarding-welcome|data-onboarding-step|onboardingHide/, 'the old checklist and carousel are gone');
  assert.doesNotMatch(homeCss, /onboarding-guide|onboarding-welcome|onboarding-step/, 'no stale checklist or carousel styles remain');
  assert.match(home, /<link rel="stylesheet" href="shared\/components\.css">/, 'the dialog reuses the shared modal styles');
  assert.match(home, /id="onboardingTour" class="modal-backdrop onboarding-tour" hidden/);
  assert.match(home, /class="modal-card onboarding-tour-card" role="dialog" aria-modal="true" aria-labelledby="onboardingTourTitle" aria-describedby="onboardingTourDescription"/);
  assert.match(home, /id="onboardingTourTitle" tabindex="-1"/);
  assert.match(home, /id="onboardingTourClose" type="button" class="modal-close"[^>]*data-i18n-aria-label="home\.onboarding\.close"/);
  assert.match(home, /<video id="onboardingTourVideo" controls playsinline preload="metadata"/);
  assert.doesNotMatch(home, /autoplay/, 'the narrated tour never plays without an explicit action');
  assert.match(home, /<details class="onboarding-tour-transcript">/);
  assert.match(home, /id="onboardingTourFooter" class="onboarding-tour-footer" hidden/, 'the footer is shown only for a next step');
  assert.doesNotMatch(home, /onboardingLater|onboardingTourProgress/, 'no redundant Not now button or progress line');
  assert.doesNotMatch(home, /\stitle="/, 'no native title tooltips');
  assert.match(homeCss, /\.onboarding-tour\[hidden\] \{ display: none !important; \}/);
  assert.match(homeCss, /prefers-reduced-motion: reduce[\s\S]*\.onboarding-tour-card \{ animation: none; \}/);
  assert.match(homeJs, /createDialogFocusTrap\(onboardingTour, \(\) => \{ if \(!document\.fullscreenElement\) closeTour\(\); \}\)/);
  assert.match(homeJs, /track\.kind = 'captions';/);
  assert.match(homeJs, /kinesis:open-setup-guide/);
  for (const asset of ['onboarding-shoes.png', 'onboarding-cycle.png', 'onboarding-plan.png']) {
    assert.equal(existsSync(publicPath('assets/onboarding', asset)), false, `${asset} is no longer shipped`);
  }
});

test('browser CSS keeps the hidden tour dialog out of layout', () => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for onboarding browser validation.');
  const components = readFileSync(publicPath('shared/components.css'), 'utf8');
  const css = readFileSync(publicPath('home.css'), 'utf8');
  const html = `<!doctype html><style>${components}${css.replace(/@import[^;]+;/, '')}</style>
    <div id="onboardingTour" class="modal-backdrop onboarding-tour" hidden></div>
    <script>document.body.dataset.hiddenDisplay = getComputedStyle(document.getElementById('onboardingTour')).display;</script>`;
  const profile = mkdtempSync(`${tmpdir()}/kinesis-onboarding-chrome-`);
  try {
    const output = execFileSync(chrome, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', `--user-data-dir=${profile}`, '--dump-dom',
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    ], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    assert.match(output, /data-hidden-display="none"/);
  } finally {
    rmSync(profile, { recursive: true, force: true });
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
          document.getElementById('feedbackAccordionTrigger').click();
          await new Promise((resolve,reject)=>{const end=Date.now()+2000;const wait=()=>{if(!document.getElementById('feedbackAccordionPanel').hidden){resolve();return}if(Date.now()>end){reject(new Error('Feedback accordion did not open for import guide validation'));return}setTimeout(wait,20)};wait()});
          const importButton=document.getElementById('importHelpBtn');
          const sourceSelect=document.getElementById('resultSourceSelect');
          const manualValues=['manualDistance','manualHours','manualMinutes','manualSeconds','manualAvgHr','manualMaxHr','manualElevation','manualCalories'].map(id=>document.getElementById(id)?.value);
          const importInitial={visible:!importButton.hidden,rect:{width:importButton.getBoundingClientRect().width,height:importButton.getBoundingClientRect().height},insideHidden:Boolean(importButton.closest('[hidden]')),tabIndex:importButton.tabIndex,source:sourceSelect.value,manualVisible:!document.getElementById('manualResultsField').hidden,fitVisible:!document.getElementById('fitField').hidden};
          importButton.focus(); importButton.click();
          await new Promise((resolve,reject)=>{const end=Date.now()+2000;const wait=()=>{const dialog=document.getElementById('importHelpDialog');if(dialog&&!dialog.hidden){resolve();return}if(Date.now()>end){reject(new Error('Import guide did not open'));return}setTimeout(wait,20)};wait()});
          const dialog=document.getElementById('importHelpDialog');
          const importOpen={focus:document.activeElement?.getAttribute('data-import-help-close'),platforms:dialog.querySelectorAll('[data-provider-id]').length};
          document.querySelector('.lang-switch [data-lang="en-US"]')?.click();
          await new Promise(r=>setTimeout(r,100));
          const englishGuide=dialog.querySelector('[data-import-help-title]')?.textContent;
          document.querySelector('.lang-switch [data-lang="pt-BR"]')?.click();
          await new Promise(r=>setTimeout(r,100));
          dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
          await new Promise((resolve,reject)=>{const end=Date.now()+2000;const wait=()=>{if(dialog.hidden){resolve();return}if(Date.now()>end){reject(new Error('Import guide did not close'));return}setTimeout(wait,20)};wait()});
          const importClosed={restored:document.activeElement===importButton,source:sourceSelect.value,unchangedManual:JSON.stringify(manualValues)===JSON.stringify(['manualDistance','manualHours','manualMinutes','manualSeconds','manualAvgHr','manualMaxHr','manualElevation','manualCalories'].map(id=>document.getElementById(id)?.value))};
          sourceSelect.value='fit'; sourceSelect.dispatchEvent(new Event('change')); const fitVisibleAfterSwitch=!document.getElementById('fitField').hidden;
          sourceSelect.value='manual'; sourceSelect.dispatchEvent(new Event('change')); const manualVisibleAfterSwitch=!document.getElementById('manualResultsField').hidden;
          const initial={source:api.training.result_data_source,hintPresent:Boolean(document.getElementById('onboardingResultHint')),active:[...select.options].some(o=>o.value==='result-active'),retired:[...select.options].find(o=>o.value==='result-retired')?.textContent,retiredDisabled:[...select.options].find(o=>o.value==='result-retired')?.disabled,foreign:[...select.options].some(o=>o.value==='result-foreign-retired'),scrollWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,importInitial,importOpen,englishGuide,importClosed,fitVisibleAfterSwitch,manualVisibleAfterSwitch};
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
      assert.equal(result.importInitial.visible, true, `${source} import guide trigger is visible`);
      assert.ok(result.importInitial.rect.width > 0 && result.importInitial.rect.height > 0, `${source} import guide trigger has a target size`);
      assert.equal(result.importInitial.insideHidden, false, `${source} import guide trigger is not inside hidden content`);
      assert.ok(result.importInitial.tabIndex >= 0, `${source} import guide trigger is keyboard reachable`);
      assert.equal(result.importInitial.source, source === 'manual' ? 'manual' : 'fit');
      assert.equal(result.importOpen.focus, '');
      assert.equal(result.importOpen.platforms, 7);
      assert.match(result.englishGuide, /Import your workout/i);
      assert.equal(result.importClosed.restored, true);
      assert.equal(result.importClosed.source, source === 'manual' ? 'manual' : 'fit');
      assert.equal(result.importClosed.unchangedManual, true);
      assert.equal(result.importInitial.fitVisible, source !== 'manual');
      assert.equal(result.importInitial.manualVisible, source === 'manual');
      assert.equal(result.fitVisibleAfterSwitch, true);
      assert.equal(result.manualVisibleAfterSwitch, true);
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
        document.getElementById('feedbackAccordionTrigger').click();
        await new Promise((resolve,reject)=>{const end=Date.now()+2000;const wait=()=>{if(!document.getElementById('feedbackAccordionPanel').hidden){resolve();return}if(Date.now()>end){reject(new Error('Feedback accordion did not open'));return}setTimeout(wait,20)};wait()});
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
      dialog.querySelector('[data-workout-create-platform="apple"]').click();
      const apple={status:dialog.querySelector('[data-workout-create-status]').textContent,note:dialog.querySelector('[data-workout-create-note]').textContent,steps:dialog.querySelector('[data-workout-create-steps]').textContent,selected:dialog.querySelector('[data-workout-create-platform="apple"]').getAttribute('aria-pressed')};
      dialog.querySelector('[data-workout-create-platform="xiaomi"]').click();
      const xiaomi={status:dialog.querySelector('[data-workout-create-status]').textContent, fallback:dialog.querySelector('[data-workout-create-steps]').textContent,selected:dialog.querySelector('[data-workout-create-platform="xiaomi"]').getAttribute('aria-pressed')};
      dialog.querySelector('[data-workout-create-platform="garmin"]').click();
      const garmin={steps:dialog.querySelector('[data-workout-create-steps]').textContent,selected:dialog.querySelector('[data-workout-create-platform="garmin"]').getAttribute('aria-pressed')};
      dialog.querySelector('[data-workout-create-platform="xiaomi"]').click();
      document.querySelector('.lang-switch [data-lang="pt-BR"]')?.click();
      await new Promise(r=>setTimeout(r,120));
      const portuguese={title:dialog.querySelector('[data-workout-create-title]').textContent, fallback:dialog.querySelector('[data-workout-create-steps]').textContent,selected:dialog.querySelector('[data-workout-create-platform="xiaomi"]').getAttribute('aria-pressed'),overflow:document.documentElement.scrollWidth<=innerWidth};
      document.querySelector('[data-workout-create-close]').click();
      const after=await fetch('/api/trainings/${trainingId}').then(r=>r.json());
      resolve({initial,apple,xiaomi,garmin,portuguese,restored:document.activeElement===trigger,unchanged:JSON.stringify(before.training)===JSON.stringify(after.training)});
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
      assert.equal(result.apple.selected, 'true');
      assert.match(result.apple.note, /watch|relógio/i);
      assert.match(result.apple.steps, /Apple|relógio|watch/i);
      assert.match(result.xiaomi.status, /Model|modelo/i);
      assert.equal(result.xiaomi.selected, 'true');
      assert.equal(result.garmin.selected, 'true');
      assert.match(result.garmin.steps, /Garmin|device|dispositivo/i);
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
        assert.equal(result[guide].isolation.backgroundInert, true, JSON.stringify(result[guide].isolation));
        assert.equal(result[guide].isolation.outsideFocusContained, true, `${guide} contains programmatic background focus`);
        assert.equal(result[guide].isolation.tabInside, true, `${guide} contains Tab after focus loss`);
        assert.equal(result[guide].isolation.shiftTabInside, true, `${guide} contains Shift+Tab after focus loss`);
        assert.equal(result[guide].isolation.focusOutsideAfterBlur, true);
        assert.equal(result[guide].escapedFromOutside.closed, true, `${guide} closes with Escape after focus leaves dialog`);
        assert.equal(result[guide].escapedFromOutside.restored, true, `${guide} restores focus after outside Escape`);
        assert.equal(result[guide].escapedFromOutside.backgroundReleased, true, `${guide} releases inert after outside Escape`);
        assert.equal(result[guide].closed.hidden, true);
        assert.equal(result[guide].closed.restored, true);
        assert.equal(result[guide].closed.reopened, true);
        assert.equal(result[guide].closed.inertWhileReopened, true);
        assert.equal(result[guide].closed.backdropOpened, true);
        assert.equal(result[guide].closed.backdropClosed, true);
        assert.equal(result[guide].closed.backgroundReleased, true);
        assert.equal(result[guide].closed.selected, 1);
        assert.equal(result[guide].closed.overflow, true);
      }
    }
  } finally {
    try { await app.close(); } catch {}
    db.close();
  }
});
