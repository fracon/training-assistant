'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { registerUser } = require('../src/auth/registration');
const { createSession } = require('../src/auth/sessions');
const { readAiConfig } = require('../src/ai/config');

function findChrome() {
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((file) => existsSync(file));
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('the three external prompt screens share the approved modal in Chrome across PT/EN and viewport sizes', async (t) => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for shared prompt modal comparison.');
  const db = createDatabase({ filename: ':memory:' });
  let providerCalls = 0;
  const app = await buildServer({
    db,
    sessionCookieSecure: false,
    aiConfig: readAiConfig({ AI_ENABLED: 'true', OPENAI_API_KEY: 'synthetic-only', AI_RETRIES: '0' }),
    aiClient: async () => { providerCalls += 1; throw new Error('Provider call forbidden in this visual test.'); },
  });
  const account = await registerUser(db, {
    email: 'shared-prompt-admin@example.test', password: 'synthetic-prompt-secret-1',
    first_name: 'Prompt', last_name: 'Admin', preferred_lang: 'en-US',
  });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(account.id);
  const cycleId = 'shared-prompt-cycle';
  db.prepare(`INSERT INTO training_cycles
    (id,user_id,objective,target_date,distance,run_before,run_count,primary_goal,secondary_goal,start_date,other_events,status)
    VALUES (?,?,?,'2026-12-01','10km','5k',1,'Finish','', '2026-08-01','', 'active')`)
    .run(cycleId, account.id, 'Synthetic city race');
  const training = db.prepare(`INSERT INTO trainings
    (user_id,dia,periodo,tipo,treino,detalhes,fc_alvo,rpe,tenis,previsao,observacoes,feedback_rpe,feedback_notas,completed)
    VALUES (?,'2026-08-24','Manhã','Corrida','Corrida leve','30 min confortável','', '3','Nimbus sintético',NULL,'',3,'Contexto sintético.',1)`)
    .run(account.id);
  const trainingId = Number(training.lastInsertRowid);
  const session = createSession(db, account.id);
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const debugPort = await freePort();
  const profile = path.join(tmpdir(), `kinesis-shared-prompt-${process.pid}`);
  const captureDir = path.join(tmpdir(), 'kinesis-shared-prompt-comparison');
  mkdirSync(captureDir, { recursive: true });
  const chromeProcess = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-allow-origins=*', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let socket;
  try {
    const debugUrl = `http://127.0.0.1:${debugPort}`;
    let versionResponse;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { versionResponse = await fetch(`${debugUrl}/json/version`); if (versionResponse.ok) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(versionResponse?.ok, 'Chrome DevTools endpoint became available.');
    const targetResponse = await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' });
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
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) resolve?.reject(new Error(message.error.message));
      else resolve?.resolve(message.result);
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++commandId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome command timed out: ${method}`)); }, 20000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = (expression, description) => evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+12000;const check=()=>{try{if(${expression})return resolve(true)}catch{}if(Date.now()>end)return reject(new Error(${JSON.stringify(`Timed out waiting for ${description}`)}));setTimeout(check,30)};check()})`,
    );
    const setLanguage = async (language) => {
      await waitFor(`document.querySelector('.lang-switch [data-lang="${language}"]')`, 'language switch');
      await evaluate(`document.querySelector('.lang-switch [data-lang="${language}"]').click()`);
      await waitFor(`document.documentElement.lang==='${language}'`, `${language} locale`);
    };
    const pages = [
      { name: 'cycles', path: '/cycles.html', trigger: '.cycle-prompt-btn', dialog: '#promptModal' },
      { name: 'workouts', path: '/ai-coach.html', trigger: '#externalPromptBtn', dialog: '#externalPromptModal' },
      { name: 'result', path: `/training-result.html?id=${trainingId}`, trigger: '[data-analysis-external-prompt="true"]', dialog: '#analysisExternalPromptDialog' },
    ];
    const viewports = [
      { name: 'desktop', width: 1280, height: 900, mobile: false },
      { name: 'short', width: 1280, height: 480, mobile: false },
      { name: 'mobile', width: 390, height: 844, mobile: true },
    ];
    const metrics = {};
    await command('Page.enable');
    await command('Runtime.enable');
    await command('Network.enable');
    const origin = new URL(baseUrl).origin;
    const cookie = await command('Network.setCookie', { name: 'ta_session', value: session.token, url: origin });
    assert.equal(cookie.success, true);

    for (const page of pages) {
      for (const language of ['en-US', 'pt-BR']) {
        for (const viewport of viewports) {
          await command('Emulation.setDeviceMetricsOverride', {
            width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile,
          });
          await command('Page.navigate', { url: `${baseUrl}${page.path}` });
          await waitFor(`document.querySelector(${JSON.stringify(page.trigger)}) && document.querySelector(${JSON.stringify(page.trigger)}).offsetParent!==null`, `${page.name} admin trigger`);
          if (page.name === 'workouts') {
            await waitFor(`document.querySelector('#availabilityGrid [data-day="monday"] [data-can-train]')`, 'availability editor readiness');
            await evaluate(`(()=>{const row=document.querySelector('[data-day="monday"]');const canTrain=row.querySelector('[data-can-train]');if(!canTrain.checked)canTrain.click();row.querySelector('[data-period="before_08"]').click();const duration=row.querySelector('[data-duration]');duration.value='60';duration.dispatchEvent(new Event('input',{bubbles:true}));row.querySelector('[data-location]').value='Porto';row.querySelector('[data-location]').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('saveAvailability').click()})()`);
            await waitFor(`!document.getElementById('saveAvailability').disabled && !document.getElementById('generateBtn').disabled`, 'saved availability readiness');
          }
          await setLanguage(language);
          await evaluate(`document.querySelector(${JSON.stringify(page.trigger)}).click()`);
          await waitFor(`document.querySelector(${JSON.stringify(page.dialog)}) && !document.querySelector(${JSON.stringify(page.dialog)}).hidden && document.querySelector(${JSON.stringify(page.dialog)}).querySelector('textarea')?.value.length>0`, `${page.name} prompt preview`);
          const actualPrompt = await evaluate(`document.querySelector(${JSON.stringify(page.dialog)}).querySelector('textarea').value`);
          assert.ok(actualPrompt.length > 100, `${page.name} delivered its real prompt text to the shared component`);
          assert.equal(await evaluate('document.activeElement.matches(".external-prompt-header .modal-close")'), true,
            `${page.name} puts initial focus on the shared close control`);
          const synthetic = `${page.name} synthetic long prompt sample — context, instructions, examples and line wrapping.\n`.repeat(45);
          await evaluate(`(()=>{const area=document.querySelector(${JSON.stringify(page.dialog)}).querySelector('textarea');area.textContent=${JSON.stringify(synthetic)};area.value=${JSON.stringify(synthetic)};area.scrollTop=0;return true})()`);
          const measured = await evaluate(`(()=>{const dialog=document.querySelector(${JSON.stringify(page.dialog)}),card=dialog.querySelector('.external-prompt-card'),area=card.querySelector('.external-prompt-text'),footer=card.querySelector('.external-prompt-actions'),buttons=[...footer.querySelectorAll('button')],rect=(node)=>node.getBoundingClientRect(),cardRect=rect(card),areaRect=rect(area),footerRect=rect(footer),x=card.querySelector('.external-prompt-header .modal-close'),xRect=rect(x),icon=rect(x.querySelector('svg')),buttonRects=buttons.map(rect),styles=getComputedStyle,footerStyle=styles(footer),areaStyle=styles(area);return {cardWidth:cardRect.width,cardHeight:cardRect.height,cardPadding:styles(card).padding,cardRadius:styles(card).borderRadius,overlayBackground:styles(dialog).backgroundColor,areaWidth:areaRect.width,areaHeight:areaRect.height,areaGap:footerRect.top-areaRect.bottom,bottomGap:cardRect.bottom-footerRect.bottom,areaFont:areaStyle.font,areaLineHeight:areaStyle.lineHeight,areaPadding:areaStyle.padding,areaRadius:areaStyle.borderRadius,areaScrollable:area.scrollHeight>area.clientHeight,cardScrollHeight:card.scrollHeight,cardClientHeight:card.clientHeight,footerBorder:footerStyle.borderTopWidth,footerPadding:footerStyle.paddingTop,footerMargin:footerStyle.marginTop,footerGap:footerStyle.columnGap,buttonRects:buttonRects.map(r=>({width:r.width,height:r.height})),xWidth:xRect.width,xHeight:xRect.height,iconWidth:icon.width,iconHeight:icon.height,scrollWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,closeLabel:buttons[0].textContent.trim(),copyLabel:buttons[1].textContent.trim(),closeAccessibleName:x.getAttribute('aria-label'),copyHasIcon:!!buttons[1].querySelector('svg,i')}})()`);
          assert.equal(measured.cardWidth, viewport.mobile ? 374 : 900, `${page.name}/${language}/${viewport.name} modal width matches the shared rule`);
          assert.equal(measured.cardPadding, '24px');
          assert.equal(measured.areaGap, 16);
          assert.ok(measured.bottomGap >= 24 && measured.bottomGap <= 25);
          assert.equal(measured.footerBorder, '0px');
          assert.equal(measured.footerPadding, '0px');
          assert.equal(measured.footerMargin, '0px');
          assert.equal(measured.footerGap, '12px');
          assert.equal(measured.buttonRects[0].width, measured.buttonRects[1].width);
          assert.equal(measured.buttonRects[0].height, measured.buttonRects[1].height);
          assert.equal(measured.xWidth, 40);
          assert.equal(measured.xHeight, 40);
          assert.equal(measured.iconWidth, 20);
          assert.equal(measured.iconHeight, 20);
          assert.equal(measured.copyHasIcon, false);
          assert.equal(measured.closeLabel, language === 'pt-BR' ? 'Fechar' : 'Close');
          assert.equal(measured.copyLabel, language === 'pt-BR' ? 'Copiar prompt' : 'Copy prompt');
          assert.equal(measured.closeAccessibleName, measured.closeLabel);
          assert.equal(measured.scrollWidth, viewport.width, `${page.name} has no horizontal overflow`);
          assert.equal(measured.cardScrollHeight, measured.cardClientHeight, `${page.name} has no competing card scroll area`);
          assert.equal(measured.areaScrollable, true, `${page.name} keeps long prompt scrolling inside its textarea`);
          assert.equal(await evaluate(`document.documentElement.lang`), language);
          const key = `${page.name}-${language}-${viewport.width}x${viewport.height}`;
          metrics[key] = measured;
          writeFileSync(path.join(captureDir, `${key}.png`), Buffer.from((await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
          await evaluate(`(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text)=>{window.__copiedExternalPrompt=text}}});document.querySelector(${JSON.stringify(page.dialog)}).querySelector('.external-prompt-actions button:last-child').click()})()`);
          await waitFor(`document.querySelector(${JSON.stringify(page.dialog)}).querySelector('.external-prompt-status').textContent.length>0`, `${page.name} copy announcement`);
          assert.equal(await evaluate('window.__copiedExternalPrompt'), page.name === 'result' ? actualPrompt : synthetic,
            `${page.name} copies its complete prompt without truncation`);
          await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
          await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
          await waitFor(`document.querySelector(${JSON.stringify(page.dialog)}).hidden`, `${page.name} Escape close`);
          assert.equal(await evaluate(`document.activeElement.matches(${JSON.stringify(page.trigger)})`), true,
            'Escape closes and restores focus to the trigger');
        }
      }
    }

    for (const language of ['en-US', 'pt-BR']) for (const viewport of viewports) {
      const [cycles, workouts, result] = ['cycles', 'workouts', 'result'].map((page) => metrics[`${page}-${language}-${viewport.width}x${viewport.height}`]);
      for (const key of ['cardWidth', 'cardHeight', 'cardPadding', 'cardRadius', 'areaWidth', 'areaHeight', 'areaGap', 'bottomGap', 'footerGap', 'xWidth', 'xHeight', 'iconWidth', 'iconHeight']) {
        assert.equal(cycles[key], workouts[key], `${key} matches cycles and Request Workouts (${language}/${viewport.name})`);
        assert.equal(workouts[key], result[key], `${key} matches Request Workouts and result (${language}/${viewport.name})`);
      }
    }
    writeFileSync(path.join(captureDir, 'metrics.json'), JSON.stringify(metrics, null, 2));
    assert.equal(providerCalls, 0, 'opening/copying previews never invokes the simulated generation provider');
    t.diagnostic(`Chrome comparison captures saved to ${captureDir}; three shared prompt screens, PT/EN, desktop, low-height desktop, and mobile; provider calls: ${providerCalls}.`);
  } finally {
    socket?.close();
    chromeProcess.kill('SIGTERM');
    await app.close();
    db.close();
  }
});
