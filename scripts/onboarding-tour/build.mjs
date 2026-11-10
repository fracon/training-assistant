#!/usr/bin/env node
// Builds the narrated welcome tour videos (PT and EN) for the dashboard.
//
//   node scripts/onboarding-tour/build.mjs --piper <piper binary> --voices <dir> [--lang pt,en] [--work <dir>]
//
// Requires ffmpeg (libvpx-vp9, libopus, libopenh264, aac), Google Chrome and
// a local Piper TTS install with the pt_BR-faber-medium and en_US-ryan-high
// voices. Nothing is sent to an external service: speech is synthesized
// locally and the frames are rendered by a headless Chrome on 127.0.0.1.
// See scripts/onboarding-tour/README.md.
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join, dirname, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { TOUR_SCENES, tourCueKey } from '../../src/public/shared/onboarding.js';
import { buildTimeline, FPS } from './timeline.mjs';
import { TOUR_STRINGS } from './strings.mjs';
import { RATE, mixTour, readMonoWav, trimSilence, writeStereoWav } from './audio.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT_DIR = join(ROOT, 'src/public/assets/onboarding/tour');
const MANIFEST = join(ROOT, 'src/public/shared/onboarding-tour-media.js');
const PUBLIC_PREFIX = '/assets/onboarding/tour';

const VOICES = {
  pt: { model: 'pt_BR-faber-medium.onnx', lengthScale: '1.0' },
  en: { model: 'en_US-ryan-high.onnx', lengthScale: '1.0' },
};
// Spoken spellings only; captions and the transcript keep the written text.
const RESPELL = {
  pt: [[/\bKinesis\b/g, 'Kinésis'], [/\bIA\b/g, 'I A'], [/\bFIT\b/g, 'fít'], [/\bZIP\b/g, 'zíp']],
  en: [[/\bAI\b/g, 'A.I.']],
};

function args() {
  const out = { lang: 'pt,en' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'preview') { out.preview = true; continue; }
    out[key] = argv[i + 1];
    i += 1;
  }
  if (!out.piper || !out.voices) {
    console.error('Usage: build.mjs --piper <piper binary> --voices <voice dir> [--lang pt,en] [--work <dir>]');
    process.exit(2);
  }
  return out;
}

function lookup(messages, key) {
  const value = key.split('.').reduce((acc, part) => acc?.[part], messages);
  if (typeof value !== 'string') throw new Error(`Missing locale string ${key}`);
  return value;
}

const sha = (value) => createHash('sha256').update(value).digest('hex');

function synthesize(options, lang, text, work) {
  const voice = VOICES[lang];
  const spoken = RESPELL[lang].reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
  const id = sha(`${voice.model}|${voice.lengthScale}|${spoken}`).slice(0, 16);
  const raw = join(work, `tts-${id}.raw.wav`);
  const wav = join(work, `tts-${id}.wav`);
  if (!existsSync(wav)) {
    execFileSync(options.piper, ['-m', join(options.voices, voice.model), '--length-scale', voice.lengthScale, '-f', raw], { input: spoken, stdio: ['pipe', 'ignore', 'ignore'] });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-ac', '1', '-ar', String(RATE), '-c:a', 'pcm_s16le', wav]);
  }
  return trimSilence(readMonoWav(wav));
}

function vttTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000); const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000); const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}

// Balanced two-line wrap for captions longer than ~42 characters.
function wrapCaption(text) {
  if (text.length <= 42) return text;
  const words = text.split(' ');
  let best = null;
  for (let i = 1; i < words.length; i += 1) {
    const a = words.slice(0, i).join(' '); const b = words.slice(i).join(' ');
    const score = Math.abs(a.length - b.length);
    if (!best || score < best.score) best = { score, text: `${a}\n${b}` };
  }
  return best.text;
}

function buildVtt(timeline, messages) {
  const cues = timeline.scenes.flatMap((scene) => scene.cues.map((cue) => ({
    start: scene.start + cue.start, end: scene.start + cue.end, text: lookup(messages, tourCueKey(cue.key)),
  })));
  const lines = ['WEBVTT', ''];
  cues.forEach((cue, i) => {
    const next = cues[i + 1];
    const end = Math.min(cue.end + 0.4, next ? next.start - 0.05 : timeline.duration);
    lines.push(String(i + 1), `${vttTime(Math.max(0, cue.start - 0.05))} --> ${vttTime(end)}`, wrapCaption(cue.text), '');
  });
  return lines.join('\n');
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png' };
async function serveStatic() {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path === '/logo-mark.png' ? join(ROOT, 'src/public/assets/brand/logo-mark.png') : join(HERE, path.replace(/^\/+/, ''));
    if (!file.startsWith(HERE) && !file.endsWith('logo-mark.png')) { res.writeHead(403).end(); return; }
    if (!existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function launchChrome() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  const profile = join(tmpdir(), `kinesis-tour-chrome-${process.pid}`);
  const child = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--font-render-hinting=none', '--force-color-profile=srgb', '--no-first-run', '--remote-allow-origins=*', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
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

async function renderFrames(browser, url, payload, frameDir, frameCount, times = null) {
  const { command, evaluate } = browser;
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url });
  for (let i = 0; i < 200 && !(await evaluate('Boolean(window.tourReady)').catch(() => false)); i += 1) await delay(50);
  const fonts = await evaluate('document.fonts.load("700 20px \\"DM Sans\\"").then(() => document.fonts.ready).then(() => document.fonts.check("700 20px \\"DM Sans\\""))');
  if (!fonts) throw new Error('DM Sans did not load; the frames would use a fallback font.');
  await evaluate(`window.TOUR = ${JSON.stringify(payload)}; window.init(); Promise.all([...document.images].map((img) => img.decode())).then(() => true)`);
  mkdirSync(frameDir, { recursive: true });
  if (times) {
    for (const [name, time] of times) {
      await evaluate(`window.renderAt(${time})`);
      const shot = await command('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(frameDir, `${name}.png`), Buffer.from(shot.data, 'base64'));
    }
    return;
  }
  for (let frame = 0; frame < frameCount; frame += 1) {
    await evaluate(`window.renderAt(${frame / FPS})`);
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(frameDir, `${String(frame).padStart(5, '0')}.png`), Buffer.from(shot.data, 'base64'));
    if (frame % 300 === 0) process.stdout.write(`  frame ${frame}/${frameCount}\n`);
  }
}

function encode(frameDir, audio, lang, duration) {
  const base = join(OUT_DIR, `kinesis-tour-${lang}`);
  const frames = ['-framerate', String(FPS), '-i', join(frameDir, '%05d.png')];
  const common = ['-v', 'error', '-y', ...frames, '-i', audio, '-t', duration.toFixed(3), '-map', '0:v', '-map', '1:a'];
  execFileSync('ffmpeg', [...common, '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '96k', `${base}.webm`], { stdio: 'inherit' });
  execFileSync('ffmpeg', [...common, '-c:v', 'libopenh264', '-b:v', '900k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', `${base}.mp4`], { stdio: 'inherit' });
}

function versioned(file) {
  return `${PUBLIC_PREFIX}/${file}?v=${sha(readFileSync(join(OUT_DIR, file))).slice(0, 10)}`;
}

async function main() {
  const options = args();
  const languages = options.lang.split(',');
  const work = resolve(options.work ?? join(tmpdir(), 'kinesis-tour-work'));
  mkdirSync(work, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const server = await serveStatic();
  const browser = await launchChrome();
  const manifest = existsSync(join(work, 'manifest.json')) ? JSON.parse(readFileSync(join(work, 'manifest.json'), 'utf8')) : {};
  try {
    for (const lang of languages) {
      console.log(`[${lang}] narration`);
      const messages = JSON.parse(readFileSync(join(ROOT, `src/public/locales/${lang}.json`), 'utf8'));
      const clips = {};
      for (const scene of TOUR_SCENES) for (const cue of scene.cues) clips[cue] = synthesize(options, lang, lookup(messages, tourCueKey(cue)), work);
      const durations = Object.fromEntries(Object.entries(clips).map(([key, samples]) => [key, samples.length / RATE]));
      const timeline = buildTimeline(TOUR_SCENES, durations);
      console.log(`[${lang}] ${timeline.duration.toFixed(2)}s`);

      const narration = timeline.scenes.flatMap((scene) => scene.cues.map((cue) => ({ time: scene.start + cue.start, samples: clips[cue.key] })));
      const sounds = timeline.scenes.flatMap((scene) => scene.beats.sounds.map((s) => ({ ...s, time: scene.start + s.time })));
      if (options.preview) {
        const times = timeline.scenes.flatMap((scene) => [0.35, 0.6, 0.97].map((f) => [`${scene.id}-${Math.round(f * 100)}`, scene.start + scene.length * f]));
        const dir = join(work, `preview-${lang}`);
        await renderFrames(browser, `http://127.0.0.1:${server.address().port}/scene.html`, { lang, strings: TOUR_STRINGS[lang], timeline, logo: '/logo-mark.png' }, dir, 0, times);
        console.log(`[${lang}] preview frames in ${dir}`);
        continue;
      }
      const [left, right] = mixTour({ duration: timeline.duration, narration, sounds });
      const mixed = join(work, `mix-${lang}.wav`); const normalized = join(work, `mix-${lang}-norm.wav`);
      writeStereoWav(mixed, left, right);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mixed, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', String(RATE), normalized]);

      writeFileSync(join(OUT_DIR, `kinesis-tour-${lang}.vtt`), buildVtt(timeline, messages));

      console.log(`[${lang}] frames`);
      const frameDir = join(work, `frames-${lang}`);
      rmSync(frameDir, { recursive: true, force: true });
      const frameCount = Math.ceil(timeline.duration * FPS);
      const payload = { lang, strings: TOUR_STRINGS[lang], timeline, logo: '/logo-mark.png' };
      await renderFrames(browser, `http://127.0.0.1:${server.address().port}/scene.html`, payload, frameDir, frameCount);

      console.log(`[${lang}] encode`);
      encode(frameDir, normalized, lang, timeline.duration);
      const posterFrame = join(frameDir, `${String(Math.round(3.2 * FPS)).padStart(5, '0')}.png`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', posterFrame, '-q:v', '3', join(OUT_DIR, `kinesis-tour-${lang}-poster.jpg`)]);

      manifest[lang] = {
        duration: Number(timeline.duration.toFixed(3)),
        webm: versioned(`kinesis-tour-${lang}.webm`),
        mp4: versioned(`kinesis-tour-${lang}.mp4`),
        captions: versioned(`kinesis-tour-${lang}.vtt`),
        poster: versioned(`kinesis-tour-${lang}-poster.jpg`),
        scenes: timeline.scenes.map((s) => ({ id: s.id, start: Number(s.start.toFixed(3)), end: Number(s.end.toFixed(3)) })),
      };
      writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }
  } finally {
    await browser.close();
    server.close();
  }
  const ordered = Object.fromEntries(['pt', 'en'].filter((l) => manifest[l]).map((l) => [l, manifest[l]]));
  if (options.preview) return;
  writeFileSync(MANIFEST, `// Generated by scripts/onboarding-tour/build.mjs. Do not edit by hand.\n// Media, captions and scene boundaries of the narrated welcome tour.\nexport const TOUR_MEDIA = ${JSON.stringify(ordered, null, 2)};\n`);
  console.log(`Wrote ${MANIFEST}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
