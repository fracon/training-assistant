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

    await navigate('/admin.html');
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
      const roleSelect=document.getElementById('userRole');
      return {
        open:!box.classList.contains('hidden'),
        roleDialog:box.querySelector('.modal-card').getAttribute('role'),
        modal:box.querySelector('.modal-card').getAttribute('aria-modal'),
        labelled:box.querySelector('.modal-card').getAttribute('aria-labelledby'),
        focused:document.activeElement.id,
        passwordShown:!document.getElementById('userPasswordField').classList.contains('hidden'),
        role:roleSelect.value,
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
      role: 'user',
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
    const invalid = await evaluate(`(async()=>{
      const set=(id,value)=>{document.getElementById(id).value=value};
      set('userFirstName','Bad');set('userLastName','Email');
      set('userEmail','not-an-email');set('userPassword','short');
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,600));
      const box=document.getElementById('userFormError');
      return {
        items:[...box.querySelectorAll('li')].map((node)=>node.textContent),
        shown:!box.classList.contains('hidden'),
        stillOpen:!document.getElementById('userModal').classList.contains('hidden'),
      };
    })()`);
    assert.equal(invalid.shown, true);
    assert.equal(invalid.stillOpen, true);
    assert.deepEqual(invalid.items, ['Enter a valid email address.', 'The password must be at least 8 characters long.']);

    /* ── A valid create adds the account and closes the modal ── */

    const created = await evaluate(`(async()=>{
      const set=(id,value)=>{document.getElementById(id).value=value};
      set('userFirstName','Diego');set('userLastName','Rocha');
      set('userEmail','diego@example.test');set('userPassword','${PASSWORD}');
      document.getElementById('userRole').value='admin';
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
    assert.equal(created.admins, 2, 'the new account carries the requested role');
    await waitForRows(3);

    /* ── A duplicate email is reported by the server ── */

    const duplicate = await evaluate(`(async()=>{
      document.getElementById('addUserBtn').click();
      const set=(id,value)=>{document.getElementById(id).value=value};
      set('userFirstName','Dup');set('userLastName','Licate');
      set('userEmail','diego@example.test');set('userPassword','${PASSWORD}');
      document.getElementById('userForm').requestSubmit();
      await new Promise((resolve)=>setTimeout(resolve,900));
      return {
        message:document.getElementById('userFormError').textContent.trim(),
        stillOpen:!document.getElementById('userModal').classList.contains('hidden'),
      };
    })()`);
    assert.equal(duplicate.stillOpen, true);
    assert.equal(duplicate.message, 'This email is already registered.');
    await evaluate(`document.getElementById('userFormCancel').click()`);

    /* ── The self role control is locked and the account is never deletable ── */

    const selfEdit = await evaluate(`(async()=>{
      const row=[...document.querySelectorAll('.user-row')]
        .find((node)=>node.querySelector('.user-self-chip'));
      row.querySelector('[data-action="edit"]').click();
      await new Promise((resolve)=>setTimeout(resolve,700));
      const select=document.getElementById('userRole');
      const hint=document.getElementById('userRoleHint');
      const state={
        disabled:select.disabled,
        hintShown:!hint.classList.contains('hidden'),
        hasDelete:!!row.querySelector('[data-action="delete"]'),
        passwordHidden:document.getElementById('userPasswordField').classList.contains('hidden'),
      };
      document.getElementById('userFormCancel').click();
      return state;
    })()`);
    assert.deepEqual(selfEdit, {
      disabled: true,
      hintShown: true,
      hasDelete: false,
      passwordHidden: true,
    }, 'the signed-in account cannot be demoted or deleted from the panel');

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

    /* ── Narrow viewports keep the group usable without overflow ── */

    // The sidebar is still vertical at tablet width, so the group keeps its
    // title; it becomes a horizontal bar at the mobile breakpoint, where the
    // title is dropped along with the other labels.
    for (const [width, height, mobile, groupTitleDisplay] of [
      [1024, 800, false, 'block'],
      [768, 900, true, 'block'],
      [375, 812, true, 'none'],
    ]) {
      await setViewport(width, height, mobile);
      await delay(250);
      const narrow = await evaluate(`({
        documentOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
        listOverflow:document.querySelector('.user-list').scrollWidth>document.querySelector('.user-list').clientWidth,
        groupTitleDisplay:getComputedStyle(document.querySelector('.nav-group-title')).display,
        itemVisible:document.querySelector('[data-nav-id="admin-users"]').getBoundingClientRect().width>0,
      })`);
      assert.deepEqual(narrow, {
        documentOverflow: false,
        listOverflow: false,
        groupTitleDisplay,
        itemVisible: true,
      }, `the layout stays intact at ${width}px`);
    }

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

    await navigate('/admin.html');
    const gate = await evaluate(`({ path:location.pathname, hasPanel:!!document.querySelector('.admin-page') })`);
    assert.equal(gate.path, '/home.html', 'the page gate redirects a regular account home');
    assert.equal(gate.hasPanel, false);
    assert.equal(admin.role, 'admin');
  } finally {
    socket?.close();
    chromeProcess.kill();
    rmSync(profile, { recursive: true, force: true });
    await app.close();
  }
});
