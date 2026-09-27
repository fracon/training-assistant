'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { registerUser } = require('../src/auth/registration');
const { SESSION_COOKIE_NAME, createSession } = require('../src/auth/sessions');

function findChrome() {
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((file) => existsSync(file));
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForPage(command, baseUrl, pathname) {
  const loaded = new Promise((resolve) => {
    const listener = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Page.loadEventFired') {
        command._socket.removeEventListener('message', listener);
        resolve();
      }
    };
    command._socket.addEventListener('message', listener);
  });
  await command('Page.navigate', { url: `${baseUrl}${pathname}` });
  await Promise.race([loaded, delay(15000).then(() => { throw new Error(`Navigation to ${pathname} timed out.`); })]);
}

test('feedback browser flows keep async state, PT/EN forms, focus, filters, and mobile layout coherent', async (t) => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for feedback browser verification.');
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });
  const admin = await registerUser(db, { email: 'feedback-browser-admin@example.test', password: 'browser-secret-1', first_name: 'Ada', last_name: 'Admin' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', admin.id);
  db.prepare(`INSERT INTO feedback (author_user_id, author_email, type, description, pathname, status, internal_note) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`)
    .run(admin.id, admin.email, 'bug', 'New feedback A', '/home.html', 'new', '', admin.id, admin.email, 'suggestion', 'New feedback B', '/calendar.html', 'new', '', admin.id, admin.email, 'other', 'Resolved feedback', '/shoes.html', 'resolved', 'old note');
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const origin = new URL(baseUrl).origin;
  const debugPort = await freePort();
  const profile = mkdtempSync(path.join(tmpdir(), 'kinesis-feedback-chrome-'));
  const chromeProcess = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--remote-allow-origins=*', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let socket;
  try {
    const debugUrl = `http://127.0.0.1:${debugPort}`;
    let versionResponse;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { versionResponse = await fetch(`${debugUrl}/json/version`); if (versionResponse.ok) break; } catch {}
      await delay(50);
    }
    assert.ok(versionResponse?.ok, 'Chrome DevTools endpoint became available.');
    const target = await (await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let id = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method) return;
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(message.error.message)); else handler.resolve(message.result);
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => { const commandId = ++id; pending.set(commandId, { resolve, reject }); socket.send(JSON.stringify({ id: commandId, method, params })); });
    command._socket = socket;
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = (expression) => evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+10000;const check=()=>{if(${expression}){resolve(true);return}if(Date.now()>end){reject(new Error('browser wait timed out'))}else{requestAnimationFrame(check)}};check()})`);
    const setViewport = (width, height, mobile) => command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    const setSession = () => command('Network.setCookie', { name: SESSION_COOKIE_NAME, value: createSession(db, admin.id).token, url: origin });
    const navigate = (pathname) => waitForPage(command, baseUrl, pathname);

    await command('Page.enable'); await command('Runtime.enable'); await command('Network.enable');
    await setViewport(1024, 768, false); await setSession(); await navigate('/admin-feedback.html');
    await waitFor('document.querySelectorAll(".feedback-row").length === 3');
    assert.equal(await evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth'), false);

    await evaluate(`window.__feedbackNativeFetch=window.fetch.bind(window);window.__feedbackPending={};window.fetch=(input,init)=>{const url=String(input);const method=(init?.method||'GET').toUpperCase();if(method==='GET'&&url.includes('/api/admin/feedback')){const status=new URL(url,location.href).searchParams.get('status')||'all';return new Promise((resolve,reject)=>{window.__feedbackPending[status]=()=>window.__feedbackNativeFetch(input,init).then(resolve,reject)})}return window.__feedbackNativeFetch(input,init)}`);
    await evaluate('document.getElementById("feedbackStatusFilter").value="new";document.getElementById("feedbackStatusFilter").dispatchEvent(new Event("change"))');
    await evaluate('document.getElementById("feedbackStatusFilter").value="resolved";document.getElementById("feedbackStatusFilter").dispatchEvent(new Event("change"))');
    await evaluate('window.__feedbackPending.resolved()'); await waitFor('document.getElementById("feedbackAdminLoading").classList.contains("hidden")');
    await evaluate('window.__feedbackPending.new()'); await delay(100);
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".feedback-row-summary")].map((node)=>node.textContent)'), ['Resolved feedback'], 'the stale filter response is discarded');
    await evaluate('window.fetch=window.__feedbackNativeFetch');

    await evaluate('document.querySelector(".feedback-row button[data-id]").click()');
    await waitFor('!document.getElementById("feedbackDetailModal").classList.contains("hidden")');
    const unsaved = await evaluate(`(()=>{const status=document.getElementById('detailStatus');const note=document.getElementById('detailNote');status.value='in_progress';note.value='rascunho PT';note.focus();document.querySelector('.lang-switch [data-lang="pt-BR"]').click();return true})()`);
    assert.equal(unsaved, true);
    await delay(500);
    assert.deepEqual(await evaluate(`({open:!document.getElementById('feedbackDetailModal').classList.contains('hidden'),status:document.getElementById('detailStatus').value,note:document.getElementById('detailNote').value,focus:document.activeElement.id,title:document.getElementById('feedbackDetailTitle').textContent})`), { open: true, status: 'in_progress', note: 'rascunho PT', focus: 'detailNote', title: 'Detalhes do feedback' });

    await evaluate(`window.__feedbackPatchPending=()=>{};const native=window.__feedbackNativeFetch;window.fetch=(input,init)=>{if((init?.method||'GET').toUpperCase()==='PATCH'&&String(input).includes('/api/admin/feedback/'))return new Promise((resolve,reject)=>{window.__feedbackPatchPending=()=>native(input,init).then(resolve,reject)});return native(input,init)}`);
    await evaluate('document.getElementById("feedbackDetailSave").click();'); await delay(100);
    await evaluate(`document.querySelector('.lang-switch [data-lang="en-US"]').click();document.getElementById('feedbackDetailModal').dispatchEvent(new MouseEvent('click',{bubbles:true}));document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert.equal(await evaluate('!document.getElementById("feedbackDetailModal").classList.contains("hidden")'), true, 'pending save cannot be closed by backdrop or Escape');
    await evaluate('window.__feedbackPatchPending()'); await waitFor('document.getElementById("feedbackDetailModal").classList.contains("hidden") && document.getElementById("feedbackAdminLoading").classList.contains("hidden")');
    assert.equal(await evaluate('document.activeElement.matches("#feedbackList button[data-id], #feedbackStatusFilter, #feedbackTypeFilter")'), true, 'save restores focus to a stable visible control when the filtered row leaves the list');

    await evaluate('document.getElementById("feedbackStatusFilter").value="";document.getElementById("feedbackStatusFilter").dispatchEvent(new Event("change"))');
    await waitFor('document.getElementById("feedbackAdminLoading").classList.contains("hidden") && document.querySelectorAll(".feedback-row").length > 0');
    await evaluate(`window.__feedbackDeletePending=()=>{};window.fetch=(input,init)=>{if((init?.method||'GET').toUpperCase()==='DELETE'&&String(input).includes('/api/admin/feedback/'))return new Promise((resolve,reject)=>{window.__feedbackDeletePending=()=>window.__feedbackNativeFetch(input,init).then(resolve,reject)});return window.__feedbackNativeFetch(input,init)}`);
    await evaluate('document.querySelector(".feedback-row button[data-id]").click();document.getElementById("feedbackDetailDelete").click()');
    await waitFor('document.getElementById("confirmOkBtn")'); await evaluate('document.getElementById("confirmOkBtn").click()'); await delay(100);
    await evaluate('document.getElementById("feedbackDetailModal").dispatchEvent(new MouseEvent("click",{bubbles:true}));document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    assert.equal(await evaluate('!document.getElementById("feedbackDetailModal").classList.contains("hidden")'), true, 'pending deletion cannot switch or close the detail dialog');
    await evaluate('window.__feedbackDeletePending()'); await waitFor('document.getElementById("feedbackDetailModal").classList.contains("hidden") && document.getElementById("feedbackAdminLoading").classList.contains("hidden")');
    assert.equal(await evaluate('document.activeElement.matches("#feedbackList button[data-id], #feedbackStatusFilter, #feedbackTypeFilter")'), true, 'deletion restores focus to a surviving row or stable filter');

    await setViewport(390, 844, true); await navigate('/home.html');
    await waitFor('document.getElementById("feedbackTrigger") && document.querySelector(".lang-switch [data-lang=\\"en-US\\"]").classList.contains("active")');
    await evaluate('document.getElementById("feedbackTrigger").click();document.getElementById("feedbackText").value="";document.getElementById("feedbackForm").requestSubmit()');
    await delay(100);
    assert.equal(await evaluate('document.getElementById("feedbackError").textContent'), 'Describe your feedback before sending.');
    await evaluate(`document.getElementById('feedbackText').value='texto preservado';document.querySelector('.lang-switch [data-lang="pt-BR"]').click()`); await delay(500);
    assert.deepEqual(await evaluate(`({text:document.getElementById('feedbackText').value,error:document.getElementById('feedbackError').textContent,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth})`), { text: 'texto preservado', error: 'Descreva seu feedback antes de enviar.', overflow: false });
    await evaluate(`const native=window.fetch.bind(window);window.fetch=(input,init)=>{if((init?.method||'GET').toUpperCase()==='POST'&&String(input).endsWith('/api/feedback'))return Promise.reject(new Error('offline'));return native(input,init)}`);
    await evaluate('document.getElementById("feedbackForm").requestSubmit()'); await delay(100);
    assert.equal(await evaluate('document.getElementById("feedbackError").textContent'), 'Não foi possível enviar seu feedback. O texto continua aqui; tente novamente.');
    await evaluate(`document.querySelector('.lang-switch [data-lang="en-US"]').click()`); await delay(500);
    assert.equal(await evaluate('document.getElementById("feedbackError").textContent'), 'Your feedback could not be sent. Your text is still here; please try again.');
    t.diagnostic('Verified feedback triage and global submission at 1024×768 and 390×844 in PT/EN, including stale filter responses, pending mutation containment, unsaved draft/caret preservation, mobile overflow, and focus restoration.');
  } finally {
    socket?.close(); chromeProcess.kill('SIGTERM'); rmSync(profile, { recursive: true, force: true }); await app.close();
  }
});
