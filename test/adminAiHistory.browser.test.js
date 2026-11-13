'use strict';

// Administration > Prompt history (issue #113) in real Chrome: admin-only
// navigation, account switching, the audited cross-account detail dialog,
// PT/EN, desktop/mobile, keyboard containment and focus restoration.

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { SESSION_COOKIE_NAME, createSession } = require('../src/auth/sessions');
const { launchChrome } = require('./helpers/chrome.cjs');
const en = require('../src/public/locales/en.json');
const pt = require('../src/public/locales/pt.json');

function addUser(db, email, first, role = 'user', active = 1) {
  return Number(db.prepare(
    "INSERT INTO users (email, password_hash, first_name, last_name, role, is_active, onboarding_status) VALUES (?, 'unused', ?, 'Synthetic', ?, ?, 'active')",
  ).run(email, first, role, active).lastInsertRowid);
}

function addExecution(db, userId, id, purpose, state, createdAt, prompt) {
  db.prepare(
    `INSERT INTO ai_executions
      (id, user_id, idempotency_key, purpose, resource_id, input_hash, prompt_version, external_prompt,
       context_json, payload_json, configuration_json, state, response_json, error_code,
       reserved_tokens, charged_tokens, reserved_cost, charged_cost, attempts, settled, created_at, updated_at,
       diagnostics_json, raw_output_capture_version)
     VALUES (?, ?, ?, ?, NULL, 'hash', 'synthetic-v1', ?, ?, ?, ?, ?, ?, ?, 900, 420, 0.02, 0.0123, 1, 1, ?, ?, ?, 1)`,
  ).run(
    id, userId, `key-${id}`, purpose, prompt,
    JSON.stringify({ purpose, note: 'synthetic context with a deliberately long line '.repeat(8) }),
    JSON.stringify({ input: 'synthetic payload' }),
    JSON.stringify({ model: 'synthetic-model' }),
    state,
    state === 'completed' ? JSON.stringify({ accepted: 'synthetic response' }) : null,
    state === 'failed' ? 'invalidDomainResponse' : null,
    createdAt, createdAt,
    JSON.stringify([{ attempt: 1, stage: state === 'completed' ? 'completed' : 'domain', code: state === 'completed' ? 'completed' : 'invalidDomainResponse' }]),
  );
}

test('Chrome PT/EN desktop/mobile: prompt history lists accounts, audits cross-account detail and keeps focus', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  const admin = addUser(db, 'history-admin@example.test', 'Ada', 'admin');
  const athlete = addUser(db, 'history-athlete-with-a-long-address@example.test', 'Zed');
  const regular = addUser(db, 'history-regular@example.test', 'Rui', 'user', 0);
  addExecution(db, athlete, 'exec-athlete-old', 'analysis', 'failed', '2026-11-10T08:00:00.000Z', 'ATHLETE OLD PROMPT');
  addExecution(db, athlete, 'exec-athlete-new', 'workouts', 'completed', '2026-11-12T08:00:00.000Z', 'ATHLETE NEW PROMPT');
  addExecution(db, admin, 'exec-admin', 'cycle', 'completed', '2026-11-01T08:00:00.000Z', 'ADMIN PROMPT');
  const app = await buildServer({ db, sessionCookieSecure: false });
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => { await app.close(); db.close(); });
  const browser = await launchChrome(t);
  const { command, evaluate, wait, key, capture } = browser;
  const pressEnter = async () => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  const audits = () => db.prepare("SELECT COUNT(*) AS n FROM admin_audit_log WHERE action = 'ai_execution_viewed'").get().n;

  // A regular account never receives the navigation item, and the page sends it home.
  db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(regular);
  await command('Network.setCookie', { name: SESSION_COOKIE_NAME, value: createSession(db, regular).token, url: origin, httpOnly: true });
  await command('Page.navigate', { url: `${origin}/home.html` });
  await wait("document.body.classList.contains('shell-mounted')");
  assert.equal(await evaluate("!!document.querySelector('a[href=\"/admin-ai-history.html\"]')"), false);
  await command('Page.navigate', { url: `${origin}/admin-ai-history.html` });
  await wait("location.pathname === '/home.html'");

  await command('Network.setCookie', { name: SESSION_COOKIE_NAME, value: createSession(db, admin).token, url: origin, httpOnly: true });
  for (const [language, messages] of [['pt-BR', pt], ['en-US', en]]) {
    for (const width of [1280, 390]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: 820, deviceScaleFactor: 1, mobile: width === 390 });
      await command('Page.navigate', { url: `${origin}/admin-ai-history.html` });
      await wait("!!document.querySelector('#aiHistoryList button[data-id]')");
      await evaluate(`document.querySelector('.lang-switch [data-lang="${language}"]').click()`);
      await wait(`document.documentElement.lang === '${language}'`);
      const strings = messages.aiHistory;
      // The Administration group carries the new item, marked active.
      assert.equal(await evaluate("document.querySelector('a.nav-item.active[href=\"/admin-ai-history.html\"]')?.textContent.trim()"), messages.shell.nav.aiHistory);
      // Accounts with history come first; the newest execution leads the list.
      assert.equal(await evaluate("document.getElementById('aiHistoryAccount').value"), String(athlete));
      assert.equal(await evaluate("document.querySelectorAll('#aiHistoryAccount option').length"), 3);
      assert.deepEqual(JSON.parse(await evaluate("JSON.stringify([...document.querySelectorAll('#aiHistoryList .ai-history-row')].map((row) => row.dataset.id))")), ['exec-athlete-new', 'exec-athlete-old']);
      assert.equal(await evaluate("document.querySelector('#aiHistoryList .ai-history-row strong').textContent"), strings.purposes.workouts);
      assert.equal(await evaluate("document.body.textContent.includes('ATHLETE NEW PROMPT')"), false, 'the list never loads prompts');
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
      await capture(`ai-history-list-${language}-${width}`);

      // Filters reload the list of the selected account.
      await evaluate("{const s=document.getElementById('aiHistoryState');s.value='failed';s.dispatchEvent(new Event('change'))}");
      await wait("document.querySelectorAll('#aiHistoryList .ai-history-row').length === 1 && document.querySelector('#aiHistoryList .ai-history-row').dataset.id === 'exec-athlete-old'");
      await evaluate("{const s=document.getElementById('aiHistoryState');s.value='';s.dispatchEvent(new Event('change'))}");
      await wait("document.querySelectorAll('#aiHistoryList .ai-history-row').length === 2");

      // Opening another account's execution: focus on the heading, the full trace, and one audit row.
      const before = audits();
      await evaluate("document.querySelector('#aiHistoryList button[data-id=\"exec-athlete-new\"]').focus()");
      await pressEnter();
      await wait("!document.getElementById('aiExecutionContent').hidden");
      assert.equal(audits(), before + 1);
      assert.equal(await evaluate('document.activeElement.id'), 'aiExecutionTitle');
      assert.equal(await evaluate("document.getElementById('aiExecutionAudit').textContent"), strings.audited);
      assert.equal(await evaluate("document.getElementById('aiExecutionPrompt').textContent"), 'ATHLETE NEW PROMPT');
      assert.match(await evaluate("document.getElementById('aiExecutionMeta').textContent"), /history-athlete-with-a-long-address@example\.test/);
      assert.equal(await evaluate("document.querySelector('#aiHistoryList').closest('[inert]') !== null || document.getElementById('appView').inert"), true);
      // Sections start collapsed; opening one stays inside the card on a phone.
      assert.equal(await evaluate("[...document.querySelectorAll('.ai-execution-section')].every((section) => !section.open)"), true);
      await evaluate("document.querySelector('.ai-execution-section[data-section=\"context\"]').open = true");
      assert.equal(await evaluate("document.getElementById('aiExecutionContext').scrollWidth <= document.getElementById('aiExecutionContext').clientWidth + 1"), true);
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
      await capture(`ai-history-detail-${language}-${width}`);
      // Response tab via the keyboard; the validated response is shown and copyable.
      await evaluate("document.getElementById('traceRequestTab').focus()");
      await key('ArrowRight', 'ArrowRight', 39);
      assert.equal(await evaluate('document.activeElement.id'), 'traceResponseTab');
      assert.equal(await evaluate("document.getElementById('traceResponsePanel').hidden"), false);
      assert.match(await evaluate("document.getElementById('traceOutput').textContent"), /synthetic response/);
      // A language change keeps the dialog open and translated.
      const other = language === 'pt-BR' ? 'en-US' : 'pt-BR';
      await evaluate(`document.querySelector('.lang-switch [data-lang="${other}"]').click()`);
      await wait(`document.documentElement.lang === '${other}'`);
      assert.equal(await evaluate("document.getElementById('aiExecutionModal').classList.contains('hidden')"), false);
      assert.equal(await evaluate("document.getElementById('aiExecutionAudit').textContent"), (other === 'pt-BR' ? pt : en).aiHistory.audited);
      assert.equal(await evaluate("document.getElementById('traceResponsePanel').hidden"), false);
      await evaluate(`document.querySelector('.lang-switch [data-lang="${language}"]').click()`);
      await wait(`document.documentElement.lang === '${language}'`);
      // Tab stays inside the dialog; Escape closes and returns focus to the trigger.
      for (let index = 0; index < 12; index += 1) {
        await key('Tab', 'Tab', 9);
        assert.equal(await evaluate("document.getElementById('aiExecutionModal').contains(document.activeElement)"), true);
      }
      await key('Escape', 'Escape', 27);
      await wait("document.getElementById('aiExecutionModal').classList.contains('hidden')");
      assert.equal(await evaluate('document.activeElement.dataset.id'), 'exec-athlete-new');

      // Switching to the administrator's own account: the read is not audited.
      await evaluate(`{const s=document.getElementById('aiHistoryAccount');s.value='${admin}';s.dispatchEvent(new Event('change'))}`);
      await wait("document.querySelector('#aiHistoryList .ai-history-row')?.dataset.id === 'exec-admin'");
      assert.equal(await evaluate("new URLSearchParams(location.search).get('account')"), String(admin));
      const ownBefore = audits();
      await evaluate("document.querySelector('#aiHistoryList button[data-id]').click()");
      await wait("!document.getElementById('aiExecutionContent').hidden");
      assert.equal(audits(), ownBefore);
      assert.equal(await evaluate("document.getElementById('aiExecutionAudit').textContent"), strings.ownExecution);
      await evaluate("document.getElementById('aiExecutionModal').click()");
      await wait("document.getElementById('aiExecutionModal').classList.contains('hidden')");
      // An account without history shows the empty state; the URL is restored for the next round.
      await evaluate(`{const s=document.getElementById('aiHistoryAccount');s.value='${regular}';s.dispatchEvent(new Event('change'))}`);
      await wait(`document.getElementById('aiHistoryEmpty').textContent === ${JSON.stringify(strings.empty)}`);
      await evaluate("history.replaceState(null, '', '/admin-ai-history.html')");
    }
  }

  // An execution removed after the list loaded answers with a localized not-found.
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: `${origin}/admin-ai-history.html?account=${athlete}` });
  await wait("!!document.querySelector('#aiHistoryList button[data-id]')");
  db.prepare("DELETE FROM ai_executions WHERE id = 'exec-athlete-new'").run();
  await evaluate("document.querySelector('#aiHistoryList button[data-id=\"exec-athlete-new\"]').click()");
  await wait(`document.getElementById('aiExecutionStatus').textContent === ${JSON.stringify(en.aiHistory.notFound)}`);
  assert.equal(await evaluate("document.getElementById('aiExecutionStatus').getAttribute('role')"), 'alert');
  assert.equal(await evaluate("document.getElementById('aiExecutionContent').hidden"), true);
});
