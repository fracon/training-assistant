'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { launchChrome } = require('./helpers/chrome.cjs');

const PT = require('../src/public/locales/pt.json').memory;
const EN = require('../src/public/locales/en.json').memory;

async function setup(t) {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false, unsplashFetch: async () => { throw new Error('No hero image in tests.'); } });
  const origin = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/\/$/, '');
  t.after(async () => { await app.close(); db.close(); });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'tabs@example.test', password: 'tabs-secret-1', first_name: 'Tab', last_name: 'Runner', preferred_lang: 'pt-BR' } });
  db.prepare("UPDATE users SET onboarding_status='active', time_zone='UTC'").run();
  const today = new Date().toISOString().slice(0, 10);
  const day = (n) => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
  db.prepare("INSERT INTO training_cycles(id,user_id,objective,status,start_date,target_date) VALUES ('c',1,'Meia maratona','active',?,?)").run(day(-40), day(60));
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino,completed,feedback_rpe,feedback_has_pain,feedback_pain,fit_distance,fit_duration) VALUES (1,1,?,'Run','Tiros',1,5,'yes','Canela',8,'45:00')").run(day(-2));
  const phase = (name, a, b) => ({ name, start: day(a), end: day(b), objective: `${name} objective`, volume: 'v', longRuns: 'l', quality: 'q', intensity: 'i', easyRuns: 'e', strength: 's', risks: 'r', advanceCriteria: 'c', rationale: 'r', evidence: [] });
  const plan = { schemaVersion: 'cycle-plan-v1', cycleId: 'c', start: day(-40), end: day(60), assessment: 'a', continuity: 'c', feasibility: 'f', confidence: 'moderate',
    phases: [phase('Base', -40, -10), phase('Build', -9, 30), phase('Taper', 31, 60)], indicators: ['RPE', 'Volume', 'Long run', 'Pain', 'Recovery'],
    adaptations: { increase: 'x', maintain: 'x', reduce: 'x', replaceQuality: 'x', reduceLongRun: 'x' }, uncertainties: [], assumptions: [], questions: [] };
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO cycle_plan_versions(id,user_id,cycle_id,version,plan_json,context_hash,cycle_hash,fingerprint_json,sources_json,applied_at) VALUES ('p',1,'c',1,?,'h','h','{}','[]',?)").run(JSON.stringify(plan), `${day(-39)}T10:00:00.000Z`);
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO workout_analysis_versions(id,user_id,training_id,sequence,adapter_version,context_json,state,language,created_at)
    VALUES ('analysis',1,1,1,'workout-analysis-v1','{}','completed','pt-BR',?)`).run(`${day(-1)}T10:00:00.000Z`);
  db.prepare(`INSERT INTO ai_interpretations(id,user_id,training_id,analysis_id,kind,text,evidence_json,evidence_key,evidence_hash,content_hash,disposition,created_at,updated_at)
    VALUES ('race','1',1,'analysis','pattern','Synthetic hypothesis','[]','[]','h','c','pending',?,?),
      ('lock','1',1,'analysis','pattern','Second hypothesis','[]','[]','h2','c2','pending',?,?)`).run(`${day(-1)}T11:00:00.000Z`, `${day(-1)}T11:00:00.000Z`, `${day(-1)}T11:00:00.000Z`, `${day(-1)}T11:00:00.000Z`);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'tabs@example.test', password: 'tabs-secret-1' } });
  const cookie = [].concat(login.headers['set-cookie'])[0].split(';')[0].split('=')[1];
  return { origin, cookie };
}

const state = `(() => ({
  selected: [...document.querySelectorAll('#purposeTabs [role=tab]')].filter((tab) => tab.getAttribute('aria-selected') === 'true').map((tab) => tab.dataset.purpose),
  tabIndexes: [...document.querySelectorAll('#purposeTabs [role=tab]')].map((tab) => tab.tabIndex),
  labelledBy: document.getElementById('memoryPurposePanel').getAttribute('aria-labelledby'),
  focus: document.activeElement.id,
  task: document.getElementById('purposeTask').textContent,
  headings: [...document.querySelectorAll('#memoryOverview h2')].map((h) => h.textContent),
  badges: [...document.querySelectorAll('.memory-badge')].map((b) => b.textContent),
  currentPhase: document.querySelector('.memory-phase-current')?.textContent ?? null,
  overflow: document.documentElement.scrollWidth > innerWidth,
}))()`;

test('Chrome: training memory shows each AI task context through accessible tabs and ignores stale reads', async (t) => {
  const { origin, cookie } = await setup(t);
  const browser = await launchChrome(t);
  const { command, evaluate, wait, key } = browser;
  await command('Network.setCookie', { name: 'ta_session', value: cookie, url: origin, httpOnly: true });
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: `${origin}/training-memory.html` });
  await wait("document.getElementById('purposeTask').textContent.length > 0");

  let view = await evaluate(state);
  assert.deepEqual(view.selected, ['cycle']);
  assert.deepEqual(view.tabIndexes, [0, -1, -1]);
  assert.equal(view.task, PT.task.cycle.replace('{objective}', 'Meia maratona'));
  assert.ok(view.headings.includes(PT.previousCycles) && view.headings.includes(PT.shoes));
  assert.ok(!view.headings.includes(PT.plan), 'cycle planning does not read the applied plan');
  assert.deepEqual(view.badges, [PT.priority.concern]);

  // Arrow keys move and select; the panel follows the selected tab.
  await evaluate("document.getElementById('purposeTab-cycle').focus()");
  await key('ArrowRight', 'ArrowRight', 39);
  await wait("document.getElementById('purposeTask').textContent.includes('" + PT.task.workouts.split('{')[0] + "')");
  view = await evaluate(state);
  assert.deepEqual(view.selected, ['workouts']);
  assert.deepEqual(view.tabIndexes, [-1, 0, -1]);
  assert.equal(view.labelledBy, 'purposeTab-workouts');
  assert.equal(view.focus, 'purposeTab-workouts');
  assert.ok(view.headings.includes(PT.plan));
  assert.match(view.currentPhase, /^Build · /);
  assert.ok(view.task.endsWith(PT.task.weatherNote));
  await key('End', 'End', 35);
  await wait("document.getElementById('purposeTask').textContent.includes('Tiros')");
  assert.deepEqual((await evaluate(state)).selected, ['analysis']);
  // The analyzed session itself is shown with its results and reports, not only named.
  const analyzed = await evaluate(`(() => { const card = document.getElementById('memory-analyzed')?.closest('section'); return card && { text: card.textContent, badge: card.querySelector('.memory-badge')?.textContent, href: card.querySelector('a[href^="/training-result.html"]:not(.memory-card-header a)')?.getAttribute('href') }; })()`);
  assert.ok(analyzed, 'the analysis tab has an analyzed-workout section');
  assert.ok(analyzed.text.includes('Canela') && analyzed.text.includes('8.00 km'), 'its discomfort report and recorded distance are visible');
  assert.equal(analyzed.badge, PT.priority.concern);
  assert.equal(analyzed.href, '/training-result.html?id=1');
  assert.ok((await evaluate(state)).headings.includes(PT.analyzed));
  await key('Home', 'Home', 36);
  await wait("document.getElementById('purposeTab-cycle').getAttribute('aria-selected') === 'true' && document.getElementById('purposeTask').textContent.includes('Meia maratona')");

  // A slow reply for an earlier tab never replaces the tab the athlete chose since.
  const held = await browser.intercept(`${origin}/api/ai/memory?purpose=workouts*`);
  await evaluate("document.getElementById('purposeTab-workouts').click()");
  const paused = await held.next;
  await evaluate("document.getElementById('purposeTab-analysis').click()");
  await wait("document.getElementById('purposeTask').textContent.includes('Tiros')");
  await held.release(paused);
  await new Promise((resolve) => setTimeout(resolve, 500));
  view = await evaluate(state);
  assert.deepEqual(view.selected, ['analysis']);
  assert.ok(view.task.includes('Tiros'), 'the late workouts reply was ignored');

  // A follow-up read after an interpretation decision cannot overwrite a tab chosen meanwhile.
  await evaluate("document.getElementById('purposeTab-cycle').click()");
  await wait("document.getElementById('purposeTask').textContent.includes('Meia maratona') && !!document.querySelector('[data-memory-action=\\'race:confirm\\']')");
  const refresh = await browser.intercept(`${origin}/api/ai/memory?purpose=cycle*`);
  await evaluate("document.querySelector('[data-memory-action=\\'race:confirm\\']').click()");
  const heldRefresh = await refresh.next;
  await evaluate("document.getElementById('purposeTab-workouts').click()");
  await wait("document.getElementById('purposeTask').textContent.includes('" + PT.task.workouts.split('{')[0] + "')");
  await refresh.release(heldRefresh);
  await new Promise((resolve) => setTimeout(resolve, 500));
  view = await evaluate(state);
  assert.deepEqual(view.selected, ['workouts']);
  assert.ok(view.headings.includes(PT.plan), 'the workouts view stays rendered after the late cycle reply');
  await evaluate("document.getElementById('purposeTab-analysis').click()");
  await wait("document.getElementById('purposeTask').textContent.includes('Tiros')");

  // Tabs wait while a write is in flight, so its completion always finds its own task.
  await evaluate("document.getElementById('purposeTab-cycle').click()");
  await wait("!!document.querySelector('[data-memory-action=\\'lock:confirm\\']') && document.getElementById('purposeTask').textContent.includes('Meia maratona')");
  const write = await browser.intercept(`${origin}/api/ai/interpretations/lock/confirm`);
  await evaluate("document.querySelector('[data-memory-action=\\'lock:confirm\\']').click()");
  const heldWrite = await write.next;
  assert.equal(await evaluate("document.getElementById('purposeTab-analysis').getAttribute('aria-disabled')"), 'true');
  await evaluate("document.getElementById('purposeTab-analysis').click()");
  assert.deepEqual((await evaluate(state)).selected, ['cycle'], 'a tab cannot be selected mid-write');
  await write.release(heldWrite);
  await wait("document.getElementById('purposeTab-analysis').getAttribute('aria-disabled') === null && !document.querySelector('[data-memory-action=\\'lock:confirm\\']')");
  assert.equal(await evaluate("document.getElementById('memoryError').classList.contains('hidden')"), true, 'the committed decision reports no error');

  // A failed tab load never leaves the previous task's context under the new tab.
  await evaluate("document.getElementById('purposeTab-cycle').click()");
  await wait("document.getElementById('purposeTask').textContent.includes('Meia maratona')");
  await evaluate(`(() => { const original = window.fetch.bind(window); let failOnce = true; window.fetch = (input, init) => {
    if (failOnce && String(input).startsWith('/api/ai/memory?purpose=analysis')) { failOnce = false; return Promise.reject(new TypeError('synthetic tab failure')); }
    return original(input, init); }; })()`);
  await evaluate("document.getElementById('purposeTab-analysis').click()");
  await wait("!document.getElementById('memoryError').classList.contains('hidden')");
  const failed = await evaluate(`({ task: document.getElementById('purposeTask').textContent, sections: document.querySelectorAll('#memoryOverview section').length, notice: document.getElementById('selectionNotice').hidden, retry: !document.getElementById('reloadMemory').hidden, busy: document.getElementById('memoryPurposePanel').getAttribute('aria-busy'), save: document.querySelector('#profileForm [type=submit]').disabled })`);
  assert.deepEqual(failed, { task: '', sections: 0, notice: true, retry: true, busy: null, save: true });
  await evaluate("document.getElementById('reloadMemory').click()");
  await wait("document.getElementById('purposeTask').textContent.includes('Tiros') && document.getElementById('memoryError').classList.contains('hidden')");
  assert.deepEqual((await evaluate(state)).selected, ['analysis']);

  // Summary tiles, the quality checklist and the experience editor cues.
  const insights = await evaluate(`({
    labels: [...document.querySelectorAll('.memory-stat-label')].map((label) => label.textContent),
    concerns: document.querySelector('.memory-stat-alert .memory-stat-value')?.textContent,
    experience: (() => { const item = document.querySelector('[data-quality="experience"]'); return item && { ok: item.classList.contains('is-ok'), href: item.querySelector('a')?.getAttribute('href') }; })(),
    counter: document.getElementById('experienceCount').textContent,
    unsaved: document.getElementById('experienceUnsaved').hidden,
  })`);
  assert.deepEqual(insights.labels, [PT.stats.volume, PT.stats.consistency, PT.stats.effort, PT.stats.alerts]);
  assert.equal(insights.concerns, '1', 'the reported discomfort is counted');
  assert.deepEqual(insights.experience, { ok: false, href: '#experience' });
  assert.equal(insights.counter, PT.experienceCount.replace('{count}', '0').replace('{max}', '2000'));
  assert.equal(insights.unsaved, true);
  await evaluate("const field = document.getElementById('experience'); field.value = 'Corro há 2 anos.'; field.dispatchEvent(new Event('input', { bubbles: true }))");
  assert.equal(await evaluate("document.getElementById('experienceUnsaved').hidden"), false);
  assert.equal(await evaluate("document.getElementById('experienceCount').textContent"), PT.experienceCount.replace('{count}', '16').replace('{max}', '2000'));
  await evaluate("document.getElementById('profileForm').requestSubmit()");
  await wait("document.getElementById('experienceUnsaved').hidden && document.querySelector('[data-quality=\"experience\"]').classList.contains('is-ok')");

  // Language changes rerender the selected task in place.
  await evaluate(`document.querySelector('.lang-switch [data-lang="en-US"]').click()`);
  await wait("document.documentElement.lang === 'en-US'");
  await wait(`document.getElementById('purposeTask').textContent.startsWith(${JSON.stringify(EN.task.analysis.split('{')[0])})`);
  assert.equal(await evaluate("document.getElementById('purposeTab-analysis').textContent"), EN.purposeTabs.analysis);

  // Phone width: tabs stay usable without horizontal page scroll.
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  view = await evaluate(state);
  assert.equal(view.overflow, false);
});
