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
    "INSERT INTO users(id,email,password_hash,role) VALUES (1,'synthetic-admin@example.invalid','synthetic','admin'),(2,'synthetic-user@example.invalid','synthetic','user')",
  ).run();
  db.prepare(
    "INSERT INTO training_cycles(id,user_id,objective) VALUES ('cycle',1,'Synthetic cycle')",
  ).run();
  const tokens = [createSession(db, 1).token, createSession(db, 2).token];
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
      "document.getElementById('goals').value='Synthetic edit during failed load';document.getElementById('goals').dispatchEvent(new Event('input',{bubbles:true}))",
    );
    await command('Network.setBlockedURLs', {
      urls: ['*unpkg.com*', '*fonts.googleapis.com*', '*fonts.gstatic.com*'],
    });
    await evaluate("document.getElementById('reloadMemory').click()");

    await waitFor(
      "document.getElementById('profileForm')?.querySelector('[type=submit]')?.disabled===false",
    );
    assert.equal(
      await evaluate("document.getElementById('goals').value"),
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
      await evaluate(`document.getElementById('entryForm').requestSubmit()`);
      assert.equal(await evaluate('document.activeElement.id'), 'entryText');
      assert.equal(
        await evaluate(
          `document.getElementById('entryText').getAttribute('aria-invalid')`,
        ),
        'true',
      );
      assert.ok(
        (
          await evaluate(`document.getElementById('memoryError').textContent`)
        ).includes(language === 'pt-BR' ? 'descrição' : 'description'),
      );
      await evaluate(
        `document.getElementById('entryText').value='Synthetic reported restriction ${language}';document.getElementById('entryDate').click();document.querySelector('#entryDate').parentElement.querySelector('[data-date="2026-10-01"]').click();document.getElementById('entryForm').requestSubmit()`,
      );
      await waitFor(
        `document.querySelectorAll('.memory-entry').length===${language === 'pt-BR' ? 2 : 1}`,
      );
      assert.equal(await evaluate('document.activeElement.id'), 'entryText');
      const styles = await evaluate(
        `(()=>{const input=getComputedStyle(document.getElementById('entryDate'));const label=getComputedStyle(document.querySelector('label[for=entryDate]'));const btn=getComputedStyle(document.querySelector('#profileForm button'));return {input:{font:input.fontFamily,border:input.borderRadius,background:input.backgroundColor},label:label.fontWeight,button:{font:btn.fontFamily,radius:btn.borderRadius},overflow:document.documentElement.scrollWidth>innerWidth}})()`,
      );
      assert.equal(styles.overflow, false);
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
      ).includes('training-context-v1'),
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
      `document.getElementById('goals').value='Synthetic preserved edit';document.getElementById('profileForm').requestSubmit()`,
    );
    await waitFor(
      `document.getElementById('memoryError').classList.contains('hidden')===false`,
    );
    assert.equal(
      await evaluate(`document.getElementById('goals').value`),
      'Synthetic preserved edit',
    );
    await evaluate(`document.getElementById('reloadMemory').click()`);
    await waitFor(
      `!document.getElementById('profileForm').querySelector('[type=submit]').disabled`,
    );
    assert.equal(
      await evaluate(`document.getElementById('goals').value`),
      'Synthetic preserved edit',
    );
    await evaluate(`document.getElementById('entryText').focus()`);
    await command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
    });
    await command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
    });
    assert.equal(await evaluate('document.activeElement.id'), 'entryDate');
    assert.equal(
      await evaluate(`document.activeElement.matches(':focus-visible')`),
      true,
    );
    await command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
    await command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
    assert.equal(
      await evaluate(
        "document.getElementById('entryDate').getAttribute('aria-expanded')",
      ),
      'true',
    );
    assert.equal(
      await evaluate("document.activeElement.matches('[data-date]')"),
      true,
    );
    await command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'ArrowRight',
      code: 'ArrowRight',
      windowsVirtualKeyCode: 39,
    });
    await command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'ArrowRight',
      code: 'ArrowRight',
      windowsVirtualKeyCode: 39,
    });
    await command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    await command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    assert.equal(await evaluate('document.activeElement.id'), 'entryDate');
    assert.equal(
      await evaluate(
        "document.getElementById('entryDate').getAttribute('aria-expanded')",
      ),
      'false',
    );
    // Month navigation must keep keyboard focus on replacement toolbar nodes.
    await command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
    await command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
    for (const action of ['previous', 'next']) {
      await evaluate(
        `document.querySelector('#entryDate-calendar-popup [data-calendar-action="${action}"]').focus()`,
      );
      await command('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      await command('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      assert.equal(
        await evaluate('document.activeElement.dataset.calendarAction'),
        action,
      );
      assert.equal(
        await evaluate(
          "document.getElementById('entryDate').getAttribute('aria-expanded')",
        ),
        'true',
      );
    }
    await command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    await command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    assert.equal(await evaluate('document.activeElement.id'), 'entryDate');
    await evaluate(`document.querySelector('.memory-entry button').click()`);
    assert.equal(await evaluate('document.activeElement.id'), 'entryText');
    const editedId = await evaluate(
      "document.querySelector('.memory-entry button').dataset.entryId",
    );
    db.prepare('UPDATE ai_memory SET version=version+1 WHERE id=?').run(
      editedId,
    );
    await evaluate(
      "document.getElementById('entryText').value='Synthetic preserved observation edit';document.getElementById('entryForm').requestSubmit()",
    );
    await waitFor(
      "!document.getElementById('memoryError').classList.contains('hidden')",
    );
    assert.equal(
      await evaluate("document.getElementById('entryText').value"),
      'Synthetic preserved observation edit',
    );
    await evaluate("document.getElementById('reloadMemory').click()");
    await waitFor(
      "!document.getElementById('entryForm').querySelector('[type=submit]').disabled",
    );
    assert.equal(
      await evaluate("document.getElementById('entryText').value"),
      'Synthetic preserved observation edit',
    );
    await evaluate("document.getElementById('entryForm').requestSubmit()");
    await waitFor("document.getElementById('entryText').value===''");
    assert.equal(
      db.prepare('SELECT text FROM ai_memory WHERE id=?').get(editedId).text,
      'Synthetic preserved observation edit',
    );
    await evaluate(
      `document.querySelector('[data-entry-id="${editedId}"][data-action="edit"]').click();document.getElementById('entryText').value='Synthetic edit after deletion'`,
    );
    db.prepare('DELETE FROM ai_memory WHERE id=?').run(editedId);
    await evaluate("document.getElementById('reloadMemory').click()");
    await waitFor("!document.getElementById('reloadMemory').disabled");
    assert.equal(
      await evaluate(
        "document.getElementById('entryForm').querySelector('[type=submit]').disabled",
      ),
      true,
    );
    assert.equal(
      await evaluate("document.getElementById('entryText').value"),
      'Synthetic edit after deletion',
    );
    await evaluate("document.getElementById('cancelEntry').click()");
    assert.equal(
      await evaluate(
        "document.getElementById('entryForm').querySelector('[type=submit]').disabled",
      ),
      false,
    );
    // Hold the real DELETE request and move focus while the refresh is pending.
    await command('Fetch.enable', {
      patterns: [
        { urlPattern: origin + '/api/ai/memory/*', requestStage: 'Request' },
      ],
    });
    const pausedDelete = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('DELETE request was not intercepted')),
        8000,
      );
      const handler = (event) => {
        const message = JSON.parse(event.data);
        if (
          message.method === 'Fetch.requestPaused' &&
          message.params.request.method === 'DELETE'
        ) {
          clearTimeout(timeout);
          socket.removeEventListener('message', handler);
          resolve(message.params.requestId);
        }
      };
      socket.addEventListener('message', handler);
    });
    await evaluate(
      "document.querySelector('.memory-entry [data-action=delete]').click()",
    );
    await waitFor("!!document.getElementById('confirmOkBtn')");
    await evaluate("document.getElementById('confirmOkBtn').click()");
    const deleteRequestId = await pausedDelete;
    await evaluate("document.getElementById('goals').focus()");
    await command('Fetch.continueRequest', { requestId: deleteRequestId });
    await waitFor("!document.getElementById('reloadMemory').disabled");
    await command('Fetch.disable');
    assert.equal(
      await evaluate("document.querySelectorAll('.memory-entry').length"),
      0,
    );
    assert.equal(await evaluate('document.activeElement.id'), 'goals');
    const memoryStyles = await evaluate(
      `(()=>{const i=getComputedStyle(document.querySelector('#entryDate'));const b=getComputedStyle(document.querySelector('#profileForm button'));return {inputFont:i.fontFamily,inputRadius:i.borderRadius,buttonRadius:b.borderRadius}})()`,
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
      await evaluate(`document.querySelectorAll('.memory-entry').length`),
      0,
    );
  } finally {
    socket?.close();
    process.kill('SIGTERM');
    await once(process, 'exit').catch(() => {});
    await app.close();
    db.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
