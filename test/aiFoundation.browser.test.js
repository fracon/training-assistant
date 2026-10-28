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
  const memoryTrainingId = db.prepare("SELECT id FROM trainings WHERE user_id=1 AND treino='Synthetic recent run'").get().id;
  const memoryNow = new Date().toISOString();
  db.prepare("INSERT INTO workout_analysis_versions(id,user_id,training_id,sequence,adapter_version,context_json,response_json,state,language,created_at) VALUES ('memory-analysis',1,?,1,'test-v1','{}','{}','completed','en-US',?)").run(memoryTrainingId,memoryNow);
  const insertMemoryInterpretation = db.prepare(`INSERT INTO ai_interpretations
    (id,user_id,training_id,analysis_id,kind,text,evidence_json,evidence_key,evidence_hash,content_hash,disposition,correction_text,version,created_at,updated_at)
    VALUES (?,1,?,'memory-analysis','pattern',?,'[]','[]',?,?,?, ?,1,?,?)`);
  insertMemoryInterpretation.run('memory-confirm',memoryTrainingId,'Synthetic confirmation text','evidence-confirm','content-confirm','pending',null,memoryNow,memoryNow);
  insertMemoryInterpretation.run('memory-dismiss-corrected',memoryTrainingId,'Synthetic original to retain','evidence-dismiss','content-dismiss','corrected','Synthetic saved correction to retain',memoryNow,memoryNow);
  insertMemoryInterpretation.run('memory-correct',memoryTrainingId,'Synthetic original for correction','evidence-correct','content-correct','pending',null,memoryNow,memoryNow);
  db.prepare("INSERT INTO ai_coach_availability(user_id,day_key,can_train,available_periods,available_minutes,location) VALUES (1,'monday',1,?,60,'Synthetic locality')").run(JSON.stringify(['before_08']));
  for (const day of ['tuesday','wednesday','thursday','friday','saturday','sunday'])
    db.prepare("INSERT INTO ai_coach_availability(user_id,day_key,can_train,available_periods,available_minutes,location) VALUES (1,?,1,?,60,'Synthetic locality')").run(day,JSON.stringify(['before_08']));
  db.prepare("UPDATE ai_coach_availability SET can_train=0,available_periods='[]',available_minutes=NULL,location='' WHERE user_id=1 AND day_key='sunday'").run();
  db.prepare("UPDATE trainings SET detalhes=? WHERE user_id=1").run('Synthetic long planning details. '.repeat(25));
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
    const reopenMemory = async () => {
      await command('Page.navigate',{url:origin+'/training-memory.html'});
      await waitFor("document.getElementById('profileForm')?.querySelector('[type=submit]')?.disabled===false");
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
    assert.equal(await evaluate("document.getElementById('reloadMemory').hidden"),false);
    assert.equal(await evaluate("document.getElementById('reloadMemory').textContent"),'Try again');
    assert.equal(await evaluate("document.querySelector('.memory-header button')"),null);
    await evaluate("document.getElementById('reloadMemory').focus();document.getElementById('reloadMemory').click()");

    await waitFor(
      "document.getElementById('profileForm')?.querySelector('[type=submit]')?.disabled===false",
    );
    assert.equal(
      await evaluate("document.getElementById('experience').value"),
      'Synthetic edit during failed load',
    );
    assert.equal(await evaluate("document.getElementById('reloadMemory').hidden"),true);
    assert.equal(await evaluate("document.getElementById('refreshMemoryVersion').hidden"),true);
    assert.equal(await evaluate("document.activeElement.tagName"),'H1');
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
      assert.equal(await evaluate("document.querySelector('.memory-header button')"),null);
      assert.equal(await evaluate("document.getElementById('reloadMemory').hidden"),true);
      assert.equal(await evaluate("document.getElementById('refreshMemoryVersion').hidden"),true);
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
        await delay(350); // Let the existing shell's responsive sidebar transition settle.
        await command('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        assert.equal(
          await evaluate('document.documentElement.scrollWidth>innerWidth'),
          false,
          JSON.stringify(await evaluate("[...document.querySelectorAll('main *')].filter(e=>e.getBoundingClientRect().right>innerWidth).map(e=>[e.tagName,e.className,e.getBoundingClientRect().width]).slice(0,12)")),
        );
        const shot = await command('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
        });
        writeFileSync(
          `/tmp/kinesis-memory-${language}-${width}.png`,
          Buffer.from(shot.data, 'base64'),
        );
        for (const source of ['availability','recent','weekly']) {
          await evaluate(`document.querySelector('[data-memory-link="${source}"]').closest('section').scrollIntoView({block:'start'})`);
          const sectionShot = await command('Page.captureScreenshot',{format:'png'});
          writeFileSync(`/tmp/kinesis-memory-section-${source}-${language}-${width}.png`,Buffer.from(sectionShot.data,'base64'));
        }
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
    // Planning is progressive disclosure; dated reports never depend on opening it.
    assert.equal(await evaluate("document.querySelector('.memory-planning').open"),false);
    assert.equal(await evaluate("document.querySelector('.memory-feedback').getBoundingClientRect().height>0"),true);
    await evaluate("document.querySelector('.memory-planning summary').focus()");
    assert.equal(await evaluate('document.activeElement.tagName'),'SUMMARY');
    for (const type of ['keyDown','keyUp']) await command('Input.dispatchKeyEvent',{type,key:' ',code:'Space',windowsVirtualKeyCode:32});
    await waitFor("document.querySelector('.memory-planning').open");
    await evaluate("document.dispatchEvent(new Event('app:languagechange'))");
    assert.equal(await evaluate("document.querySelector('.memory-planning').open"),true);
    assert.equal(await evaluate("document.activeElement.tagName"),'SUMMARY');
    assert.equal(await evaluate("document.querySelector('.memory-table tbody tr').dataset.day"),'monday');
    await evaluate("import('./shared/shell.js').then(m=>m.saveUserPreferences({...m.getUserPreferences(),first_day_of_week:'Sunday'}))");
    assert.equal(await evaluate("document.querySelector('.memory-table tbody tr').dataset.day"),'sunday');
    await evaluate("import('./shared/shell.js').then(m=>m.saveUserPreferences({...m.getUserPreferences(),first_day_of_week:'Monday'}))");
    assert.equal(await evaluate("document.querySelectorAll('.memory-table caption').length>=2"),true);
    await evaluate("document.querySelector('[data-memory-link=\"table:memory-weekly\"]').focus();document.dispatchEvent(new Event('app:languagechange'))");
    assert.equal(await evaluate('document.activeElement.dataset.memoryLink'),'table:memory-weekly');
    const tableScroll = await evaluate("(()=>{const region=document.querySelector('[data-memory-link=\"table:memory-weekly\"]');region.scrollLeft=0;return {before:region.scrollLeft,max:region.scrollWidth-region.clientWidth};})()");
    assert.ok(tableScroll.max>0);
    for (const type of ['keyDown','keyUp']) await command('Input.dispatchKeyEvent',{type,key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
    await waitFor("document.querySelector('[data-memory-link=\"table:memory-weekly\"]').scrollLeft>0");
    assert.equal(await evaluate("document.getElementById('memoryDebug').open"),false);
    assert.equal(await evaluate("document.getElementById('previewDate').getBoundingClientRect().height"),0);
    await evaluate("document.querySelector('#memoryDebug > summary').click()");
    await command('Emulation.clearDeviceMetricsOverride');
    await evaluate(
      `document.querySelector('#previewForm [type=submit]').click()`,
    );
    await waitFor(`document.getElementById('promptPreview').value.length>100`);
    assert.ok(
      (
        await evaluate(`document.getElementById('contextPreview').value`)
      ).includes('training-context-v5'),
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
    assert.equal(await evaluate("document.getElementById('reloadMemory').hidden"),true);
    assert.equal(await evaluate("document.getElementById('refreshMemoryVersion').hidden"),false);
    await evaluate(`document.getElementById('refreshMemoryVersion').focus();document.getElementById('refreshMemoryVersion').click()`);
    await waitFor(
      `!document.getElementById('profileForm').querySelector('[type=submit]').disabled`,
    );
    assert.equal(
      await evaluate(`document.getElementById('experience').value`),
      'Synthetic preserved edit',
    );
    await evaluate("document.getElementById('profileForm').requestSubmit()");
    await waitFor("!document.querySelector('#profileForm [type=submit]').disabled");
    assert.equal(db.prepare('SELECT fields_json FROM ai_profiles WHERE user_id=1').get().fields_json.includes('Synthetic preserved edit'),true);
    // Canonical corrections appear on refresh, without another personal form.
    db.prepare("UPDATE training_cycles SET primary_goal='Synthetic corrected goal' WHERE id='cycle'").run();
    await reopenMemory();
    await waitFor("document.getElementById('memoryOverview').textContent.includes('Synthetic corrected goal')");
    await evaluate(`(()=>{const original=window.fetch.bind(window);window.__failMemoryGet=false;window.__memoryGetCalls=0;window.fetch=(input,init)=>{if(String(input)==='/api/ai/memory'&&(!init?.method||init.method==='GET'))window.__memoryGetCalls++;if(window.__failMemoryGet&&String(input)==='/api/ai/memory'&&(!init?.method||init.method==='GET')){window.__failMemoryGet=false;return Promise.reject(new TypeError('synthetic memory refresh failure'))}return original(input,init)}})()`);
    assert.equal(await evaluate("!!document.querySelector('[data-memory-action=\"memory-confirm:confirm\"]')"),true,'the pending synthetic interpretation exposes its confirm action');
    assert.equal(await evaluate("document.querySelector('[data-memory-action=\"memory-confirm:confirm\"]').disabled"),false,'memory actions are ready after the persisted overview loads');
    await evaluate("window.__failMemoryGet=true;document.querySelector('[data-memory-action=\"memory-confirm:confirm\"]').click()");
    await waitFor('window.__memoryGetCalls===1');
    await waitFor("document.getElementById('memoryError').textContent.length>0");
    assert.equal(db.prepare("SELECT disposition FROM ai_interpretations WHERE id='memory-confirm'").get().disposition,'confirmed','confirmation is persisted before the simulated follow-up read failure');
    assert.equal(await evaluate("document.querySelector('[data-memory-item=\"memory-confirm\"]').textContent.includes('Synthetic confirmation text')"),true,'confirmation preserves the API text field when the subsequent memory GET fails');
    assert.equal(await evaluate("document.querySelector('[data-memory-item=\"memory-confirm\"]').textContent.includes('undefined')"),false);
    assert.equal(await evaluate("(()=>{const text=document.querySelector('[data-memory-item=\"memory-confirm\"]').textContent;return text.includes('will be checked when the memory refreshes')||text.includes('será verificada ao atualizar a memória')})()"),true,'unverified context membership is not optimistically shown as included');
    await evaluate("document.getElementById('reloadMemory').click()");
    await waitFor("document.getElementById('memoryError').classList.contains('hidden')");
    await waitFor("document.getElementById('profileForm').querySelector('[type=submit]').disabled===false");
    await evaluate("window.__failMemoryGet=true;document.querySelector('[data-memory-action=\"memory-dismiss-corrected:discard\"]').click()");
    await waitFor('window.__memoryGetCalls===3');
    await waitFor("document.getElementById('memoryError').textContent.length>0");
    assert.equal(db.prepare("SELECT disposition FROM ai_interpretations WHERE id='memory-dismiss-corrected'").get().disposition,'dismissed');
    assert.equal(await evaluate("(()=>{const text=document.querySelector('[data-memory-item=\"memory-dismiss-corrected\"]').textContent;return text.includes('Synthetic original to retain')&&text.includes('Synthetic saved correction to retain')&&!text.includes('undefined')})()"),true,'discarding a corrected item preserves its original and correction history');
    await evaluate("document.getElementById('reloadMemory').click()");
    await waitFor("document.getElementById('memoryError').classList.contains('hidden')");
    await waitFor("document.getElementById('profileForm').querySelector('[type=submit]').disabled===false");
    await evaluate("document.querySelector('[data-memory-action=\"memory-correct:correct\"]').click();document.querySelector('[data-memory-item=\"memory-correct\"] textarea').value='Synthetic correction kept after refresh failure';window.__failMemoryGet=true;document.querySelector('[data-memory-action=\"memory-correct:save-correction\"]').click()");
    await waitFor('window.__memoryGetCalls===5');
    await waitFor("document.getElementById('memoryError').textContent.length>0");
    assert.equal(db.prepare("SELECT correction_text FROM ai_interpretations WHERE id='memory-correct'").get().correction_text,'Synthetic correction kept after refresh failure','correction persists before its follow-up read');
    assert.equal(await evaluate("(()=>{const text=document.querySelector('[data-memory-item=\"memory-correct\"]').textContent;return text.includes('Synthetic original for correction')&&text.includes('Synthetic correction kept after refresh failure')&&!text.includes('undefined')})()"),true,'the successful correction and original remain visible when the refresh fails');
    await evaluate("document.getElementById('reloadMemory').click()");
    await waitFor("document.getElementById('memoryError').classList.contains('hidden')");
    await waitFor("document.getElementById('profileForm').querySelector('[type=submit]').disabled===false");
    // Per-source dates remain visible when different; legacy periods stay explicit.
    assert.equal(await evaluate("document.querySelectorAll('.memory-row-note').length"),0);
    db.prepare("UPDATE ai_coach_availability SET updated_at='2026-01-01',available_periods=? WHERE user_id=1 AND day_key='monday'").run(JSON.stringify(['before_08','08_12']));
    await reopenMemory();
    await waitFor("!document.querySelector('#profileForm [type=submit]').disabled");
    assert.equal(await evaluate("document.querySelectorAll('.memory-row-note').length"),8);
    assert.equal(await evaluate("document.querySelector('[data-day=sunday] td').textContent"),'Indisponível');
    // A real conflict exposes version recovery, without a permanent refresh action.
    db.prepare('UPDATE ai_profiles SET version=version+1 WHERE user_id=1').run();
    await evaluate("document.getElementById('profileForm').requestSubmit()");
    await waitFor("document.getElementById('refreshMemoryVersion').hidden===false");
    // Hold a real reload and move focus: the refresh must not take focus away.
    await command('Fetch.enable',{patterns:[{urlPattern:origin+'/api/ai/memory',requestStage:'Request'}]});
    const pausedLoad = new Promise((resolve) => {
      const handler = (event) => { const message=JSON.parse(event.data); if(message.method==='Fetch.requestPaused') {socket.removeEventListener('message',handler);resolve(message.params.requestId);} };
      socket.addEventListener('message',handler);
    });
    await evaluate("document.getElementById('refreshMemoryVersion').focus();document.getElementById('refreshMemoryVersion').click()");
    const requestId=await pausedLoad;
    await evaluate("document.getElementById('experience').focus()");
    await command('Fetch.continueRequest',{requestId});
    await waitFor("!document.querySelector('#profileForm [type=submit]').disabled");
    await command('Fetch.disable');
    assert.equal(await evaluate('document.activeElement.id'),'experience');
    await evaluate("document.getElementById('memoryDebug').open=true");
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
      7,
    );
    for(const language of ['en-US','pt-BR']) {
      await evaluate(`document.querySelector(".lang-switch [data-lang='${language}']").click()`);
      await waitFor(`document.documentElement.lang==='${language}'`);
      for(const width of [1280,390]) {
        await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
        await delay(350);
        assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
        assert.equal(await evaluate("document.querySelector('#memoryOverview a').getAttribute('href')"),'/cycles.html');
        const shot=await command('Page.captureScreenshot',{format:'png'});
        writeFileSync(`/tmp/kinesis-memory-empty-${language}-${width}.png`,Buffer.from(shot.data,'base64'));
      }
    }
    db.prepare("INSERT INTO training_cycles(id,user_id,objective,status) VALUES ('user-cycle',2,'Own regular cycle','active')").run();
    db.prepare("INSERT INTO trainings(user_id,dia,tipo,treino,feedback_pain,feedback_has_pain) VALUES (2,date('now'),'Run','Own regular session','Dated synthetic discomfort','yes')").run();
    await reopenMemory();
    await waitFor("document.getElementById('memoryOverview').textContent.includes('Dated synthetic discomfort')");
    assert.equal(await evaluate("document.getElementById('memoryOverview').textContent.includes('Synthetic corrected goal')"),false);
    db.prepare("UPDATE trainings SET feedback_has_pain='no',feedback_pain='' WHERE user_id=2").run();
    await reopenMemory();
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
          await delay(350);
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
