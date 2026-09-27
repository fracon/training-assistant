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

const PASSWORD = 'browser-secret-1';

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

async function makeAccount(db, { email, firstName, lastName, role }) {
  const account = await registerUser(db, {
    email, password: PASSWORD, first_name: firstName, last_name: lastName,
  });
  if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, account.id);
  return { ...account, role: role ?? 'user' };
}

test('the administration page manages accounts in PT/EN with keyboard and mobile support', async (t) => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for administration browser verification.');

  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });
  const admin = await makeAccount(db, {
    email: 'admin@example.test', firstName: 'Ada', lastName: 'Admin', role: 'admin',
  });
  const regular = await makeAccount(db, {
    email: 'runner@example.test', firstName: 'Rita', lastName: 'Runner',
  });
  db.prepare("UPDATE users SET onboarding_status = 'active' WHERE id = ?").run(regular.id);
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const origin = new URL(baseUrl).origin;
  const debugPort = await freePort();
  const profile = mkdtempSync(path.join(tmpdir(), 'kinesis-admin-chrome-'));
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
      try {
        versionResponse = await fetch(`${debugUrl}/json/version`);
        if (versionResponse.ok) break;
      } catch {}
      await delay(50);
    }
    assert.ok(versionResponse?.ok, 'Chrome DevTools endpoint became available.');
    const targetResponse = await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' });
    const target = await targetResponse.json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });

    let id = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method) return;
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(message.error.message));
      else handler.resolve(message.result);
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const commandId = ++id;
      pending.set(commandId, { resolve, reject });
      socket.send(JSON.stringify({ id: commandId, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      }
      return result.result.value;
    };
    const pressKey = async (key, code, keyCode) => {
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
      await delay(40);
    };
    const setViewport = (width, height, mobile) => command('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile,
    });
    const setLanguage = (lang) => evaluate(
      `document.querySelector('.lang-switch [data-lang="${lang}"]').click()`
    );
    const waitForRows = (count) => evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+10000;const check=()=>{`
      + `if(document.querySelectorAll('.user-row').length===${count}){resolve(true);return}`
      + `if(Date.now()>end){reject(new Error('Timed out waiting for ${count} rows'));return}`
      + `requestAnimationFrame(check)};check()})`
    );
    const waitForText = (selector, expected) => evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+10000;const check=()=>{`
      + `const element=document.querySelector(${JSON.stringify(selector)});`
      + `if(element&&!element.classList.contains('hidden')&&element.textContent.trim()===${JSON.stringify(expected)}){resolve(true);return}`
      + `if(Date.now()>end){reject(new Error('Timed out waiting for text on ${selector}'));return}`
      + `requestAnimationFrame(check)};check()})`
    );
    const navigate = async (pathname) => {
      const loaded = new Promise((resolve) => {
        const listener = (event) => {
          if (JSON.parse(event.data).method === 'Page.loadEventFired') {
            socket.removeEventListener('message', listener);
            resolve();
          }
        };
        socket.addEventListener('message', listener);
      });
      await command('Page.navigate', { url: `${baseUrl}${pathname}` });
      await Promise.race([loaded, delay(15000).then(() => {
        throw new Error(`Navigation to ${pathname} timed out.`);
      })]);
    };
    const setSession = (account) => command('Network.setCookie', {
      name: SESSION_COOKIE_NAME, value: createSession(db, account.id).token, url: origin,
    });

    await command('Page.enable');
    await command('Runtime.enable');
    await command('Network.enable');
    await setViewport(1280, 900, false);
    await setSession(admin);

    /* ── The page loads for an administrator ── */

    await navigate('/admin-users.html');
    await waitForRows(2);
    const layout = await evaluate(`(()=>{
      const list=document.querySelector('.user-list');
      const group=document.querySelector('.nav-group');
      const groupTitle=document.querySelector('.nav-group-title');
      const item=document.querySelector('[data-nav-id="admin-users"]');
      return {
        title:document.title,
        heading:document.querySelector('.admin-header-text h1').textContent,
        groupTitle:groupTitle.textContent,
        navLabel:item.querySelector('.nav-label').textContent,
        active:item.classList.contains('active'),
        groupDisplay:getComputedStyle(group).display,
        names:[...document.querySelectorAll('.user-name')].map((node)=>node.textContent),
        admins:document.querySelectorAll('.user-role.role-admin').length,
        selfDeleteButtons:document.querySelectorAll('.user-row [data-action="delete"]').length,
        created:document.querySelector('.user-created').textContent,
        documentOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
        listOverflow:list.scrollWidth>list.clientWidth,
      };
    })()`);
    assert.equal(layout.title, 'Users - Kinesis');
    assert.equal(layout.heading, 'Users');
    assert.equal(layout.groupTitle, 'Administration');
    assert.equal(layout.navLabel, 'Users');
    assert.equal(layout.active, true, 'the accounts item is the active navigation entry');
    assert.equal(layout.groupDisplay, 'flex');
    assert.deepEqual(layout.names, ['Ada Admin', 'Rita Runner']);
    assert.equal(layout.admins, 1, 'only the seeded account is an administrator');
    // The signed-in account is never offered a delete control.
    assert.equal(layout.selfDeleteButtons, 1, 'only the other account can be deleted');
    assert.match(layout.created, /^Created on \d{2}\/\d{2}\/\d{4}$/, 'the creation date renders');
    assert.equal(layout.documentOverflow, false, 'no horizontal page overflow');
    assert.equal(layout.listOverflow, false, 'the account list does not overflow its row');

    /* ── Language switching rerenders the page and the group ── */

    await setLanguage('pt-BR');
    await delay(400);
    const portuguese = await evaluate(`({
      lang:document.documentElement.lang,
      heading:document.querySelector('.admin-header-text h1').textContent,
      groupTitle:document.querySelector('.nav-group-title').textContent,
      navLabel:document.querySelector('[data-nav-id="admin-users"] .nav-label').textContent,
      created:document.querySelector('.user-created').textContent,
      self:document.querySelector('.user-self-chip').textContent,
      editLabel:document.querySelector('[data-action="edit"]').getAttribute('aria-label'),
      deleteLabel:document.querySelector('[data-action="delete"]').getAttribute('aria-label'),
    })`);
    assert.equal(portuguese.lang, 'pt-BR');
    assert.equal(portuguese.heading, 'Usuários');
    assert.equal(portuguese.groupTitle, 'Administração');
    assert.equal(portuguese.navLabel, 'Usuários');
    assert.equal(portuguese.self, 'Você');
    assert.equal(portuguese.editLabel, 'Editar usuário');
    assert.equal(portuguese.deleteLabel, 'Excluir usuário');
    assert.match(portuguese.created, /^Criada em /);
    await setLanguage('en-US');
    await delay(400);

    /* ── The collapsed sidebar keeps only the icon ── */

    const collapsed = await evaluate(`(()=>{
      document.getElementById('sidebarToggle').click();
      const shell=document.querySelector('.app-shell');
      const title=document.querySelector('.nav-group-title');
      const item=document.querySelector('[data-nav-id="admin-users"]');
      const state={
        collapsed:shell.classList.contains('collapsed'),
        titleDisplay:getComputedStyle(title).display,
        itemDisplay:getComputedStyle(item).display,
        hasIcon:!!item.querySelector('svg'),
      };
      document.getElementById('sidebarToggle').click();
      return state;
    })()`);
    assert.deepEqual(collapsed, {
      collapsed: true, titleDisplay: 'none', itemDisplay: 'flex', hasIcon: true,
    }, 'the collapsed sidebar keeps the administration icon and hides the labels');

    /* ── The modal is keyboard contained and restores focus ── */

    const modal = await evaluate(`(()=>{
      document.getElementById('addUserBtn').focus();
      document.getElementById('addUserBtn').click();
      const box=document.getElementById('userModal');
      return {
        open:!box.classList.contains('hidden'),
        roleDialog:box.querySelector('.modal-card').getAttribute('role'),
        modal:box.querySelector('.modal-card').getAttribute('aria-modal'),
        labelled:box.querySelector('.modal-card').getAttribute('aria-labelledby'),
        focused:document.activeElement.id,
        passwordShown:!document.getElementById('userPasswordFields').classList.contains('hidden'),
        roleSelector:!!document.getElementById('userRole'),
        backgroundInert:document.querySelector('.app-shell').hasAttribute('inert'),
      };
    })()`);
    assert.deepEqual(modal, {
      open: true,
      roleDialog: 'dialog',
      modal: 'true',
      labelled: 'userModalTitle',
      focused: 'userFirstName',
      passwordShown: true,
      roleSelector: false,
      backgroundInert: true,
    });

    // Tab wraps inside the dialog instead of reaching the page behind it.
    for (let index = 0; index < 12; index += 1) await pressKey('Tab', 'Tab', 9);
    assert.equal(
      await evaluate(`document.getElementById('userModal').contains(document.activeElement)`),
      true,
      'Tab stays inside the account dialog'
    );
    await pressKey('Escape', 'Escape', 27);
    const closedByEscape = await evaluate(`({
      closed:document.getElementById('userModal').classList.contains('hidden'),
      focused:document.activeElement.id,
      backgroundInert:document.querySelector('.app-shell').hasAttribute('inert'),
    })`);
    assert.deepEqual(closedByEscape, { closed: true, focused: 'addUserBtn', backgroundInert: false },
      'Escape closes the dialog and returns focus to the trigger');

    /* ── Client validation is localized and blocks the request ── */

    await evaluate(`document.getElementById('addUserBtn').click()`);
    const confirmationField = await evaluate(`(async()=>{
      const field=document.getElementById('userPasswordConfirm');
      const label=document.querySelector('label[for="userPasswordConfirm"]');
      return {
        type:field.getAttribute('type'),
        autocomplete:field.getAttribute('autocomplete'),
        label:label.textContent,
        listed:!!document.querySelector('label[for="userPasswordConfirm"]'),
        passwordKeystroke:field.getAttribute('autocomplete'),
        ordered:document.querySelector('label[for="userPassword"]').compareDocumentPosition(field)
          & Node.DOCUMENT_POSITION_FOLLOWING ? true : false,
      };
    })()`);
    assert.deepEqual(confirmationField, {
      type: 'password',
      autocomplete: 'new-password',
      label: 'Confirm password',
      listed: true,
      passwordKeystroke: 'new-password',
      ordered: true,
    }, 'the confirmation sits right after the initial password and is a masked field');

    const invalid = await evaluate(`(async()=>{
      const set=(id,value)=>{document.getElementById(id).value=value};
      set('userFirstName','Bad');set('userLastName','Email');
      set('userEmail','not-an-email');set('userPassword','short');
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,600));
      const box=document.getElementById('userFormError');
      const confirm=document.getElementById('userPasswordConfirm');
      return {
        items:[...box.querySelectorAll('li')].map((node)=>node.textContent),
        shown:!box.classList.contains('hidden'),
        stillOpen:!document.getElementById('userModal').classList.contains('hidden'),
        focused:document.activeElement.id,
        invalid:confirm.getAttribute('aria-invalid'),
        described:confirm.getAttribute('aria-describedby'),
        marked:confirm.classList.contains('input-error'),
        boxRole:box.getAttribute('role'),
      };
    })()`);
    assert.equal(invalid.shown, true);
    assert.equal(invalid.stillOpen, true);
    assert.deepEqual(invalid.items, [
      'Enter a valid email address.',
      'The password must be at least 8 characters long.',
      'Confirm the initial password.',
    ]);
    // The refusal is explained in place: the group error is announced, the
    // confirmation is described by it, marked invalid and takes focus, and the
    // typed values are kept for the retry.
    assert.equal(invalid.boxRole, 'alert');
    assert.equal(invalid.focused, 'userPasswordConfirm');
    assert.equal(invalid.invalid, 'true');
    assert.equal(invalid.described, 'userFormError');
    assert.equal(invalid.marked, true);

    /* ── A mismatched confirmation is refused and keeps every typed value ── */

    const mismatch = await evaluate(`(async()=>{
      const set=(id,value)=>{document.getElementById(id).value=value};
      set('userEmail','mismatch@example.test');
      set('userPassword','${PASSWORD}');set('userPasswordConfirm','${PASSWORD}-typo');
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,600));
      const box=document.getElementById('userFormError');
      const confirm=document.getElementById('userPasswordConfirm');
      return {
        // A single failure is stated as one message, matching the other fields.
        text:box.textContent,
        items:[...box.querySelectorAll('li')].map((node)=>node.textContent),
        shown:!box.classList.contains('hidden'),
        stillOpen:!document.getElementById('userModal').classList.contains('hidden'),
        rows:document.querySelectorAll('.user-row').length,
        firstName:document.getElementById('userFirstName').value,
        email:document.getElementById('userEmail').value,
        password:document.getElementById('userPassword').value,
        confirm:confirm.value,
        focused:document.activeElement.id,
        invalid:confirm.getAttribute('aria-invalid'),
      };
    })()`);
    assert.deepEqual(mismatch, {
      text: 'The passwords do not match.',
      items: [],
      shown: true,
      stillOpen: true,
      rows: 2,
      firstName: 'Bad',
      email: 'mismatch@example.test',
      password: PASSWORD,
      confirm: `${PASSWORD}-typo`,
      focused: 'userPasswordConfirm',
      invalid: 'true',
    }, 'a mismatch is refused before any request and nothing typed is discarded');

    // Correcting the confirmation clears the field's association with the error
    // box; the box itself stays until the next submit.
    const corrected = await evaluate(`(()=>{
      const confirm=document.getElementById('userPasswordConfirm');
      confirm.value='${PASSWORD}';
      confirm.dispatchEvent(new Event('input',{bubbles:true}));
      return {
        invalid:confirm.getAttribute('aria-invalid'),
        marked:confirm.classList.contains('input-error'),
        stillOpen:!document.getElementById('userModal').classList.contains('hidden'),
      };
    })()`);
    assert.deepEqual(corrected, { invalid: null, marked: false, stillOpen: true },
      'typing again clears the field error without closing the dialog');

    /* ── A visible validation error survives a language switch ── */

    // The error is held as translation keys, so switching language restates it
    // in the new language instead of clearing the explanation. Everything the
    // user typed, the create mode, the focused control and the open dialog are
    // preserved.
    const localizedValidation = await evaluate(`(async()=>{
      const set=(id,value)=>{document.getElementById(id).value=value};
      set('userEmail','not-an-email');set('userPassword','short');
      set('userPasswordConfirm','');
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,600));
      document.getElementById('userEmail').focus();
      document.querySelector('.lang-switch [data-lang="pt-BR"]').click();
      await new Promise((resolve)=>setTimeout(resolve,700));
      const box=document.getElementById('userFormError');
      const confirm=document.getElementById('userPasswordConfirm');
      return {
        items:[...box.querySelectorAll('li')].map((node)=>node.textContent),
        shown:!box.classList.contains('hidden'),
        stillOpen:!document.getElementById('userModal').classList.contains('hidden'),
        firstName:document.getElementById('userFirstName').value,
        email:document.getElementById('userEmail').value,
        password:document.getElementById('userPassword').value,
        confirmLabel:document.querySelector('label[for="userPasswordConfirm"]').textContent,
        confirmInvalid:confirm.getAttribute('aria-invalid'),
        title:document.getElementById('userModalTitle').textContent,
        mode:document.getElementById('userForm').dataset.mode,
        focused:document.activeElement.id,
        passwordShown:!document.getElementById('userPasswordFields').classList.contains('hidden'),
      };
    })()`);
    assert.deepEqual(localizedValidation, {
      items: [
        'Informe um e-mail válido.',
        'A senha deve ter pelo menos 8 caracteres.',
        'Confirme a senha inicial.',
      ],
      shown: true,
      stillOpen: true,
      firstName: 'Bad',
      email: 'not-an-email',
      password: 'short',
      confirmLabel: 'Confirmar senha',
      confirmInvalid: 'true',
      title: 'Adicionar Novo Usuário',
      mode: 'add',
      focused: 'userEmail',
      passwordShown: true,
    }, 'a PT switch restates the pending validation error and preserves the dialog');

    // …and back to English, in the other direction.
    const backToEnglish = await evaluate(`(async()=>{
      document.querySelector('.lang-switch [data-lang="en-US"]').click();
      await new Promise((resolve)=>setTimeout(resolve,700));
      const box=document.getElementById('userFormError');
      return {
        items:[...box.querySelectorAll('li')].map((node)=>node.textContent),
        title:document.getElementById('userModalTitle').textContent,
        confirmLabel:document.querySelector('label[for="userPasswordConfirm"]').textContent,
        focused:document.activeElement.id,
      };
    })()`);
    assert.deepEqual(backToEnglish, {
      items: [
        'Enter a valid email address.',
        'The password must be at least 8 characters long.',
        'Confirm the initial password.',
      ],
      title: 'Add New User',
      confirmLabel: 'Confirm password',
      focused: 'userEmail',
    }, 'the error is restated in English as well, without losing focus');

    /* ── A valid create adds the account and closes the modal ── */

    const created = await evaluate(`(async()=>{
      const set=(id,value)=>{document.getElementById(id).value=value};
      set('userFirstName','Diego');set('userLastName','Rocha');
      set('userEmail','diego@example.test');set('userPassword','${PASSWORD}');set('userPasswordConfirm','${PASSWORD}');
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,900));
      return {
        closed:document.getElementById('userModal').classList.contains('hidden'),
        toast:document.querySelector('.toast-text').textContent,
        visible:document.getElementById('toast').classList.contains('visible'),
        admins:document.querySelectorAll('.user-role.role-admin').length,
      };
    })()`);
    assert.equal(created.closed, true, 'the dialog closes after a successful save');
    assert.equal(created.visible, true, 'the toast confirms the change');
    assert.equal(created.admins, 1, 'web creation cannot grant administrator access');
    await waitForRows(3);

    /* ── A committed create is not reported as failed when its refresh fails ── */

    const refreshFailureCreate = await evaluate(`(async()=>{
      window.__failNextAdminList=true;
      window.__holdNextMutation='POST';
      const nativeFetch=window.fetch.bind(window);
      window.fetch=(input,init)=>{
        const method=(init?.method||'GET').toUpperCase();
        if(window.__editFetchHold&&method==='GET'&&String(input).includes('/api/admin/users/')
          && !String(input).endsWith('/api/admin/users')){
          const id=String(input).split('/').pop();
          return new Promise((resolve,reject)=>{
            window.__pendingEditGets[id]={
              resolve:()=>nativeFetch(input,init).then(resolve,reject),
              reject:()=>reject(new Error('stale edit request failed')),
            };
          });
        }
        if(window.__captureNextPut&&method==='PUT'&&String(input).includes('/api/admin/users/')){
          window.__captureNextPut=false;
          window.__capturedPut={id:String(input).split('/').pop(),body:JSON.parse(init.body)};
          return Promise.resolve(new Response(JSON.stringify({user:{
            id:Number(window.__capturedPut.id),
            email:window.__capturedPut.body.email,
            first_name:window.__capturedPut.body.first_name,
            last_name:window.__capturedPut.body.last_name,
            role:'user',
            created_at:null,
          }}),{status:200,headers:{'content-type':'application/json'}}));
        }
        if(window.__returnEmptyAdminList&&method==='GET'&&String(input).endsWith('/api/admin/users')){
          return Promise.resolve(new Response(JSON.stringify({users:[]}),
            {status:200,headers:{'content-type':'application/json'}}));
        }
        if(window.__holdNextAdminList&&method==='GET'&&String(input).endsWith('/api/admin/users')){
          window.__holdNextAdminList=false;
          return new Promise((resolve,reject)=>{
            window.__releaseAdminList=()=>nativeFetch(input,init).then(resolve,reject);
            window.__rejectAdminList=()=>reject(new Error('simulated list refresh failure'));
          });
        }
        if(window.__failNextAdminList&&method==='GET'&&String(input).includes('/api/admin/users')){
          window.__failNextAdminList=false;
          return Promise.reject(new Error('simulated list refresh failure'));
        }
        if(window.__failNextMutation===method&&String(input).includes('/api/admin/users')){
          window.__failNextMutation=null;
          return Promise.reject(new Error('simulated mutation failure'));
        }
        if(window.__holdNextMutation===method&&String(input).includes('/api/admin/users')){
          window.__holdNextMutation=null;
          return new Promise((resolve,reject)=>{
            window.__releaseAdminMutation=()=>nativeFetch(input,init).then(resolve,reject);
            window.__rejectAdminMutation=()=>reject(new Error('simulated mutation failure'));
          });
        }
        return nativeFetch(input,init);
      };
      document.getElementById('addUserBtn').click();
      const set=(id,value)=>{document.getElementById(id).value=value};
      set('userFirstName','Refresh');set('userLastName','Create');
      set('userEmail','refresh-create@example.test');set('userPassword','${PASSWORD}');set('userPasswordConfirm','${PASSWORD}');
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,150));
      const pending={
        open:!document.getElementById('userModal').classList.contains('hidden'),
        saving:document.getElementById('userFormSubmitLabel').textContent,
        saveDisabled:document.getElementById('userFormSubmit').disabled,
        cancelDisabled:document.getElementById('userFormCancel').disabled,
        closeDisabled:document.getElementById('userModalClose').disabled,
        addDisabled:document.getElementById('addUserBtn').disabled,
        firstName:document.getElementById('userFirstName').value,
      };
      document.querySelector('.lang-switch [data-lang="pt-BR"]').click();
      await new Promise((resolve)=>setTimeout(resolve,350));
      const savingPt=document.getElementById('userFormSubmitLabel').textContent;
      document.querySelector('.lang-switch [data-lang="en-US"]').click();
      await new Promise((resolve)=>setTimeout(resolve,350));
      document.getElementById('userFormCancel').click();
      document.getElementById('userModalClose').click();
      document.getElementById('userModal').dispatchEvent(new MouseEvent('click',{bubbles:true}));
      document.getElementById('addUserBtn').click();
      const stillPending=!document.getElementById('userModal').classList.contains('hidden');
      await window.__releaseAdminMutation();
      await new Promise((resolve)=>setTimeout(resolve,900));
      return {
        pending,savingPt,stillPending,
        closed:document.getElementById('userModal').classList.contains('hidden'),
        success:document.querySelector('#toast .toast-text').textContent,
        refreshError:document.querySelector('#usersError p').textContent,
        errorVisible:!document.getElementById('usersError').classList.contains('hidden'),
        staleRows:document.querySelectorAll('.user-row').length,
      };
    })()`,);
    assert.deepEqual(refreshFailureCreate.pending, {
      open: true,
      saving: 'Saving…',
      saveDisabled: true,
      cancelDisabled: true,
      closeDisabled: true,
      addDisabled: true,
      firstName: 'Refresh',
    });
    assert.equal(refreshFailureCreate.savingPt, 'Salvando…');
    assert.equal(refreshFailureCreate.stillPending, true);
    assert.deepEqual(refreshFailureCreate, {
      pending: refreshFailureCreate.pending,
      savingPt: 'Salvando…',
      stillPending: true,
      closed: true,
      success: 'Account created.',
      refreshError: 'The change was saved, but the account list could not be updated.',
      errorVisible: true,
      staleRows: 0,
    });
    await setLanguage('pt-BR');
    await new Promise((resolve)=>setTimeout(resolve,350));
    const refreshErrorPt=await evaluate(`({
      error:!document.getElementById('usersError').classList.contains('hidden'),
      empty:!document.getElementById('usersEmpty').classList.contains('hidden'),
      retry:!document.getElementById('retryUsersBtn').classList.contains('hidden'),
      message:document.querySelector('#usersError p').textContent,
    })`);
    assert.deepEqual(refreshErrorPt, {
      error:true,
      empty:false,
      retry:true,
      message:'A alteração foi salva, mas não foi possível atualizar a lista de contas.',
    });
    await setLanguage('en-US');
    await new Promise((resolve)=>setTimeout(resolve,350));
    await evaluate(`window.__returnEmptyAdminList=true;document.getElementById('retryUsersBtn').click()`);
    await waitForText('#usersEmpty p', 'No accounts registered yet.');
    const emptyAfterRetry=await evaluate(`({error:!document.getElementById('usersError').classList.contains('hidden'),empty:!document.getElementById('usersEmpty').classList.contains('hidden')})`);
    assert.deepEqual(emptyAfterRetry,{error:false,empty:true});
    await evaluate(`window.__returnEmptyAdminList=false;document.getElementById('retryUsersBtn').click()`);
    await waitForRows(4);
    assert.equal(await evaluate(`document.getElementById('usersError').classList.contains('hidden')`), true);

    /* ── Only the newest edit lookup may populate the dialog ── */

    const staleEditLookup = await evaluate(`(async()=>{
      const rowA=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Diego Rocha');
      const rowB=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Rita Runner');
      const idA=rowA.dataset.userId;
      const idB=rowB.dataset.userId;
      window.__editFetchHold=true;
      window.__pendingEditGets={};
      rowA.querySelector('[data-action="edit"]').click();
      rowB.querySelector('[data-action="edit"]').click();
      await new Promise((resolve)=>setTimeout(resolve,100));
      document.querySelector('.lang-switch [data-lang="pt-BR"]').click();
      await new Promise((resolve)=>setTimeout(resolve,300));
      window.__pendingEditGets[idB].resolve();
      await new Promise((resolve)=>setTimeout(resolve,500));
      const portuguese={
        id:document.getElementById('userForm').dataset.userId,
        email:document.getElementById('userEmail').value,
        title:document.getElementById('userModalTitle').textContent,
      };
      window.__pendingEditGets[idA].reject();
      await new Promise((resolve)=>setTimeout(resolve,400));
      window.__editFetchHold=false;
      document.querySelector('.lang-switch [data-lang="en-US"]').click();
      await new Promise((resolve)=>setTimeout(resolve,300));
      document.getElementById('userFirstName').value='Rita Promoted';
      window.__captureNextPut=true;
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,900));
      return {idA,idB,portuguese,put:window.__capturedPut,
        closed:document.getElementById('userModal').classList.contains('hidden'),
        staleError:document.querySelector('#toast').classList.contains('visible')
          && document.querySelector('#toast .toast-text').textContent.includes('stale')};
    })()`);
    assert.equal(staleEditLookup.idA !== staleEditLookup.idB, true);
    assert.deepEqual(staleEditLookup.portuguese, {
      id: staleEditLookup.idB,
      email: 'runner@example.test',
      title: 'Editar Usuário',
    });
    assert.deepEqual(staleEditLookup.put, {
      id: staleEditLookup.idB,
      body: {
        first_name: 'Rita Promoted',
      },
    });
    assert.equal(staleEditLookup.closed, true);
    assert.equal(staleEditLookup.staleError, false);

    const unchangedEdit = await evaluate(`(async()=>{
      const row=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Diego Rocha');
      row.querySelector('[data-action="edit"]').click();
      await new Promise((resolve)=>setTimeout(resolve,450));
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,350));
      const state={
        open:!document.getElementById('userModal').classList.contains('hidden'),
        error:document.getElementById('userFormError').textContent.trim(),
      };
      document.getElementById('userFormCancel').click();
      return state;
    })()`);
    assert.deepEqual(unchangedEdit, {
      open:true,
      error:'Make at least one change before saving.',
    });

    /* ── Deletion serializes list actions until DELETE settles ── */

    const delayedDelete = await evaluate(`(async()=>{
      const row=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Diego Rocha');
      row.querySelector('[data-action="delete"]').click();
      await new Promise((resolve)=>setTimeout(resolve,300));
      window.__holdNextMutation='DELETE';
      document.getElementById('confirmOkBtn').click();
      await new Promise((resolve)=>setTimeout(resolve,180));
      const editRow=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Rita Runner');
      editRow.querySelector('[data-action="edit"]').click();
      row.querySelector('[data-action="delete"]').click();
      const pending={
        addDisabled:document.getElementById('addUserBtn').disabled,
        actionsDisabled:[...document.querySelectorAll('#userList [data-action]')].every((button)=>button.disabled),
        modal:!document.getElementById('userModal').classList.contains('hidden'),
      };
      window.__rejectAdminMutation();
      await new Promise((resolve)=>setTimeout(resolve,650));
      return {pending,
        error:document.querySelector('#toast .toast-text').textContent,
        rowStillPresent:[...document.querySelectorAll('.user-row')].some((item)=>item.dataset.userId===row.dataset.userId),
        actionsEnabled:[...document.querySelectorAll('#userList [data-action]')].every((button)=>!button.disabled)};
    })()`);
    assert.deepEqual(delayedDelete, {
      pending:{addDisabled:true,actionsDisabled:true,modal:false},
      error:'The request could not be completed. Try again.',
      rowStillPresent:true,
      actionsEnabled:true,
    });

    /* ── Deletion invalidates an edit lookup before opening confirmation ── */

    const editThenCancelDelete = await evaluate(`(async()=>{
      const rowA=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Diego Rocha');
      const rowB=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Rita Runner');
      const idA=rowA.dataset.userId;
      window.__editFetchHold=true;
      window.__pendingEditGets={};
      rowA.querySelector('[data-action="edit"]').click();
      rowB.querySelector('[data-action="delete"]').click();
      await new Promise((resolve)=>setTimeout(resolve,350));
      const confirmationOpen=!!document.querySelector('.confirm-card');
      window.__pendingEditGets[idA].resolve();
      await new Promise((resolve)=>setTimeout(resolve,450));
      const noOverlay={
        userModal:!document.getElementById('userModal').classList.contains('hidden'),
        confirmation:!!document.querySelector('.confirm-card'),
        toast:document.querySelector('#toast .toast-text').textContent.includes('stale'),
        focusInConfirmation:!!document.querySelector('.confirm-card')?.contains(document.activeElement),
      };
      document.getElementById('confirmCancelBtn').click();
      await new Promise((resolve)=>setTimeout(resolve,300));
      return {confirmationOpen,noOverlay,closed:!document.querySelector('.confirm-card')};
    })()`);
    assert.deepEqual(editThenCancelDelete, {
      confirmationOpen:true,
      noOverlay:{userModal:false,confirmation:true,toast:false,focusInConfirmation:true},
      closed:true,
    });

    const editThenConfirmDelete = await evaluate(`(async()=>{
      const rowA=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Diego Rocha');
      const rowB=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Rita Runner');
      const idA=rowA.dataset.userId;
      window.__editFetchHold=true;
      window.__pendingEditGets={};
      rowA.querySelector('[data-action="edit"]').click();
      window.__failNextMutation='DELETE';
      rowB.querySelector('[data-action="delete"]').click();
      await new Promise((resolve)=>setTimeout(resolve,350));
      window.__pendingEditGets[idA].reject();
      await new Promise((resolve)=>setTimeout(resolve,350));
      document.getElementById('confirmOkBtn').click();
      await new Promise((resolve)=>setTimeout(resolve,650));
      window.__editFetchHold=false;
      return {
        userModal:!document.getElementById('userModal').classList.contains('hidden'),
        confirmation:!!document.querySelector('.confirm-card'),
        rowStillPresent:[...document.querySelectorAll('.user-row')].some((row)=>row.dataset.userId===rowB.dataset.userId),
        errorToast:document.querySelector('#toast .toast-text').textContent,
      };
    })()`);
    assert.deepEqual(editThenConfirmDelete, {
      userModal:false,
      confirmation:false,
      rowStillPresent:true,
      errorToast:'The request could not be completed. Try again.',
    });

    /* ── A rejected create keeps its dialog, fields and current-language error ── */

    const failedCreate = await evaluate(`(async()=>{
      window.__holdNextMutation='POST';
      document.getElementById('addUserBtn').click();
      const set=(id,value)=>{document.getElementById(id).value=value};
      set('userFirstName','Pending');set('userLastName','Create Failure');
      set('userEmail','pending-create-failure@example.test');set('userPassword','${PASSWORD}');set('userPasswordConfirm','${PASSWORD}');
      document.getElementById('userEmail').focus();
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,150));
      document.querySelector('.lang-switch [data-lang="pt-BR"]').click();
      await new Promise((resolve)=>setTimeout(resolve,350));
      document.querySelector('.lang-switch [data-lang="en-US"]').click();
      await new Promise((resolve)=>setTimeout(resolve,350));
      window.__rejectAdminMutation();
      await new Promise((resolve)=>setTimeout(resolve,500));
      return {open:!document.getElementById('userModal').classList.contains('hidden'),
        error:document.getElementById('userFormError').textContent.trim(),
        label:document.getElementById('userFormSubmitLabel').textContent,
        email:document.getElementById('userEmail').value,
        focused:document.activeElement.id,
        saveDisabled:document.getElementById('userFormSubmit').disabled};
    })()`);
    assert.deepEqual(failedCreate, {
      open: true,
      error: 'The request could not be completed. Try again.',
      label: 'Save',
      email: 'pending-create-failure@example.test',
      focused: 'userEmail',
      saveDisabled: false,
    });
    await evaluate(`document.getElementById('userFormCancel').click()`);

    /* ── A duplicate email is reported by the server ── */

    const duplicate = await evaluate(`(async()=>{
      document.getElementById('addUserBtn').click();
      const set=(id,value)=>{document.getElementById(id).value=value};
      set('userFirstName','Dup');set('userLastName','Licate');
      set('userEmail','diego@example.test');set('userPassword','${PASSWORD}');set('userPasswordConfirm','${PASSWORD}');
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,900));
      return {
        message:document.getElementById('userFormError').textContent.trim(),
        stillOpen:!document.getElementById('userModal').classList.contains('hidden'),
      };
    })()`);
    assert.equal(duplicate.stillOpen, true);
    assert.equal(duplicate.message, 'This email is already registered.');

    // A server error keeps its stable code mapped to a translation, so the
    // message follows the language too and the raw server prose is never shown.
    const localizedApiError = await evaluate(`(async()=>{
      document.getElementById('userEmail').focus();
      document.querySelector('.lang-switch [data-lang="pt-BR"]').click();
      await new Promise((resolve)=>setTimeout(resolve,700));
      const box=document.getElementById('userFormError');
      const state={
        message:box.textContent.trim(),
        shown:!box.classList.contains('hidden'),
        stillOpen:!document.getElementById('userModal').classList.contains('hidden'),
        email:document.getElementById('userEmail').value,
        title:document.getElementById('userModalTitle').textContent,
        focused:document.activeElement.id,
      };
      document.querySelector('.lang-switch [data-lang="en-US"]').click();
      await new Promise((resolve)=>setTimeout(resolve,700));
      state.backInEnglish=box.textContent.trim();
      return state;
    })()`);
    assert.deepEqual(localizedApiError, {
      message: 'Este e-mail já está cadastrado.',
      shown: true,
      stillOpen: true,
      email: 'diego@example.test',
      title: 'Adicionar Novo Usuário',
      focused: 'userEmail',
      backInEnglish: 'This email is already registered.',
    }, 'a server error is restated in the new language in both directions');

    await evaluate(`document.getElementById('userFormCancel').click()`);

    /* ── The edit trigger survives list rerenders and both language changes ── */

    const editFocus = await evaluate(`(async()=>{
      const row=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Refresh Create');
      const trigger=row.querySelector('[data-action="edit"]');
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      trigger.click();
      await new Promise((resolve)=>setTimeout(resolve,500));
      const before=document.getElementById('userFirstName').value;
      document.querySelector('.lang-switch [data-lang="pt-BR"]').click();
      await new Promise((resolve)=>setTimeout(resolve,600));
      document.querySelector('.lang-switch [data-lang="en-US"]').click();
      await new Promise((resolve)=>setTimeout(resolve,600));
      document.getElementById('userModalClose').click();
      const afterButton=document.activeElement;
      const closedByButton={
        id:afterButton.dataset.id,
        action:afterButton.dataset.action,
        connected:afterButton.isConnected,
        visible:afterButton.getBoundingClientRect().width>0,
        value:before,
      };
      const nextRow=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Refresh Create');
      nextRow.querySelector('[data-action="edit"]').focus();
      nextRow.querySelector('[data-action="edit"]').click();
      await new Promise((resolve)=>setTimeout(resolve,500));
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      const escapeFocus=document.activeElement;
      return {closedByButton,closedByEscape:{id:escapeFocus.dataset.id,connected:escapeFocus.isConnected,
        visible:escapeFocus.getBoundingClientRect().width>0}};
    })()`);
    assert.equal(editFocus.closedByButton.action, 'edit');
    assert.ok(editFocus.closedByButton.id);
    assert.equal(editFocus.closedByButton.connected, true);
    assert.equal(editFocus.closedByButton.visible, true);
    assert.equal(editFocus.closedByButton.value, 'Refresh');
    assert.ok(editFocus.closedByEscape.id);
    assert.equal(editFocus.closedByEscape.connected, true);
    assert.equal(editFocus.closedByEscape.visible, true);

    /* ── Edit and delete keep their success when the following refresh fails ── */

    const refreshFailureEdit = await evaluate(`(async()=>{
      const row=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Refresh Create');
      row.querySelector('[data-action="edit"]').click();
      await new Promise((resolve)=>setTimeout(resolve,400));
      document.getElementById('userFirstName').value='Refresh Updated';
      window.__failNextAdminList=true;
      window.__holdNextMutation='PUT';
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,150));
      document.querySelector('.lang-switch [data-lang="pt-BR"]').click();
      await new Promise((resolve)=>setTimeout(resolve,350));
      const savingPt=document.getElementById('userFormSubmitLabel').textContent;
      document.getElementById('userFormCancel').click();
      document.getElementById('userModalClose').click();
      document.getElementById('userModal').dispatchEvent(new MouseEvent('click',{bubbles:true}));
      await window.__releaseAdminMutation();
      await new Promise((resolve)=>setTimeout(resolve,900));
      return {closed:document.getElementById('userModal').classList.contains('hidden'),
        success:document.querySelector('#toast .toast-text').textContent,
        error:document.querySelector('#usersError p').textContent,
        rows:document.querySelectorAll('.user-row').length,savingPt,
        focused:document.activeElement.id,
        focusConnected:document.activeElement.isConnected};
    })()`);
    assert.deepEqual(refreshFailureEdit, {
      closed: true,
      success: 'Conta atualizada.',
      error: 'A alteração foi salva, mas não foi possível atualizar a lista de contas.',
      savingPt: 'Salvando…',
      rows: 0,
      focused: 'addUserBtn',
      focusConnected: true,
    });
    await evaluate(`document.getElementById('retryUsersBtn').click()`);
    await waitForRows(4);
    await setLanguage('en-US');
    await delay(350);

    const refreshFailureDelete = await evaluate(`(async()=>{
      const row=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Refresh Updated Create');
      row.querySelector('[data-action="delete"]').click();
      await new Promise((resolve)=>setTimeout(resolve,300));
      window.__failNextAdminList=true;
      document.getElementById('confirmOkBtn').click();
      await new Promise((resolve)=>setTimeout(resolve,900));
      return {success:document.querySelector('#toast .toast-text').textContent,
        error:document.querySelector('#usersError p').textContent,
        rows:document.querySelectorAll('.user-row').length};
    })()`);
    assert.deepEqual(refreshFailureDelete, {
      success: 'Account deleted.',
      error: 'The change was saved, but the account list could not be updated.',
      rows: 0,
    });
    await evaluate(`document.getElementById('retryUsersBtn').click()`);
    await waitForRows(3);

    /* ── Mutation failures remain errors in their original UI surfaces ── */

    const mutationFailureEdit = await evaluate(`(async()=>{
      const row=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Diego Rocha');
      row.querySelector('[data-action="edit"]').click();
      await new Promise((resolve)=>setTimeout(resolve,400));
      document.getElementById('userFirstName').value='Diego Pending Edit';
      window.__holdNextMutation='PUT';
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,150));
      document.querySelector('.lang-switch [data-lang="pt-BR"]').click();
      await new Promise((resolve)=>setTimeout(resolve,350));
      window.__rejectAdminMutation();
      await new Promise((resolve)=>setTimeout(resolve,500));
      return {open:!document.getElementById('userModal').classList.contains('hidden'),
        error:document.getElementById('userFormError').textContent.trim(),
        label:document.getElementById('userFormSubmitLabel').textContent,
        focused:document.activeElement.id};
    })()`);
    assert.deepEqual(mutationFailureEdit, {
      open: true,
      error: 'Não foi possível concluir a solicitação. Tente novamente.',
      label: 'Salvar',
      focused: 'userFirstName',
    });
    await evaluate(`document.getElementById('userFormCancel').click()`);
    await setLanguage('en-US');
    await delay(350);

    const mutationFailureDelete = await evaluate(`(async()=>{
      const row=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Diego Rocha');
      row.querySelector('[data-action="delete"]').click();
      await new Promise((resolve)=>setTimeout(resolve,300));
      window.__failNextMutation='DELETE';
      document.getElementById('confirmOkBtn').click();
      await new Promise((resolve)=>setTimeout(resolve,700));
      return {rows:document.querySelectorAll('.user-row').length,
        error:document.querySelector('#toast .toast-text').textContent};
    })()`);
    assert.deepEqual(mutationFailureDelete, {
      rows: 3,
      error: 'The request could not be completed. Try again.',
    });

    /* ── The role is informational only and the account is never deletable ── */

    const selfEdit = await evaluate(`(async()=>{
      const row=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-self-chip'));
      row.querySelector('[data-action="edit"]').click();
      await new Promise((resolve)=>setTimeout(resolve,700));
      const state={
        roleSelector:!!document.getElementById('userRole'),
        hasDelete:!!row.querySelector('[data-action="delete"]'),
        passwordHidden:document.getElementById('userPasswordFields').classList.contains('hidden'),
      };
      document.getElementById('userFirstName').value='Aline';
      document.getElementById('userLastName').value='Administradora';
      document.getElementById('userEmail').value='admin-updated@example.test';
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,900));
      state.badgeAfterSave=document.getElementById('userBadgeName').textContent;
      state.modalClosed=document.getElementById('userModal').classList.contains('hidden');
      document.querySelector('.lang-switch [data-lang="pt-BR"]').click();
      await new Promise((resolve)=>setTimeout(resolve,500));
      state.badgeInPortuguese=document.getElementById('userBadgeName').textContent;
      document.querySelector('.lang-switch [data-lang="en-US"]').click();
      await new Promise((resolve)=>setTimeout(resolve,500));
      state.badgeInEnglish=document.getElementById('userBadgeName').textContent;
      const ownRow=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-self-chip'));
      ownRow.querySelector('[data-action="edit"]').click();
      await new Promise((resolve)=>setTimeout(resolve,500));
      document.getElementById('userFirstName').value='Should Not Save';
      document.getElementById('userEmail').value='runner@example.test';
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,700));
      state.failedPutBadge=document.getElementById('userBadgeName').textContent;
      state.failedPutOpen=!document.getElementById('userModal').classList.contains('hidden');
      state.failedPutError=document.getElementById('userFormError').textContent.trim();
      document.getElementById('userFormCancel').click();
      const refreshedRow=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-self-chip'));
      refreshedRow.querySelector('[data-action="edit"]').click();
      await new Promise((resolve)=>setTimeout(resolve,500));
      document.getElementById('userFirstName').value='Aline Refresh';
      window.__failNextAdminList=true;
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,900));
      state.badgeAfterRefreshFailure=document.getElementById('userBadgeName').textContent;
      state.refreshError=document.querySelector('#usersError p').textContent;
      state.refreshRows=document.querySelectorAll('.user-row').length;
      return state;
    })()`);
    assert.deepEqual(selfEdit, {
      roleSelector: false,
      hasDelete: false,
      passwordHidden: true,
      badgeAfterSave: 'Aline Administradora',
      modalClosed: true,
      badgeInPortuguese: 'Aline Administradora',
      badgeInEnglish: 'Aline Administradora',
      failedPutBadge: 'Aline Administradora',
      failedPutOpen: true,
      failedPutError: 'This email is already registered.',
      badgeAfterRefreshFailure: 'Aline Refresh Administradora',
      refreshError: 'The change was saved, but the account list could not be updated.',
      refreshRows: 0,
    }, 'the signed-in account cannot be demoted or deleted from the panel');
    await evaluate(`document.getElementById('retryUsersBtn').click()`);
    await waitForRows(3);

    /* ── The activity state is shown per account and never for an administrator ── */

    const activityOffered = await evaluate(`(()=>{
      const rowFor=(name)=>[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent===name);
      const runner=rowFor('Rita Runner');
      const self=rowFor('Aline Refresh Administradora');
      return {
        runnerStatus:runner.querySelector('.user-status').textContent,
        runnerStatusClass:runner.querySelector('.user-status').className,
        selfStatus:self.querySelector('.user-status').textContent,
        runnerActions:[...runner.querySelectorAll('[data-action]')].map((node)=>node.dataset.action),
        selfActions:[...self.querySelectorAll('[data-action]')].map((node)=>node.dataset.action),
        roleBadges:document.querySelectorAll('.user-status').length,
        // Every control is labeled in the active language, with the custom
        // tooltip resolved instead of leaking a dictionary key.
        labels:[...runner.querySelectorAll('[data-action]')]
          .map((node)=>[node.dataset.action,node.getAttribute('aria-label')]),
        tooltips:[...runner.querySelectorAll('[data-action]')]
          .map((node)=>node.querySelector('.custom-tooltip').textContent),
      };
    })()`);
    assert.deepEqual(activityOffered, {
      runnerStatus: 'Active',
      runnerStatusClass: 'user-status',
      selfStatus: 'Active',
      runnerActions: ['edit', 'deactivate', 'delete'],
      selfActions: ['edit'],
      roleBadges: 3,
      labels: [
        ['edit', 'Edit user'],
        ['deactivate', 'Deactivate account'],
        ['delete', 'Delete user'],
      ],
      tooltips: ['Edit user', 'Deactivate account', 'Delete user'],
    }, 'a regular account shows its state and can be deactivated, an administrator cannot be');
    const badgeGeometry = await evaluate(`(()=>{
      const runner=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Rita Runner');
      const read=(node)=>{
        const style=getComputedStyle(node);
        return {
          background:style.backgroundColor,
          border:style.borderTopWidth,
          font:style.fontSize,
          radius:style.borderTopLeftRadius,
        };
      };
      return {status:read(runner.querySelector('.user-status')),role:read(runner.querySelector('.user-role'))};
    })()`);
    assert.deepEqual(badgeGeometry, {
      status: { background: 'rgba(0, 0, 0, 0)', border: '1px', font: '11.52px', radius: '999px' },
      role: { background: 'rgba(139, 129, 114, 0.12)', border: '0px', font: '11.52px', radius: '999px' },
    }, 'the state badge reuses the shared pill geometry but stays visually distinct from the role badge');

    /* ── Deactivating confirms, states that data is kept, and can be cancelled ── */

    const deactivateCancelled = await evaluate(`(async()=>{
      const row=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Rita Runner');
      const trigger=row.querySelector('[data-action="deactivate"]');
      // A pointer user focuses the control before activating it, which is what
      // the dialog restores its focus to.
      trigger.focus();
      trigger.click();
      await new Promise((resolve)=>setTimeout(resolve,400));
      const dialog=document.querySelector('.confirm-card');
      const state={
        role:dialog.getAttribute('role'),
        title:document.querySelector('.confirm-title').textContent,
        message:document.querySelector('.confirm-message').textContent,
        confirm:document.getElementById('confirmOkBtn').textContent,
        danger:getComputedStyle(document.getElementById('confirmOkBtn')).backgroundColor,
        focused:document.activeElement.id,
      };
      document.getElementById('confirmCancelBtn').click();
      await new Promise((resolve)=>setTimeout(resolve,400));
      return {...state,
        open:document.querySelectorAll('.confirm-backdrop').length,
        status:document.querySelector('.user-status').textContent,
        focusAfter:document.activeElement.getAttribute('data-action'),
      };
    })()`);
    assert.equal(deactivateCancelled.role, 'alertdialog');
    assert.equal(deactivateCancelled.title, 'Deactivate account');
    assert.match(deactivateCancelled.message, /runner@example\.test/);
    assert.match(deactivateCancelled.message, /kept/, 'the dialog states the data is preserved');
    assert.match(deactivateCancelled.message, /signed out/, 'the dialog states the sessions end');
    assert.equal(deactivateCancelled.confirm, 'Deactivate');
    assert.notEqual(deactivateCancelled.danger, 'rgba(0, 0, 0, 0)', 'the destructive action is styled');
    assert.equal(deactivateCancelled.focused, 'confirmCancelBtn');
    assert.equal(deactivateCancelled.open, 0, 'cancelling closes the confirmation');
    assert.equal(deactivateCancelled.status, 'Active', 'cancelling keeps the account active');
    assert.equal(deactivateCancelled.focusAfter, 'deactivate', 'focus returns to the trigger');

    /* ── Deactivating flips the badge, the action and the focus ── */

    const deactivated = await evaluate(`(async()=>{
      const row=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Rita Runner');
      row.querySelector('[data-action="deactivate"]').click();
      await new Promise((resolve)=>setTimeout(resolve,400));
      document.getElementById('confirmOkBtn').click();
      await new Promise((resolve)=>setTimeout(resolve,1500));
      const updated=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Rita Runner');
      return {
        toast:document.querySelector('#toast .toast-text').textContent,
        toastVisible:document.getElementById('toast').classList.contains('visible'),
        status:updated.querySelector('.user-status').textContent,
        statusClass:updated.querySelector('.user-status').className,
        actions:[...updated.querySelectorAll('[data-action]')].map((node)=>node.dataset.action),
        activateLabel:updated.querySelector('[data-action="activate"]').getAttribute('aria-label'),
        focus:document.activeElement.getAttribute('data-action'),
        rows:document.querySelectorAll('.user-row').length,
      };
    })()`);
    assert.deepEqual(deactivated, {
      toast: 'Account deactivated.',
      toastVisible: true,
      status: 'Inactive',
      statusClass: 'user-status status-inactive',
      actions: ['edit', 'activate', 'delete'],
      activateLabel: 'Activate account',
      focus: 'activate',
      rows: 3,
    }, 'the deactivated account keeps its row and its data, and offers activation');

    await evaluate(`document.querySelector('.lang-switch [data-lang="pt-BR"]').click()`);
    await delay(400);
    assert.deepEqual(
      await evaluate(`(()=>{
        const row=[...document.querySelectorAll('.user-row')]
          .find((node)=>node.querySelector('.user-name').textContent==='Rita Runner');
        return {
          status:row.querySelector('.user-status').textContent,
          label:row.querySelector('[data-action="activate"]').getAttribute('aria-label'),
        };
      })()`),
      { status: 'Inativo', label: 'Ativar conta' },
      'the state and its action are translated'
    );
    await evaluate(`document.querySelector('.lang-switch [data-lang="en-US"]').click()`);
    await delay(400);

    /* ── A stale state is refused and the list is refreshed ── */

    const conflict = await evaluate(`(async()=>{
      const nativeFetch=window.fetch.bind(window);
      window.fetch=(input,init)=>{
        const method=(init?.method||'GET').toUpperCase();
        if(method==='POST'&&String(input).includes('/activity')){
          return Promise.resolve(new Response(
            JSON.stringify({error:'conflict',errors:['activityConflict']}),
            {status:409,headers:{'content-type':'application/json'}}));
        }
        return nativeFetch(input,init);
      };
      const row=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Rita Runner');
      row.querySelector('[data-action="activate"]').click();
      await new Promise((resolve)=>setTimeout(resolve,400));
      document.getElementById('confirmOkBtn').click();
      await new Promise((resolve)=>setTimeout(resolve,1500));
      const updated=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Rita Runner');
      const state={
        toast:document.querySelector('#toast .toast-text').textContent,
        toastError:document.getElementById('toast').classList.contains('toast-error'),
        status:updated.querySelector('.user-status').textContent,
        actions:[...updated.querySelectorAll('[data-action]')].map((node)=>node.dataset.action),
        focus:document.activeElement.getAttribute('data-action'),
        inList:!!document.activeElement.closest('#userList'),
        visible:document.activeElement.getBoundingClientRect().width>0,
      };
      window.fetch=nativeFetch;
      return state;
    })()`);
    assert.deepEqual(conflict, {
      toast: 'This account changed while you were working. The list was refreshed; check its state and try again.',
      toastError: true,
      status: 'Inactive',
      actions: ['edit', 'activate', 'delete'],
      focus: 'activate',
      inList: true,
      visible: true,
    }, 'a refused transition is explained, the list shows the real state and the control is focusable again');

    /* ── Activating restores the login and flips the row back ── */

    const activated = await evaluate(`(async()=>{
      const row=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Rita Runner');
      row.querySelector('[data-action="activate"]').click();
      await new Promise((resolve)=>setTimeout(resolve,400));
      const dialog={
        title:document.querySelector('.confirm-title').textContent,
        message:document.querySelector('.confirm-message').textContent,
        confirm:document.getElementById('confirmOkBtn').textContent,
      };
      document.getElementById('confirmOkBtn').click();
      await new Promise((resolve)=>setTimeout(resolve,1500));
      const updated=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Rita Runner');
      return {...dialog,
        toast:document.querySelector('#toast .toast-text').textContent,
        status:updated.querySelector('.user-status').textContent,
        actions:[...updated.querySelectorAll('[data-action]')].map((node)=>node.dataset.action),
        focus:document.activeElement.getAttribute('data-action'),
      };
    })()`);
    assert.equal(activated.title, 'Activate account');
    assert.match(activated.message, /previous sessions stay signed out/,
      'activation does not promise to restore the revoked sessions');
    assert.equal(activated.confirm, 'Activate');
    assert.deepEqual({
      toast: activated.toast,
      status: activated.status,
      actions: activated.actions,
      focus: activated.focus,
    }, {
      toast: 'Account activated.',
      status: 'Active',
      actions: ['edit', 'deactivate', 'delete'],
      focus: 'deactivate',
    }, 'the activated account is offered the deactivation again');

    /* ── Deleting asks for confirmation and then removes the account ── */

    const cancelled = await evaluate(`(async()=>{
      const row=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Diego Rocha');
      row.querySelector('[data-action="delete"]').click();
      await new Promise((resolve)=>setTimeout(resolve,400));
      const dialog=document.querySelector('.confirm-card');
      const state={
        role:dialog.getAttribute('role'),
        message:document.querySelector('.confirm-message').textContent,
      };
      document.getElementById('confirmCancelBtn').click();
      await new Promise((resolve)=>setTimeout(resolve,300));
      return {...state, rows:document.querySelectorAll('.user-row').length,
        open:document.querySelectorAll('.confirm-backdrop').length};
    })()`);
    assert.equal(cancelled.role, 'alertdialog');
    assert.match(cancelled.message, /diego@example\.test/, 'the confirmation names the account');
    assert.equal(cancelled.open, 0, 'cancelling closes the confirmation');
    assert.equal(cancelled.rows, 3, 'cancelling keeps the account');

    await evaluate(`(async()=>{
      const row=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Diego Rocha');
      row.querySelector('[data-action="delete"]').click();
      await new Promise((resolve)=>setTimeout(resolve,400));
      document.getElementById('confirmOkBtn').click();
      await new Promise((resolve)=>setTimeout(resolve,1200));
    })()`);
    await waitForRows(2);
    assert.equal(
      await evaluate(`document.querySelector('#toast .toast-text').textContent`),
      'Account deleted.'
    );
    assert.deepEqual(await evaluate(`({id:document.activeElement.id,
      connected:document.activeElement.isConnected,
      visible:document.activeElement.getBoundingClientRect().width>0})`),
      {id:'addUserBtn',connected:true,visible:true},
      'deleting a row restores focus to a stable control');

    /* ── Narrow viewports keep the group usable without overflow ── */

    // The sidebar is still vertical at tablet width, so the group keeps its
    // title; it becomes a horizontal bar at the mobile breakpoint, where the
    // title is dropped along with the other labels.
    for (const [width, height, mobile, groupTitleDisplay] of [
      [1024, 800, false, 'block'],
      [768, 900, true, 'block'],
      [320, 812, true, 'none'],
      [360, 812, true, 'none'],
      [390, 812, true, 'none'],
    ]) {
      await setViewport(width, height, mobile);
      await delay(250);
      const narrow = await evaluate(`({
        documentOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
        listOverflow:document.querySelector('.user-list').scrollWidth>document.querySelector('.user-list').clientWidth,
        groupTitleDisplay:getComputedStyle(document.querySelector('.nav-group-title')).display,
        itemVisible:document.querySelector('[data-nav-id="admin-users"]').getBoundingClientRect().width>0,
        sidebarOverflow:getComputedStyle(document.querySelector('.sidebar')).overflowX,
        controlsReachable:[...document.querySelectorAll('.sidebar-brand, .sidebar-nav, .sidebar-footer')]
          .every((node)=>node.scrollWidth<=node.clientWidth || node.parentElement.scrollWidth>node.parentElement.clientWidth),
        // The activity badge and its row action are the widest part of a row,
        // so both must stay inside the row instead of being clipped away.
        rowOverflow:[...document.querySelectorAll('.user-row')]
          .some((row)=>row.scrollWidth>row.clientWidth),
        badgesVisible:[...document.querySelectorAll('.user-status')]
          .every((node)=>node.getBoundingClientRect().width>0),
        actionsVisible:[...document.querySelectorAll('.user-row [data-action]')]
          .every((node)=>node.getBoundingClientRect().width>0),
      })`);
      assert.deepEqual(narrow, {
        documentOverflow: false,
        listOverflow: false,
        groupTitleDisplay,
        itemVisible: true,
        sidebarOverflow: width <= 640 ? 'auto' : 'hidden',
        controlsReachable: true,
        rowOverflow: false,
        badgesVisible: true,
        actionsVisible: true,
      }, `the layout stays intact at ${width}px`);
    }

    /* ── A save stays isolated from a later save until its refresh settles ── */

    const serializedSaves = await evaluate(`(async()=>{
      const set=(id,value)=>{document.getElementById(id).value=value};
      window.__holdNextAdminList=true;
      document.getElementById('addUserBtn').click();
      set('userFirstName','Refresh A');set('userLastName','Create A');
      set('userEmail','refresh-a@example.test');set('userPassword','${PASSWORD}');set('userPasswordConfirm','${PASSWORD}');
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,700));
      const aRefreshPending={
        modal:!document.getElementById('userModal').classList.contains('hidden'),
        addDisabled:document.getElementById('addUserBtn').disabled,
        actionsDisabled:[...document.querySelectorAll('#userList [data-action]')].every((button)=>button.disabled),
      };
      document.getElementById('addUserBtn').click();
      const blockedSecondOpen=!document.getElementById('userModal').classList.contains('hidden');
      window.__releaseAdminList();
      await new Promise((resolve)=>setTimeout(resolve,700));
      const aId=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-email').textContent==='refresh-a@example.test').dataset.userId;

      window.__holdNextMutation='POST';
      document.getElementById('addUserBtn').click();
      set('userFirstName','Refresh B');set('userLastName','Create B');
      set('userEmail','refresh-b@example.test');set('userPassword','${PASSWORD}');set('userPasswordConfirm','${PASSWORD}');
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,180));
      const bMutationPending={
        modal:!document.getElementById('userModal').classList.contains('hidden'),
        saveDisabled:document.getElementById('userFormSubmit').disabled,
        cancelDisabled:document.getElementById('userFormCancel').disabled,
        addDisabled:document.getElementById('addUserBtn').disabled,
      };
      document.getElementById('userFormCancel').click();
      const bStillOpen=!document.getElementById('userModal').classList.contains('hidden');
      await window.__releaseAdminMutation();
      await new Promise((resolve)=>setTimeout(resolve,700));
      const bId=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-email').textContent==='refresh-b@example.test').dataset.userId;

      const rowA=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Refresh A Create A');
      window.__holdNextAdminList=true;
      rowA.querySelector('[data-action="edit"]').focus();
      rowA.querySelector('[data-action="edit"]').click();
      await new Promise((resolve)=>setTimeout(resolve,450));
      document.getElementById('userFirstName').value='Refresh A Updated';
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,700));
      const editRefreshPending={
        modal:!document.getElementById('userModal').classList.contains('hidden'),
        addDisabled:document.getElementById('addUserBtn').disabled,
      };
      const focusAfterCloseBeforeRefresh={
        connected:document.activeElement.isConnected,
      };
      const otherRow=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-name').textContent==='Rita Runner');
      otherRow.querySelector('[data-action="edit"]').click();
      const blockedEditOpen=!document.getElementById('userModal').classList.contains('hidden');
      window.__releaseAdminList();
      await new Promise((resolve)=>setTimeout(resolve,700));
      const editFocus={
        id:document.activeElement.dataset.id,
        action:document.activeElement.dataset.action,
        connected:document.activeElement.isConnected,
        visible:document.activeElement.getBoundingClientRect().width>0,
      };
      const rowB=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-email').textContent==='refresh-b@example.test');
      window.__holdNextAdminList=true;
      rowB.querySelector('[data-action="edit"]').click();
      await new Promise((resolve)=>setTimeout(resolve,450));
      document.getElementById('userFirstName').value='Refresh B Updated';
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,700));
      document.getElementById('sidebarToggle').focus();
      window.__releaseAdminList();
      await new Promise((resolve)=>setTimeout(resolve,700));
      const intentionalFocus={id:document.activeElement.id,connected:document.activeElement.isConnected};
      return {aId,bId,aRefreshPending,blockedSecondOpen,bMutationPending,bStillOpen,
        editRefreshPending,focusAfterCloseBeforeRefresh,blockedEditOpen,editFocus,intentionalFocus};
    })()`);
    assert.deepEqual(serializedSaves, {
      aId: serializedSaves.aId,
      bId: serializedSaves.bId,
      aRefreshPending:{modal:false,addDisabled:true,actionsDisabled:true},
      blockedSecondOpen:false,
      bMutationPending:{modal:true,saveDisabled:true,cancelDisabled:true,addDisabled:true},
      bStillOpen:true,
      editRefreshPending:{modal:false,addDisabled:true},
      focusAfterCloseBeforeRefresh:{connected:true},
      blockedEditOpen:false,
      editFocus:{id:serializedSaves.aId,action:'edit',connected:true,visible:true},
      intentionalFocus:{id:'sidebarToggle',connected:true},
    }, 'a completed mutation cannot clear another dialog operation');

    // Remove only the two temporary accounts so the access-control assertions
    // below retain their original two-account fixture. Reload once after the
    // direct cleanup so the page state cannot retain a deleted row.
    await evaluate(`Promise.all(${JSON.stringify([serializedSaves.aId, serializedSaves.bId])}
      .map((id)=>fetch('/api/admin/users/'+id,{method:'DELETE'})))`);
    await navigate('/admin-users.html');
    await waitForRows(2);

    /* ── A regular account has no administration entry at all ── */

    await setViewport(1280, 900, false);
    await setSession(regular);
    await navigate('/home.html');
    const regularNav = await evaluate(`({
      group:!!document.querySelector('.nav-group'),
      item:!!document.querySelector('[data-nav-id="admin-users"]'),
      groupTitle:!!document.querySelector('.nav-group-title'),
    })`);
    assert.deepEqual(regularNav, { group: false, item: false, groupTitle: false },
      'the administration group is absent from the DOM for a regular account');

    await navigate('/admin-users.html');
    const gate = await evaluate(`({ path:location.pathname, hasPanel:!!document.querySelector('.admin-page') })`);
    assert.equal(gate.path, '/home.html', 'the page gate redirects a regular account home');
    assert.equal(gate.hasPanel, false);

    /* ── The shared confirmation also traps focus outside administration ── */

    const sharedConfirm = await evaluate(`(async()=>{
      const trigger=document.createElement('button');
      trigger.id='external-confirm-trigger';
      trigger.textContent='Open confirmation';
      document.getElementById('appView').appendChild(trigger);
      trigger.focus();
      const {showConfirm}=await import('/shared/confirm-modal.js?browser-test=1');
      const beforeConfirm=showConfirm({title:'Backdrop confirmation',message:'Cancel before confirming',confirmText:'Confirm',cancelText:'Cancel'});
      await new Promise((resolve)=>setTimeout(resolve,50));
      document.querySelector('.confirm-backdrop').dispatchEvent(new MouseEvent('click',{bubbles:true}));
      const backdropCancelled=await beforeConfirm;
      const first=showConfirm({title:'Shared confirmation',message:'Confirm outside admin',confirmText:'Confirm',cancelText:'Cancel'});
      await new Promise((resolve)=>setTimeout(resolve,50));
      const opened={active:document.activeElement.id, backdrop:document.querySelectorAll('.confirm-backdrop').length};
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));
      const wrapped=document.activeElement.id;
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      const cancelled=await first;
      const afterEscape={cancelled,backdrop:document.querySelectorAll('.confirm-backdrop').length,focus:document.activeElement.id};
      const second=showConfirm({title:'Shared confirmation',message:'Confirm outside admin',confirmText:'Confirm',cancelText:'Cancel'});
      await new Promise((resolve)=>setTimeout(resolve,50));
      document.getElementById('confirmOkBtn').click();
      const confirmed=await second;
      let resolveCycle;
      let cycleChanged=0;
      const onCycleChanged=()=>{cycleChanged+=1};
      window.addEventListener('kinesis:cycle-changed',onCycleChanged);
      const pending=showConfirm({title:'Cycle confirmation',message:'Complete cycle',confirmText:'Confirm',cancelText:'Cancel',
        onConfirm:()=>new Promise((resolve)=>{resolveCycle=()=>{window.dispatchEvent(new CustomEvent('kinesis:cycle-changed'));resolve()}})});
      await new Promise((resolve)=>setTimeout(resolve,50));
      document.getElementById('confirmOkBtn').click();
      const pendingState={cancelDisabled:document.getElementById('confirmCancelBtn').disabled,
        confirmDisabled:document.getElementById('confirmOkBtn').disabled,
        backgroundInert:document.querySelector('.app-shell').hasAttribute('inert')};
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      document.getElementById('confirmCancelBtn').click();
      document.querySelector('.confirm-backdrop').dispatchEvent(new MouseEvent('click',{bubbles:true}));
      resolveCycle();
      const cycleResult=await pending;
      window.removeEventListener('kinesis:cycle-changed',onCycleChanged);
      let rejectionCalls=0;
      const rejected=showConfirm({title:'Rejected confirmation',message:'Fail',confirmText:'Confirm',cancelText:'Cancel',
        onConfirm:async()=>{rejectionCalls+=1;throw new Error('simulated failure')}});
      await new Promise((resolve)=>setTimeout(resolve,50));
      document.getElementById('confirmOkBtn').click();
      document.getElementById('confirmOkBtn').click();
      const rejectionResult=await rejected;
      return {backdropCancelled,opened,wrapped,afterEscape,confirmed,finalFocus:document.activeElement.id,pendingState,
        cycleResult,cycleChanged,rejectionResult,rejectionCalls,clean:document.querySelectorAll('.confirm-backdrop').length===0};
    })()`);
    assert.deepEqual(sharedConfirm, {
      backdropCancelled: false,
      opened: { active: 'confirmCancelBtn', backdrop: 1 },
      wrapped: 'confirmOkBtn',
      afterEscape: { cancelled: false, backdrop: 0, focus: 'external-confirm-trigger' },
      confirmed: true,
      finalFocus: 'external-confirm-trigger',
      pendingState: { cancelDisabled: true, confirmDisabled: true, backgroundInert: true },
      cycleResult: true,
      cycleChanged: 1,
      rejectionResult: false,
      rejectionCalls: 1,
      clean: true,
    }, 'the shared confirmation traps, closes, restores focus, and reopens outside the admin page');

    assert.equal(admin.role, 'admin');
  } finally {
    socket?.close();
    chromeProcess.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await app.close();
  }
});
