// Captures real Kinesis screens for the welcome tour. A throwaway in-memory
// server is filled with one synthetic athlete (no real data), and each page is
// photographed by headless Chrome at 1440×810 CSS px, scaled to 1920×1080.
// Element boxes listed in SHOTS are measured in the same pass, so the video can
// zoom into the exact control the narration names.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { buildServer } = require('../../src/server');
const { createDatabase } = require('../../src/db/database');
const { readAiConfig } = require('../../src/ai/config');

const VIEW = { width: 1440, height: 810, scale: 4 / 3 };

const DATA = {
  pt: {
    language: 'pt-BR', first: 'Ana', last: 'Corredora', objective: 'Correr 10 km',
    location: 'São Paulo, SP',
    workouts: [
      ['Rodagem', 'Rodagem leve', '40 min em ritmo confortável'],
      ['Intervalado', 'Tiros 6×400 m', 'Aquecimento, 6×400 m forte, 2 min de trote'],
      ['Rodagem', 'Trote regenerativo', '30 min bem leve'],
      ['Ritmo', 'Ritmo 20 min', '20 min no ritmo de prova'],
      ['Longão', 'Longão', '75 min leve e constante'],
    ],
  },
  en: {
    language: 'en-US', first: 'Alex', last: 'Runner', objective: 'Run 10 km',
    location: 'Boston, MA',
    workouts: [
      ['Run', 'Easy run', '40 min at a comfortable pace'],
      ['Intervals', 'Speed 6×400 m', 'Warm-up, 6×400 m hard, 2 min jog'],
      ['Run', 'Recovery jog', '30 min very easy'],
      ['Tempo', 'Tempo 20 min', '20 min at race pace'],
      ['Long run', 'Long run', '75 min easy and steady'],
    ],
  },
};

// One entry per screen. `boxes` names the selectors whose on-screen rectangle
// the video zooms into; `prepare` runs in the page before the photo.
const openResult = (target, source = null) => `(async () => {
  const trigger = document.getElementById('feedbackAccordionTrigger');
  if (trigger && trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
  await new Promise((r) => setTimeout(r, 600));
  const select = document.getElementById('resultSourceSelect');
  if (${JSON.stringify(source)} && select) { select.value = ${JSON.stringify(source)}; select.dispatchEvent(new Event('change', { bubbles: true })); }
  await new Promise((r) => setTimeout(r, 300));
  document.querySelector(${JSON.stringify(target)})?.scrollIntoView({ block: 'center' });
  await new Promise((r) => setTimeout(r, 400));
  return true;
})()`;

const SHOTS = [
  { id: 'home', path: '/home.html', boxes: {} },
  { id: 'shoes', path: '/shoes.html', boxes: { card: '.shoe-card, [data-shoe-id], .card', list: 'all:.shoe-card, [data-shoe-id]' } },
  { id: 'cycles', path: '/cycles.html', boxes: { card: '.cycle-card, .card', planning: '[data-action="planning"], .cycle-planning-btn, .btn-icon' } },
  { id: 'request', path: '/ai-coach.html', boxes: { availability: '.availability-fieldset', days: 'all:.availability-grid' } },
  { id: 'generate', path: '/ai-coach.html', prepare: `(async () => { document.getElementById('generateBtn')?.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 400)); return true; })()`, boxes: { generate: '#generateBtn' } },
  { id: 'calendar', path: '/calendar.html', boxes: { chips: 'all:.training-chip', first: '.training-chip', cells: 'each:.day-cell', chipList: 'each:.training-chip', import: '#importBtn' } },
  { id: 'upload', path: '/training-result.html?id={resultId}', prepare: openResult('#fitDropzone', 'fit'), boxes: { dropzone: '#fitDropzone', source: '#resultSourceSelect' } },
  { id: 'rpe', path: '/training-result.html?id={resultId}', prepare: openResult('#feedbackRpe'), boxes: { rpe: '#feedbackRpe', emojis: 'each:.rpe-emoji' } },
  { id: 'analysis', path: '/training-result.html?id={resultId}', prepare: openResult('#analysisSection:not([hidden]), #generateBtn'), boxes: { analysis: '#analysisSection', generate: '#generateBtn' } },
  { id: 'memory', path: '/training-memory.html', boxes: { sections: 'each:.memory-section' } },
];

function isoDate(date) { return date.toISOString().slice(0, 10); }
function mondayOf(today) {
  const d = new Date(`${isoDate(today)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}
function addDays(date, days) { const d = new Date(date); d.setUTCDate(d.getUTCDate() + days); return isoDate(d); }

async function seed(app, db, lang) {
  const data = DATA[lang];
  const email = `tour-${lang}@example.test`;
  const password = 'tour-capture-123';
  const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password, first_name: data.first, last_name: data.last, preferred_lang: data.language } });
  if (registered.statusCode !== 201) throw new Error(`register ${registered.statusCode}`);
  const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  db.prepare("UPDATE users SET onboarding_status = 'active' WHERE id = ?").run(userId);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  const cookie = [].concat(login.headers['set-cookie'])[0].split(';')[0].split('=')[1];

  db.prepare('INSERT INTO shoes (id, user_id, brand, model, mileage, base_mileage, target_mileage, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`shoe-a-${lang}`, userId, 'Nike', 'Pegasus 41', 412.6, 0, 700, 'active');
  db.prepare('INSERT INTO shoes (id, user_id, brand, model, mileage, base_mileage, target_mileage, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`shoe-b-${lang}`, userId, 'Asics', 'Novablast 5', 128.4, 0, 800, 'active');

  const monday = mondayOf(new Date());
  const cycleId = `cycle-${lang}`;
  db.prepare('INSERT INTO training_cycles (id, user_id, objective, target_date, distance, start_date, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(cycleId, userId, data.objective, addDays(monday, 7 * 10 + 6), '10', addDays(monday, -14), 'active');

  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const plan = { monday: 'before_08', wednesday: 'after_18', friday: 'before_08', sunday: '08_12' };
  const minutes = { monday: 50, wednesday: 60, friday: 45, sunday: 90 };
  const availability = await app.inject({
    method: 'PUT', url: '/api/ai-coach/availability', headers: { cookie: `ta_session=${cookie}` },
    payload: { days: days.map((day) => (plan[day]
      ? { day, can_train: true, available_periods: [plan[day]], available_minutes: minutes[day], location: data.location }
      : { day, can_train: false, available_periods: [], available_minutes: null, location: '' })) },
  });
  if (availability.statusCode !== 200) throw new Error(`availability ${availability.statusCode} ${availability.body}`);

  const offsets = [0, 2, 3, 4, 6];
  const ids = data.workouts.map(([tipo, treino, detalhes], i) => db.prepare(
    'INSERT INTO trainings (user_id, training_cycle_id, dia, tipo, treino, detalhes, location) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(userId, cycleId, addDays(monday, offsets[i]), tipo, treino, detalhes, data.location).lastInsertRowid);
  const resultId = ids[0];
  const result = await app.inject({
    method: 'PUT', url: `/api/trainings/${resultId}/manual-results`, headers: { cookie: `ta_session=${cookie}` },
    payload: { distance_km: 7.2, duration_seconds: 2538, feedback_rpe: 3 },
  });
  if (result.statusCode !== 200) throw new Error(`manual result ${result.statusCode} ${result.body}`);
  return { cookie, resultId };
}

async function chrome() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  const profile = mkdtempSync(join(tmpdir(), 'kinesis-tour-capture-'));
  const child = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb', '--no-first-run', '--remote-allow-origins=*', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 200; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} await delay(50); }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open');
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', (event) => {
    const m = JSON.parse(event.data); const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  });
  const command = (method, params = {}) => new Promise((res, rej) => { const id = ++sequence; pending.set(id, { resolve: res, reject: rej }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const close = async () => { socket.close(); child.kill('SIGTERM'); await once(child, 'exit'); rmSync(profile, { recursive: true, force: true }); };
  return { command, evaluate, close };
}

// Returns { [shotId]: { file, boxes: { name: {x, y, w, h} } } } in 1920×1080 px.
export async function captureScreens(lang, outDir) {
  mkdirSync(outDir, { recursive: true });
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({
    db, sessionCookieSecure: false,
    aiConfig: readAiConfig({ AI_ENABLED: 'true', OPENAI_API_KEY: 'synthetic-capture-key', AI_RETRIES: '0' }),
    aiClient: async () => ({ value: null, usage: { input: 0, output: 0, cached: 0 }, error: 'providerRejected' }),
    unsplashFetch: async () => { throw new Error('No hero image in captures.'); },
    weatherFetch: async () => { throw new Error('No weather in captures.'); },
  });
  const origin = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/\/$/, '');
  const browser = await chrome();
  const shots = {};
  try {
    const { cookie, resultId } = await seed(app, db, lang);
    const { command, evaluate } = browser;
    await command('Page.enable');
    await command('Network.enable');
    await command('Network.setCookie', { name: 'ta_session', value: cookie, url: origin, httpOnly: true });
    await command('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: VIEW.scale, mobile: false });
    await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    for (const shot of SHOTS) {
      await command('Page.navigate', { url: origin + shot.path.replace('{resultId}', resultId) });
      for (let i = 0; i < 200; i += 1) {
        if (await evaluate("document.readyState === 'complete' && document.body?.classList.contains('shell-mounted')").catch(() => false)) break;
        await delay(50);
      }
      await evaluate('document.fonts.ready.then(() => true)');
      await delay(1500);
      if (shot.prepare) await evaluate(shot.prepare);
      const boxes = await evaluate(`(() => {
        const out = {};
        for (const [name, selector] of Object.entries(${JSON.stringify(shot.boxes)})) {
          const mode = /^(all|each):/.exec(selector)?.[1] ?? 'first';
          const visible = [...document.querySelectorAll(mode === 'first' ? selector : selector.slice(mode.length + 1))].filter((node) => { const b = node.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
          if (!visible.length) continue;
          const k = ${VIEW.scale};
          const box = (b) => ({ x: Math.round(b.left * k), y: Math.round(b.top * k), w: Math.round(b.width * k), h: Math.round(b.height * k) });
          if (mode === 'each') { out[name] = visible.map((node) => box(node.getBoundingClientRect())); continue; }
          const all = mode === 'all';
          const rects = (all ? visible : visible.slice(0, 1)).map((node) => node.getBoundingClientRect());
          const left = Math.min(...rects.map((b) => b.left)); const top = Math.min(...rects.map((b) => b.top));
          const r = { left, top, width: Math.max(...rects.map((b) => b.right)) - left, height: Math.max(...rects.map((b) => b.bottom)) - top };
          out[name] = box({ left: r.left, top: r.top, width: r.width, height: r.height });
        }
        return out;
      })()`);
      const image = await command('Page.captureScreenshot', { format: 'png' });
      const file = join(outDir, `${shot.id}.png`);
      writeFileSync(file, Buffer.from(image.data, 'base64'));
      shots[shot.id] = { file, boxes, lang: await evaluate('document.documentElement.lang') };
    }
  } finally {
    await browser.close();
    await app.close();
    db.close();
  }
  return shots;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [lang = 'pt', out = join(tmpdir(), 'kinesis-tour-shots')] = process.argv.slice(2);
  captureScreens(lang, join(out, lang)).then((shots) => console.log(JSON.stringify(shots, null, 1)));
}
