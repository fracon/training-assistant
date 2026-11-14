'use strict';

// Athlete anamnesis as the entry gate (issue #80, PR 2, owner decision
// 2026-11-14) in real Chrome: registration and every other page lead to the
// anamnesis until it is completed, the navigation is locked with a note, a
// cycle cannot be created, completing it unlocks Kinesis, and the AI
// requirement notices still explain a refusal when the anamnesis disappears
// in another tab. Training memory shows the source. PT/EN, desktop/mobile.
// Synthetic data, no provider or weather call.

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { readAiConfig } = require('../src/ai/config');
const { readAnamnesis, saveAnamnesis, addWeight } = require('../src/anamnesis');
const { launchChrome } = require('./helpers/chrome.cjs');
const en = require('../src/public/locales/en.json');
const pt = require('../src/public/locales/pt.json');

const fill = (pairs) => `(()=>{${pairs.map(([id, value]) => `{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));}`).join('')}})()`;
const YEAR = new Date().getUTCFullYear();
const ANSWERS = {
  birth_year: { status: 'answered', value: YEAR - 30 },
  height_cm: { status: 'declined' },
  weight: { status: 'answered' },
  motivations: { status: 'answered', value: { options: ['health'] } },
  running_experience: { status: 'answered', value: 'two_to_5_years' },
  recent_consistency: { status: 'answered', value: 'regular' },
  runs_per_week: { status: 'answered', value: 3 },
  weekly_distance_km: { status: 'answered', value: 20 },
  longest_run_km: { status: 'unknown' },
  race_results: { status: 'answered', value: [] },
  strength_training: { status: 'answered', value: 'none' },
  other_activities: { status: 'answered', value: { answer: 'no' } },
  hr_device: { status: 'unknown' },
  current_pain: { status: 'answered', value: { answer: 'no' } },
  injuries_12_months: { status: 'unknown' },
  professional_restriction: { status: 'declined' },
  health_conditions: { status: 'unknown' },
};

test('Chrome PT/EN desktop/mobile: the anamnesis gates Kinesis until it is completed', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  let providerCalls = 0;
  let weatherCalls = 0;
  const app = await buildServer({
    db,
    sessionCookieSecure: false,
    aiConfig: readAiConfig({ AI_ENABLED: 'true', OPENAI_API_KEY: 'synthetic-test-key' }),
    aiClient: async () => { providerCalls++; throw new Error('no provider call expected'); },
    weatherFetch: async () => { weatherCalls++; throw new Error('no weather call expected'); },
  });
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => { await app.close(); db.close(); });
  const { command, evaluate, wait, capture, socket } = await launchChrome(t);
  const exceptions = [];
  let fakeStatus = null;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    // Simulates the anamnesis erased in another tab after the page loaded.
    if (message.method === 'Fetch.requestPaused') {
      const { requestId } = message.params;
      if (fakeStatus) command('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ status: fakeStatus })).toString('base64') });
      else command('Fetch.continueRequest', { requestId });
    }
  });
  await command('Runtime.enable');
  const today = new Date().toISOString().slice(0, 10);
  const target = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const onAnamnesis = (language) => `location.pathname === '/anamnesis.html' && document.documentElement.lang === '${language}' && !document.getElementById('anamnesisWelcome').hidden && !!document.getElementById('anamnesisLockNote')`;

  for (const [language, messages, width] of [['pt-BR', pt, 1280], ['en-US', en, 390]]) {
    const a = messages.anamnesis;
    await command('Network.clearBrowserCookies');
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
    const email = `anamnesis-gate-${language.toLowerCase()}@example.test`;

    // Registration leads to the anamnesis, welcoming the new account.
    await command('Page.navigate', { url: `${origin}/register.html` });
    await wait("!!document.getElementById('registerForm') && document.getElementById('preferredLang').value === document.documentElement.lang");
    await evaluate(fill([['firstName', 'Synthetic'], ['lastName', 'Runner'], ['email', email], ['password', 'runner-secret-1'], ['confirm', 'runner-secret-1']]));
    await evaluate(`document.getElementById('preferredLang').value = '${language}';document.getElementById('submitBtn').click()`);
    await wait(onAnamnesis(language));
    assert.equal(await evaluate('location.search'), '', 'the transient parameter is consumed');
    assert.equal(await evaluate("document.getElementById('anamnesisWelcomeTitle').textContent"), a.gate.welcome.title);
    assert.equal(await evaluate("document.getElementById('anamnesisContinueActions').hidden"), true);
    // Nothing is stored yet, so there is nothing to download or erase.
    assert.equal(await evaluate("getComputedStyle(document.getElementById('anamnesisDataActions')).display"), 'none');
    // Every navigation entry is locked and described by the note.
    assert.equal(await evaluate("document.querySelector('#anamnesisLockNote .nav-lock-title').textContent"), messages.shell.anamnesisLockTitle);
    assert.equal(await evaluate("document.querySelector('#anamnesisLockNote .nav-lock-detail').textContent"), messages.shell.anamnesisLock);
    assert.equal(await evaluate("[...document.querySelectorAll('.sidebar-nav .cycle-guard-badge')].every((b)=>getComputedStyle(b).display==='none')"), true, 'no missing-cycle chip while locked');
    // The note wraps inside the sidebar instead of being clipped to one line.
    if (width === 1280)
      assert.equal(await evaluate("(()=>{const n=document.getElementById('anamnesisLockNote');return n.scrollWidth<=n.clientWidth && n.getBoundingClientRect().height>40 && n.getBoundingClientRect().right<=n.closest('.sidebar').getBoundingClientRect().right;})()"), true);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.sidebar-nav .nav-item')].filter((e)=>e.getAttribute('aria-disabled')!=='true'||e.hasAttribute('href')||!(e.getAttribute('aria-describedby')||'').includes('anamnesisLockNote')).map((e)=>e.dataset.navId)"), []);
    assert.equal(await evaluate("document.getElementById('anamnesisSources').closest('[hidden]') !== null"), true);
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    await capture(`anamnesis-gate-welcome-${language}-${width}`);
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;

    // Every other page, served by a route or statically, leads back to it.
    for (const page of ['/home.html', '/cycles.html', '/calendar.html', '/shoes.html', '/weight.html', '/training-memory.html', '/ai-coach.html', '/']) {
      await command('Page.navigate', { url: `${origin}${page}` });
      await wait(onAnamnesis(language));
      assert.equal(await evaluate("document.getElementById('anamnesisWelcomeTitle').textContent"), a.gate.required.title, page);
    }
    // A cycle cannot be created through the API either.
    assert.equal(await evaluate("fetch('/api/cycles',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({objective:'Synthetic'})}).then(async(r)=>r.status+':'+(await r.json()).error)"), '409:anamnesisRequired');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM training_cycles WHERE user_id = ?').get(userId).n, 0);

    // Completing it unlocks Kinesis from the page itself.
    addWeight(db, userId, { measured_on: today, weight_kg: 70 });
    saveAnamnesis(db, userId, { answers: ANSWERS, expected_revision: readAnamnesis(db, userId).anamnesis.revision });
    await command('Page.reload');
    await wait("!document.getElementById('anamnesisReview').hidden && !document.getElementById('anamnesisReviewActions').hidden");
    assert.equal(await evaluate("document.getElementById('anamnesisDataActions').hidden"), false, 'answers and a weight are stored');
    await evaluate("document.getElementById('anamnesisComplete').click()");
    await wait("!document.getElementById('anamnesisContinueActions').hidden");
    assert.equal(await evaluate("document.getElementById('anamnesisWelcomeTitle').textContent"), a.gate.done.title);
    assert.equal(await evaluate("document.getElementById('anamnesisLockNote')"), null);
    assert.equal(await evaluate("document.querySelector('.sidebar-nav .nav-item[data-nav-id=\"shoes\"]').getAttribute('href')"), '/shoes.html');
    assert.equal(await evaluate("document.querySelector('.sidebar-nav .nav-item[data-nav-id=\"ai-coach\"]').classList.contains('disabled')"), true, 'the cycle guard still applies');
    assert.equal(await evaluate("document.getElementById('anamnesisSources').hidden"), false);
    await capture(`anamnesis-gate-done-${language}-${width}`);
    await evaluate("document.getElementById('anamnesisContinue').click()");
    await wait("location.pathname === '/home.html'");

    // If the anamnesis disappears in another tab, the AI notices explain the
    // refusal instead of generating.
    db.prepare("INSERT INTO training_cycles(id,user_id,objective,status,start_date,target_date) VALUES (?,?,'Synthetic goal','active',?,?)").run(`cycle-${userId}`, userId, today, target);
    await command('Page.navigate', { url: `${origin}/cycles.html` });
    await wait("!!document.querySelector('[data-action=\"planning\"]')");
    db.prepare("UPDATE athlete_anamnesis SET status = 'draft', completed_at = NULL WHERE user_id = ?").run(userId);
    await evaluate("document.querySelector('[data-action=\"planning\"]').click()");
    await wait("!!document.querySelector('#cyclePlanningContent .cycle-planning-anamnesis')");
    assert.equal(await evaluate("document.getElementById('cyclePlanningStatus').textContent"), messages.cyclePlanning.anamnesisRequired);
    assert.equal(await evaluate("document.querySelector('.cycle-planning-anamnesis a').getAttribute('href')"), '/anamnesis.html');
    assert.equal(await evaluate("document.getElementById('cyclePlanningGenerate').hidden"), true);
    assert.equal(await evaluate("document.getElementById('cyclePlanningLater').textContent"), messages.cyclePlanning.done);
    await capture(`anamnesis-cycle-notice-${language}-${width}`);
    await evaluate("document.getElementById('cyclePlanningLater').click()");
    db.prepare("UPDATE athlete_anamnesis SET status = 'completed', completed_at = ? WHERE user_id = ?").run(new Date().toISOString(), userId);

    fakeStatus = 'draft';
    await command('Fetch.enable', { patterns: [{ urlPattern: '*/api/anamnesis/status' }] });
    await command('Page.navigate', { url: `${origin}/ai-coach.html` });
    await wait("!document.getElementById('anamnesisNotice').hidden");
    assert.equal(await evaluate("document.querySelector('#anamnesisNotice span').textContent"), messages.aiCoach.anamnesisNotice);
    assert.equal(await evaluate("document.querySelector('#anamnesisNotice a').getAttribute('href')"), '/anamnesis.html');
    assert.equal(await evaluate("document.getElementById('generateBtn').disabled"), true);
    await evaluate("document.getElementById('anamnesisNotice').scrollIntoView({block:'center'})");
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    await capture(`anamnesis-weekly-notice-${language}-${width}`);
    fakeStatus = null;
    await command('Fetch.disable');

    // Training memory shows the completed anamnesis as a source.
    await command('Page.navigate', { url: `${origin}/training-memory.html` });
    await wait("!!document.getElementById('memory-anamnesis')");
    assert.equal(await evaluate("document.getElementById('memory-anamnesis').textContent"), messages.memory.anamnesis);
    const section = "document.getElementById('memory-anamnesis').closest('section')";
    assert.ok((await evaluate(`${section}.textContent`)).includes(messages.memory.anamnesisUsed));
    assert.ok((await evaluate(`${section}.textContent`)).includes(messages.memory.anamnesisNotShared));
    assert.equal(await evaluate(`${section}.querySelector('a.memory-source').getAttribute('href')`), '/anamnesis.html');
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    await evaluate(`${section}.scrollIntoView({block:'center'})`);
    await capture(`anamnesis-memory-source-${language}-${width}`);
  }
  assert.equal(providerCalls, 0);
  assert.equal(weatherCalls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_executions').get().n, 0);
  assert.deepEqual(exceptions, []);
});
