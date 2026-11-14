'use strict';

// Weight log page (issue #80) in real Chrome: sidebar entry, add/correct/delete
// with field errors and focus, the note about the anamnesis answer, the last
// entry kept by a completed answer, and a pending value converted when the
// body unit changes. PT/EN, desktop and mobile. Synthetic data only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { SESSION_COOKIE_NAME, createSession } = require('../src/auth/sessions');
const { saveAnamnesis } = require('../src/anamnesis');
const { launchChrome } = require('./helpers/chrome.cjs');
const en = require('../src/public/locales/en.json');
const pt = require('../src/public/locales/pt.json');

const fill = (pairs) => `(()=>{${pairs.map(([id, value]) => `{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));}`).join('')}})()`;

test('Chrome PT/EN desktop/mobile: the weight log has its own page and keeps the anamnesis answer intact', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  const owner = Number(db.prepare(
    "INSERT INTO users (email, password_hash, first_name, onboarding_status, preferred_lang) VALUES ('weight@example.test', 'unused', 'Ana', 'active', 'pt-BR')",
  ).run().lastInsertRowid);
  const app = await buildServer({ db, sessionCookieSecure: false });
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => { await app.close(); db.close(); });
  const { command, evaluate, wait, capture, socket } = await launchChrome(t);
  const exceptions = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  });
  await command('Runtime.enable');
  await command('Network.setCookie', { name: SESSION_COOKIE_NAME, value: createSession(db, owner).token, url: origin, httpOnly: true });
  const weights = () => db.prepare('SELECT measured_on, weight_kg FROM body_weight_entries ORDER BY measured_on').all().map((row) => ({ ...row }));
  const open = async (language) => {
    await command('Page.navigate', { url: `${origin}/weight.html` });
    await wait(`document.documentElement.lang === '${language}' && !document.getElementById('weightFormCard').hidden`);
  };

  for (const [language, messages] of [['pt-BR', pt], ['en-US', en]]) {
    for (const width of [1280, 390]) {
      const w = messages.weightLog;
      db.prepare('DELETE FROM athlete_anamnesis').run();
      db.prepare('DELETE FROM body_weight_entries').run();
      db.prepare("UPDATE users SET preferred_lang = ?, body_unit = 'metric' WHERE id = ?").run(language, owner);
      await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      await open(language);

      // The sidebar item is the current page; the anamnesis is not in the sidebar.
      assert.equal(await evaluate("document.querySelector('.sidebar-nav .nav-item.active')?.getAttribute('href')"), '/weight.html');
      assert.equal(await evaluate("document.querySelector('.sidebar-nav .nav-item.active')?.getAttribute('aria-current')"), 'page');
      assert.equal(await evaluate("document.querySelector('.sidebar-nav a[href=\"/anamnesis.html\"]')"), null);
      assert.equal(await evaluate("document.getElementById('weightTitle').textContent"), w.title);
      assert.equal(await evaluate("document.getElementById('weightLoadError').getBoundingClientRect().height"), 0);
      assert.equal(await evaluate("document.getElementById('weightEmpty').hidden"), false);
      assert.equal(await evaluate("document.getElementById('weightAnamnesisNoteText').textContent"), w.notes.unanswered);
      assert.deepEqual(await evaluate("(()=>{const e=document.getElementById('weightValue');return [e.type,e.placeholder,e.min,e.max];})()"), ['number', w.placeholder.metric, '20', '400']);

      // An empty value is explained on the field.
      await evaluate("document.getElementById('weightSubmit').click()");
      await wait("!document.getElementById('weightValueError').hidden");
      assert.equal(await evaluate("document.getElementById('weightValueError').textContent"), w.errors.invalidWeight);
      assert.equal(await evaluate('document.activeElement.id'), 'weightValue');
      assert.equal(await evaluate("document.getElementById('weightValue').getAttribute('aria-invalid')"), 'true');
      await capture(`weight-error-${language}-${width}`);

      // Two dated entries, newest first.
      await evaluate(fill([['weightValue', '70.2']]));
      await evaluate("document.getElementById('weightDate').dataset.iso = '2026-01-05'");
      await evaluate("document.getElementById('weightSubmit').click()");
      await wait("document.querySelectorAll('#weightList li').length === 1 && !document.getElementById('weightSubmit').disabled");
      assert.equal(await evaluate('document.activeElement.id'), 'weightValue');
      assert.equal(await evaluate("document.getElementById('weightValueError').hidden"), true);
      await evaluate(fill([['weightValue', '71.5']]));
      await evaluate("document.getElementById('weightDate').dataset.iso = '2026-02-05'");
      await evaluate("document.getElementById('weightSubmit').click()");
      await wait("document.querySelectorAll('#weightList li').length === 2 && !document.getElementById('weightSubmit').disabled");
      assert.match(await evaluate("document.querySelector('#weightList li strong').textContent"), /71[.,]5 kg/);
      assert.deepEqual(weights(), [{ measured_on: '2026-01-05', weight_kg: 70.2 }, { measured_on: '2026-02-05', weight_kg: 71.5 }]);

      // Correcting an entry goes through the same form and returns focus.
      await evaluate("document.querySelectorAll('#weightList button[data-action=\"edit\"]')[1].click()");
      assert.equal(await evaluate('document.activeElement.id'), 'weightValue');
      assert.equal(await evaluate("document.getElementById('weightValue').value"), '70.2');
      assert.equal(await evaluate("document.getElementById('weightSubmit').textContent"), w.save);
      assert.equal(await evaluate("document.getElementById('weightCancel').hidden"), false);
      await evaluate(fill([['weightValue', '69.8']]));
      await evaluate("document.getElementById('weightSubmit').click()");
      await wait("document.activeElement?.dataset.action === 'edit'");
      assert.equal(await evaluate("document.activeElement.dataset.id"), String(db.prepare("SELECT id FROM body_weight_entries WHERE measured_on = '2026-01-05'").get().id));
      assert.equal(await evaluate("document.getElementById('weightCancel').hidden"), true);
      assert.equal(db.prepare("SELECT weight_kg FROM body_weight_entries WHERE measured_on = '2026-01-05'").get().weight_kg, 69.8);

      // The same date twice is explained on the date field.
      await evaluate(fill([['weightValue', '68']]));
      await evaluate("document.getElementById('weightDate').dataset.iso = '2026-01-05'");
      await evaluate("document.getElementById('weightSubmit').click()");
      await wait(`document.getElementById('weightDateError').textContent === ${JSON.stringify(w.errors.weightDateExists)}`);
      assert.equal(await evaluate('document.activeElement.id'), 'weightDate');
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
      await capture(`weight-list-${language}-${width}`);

      // A completed anamnesis that shares the weight keeps the last entry.
      saveAnamnesis(db, owner, { answers: { weight: { status: 'answered' } }, expected_revision: 0 });
      db.prepare("UPDATE athlete_anamnesis SET status = 'completed'").run();
      await open(language);
      assert.equal(await evaluate("document.getElementById('weightAnamnesisNoteText').textContent"), w.notes.answered);
      assert.equal(await evaluate("document.querySelector('#weightAnamnesisNote a').getAttribute('href')"), '/anamnesis.html');
      for (const expected of [1, 0]) {
        await evaluate("document.querySelector('#weightList button[data-action=\"delete\"]').click()");
        await wait("!!document.getElementById('confirmOkBtn')");
        await evaluate("document.getElementById('confirmOkBtn').click()");
        if (expected === 1) await wait("document.querySelectorAll('#weightList li').length === 1");
        else await wait(`document.querySelector('.toast.visible')?.textContent.includes(${JSON.stringify(w.errors.weightRequired)})`);
      }
      assert.equal(weights().length, 1);
      assert.equal(await evaluate("document.activeElement?.dataset.action"), 'delete');

      // "Rather not say" in the anamnesis is explained, never changed here.
      db.prepare(`UPDATE athlete_anamnesis SET answers_json = '{"weight":{"status":"declined"}}'`).run();
      await open(language);
      assert.equal(await evaluate("document.getElementById('weightAnamnesisNoteText').textContent"), w.notes.declined);
      await evaluate(fill([['weightValue', '70']]));
      await evaluate("document.getElementById('weightDate').dataset.iso = '2026-03-05'");
      await evaluate("document.getElementById('weightSubmit').click()");
      await wait("document.querySelectorAll('#weightList li').length === 2");
      assert.match(db.prepare('SELECT answers_json FROM athlete_anamnesis').get().answers_json, /"declined"/);
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    }
  }

  // A pending edit keeps its meaning when the body unit changes: 70 kg shown
  // as 154.3 lb is saved back as ~70 kg, not as 154.3 kg or 70 lb.
  await evaluate("document.querySelector('#weightList button[data-action=\"edit\"]').click()");
  assert.equal(await evaluate("document.getElementById('weightValue').value"), '70');
  await evaluate("document.getElementById('userBadge').click()");
  await evaluate("document.getElementById('userPreferences').click()");
  await wait("!!document.querySelector('#preferencesForm input[name=\"body_unit\"][value=\"imperial\"]')");
  await evaluate("document.querySelector('#preferencesForm input[name=\"body_unit\"][value=\"imperial\"]').click();document.getElementById('preferencesSubmit').click()");
  await wait("/lb/.test(document.getElementById('weightValueLabel').textContent)");
  assert.equal(await evaluate("document.getElementById('weightValue').value"), '154.3');
  assert.equal(await evaluate("document.getElementById('weightValue').placeholder"), en.weightLog.placeholder.imperial);
  assert.match(await evaluate("document.querySelector('#weightList li strong').textContent"), /lb/);
  await evaluate("document.getElementById('weightSubmit').click()");
  await wait("document.activeElement?.dataset.action === 'edit'");
  const kept = db.prepare("SELECT weight_kg FROM body_weight_entries WHERE measured_on = '2026-03-05'").get().weight_kg;
  assert.ok(Math.abs(kept - 70) < 0.05, `weight kept as ${kept} kg`);
  assert.deepEqual(exceptions, []);
});
