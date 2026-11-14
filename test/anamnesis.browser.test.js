'use strict';

// Athlete anamnesis page (issue #80) in real Chrome: step errors and focus,
// resume after reload, conditional follow-ups, a language switch that keeps
// typed answers, review/completion/editing, the link to the Weight log, a
// conflict with another tab and erasure, in PT
// and EN, desktop and mobile. Synthetic data only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { SESSION_COOKIE_NAME, createSession } = require('../src/auth/sessions');
const { launchChrome } = require('./helpers/chrome.cjs');
const en = require('../src/public/locales/en.json');
const pt = require('../src/public/locales/pt.json');

const fill = (pairs) => `(()=>{${pairs.map(([id, value]) => `{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));}`).join('')}})()`;
const pick = (name, value) => `document.querySelector('input[name="${name}"][value="${value}"]').click()`;

test('Chrome PT/EN desktop/mobile: the anamnesis guides, validates, resumes, completes and links to the weight log', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  const owner = Number(db.prepare(
    "INSERT INTO users (email, password_hash, first_name, onboarding_status, preferred_lang) VALUES ('anamnesis@example.test', 'unused', 'Ana', 'active', 'pt-BR')",
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
  const stepTitle = () => evaluate("document.getElementById('anamnesisStepTitle').textContent");

  for (const [language, messages] of [['pt-BR', pt], ['en-US', en]]) {
    for (const width of [1280, 390]) {
      const a = messages.anamnesis;
      db.prepare('DELETE FROM athlete_anamnesis').run();
      db.prepare('DELETE FROM body_weight_entries').run();
      db.prepare('UPDATE users SET preferred_lang = ? WHERE id = ?').run(language, owner);
      await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      await command('Page.navigate', { url: `${origin}/anamnesis.html` });
      await wait(`document.documentElement.lang === '${language}' && !document.getElementById('anamnesisWizard').hidden`);
      assert.equal(await evaluate("document.getElementById('anamnesisStatus').textContent"), a.status.not_started);
      assert.equal(await stepTitle(), a.steps.about.title);
      assert.equal(await evaluate("document.getElementById('anamnesisLoadError').getBoundingClientRect().height"), 0);
      // No answer is pre-selected, health or otherwise.
      assert.equal(await evaluate("document.querySelectorAll('#anamnesisStepFields input:checked').length"), 0);
      // Numeric answers are number inputs with the backend limits and a valid example.
      assert.deepEqual(await evaluate("['q-birth_year','q-height_cm','q-weight'].map((id)=>{const e=document.getElementById(id);return [e.type,e.placeholder,e.min!=='',e.max!==''];})"), [
        ['number', a.placeholders.birth_year, true, true],
        ['number', a.placeholders.height_cm, true, true],
        ['number', a.placeholders.weight.metric, true, true],
      ]);
      // The weight log lives on its own page, not here.
      assert.equal(await evaluate("document.getElementById('weightList')"), null);
      assert.equal(await evaluate("document.getElementById('q-motivations-other').placeholder"), a.placeholders.motivations);

      // An empty step is refused field by field, focusing the first question.
      await evaluate("document.getElementById('anamnesisNext').click()");
      await wait("document.querySelectorAll('#anamnesisStepFields .field-error:not([hidden])').length === 4");
      assert.equal(await evaluate('document.activeElement.id'), 'q-birth_year');
      assert.equal(await evaluate("document.getElementById('q-birth_year').getAttribute('aria-invalid')"), 'true');
      assert.equal(await evaluate("document.getElementById('q-birth_year-error').textContent"), a.errors.required);
      assert.match(await evaluate("document.getElementById('q-birth_year').getAttribute('aria-describedby')"), /q-birth_year-error/);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM athlete_anamnesis').get().n, 0);
      await capture(`anamnesis-errors-${language}-${width}`);

      // Out-of-range input is explained; "rather not say" disables the value.
      await evaluate(fill([['q-birth_year', '1800'], ['q-weight', '71.5']]));
      await evaluate(`${pick('q-height_cm-status', 'declined')};${pick('q-motivations', 'weight_loss')};${pick('q-motivations', 'other')}`);
      assert.equal(await evaluate("document.getElementById('q-height_cm').disabled"), true);
      assert.equal(await evaluate("document.getElementById('q-motivations-other').closest('.anamnesis-details').hidden"), false);
      await evaluate("document.getElementById('anamnesisNext').click()");
      await wait("!document.getElementById('q-birth_year-error').hidden");
      assert.match(await evaluate("document.getElementById('q-birth_year-error').textContent"), /\d{4}/);
      // A language switch keeps typed answers and translates the step.
      const other = language === 'pt-BR' ? 'en-US' : 'pt-BR';
      const otherMessages = other === 'pt-BR' ? pt : en;
      await evaluate(`document.querySelector('.lang-switch [data-lang="${other}"]').click()`);
      await wait(`document.documentElement.lang === '${other}'`);
      assert.equal(await stepTitle(), otherMessages.anamnesis.steps.about.title);
      assert.equal(await evaluate("document.getElementById('q-birth_year').value"), '1800');
      assert.equal(await evaluate("document.getElementById('q-birth_year').placeholder"), otherMessages.anamnesis.placeholders.birth_year);
      assert.equal(await evaluate("document.getElementById('anamnesisProgress').textContent"), otherMessages.anamnesis.progress.replace('{current}', '1').replace('{total}', '5'));
      await evaluate(`document.querySelector('.lang-switch [data-lang="${language}"]').click()`);
      await wait(`document.documentElement.lang === '${language}'`);

      await evaluate(fill([['q-birth_year', '1990']]));
      await evaluate("document.getElementById('anamnesisNext').click()");
      await wait(`document.getElementById('anamnesisStepTitle').textContent === ${JSON.stringify(a.steps.experience.title)}`);
      assert.equal(await evaluate('document.activeElement.id'), 'anamnesisStepTitle');
      assert.deepEqual({ ...db.prepare('SELECT weight_kg FROM body_weight_entries').get() }, { weight_kg: 71.5 });

      // Reload resumes at the first incomplete step; earlier answers are kept.
      await command('Page.reload');
      await wait(`!document.getElementById('anamnesisWizard').hidden && document.getElementById('anamnesisStepTitle').textContent === ${JSON.stringify(a.steps.experience.title)}`);
      assert.equal(await evaluate("document.getElementById('anamnesisStatus').textContent"), a.status.draft);
      await evaluate("document.getElementById('anamnesisBack').click()");
      await wait("document.getElementById('q-birth_year')?.value === '1990'");
      assert.equal(await evaluate("document.querySelector('input[name=\"q-height_cm-status\"]').checked"), true);
      // With an entry, the question shows the latest weight and links to the
      // Weight log instead of offering a second way to log one.
      assert.match(await evaluate("document.querySelector('.anamnesis-latest').textContent"), /71[.,]5/);
      assert.equal(await evaluate("document.querySelector('.anamnesis-latest a').getAttribute('href')"), '/weight.html');
      assert.equal(await evaluate("document.querySelector('.anamnesis-latest a').textContent"), a.weight.updateLink);
      assert.equal(await evaluate("document.getElementById('q-weight')"), null);
      assert.equal(await evaluate("document.querySelector('[data-key=\"weight\"]').tagName"), 'FIELDSET');
      await evaluate("document.querySelector('[data-key=\"weight\"]').scrollIntoView({block:'center'})");
      await capture(`anamnesis-weight-link-${language}-${width}`);
      await evaluate("document.getElementById('anamnesisNext').click()");
      await wait(`document.getElementById('anamnesisStepTitle').textContent === ${JSON.stringify(a.steps.experience.title)}`);

      // Zero runs a week hides the volume follow-ups.
      await evaluate(`${pick('q-running_experience', 'under_6_months')};${pick('q-recent_consistency', 'irregular')}`);
      await evaluate(fill([['q-runs_per_week', '0']]));
      assert.equal(await evaluate("document.querySelector('[data-key=\"weekly_distance_km\"]').hidden"), true);
      await evaluate(fill([['q-runs_per_week', '2'], ['q-weekly_distance_km', '12']]));
      assert.equal(await evaluate("document.querySelector('[data-key=\"weekly_distance_km\"]').hidden"), false);
      await evaluate(pick('q-longest_run_km-status', 'unknown'));
      assert.deepEqual(await evaluate("['q-runs_per_week','q-weekly_distance_km'].map((id)=>[document.getElementById(id).type,document.getElementById(id).placeholder])"), [
        ['number', a.placeholders.runs_per_week],
        ['number', a.placeholders.weekly_distance_km.km],
      ]);
      // A race time is hours, minutes and seconds; minutes above 59 are refused.
      await evaluate("document.querySelector('[data-key=\"race_results\"] > .btn-secondary').click()");
      assert.equal(await evaluate('document.activeElement.id'), 'q-race-1-distance');
      assert.deepEqual(await evaluate("['hours','minutes','seconds','year'].map((k)=>{const e=document.getElementById('q-race-1-'+k);return [e.type,e.placeholder];})"), [
        ['number', a.placeholders.race.hours],
        ['number', a.placeholders.race.minutes],
        ['number', a.placeholders.race.seconds],
        ['number', a.placeholders.race.year.replace('{year}', String(new Date().getFullYear() - 1))],
      ]);
      await evaluate(fill([['q-race-1-minutes', '75'], ['q-race-1-seconds', '10'], ['q-race-1-year', '2025']]));
      await evaluate("document.getElementById('anamnesisNext').click()");
      await wait("!document.getElementById('q-race_results-error').hidden");
      assert.equal(await evaluate("document.getElementById('q-race_results-error').textContent"), a.errors.timeFormat);
      assert.equal(await evaluate("document.getElementById('q-race-1-minutes').getAttribute('aria-invalid')"), 'true');
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
      await capture(`anamnesis-race-${language}-${width}`);
      await evaluate(fill([['q-race-1-minutes', '24']]));
      await evaluate(fill([['q-experience-notes', 'Synthetic notes from the anamnesis']]));
      await evaluate("document.getElementById('anamnesisNext').click()");
      await wait(`document.getElementById('anamnesisStepTitle').textContent === ${JSON.stringify(a.steps.routine.title)}`);
      assert.match(db.prepare('SELECT fields_json FROM ai_profiles WHERE user_id = ?').get(owner).fields_json, /Synthetic notes from the anamnesis/);
      await evaluate(`${pick('q-strength_training', 'none')};${pick('q-other_activities', 'no')};${pick('q-hr_device', 'status:unknown')}`);
      await evaluate("document.getElementById('anamnesisNext').click()");
      await wait(`document.getElementById('anamnesisStepTitle').textContent === ${JSON.stringify(a.steps.health.title)}`);
      assert.equal(await evaluate("document.getElementById('q-sensitive-consent').checked"), false);
      await evaluate(`${pick('q-current_pain', 'yes')}`);
      assert.equal(await evaluate("document.getElementById('q-current_pain-details').closest('.anamnesis-details').hidden"), false);
      await evaluate(fill([['q-current_pain-details', 'Synthetic knee discomfort']]));
      await evaluate(`${pick('q-injuries_12_months', 'status:declined')};${pick('q-professional_restriction', 'no')};${pick('q-health_conditions', 'status:unknown')}`);
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
      await capture(`anamnesis-health-${language}-${width}`);
      await evaluate("document.getElementById('anamnesisNext').click()");
      await wait("!document.getElementById('anamnesisReview').hidden");
      assert.equal(await evaluate('document.activeElement.id'), 'anamnesisReviewTitle');
      assert.match(await evaluate("document.getElementById('anamnesisSummary').textContent"), /Synthetic knee discomfort/);
      assert.match(await evaluate("document.getElementById('anamnesisSummary').textContent"), /0:24:10 · 2025/);
      await evaluate("document.getElementById('anamnesisComplete').click()");
      await wait(`document.getElementById('anamnesisStatus').textContent === ${JSON.stringify(a.status.completed)}`);
      assert.equal(await evaluate("document.getElementById('anamnesisReviewTitle').textContent"), a.answersTitle);
      assert.equal(await evaluate("document.getElementById('anamnesisReviewActions').hidden"), true);
      assert.equal(db.prepare('SELECT status FROM athlete_anamnesis WHERE user_id = ?').get(owner).status, 'completed');
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
      await capture(`anamnesis-completed-${language}-${width}`);

      // Editing one step from the summary saves in place and returns to it.
      await evaluate("document.querySelector('#anamnesisSummary button[data-step=\"routine\"]').click()");
      await wait(`!document.getElementById('anamnesisWizard').hidden && !document.getElementById('anamnesisCancel').hidden`);
      assert.equal(await evaluate("document.getElementById('anamnesisBack').hidden"), true);
      assert.equal(await evaluate("document.querySelector('input[name=\"q-strength_training\"]:checked').value"), 'none');
      await evaluate(`${pick('q-strength_training', 'weekly_2_plus')};document.getElementById('anamnesisNext').click()`);
      await wait("!document.getElementById('anamnesisReview').hidden");
      assert.match(db.prepare('SELECT answers_json FROM athlete_anamnesis').get().answers_json, /weekly_2_plus/);

      assert.equal(await evaluate("document.querySelector('.anamnesis-source-list a[href=\"/weight.html\"]')?.textContent"), a.review.openWeight);
    }
  }

  // An open step saves against the revision it was rendered from, so another
  // tab's save is a conflict, never silently overwritten.
  await evaluate("document.querySelector('#anamnesisSummary button[data-step=\"routine\"]').click()");
  await wait("!document.getElementById('anamnesisWizard').hidden");
  await evaluate("(async()=>{const r=await (await fetch('/api/anamnesis')).json();const w=await fetch('/api/anamnesis',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({answers:{strength_training:{status:'answered',value:'occasional'}},expected_revision:r.anamnesis.revision})});if(!w.ok)throw Error('other tab save failed');})()");
  await evaluate(`${pick('q-strength_training', 'weekly_1')};document.getElementById('anamnesisNext').click()`);
  await wait("!document.getElementById('anamnesisFormError').hidden");
  assert.equal(await evaluate("document.getElementById('anamnesisFormError').textContent"), en.anamnesis.errors.anamnesisConflict);
  assert.match(db.prepare('SELECT answers_json FROM athlete_anamnesis').get().answers_json, /"occasional"/);
  await evaluate("document.getElementById('anamnesisCancel').click()");

  // Erasing removes answers and weights after confirmation.
  await evaluate("document.getElementById('anamnesisDelete').click()");
  await wait("document.getElementById('confirmOkBtn')?.textContent === " + JSON.stringify(en.anamnesis.privacy.deleteTitle));
  await evaluate("document.getElementById('confirmOkBtn').click()");
  await wait(`document.getElementById('anamnesisStatus').textContent === ${JSON.stringify(en.anamnesis.status.not_started)}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM athlete_anamnesis').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM body_weight_entries').get().n, 0);

  // Unsaved answers survive a preference change, converted to the new units.
  const setPreferences = async (values) => {
    await evaluate("document.getElementById('userBadge').click();document.getElementById('userPreferences').click()");
    await wait("!!document.querySelector('#preferencesForm input[name=\"body_unit\"]')");
    await evaluate(`${Object.entries(values).map(([name, value]) => `document.querySelector('#preferencesForm input[name="${name}"][value="${value}"]').click()`).join(';')};document.getElementById('preferencesSubmit').click()`);
  };
  await evaluate(fill([['q-birth_year', '1985'], ['q-height_cm', '172'], ['q-weight', '70']]));
  await evaluate("document.getElementById('q-weight-date').dataset.iso = '2026-01-20'");
  await evaluate(pick('q-motivations', 'health'));
  await setPreferences({ body_unit: 'imperial', distance_unit: 'mi' });
  await wait("!!document.getElementById('q-height_cm-inches')");
  assert.deepEqual(await evaluate("['q-birth_year','q-height_cm','q-height_cm-inches','q-weight'].map((id)=>document.getElementById(id).value)"), ['1985', '5', '7.7', '154.3']);
  assert.equal(await evaluate("document.querySelector('input[name=\"q-motivations\"][value=\"health\"]').checked"), true);
  assert.equal(await evaluate("document.getElementById('q-weight-date').dataset.iso"), '2026-01-20');
  // The weight is logged but the answers fail on the network: retrying the
  // step saves the answers without logging the same weight twice.
  let failNextPut = true;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = message.params;
    if (failNextPut && request.method === 'PUT') {
      failNextPut = false;
      command('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' });
    } else command('Fetch.continueRequest', { requestId });
  });
  await command('Fetch.enable', { patterns: [{ urlPattern: '*/api/anamnesis' }] });
  await evaluate("document.getElementById('anamnesisNext').click()");
  await wait("!document.getElementById('anamnesisFormError').hidden");
  assert.equal(await evaluate("document.getElementById('anamnesisFormError').textContent"), en.anamnesis.errors.generic);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM body_weight_entries').get().n, 1);
  await evaluate("document.getElementById('anamnesisNext').click()");
  await wait(`document.getElementById('anamnesisStepTitle').textContent === ${JSON.stringify(en.anamnesis.steps.experience.title)}`);
  await command('Fetch.disable');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM body_weight_entries').get().n, 1);
  const about = JSON.parse(db.prepare('SELECT answers_json FROM athlete_anamnesis').get().answers_json);
  assert.equal(about.birth_year.value, 1985);
  assert.ok(Math.abs(about.height_cm.value - 172) < 0.5, `height kept as ${about.height_cm.value} cm`);
  assert.ok(Math.abs(db.prepare("SELECT weight_kg FROM body_weight_entries WHERE measured_on = '2026-01-20'").get().weight_kg - 70) < 0.05);

  // Distances follow a distance-unit change; a race row and its values stay.
  await evaluate(`${pick('q-running_experience', 'over_5_years')};${pick('q-recent_consistency', 'regular')}`);
  await evaluate(fill([['q-runs_per_week', '3'], ['q-weekly_distance_km', '12.4']]));
  await evaluate(pick('q-longest_run_km-status', 'unknown'));
  await evaluate("document.querySelector('[data-key=\"race_results\"] > .btn-secondary').click()");
  await evaluate("{const s=document.getElementById('q-race-1-distance');s.value='other';s.dispatchEvent(new Event('change'));}");
  await evaluate(fill([['q-race-1-km', '6.2'], ['q-race-1-minutes', '31'], ['q-race-1-seconds', '5'], ['q-race-1-year', '2025']]));
  await evaluate(fill([['q-experience-notes', 'Synthetic notes typed in this tab']]));
  await setPreferences({ distance_unit: 'km' });
  await wait("/km/.test(document.querySelector('[data-key=\"weekly_distance_km\"] label').textContent)");
  assert.deepEqual(await evaluate("['q-runs_per_week','q-weekly_distance_km','q-race-1-distance','q-race-1-km','q-race-1-minutes','q-race-1-year','q-experience-notes'].map((id)=>document.getElementById(id).value)"),
    ['3', '20', 'other', '9.98', '31', '2025', 'Synthetic notes typed in this tab']);
  assert.equal(await evaluate("document.getElementById('q-race-1-km').closest('.field').hidden"), false);
  assert.equal(await evaluate("document.querySelector('input[name=\"q-longest_run_km-status\"]').checked"), true);
  assert.equal(await evaluate("document.getElementById('q-longest_run_km').disabled"), true);

  // The notes changed in another session: the answers are saved, the notes
  // conflict, and reloading the saved version keeps the typed text so the
  // same step can be saved again instead of failing with a stale revision.
  await evaluate("(async()=>{const r=await (await fetch('/api/anamnesis')).json();const w=await fetch('/api/ai/profile',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({fields:{experience:'Notes from another session'},expected_version:r.experience.version})});if(!w.ok)throw Error('other session save failed');})()");
  await evaluate("document.getElementById('anamnesisNext').click()");
  await wait("!document.getElementById('anamnesisReloadExperience').hidden");
  assert.equal(await evaluate("document.getElementById('anamnesisFormError').textContent"), en.anamnesis.errors.memoryConflict);
  await evaluate("document.getElementById('anamnesisReloadExperience').scrollIntoView({block:'center'})");
  await capture('anamnesis-notes-conflict-en-US-390');
  assert.equal(JSON.parse(db.prepare('SELECT answers_json FROM athlete_anamnesis').get().answers_json).runs_per_week.value, 3);
  await evaluate("document.getElementById('anamnesisReloadExperience').click()");
  await wait("document.getElementById('anamnesisReloadExperience').hidden");
  assert.equal(await evaluate('document.activeElement.id'), 'q-experience-notes');
  assert.equal(await evaluate("document.getElementById('q-experience-notes').value"), 'Synthetic notes typed in this tab');
  await evaluate("document.getElementById('anamnesisNext').click()");
  await wait(`document.getElementById('anamnesisStepTitle').textContent === ${JSON.stringify(en.anamnesis.steps.routine.title)}`);
  assert.match(db.prepare('SELECT fields_json FROM ai_profiles WHERE user_id = ?').get(owner).fields_json, /Synthetic notes typed in this tab/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM body_weight_entries').get().n, 1);
  assert.deepEqual(exceptions, []);
});
