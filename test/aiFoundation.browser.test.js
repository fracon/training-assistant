'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { createSession, SESSION_COOKIE_NAME } = require('../src/auth/sessions');
async function freePort() {
  const s = createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
test('training memory Chrome PT/EN desktop/mobile, ownership, keyboard, loading, errors and visual consistency', async () => {
  const chrome = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find(existsSync);
  assert.ok(chrome);
  const db = createDatabase({ filename: ':memory:' });
  db.prepare(
    "INSERT INTO users(id,email,password_hash,role) VALUES (1,'synthetic-admin@example.invalid','synthetic','admin'),(2,'synthetic-user@example.invalid','synthetic','user'),(3,'synthetic-new-admin@example.invalid','synthetic','admin')",
  ).run();
  db.prepare(
    "INSERT INTO training_cycles(id,user_id,objective) VALUES ('cycle',1,'Synthetic cycle')",
  ).run();
  db.prepare("UPDATE training_cycles SET status='active',primary_goal='Synthetic goal',target_date='2026-12-01',start_date='2026-09-01' WHERE id='cycle'").run();
  db.prepare("INSERT INTO trainings(user_id,dia,tipo,treino,completed,feedback_rpe,feedback_pain,feedback_has_pain,fit_distance,fit_duration,result_data_source) VALUES (1,date('now'),'Run','Synthetic recent run',1,3,'Synthetic dated discomfort','yes',5,'30:00','manual'),(1,date('now','-30 days'),'Run','Synthetic older run',1,4,NULL,NULL,10,'1:00:00','manual'),(1,date('now','+2 days'),'Run','Synthetic planned run',0,NULL,NULL,NULL,NULL,NULL,'none')").run();
  db.prepare("INSERT INTO ai_coach_availability(user_id,day_key,can_train,available_periods,available_minutes,location) VALUES (1,'monday',1,?,60,'Synthetic locality')").run(JSON.stringify(['before_08']));
  const tokens = [1,2,3].map((id)=>createSession(db,id).token);
  const app = await buildServer({ db, sessionCookieSecure: false });
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  const debugPort = await freePort();
  const profile = mkdtempSync(path.join(tmpdir(), 'kinesis-memory-chrome-'));
  const process = spawn(
    chrome,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let socket;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok)
          break;
      } catch {}
      await delay(50);
    }
    const target = await (
      await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, {
        method: 'PUT',
      })
    ).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, 'open');
    let id = 0;
    const pending = new Map();
    const requests = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Network.requestWillBeSent') {
        requests.push({
          method: message.params.request.method,
          url: message.params.request.url,
        });
      }
      if (message.method) return;
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(message.error.message));
      else handler.resolve(message.result);
    });
    const command = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const commandId = ++id;
        pending.set(commandId, { resolve, reject });
        socket.send(JSON.stringify({ id: commandId, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text,
        );
      }
      return result.result.value;
    };

    const waitFor = async (expr) => {
      for (let i = 0; i < 160; i++) {
        try {
          if (await evaluate(expr)) return;
        } catch {}
        await delay(50);
      }
      throw Error('Timed out: ' + expr);
    };
    await command('Network.enable');
    await command('Network.setBlockedURLs', {
      urls: ['*unpkg.com*', '*fonts.googleapis.com*', '*fonts.gstatic.com*'],
    });
    await command('Page.enable');
    await command('Network.setCookie', {
      name: SESSION_COOKIE_NAME,
      value: tokens[0],
      url: origin,
      httpOnly: true,
    });
    await command('Network.setBlockedURLs', {
      urls: [
        '*unpkg.com*',
        '*fonts.googleapis.com*',
        '*fonts.gstatic.com*',
        '*api/ai/memory*',
      ],
    });
    await command('Page.navigate', { url: origin + '/training-memory.html' });
    await waitFor(
      "document.getElementById('memoryError')?.classList.contains('hidden')===false",
    );
    assert.equal(
      await evaluate(
        "document.getElementById('profileForm').querySelector('[type=submit]').disabled",
      ),
      true,
    );
    await evaluate(
      "document.getElementById('experience').value='Synthetic edit during failed load';document.getElementById('experience').dispatchEvent(new Event('input',{bubbles:true}))",
    );
    await command('Network.setBlockedURLs', {
      urls: ['*unpkg.com*', '*fonts.googleapis.com*', '*fonts.gstatic.com*'],
    });
    await evaluate("document.getElementById('reloadMemory').click()");

    await waitFor(
      "document.getElementById('profileForm')?.querySelector('[type=submit]')?.disabled===false",
    );
    assert.equal(
      await evaluate("document.getElementById('experience').value"),
      'Synthetic edit during failed load',
    );
    for (const language of ['en-US', 'pt-BR']) {
      await evaluate(
        `document.querySelector(".lang-switch [data-lang='${language}']").click()`,
      );
      await waitFor(`document.documentElement.lang==='${language}'`);
      assert.equal(
        await evaluate(`document.querySelector('main h1').textContent.trim()`),
        language === 'pt-BR' ? 'Memória de treinamento' : 'Training memory',
      );
      await evaluate(
        `document.getElementById('experience').value='Synthetic experience';document.getElementById('profileForm').requestSubmit()`,
      );
      await waitFor(
        `!document.getElementById('profileForm').querySelector('[type=submit]').disabled`,
      );
      assert.equal(await evaluate("document.querySelectorAll('#goals,#preferences,#restrictions,#entryForm').length"),0);
      assert.ok((await evaluate("document.getElementById('memoryOverview').textContent")).includes('Synthetic cycle'));
      assert.ok((await evaluate("document.getElementById('memoryOverview').textContent")).includes(language==='pt-BR'?'Desconforto relatado: Sim':'Discomfort reported: Yes'));
      assert.equal(await evaluate("document.querySelector('#memoryOverview a').getAttribute('href')"),'/cycles.html');
      for (const width of [1280, 390]) {
        await command('Emulation.setDeviceMetricsOverride', {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: width === 390,
        });
        await command('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        assert.equal(
          await evaluate('document.documentElement.scrollWidth>innerWidth'),
          false,
        );
        const shot = await command('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
        });
        writeFileSync(
          `/tmp/kinesis-memory-${language}-${width}.png`,
          Buffer.from(shot.data, 'base64'),
        );
        const savedScroll = await evaluate(
          "document.querySelector('.main-content').scrollTop",
        );
        await evaluate("document.querySelector('.main-content').scrollTop=0");
        const topShot = await command('Page.captureScreenshot', {
          format: 'png',
        });
        writeFileSync(
          `/tmp/kinesis-memory-top-${language}-${width}.png`,
          Buffer.from(topShot.data, 'base64'),
        );
        await evaluate(
          `document.querySelector('.main-content').scrollTop=${savedScroll}`,
        );
      }
    }
    await command('Emulation.clearDeviceMetricsOverride');
    await evaluate(
      `document.querySelector('#previewForm [type=submit]').click()`,
    );
    await waitFor(`document.getElementById('promptPreview').value.length>100`);
    assert.ok(
      (
        await evaluate(`document.getElementById('contextPreview').value`)
      ).includes('training-context-v3'),
    );
    assert.equal(
      requests.some((r) => r.url.includes('api.openai.com')),
      false,
    );
    // A conflict must preserve edits; reloading a version must not erase typed text.
    db.prepare(
      'UPDATE ai_profiles SET version=version+1 WHERE user_id=1',
    ).run();
    await evaluate(
      `document.getElementById('experience').value='Synthetic preserved edit';document.getElementById('experience').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('profileForm').requestSubmit()`,
    );
    await waitFor(
      `document.getElementById('memoryError').classList.contains('hidden')===false`,
    );
    assert.equal(
      await evaluate(`document.getElementById('experience').value`),
      'Synthetic preserved edit',
    );
    await evaluate(`document.getElementById('reloadMemory').click()`);
    await waitFor(
      `!document.getElementById('profileForm').querySelector('[type=submit]').disabled`,
    );
    assert.equal(
      await evaluate(`document.getElementById('experience').value`),
      'Synthetic preserved edit',
    );
    await evaluate("document.getElementById('profileForm').requestSubmit()");
    await waitFor("!document.getElementById('reloadMemory').disabled");
    assert.equal(db.prepare('SELECT fields_json FROM ai_profiles WHERE user_id=1').get().fields_json.includes('Synthetic preserved edit'),true);
    // Canonical corrections appear on refresh, without another personal form.
    db.prepare("UPDATE training_cycles SET primary_goal='Synthetic corrected goal' WHERE id='cycle'").run();
    await evaluate("document.getElementById('reloadMemory').click()");
    await waitFor("document.getElementById('memoryOverview').textContent.includes('Synthetic corrected goal')");
    // Hold a real reload and move focus: the refresh must not take focus away.
    await command('Fetch.enable',{patterns:[{urlPattern:origin+'/api/ai/memory',requestStage:'Request'}]});
    const pausedLoad = new Promise((resolve) => {
      const handler = (event) => { const message=JSON.parse(event.data); if(message.method==='Fetch.requestPaused') {socket.removeEventListener('message',handler);resolve(message.params.requestId);} };
      socket.addEventListener('message',handler);
    });
    await evaluate("document.getElementById('reloadMemory').click()");
    const requestId=await pausedLoad;
    await evaluate("document.getElementById('experience').focus()");
    await command('Fetch.continueRequest',{requestId});
    await waitFor("!document.getElementById('reloadMemory').disabled");
    await command('Fetch.disable');
    assert.equal(await evaluate('document.activeElement.id'),'experience');
    // The remaining admin DatePicker keeps the reviewed keyboard/month behavior.
    await evaluate("document.getElementById('previewPurpose').value='workouts';document.getElementById('previewPurpose').dispatchEvent(new Event('change'));document.getElementById('previewDate').focus()");
    const key = async (key,code,windowsVirtualKeyCode) => {for(const type of ['keyDown','keyUp']) await command('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode});};
    await key('Enter','Enter',13);
    assert.equal(await evaluate("document.getElementById('previewDate').getAttribute('aria-expanded')"),'true');
    for(const action of ['previous','next']) {
      await evaluate(`document.querySelector('#previewDate-calendar-popup [data-calendar-action="${action}"]').focus()`);
      await key('Enter','Enter',13);
      assert.equal(await evaluate('document.activeElement.dataset.calendarAction'),action);
    }
    await key('Escape','Escape',27);
    assert.equal(await evaluate('document.activeElement.id'),'previewDate');
    // Source links remain keyboard controls and point at established pages.
    await evaluate("document.querySelector('#memoryOverview a').focus()");
    await key('Tab','Tab',9);
    assert.equal(await evaluate("document.activeElement.tagName"),'A');
    const memoryStyles = await evaluate(
      `(()=>{const i=getComputedStyle(document.querySelector('#previewDate'));const b=getComputedStyle(document.querySelector('#profileForm button'));return {inputFont:i.fontFamily,inputRadius:i.borderRadius,buttonRadius:b.borderRadius}})()`,
    );
    await command('Page.navigate', { url: origin + '/shoes.html' });
    await waitFor(
      `document.body.classList.contains('shell-mounted') && !!document.getElementById('addShoeBtn')`,
    );
    await delay(150);
    await evaluate(`document.getElementById('addShoeBtn').click()`);
    await waitFor(
      `!document.getElementById('shoeModal').classList.contains('hidden')`,
    );
    const existingStyles = await evaluate(
      `(()=>{const i=getComputedStyle(document.getElementById('shoeBrand'));const b=getComputedStyle(document.getElementById('formSaveBtn'));return {inputFont:i.fontFamily,inputRadius:i.borderRadius,buttonRadius:b.borderRadius}})()`,
    );
    assert.deepEqual(memoryStyles, existingStyles);
    await command('Network.setCookie', {
      name: SESSION_COOKIE_NAME,
      value: tokens[1],
      url: origin,
      httpOnly: true,
    });
    await command('Page.navigate', { url: origin + '/training-memory.html' });
    await waitFor(
      `document.getElementById('profileForm')?.querySelector('[type=submit]')?.disabled===false`,
    );
    assert.equal(
      await evaluate(`document.getElementById('memoryDebug')`),
      null,
    );
    assert.equal(
      await evaluate(`document.querySelectorAll('#memoryOverview section').length`),
      6,
    );
    for(const language of ['en-US','pt-BR']) {
      await evaluate(`document.querySelector(".lang-switch [data-lang='${language}']").click()`);
      await waitFor(`document.documentElement.lang==='${language}'`);
      for(const width of [1280,390]) {
        await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
        assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
        assert.equal(await evaluate("document.querySelector('#memoryOverview a').getAttribute('href')"),'/cycles.html');
        const shot=await command('Page.captureScreenshot',{format:'png'});
        writeFileSync(`/tmp/kinesis-memory-empty-${language}-${width}.png`,Buffer.from(shot.data,'base64'));
      }
    }
    db.prepare("INSERT INTO training_cycles(id,user_id,objective,status) VALUES ('user-cycle',2,'Own regular cycle','active')").run();
    db.prepare("INSERT INTO trainings(user_id,dia,tipo,treino,feedback_pain,feedback_has_pain) VALUES (2,date('now'),'Run','Own regular session','Dated synthetic discomfort','yes')").run();
    await evaluate("document.getElementById('reloadMemory').click()");
    await waitFor("document.getElementById('memoryOverview').textContent.includes('Dated synthetic discomfort')");
    assert.equal(await evaluate("document.getElementById('memoryOverview').textContent.includes('Synthetic corrected goal')"),false);
    db.prepare("UPDATE trainings SET feedback_has_pain='no',feedback_pain='' WHERE user_id=2").run();
    await evaluate("document.getElementById('reloadMemory').click()");
    await waitFor("document.getElementById('memoryOverview').textContent.includes('Desconforto relatado: Não')");
    // Check focus identity across translation when several links share the same URL.
    await evaluate("document.querySelector('[data-memory-link=weekly]').focus()");
    await evaluate(`document.querySelector(".lang-switch [data-lang='en-US']").click()`);
    await waitFor("document.documentElement.lang==='en-US'");
    // Changing language through a pointer legitimately focuses its trigger;
    // dispatching the event with the source link focused preserves that link.
    await evaluate("document.querySelector('[data-memory-link=weekly]').focus();document.dispatchEvent(new Event('app:languagechange'))");
    assert.equal(await evaluate('document.activeElement.dataset.memoryLink'),'weekly');
    for(const roleCase of ['regular-history','admin-empty']) {
      if(roleCase==='admin-empty') {
        await command('Network.setCookie',{name:SESSION_COOKIE_NAME,value:tokens[2],url:origin,httpOnly:true});
        await command('Page.navigate',{url:origin+'/training-memory.html'});
        await waitFor("document.getElementById('profileForm')?.querySelector('[type=submit]')?.disabled===false");
      }
      for(const language of ['en-US','pt-BR']) {
        await evaluate(`document.querySelector(".lang-switch [data-lang='${language}']").click()`);
        await waitFor(`document.documentElement.lang==='${language}'`);
        for(const width of [1280,390]) {
          await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
          assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
          assert.equal(await evaluate("!!document.getElementById('memoryDebug')"),roleCase==='admin-empty');
          const shot=await command('Page.captureScreenshot',{format:'png'});
          writeFileSync(`/tmp/kinesis-memory-${roleCase}-${language}-${width}.png`,Buffer.from(shot.data,'base64'));
        }
      }
    }
    assert.equal(requests.some((r)=>r.url.includes('api.openai.com')),false);
  } finally {
    socket?.close();
    process.kill('SIGTERM');
    await once(process, 'exit').catch(() => {});
    await app.close();
    db.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
