#!/usr/bin/env node
// Builds the narrated welcome tour videos (PT and EN) for the dashboard.
//
//   node scripts/onboarding-tour/build.mjs --python <venv python> --kokoro <model dir> \
//     --whisper-model <ggml model> [--lang pt,en] [--work <dir>] [--preview]
//
// Pipeline per language (see README.md):
//   1. Kokoro (local neural TTS) speaks each narration cue.
//   2. whisper.cpp measures when every word is said, so moves land on words.
//   3. capture.mjs photographs real Kinesis screens from a synthetic account.
//   4. compose.mjs writes a HyperFrames project; HyperFrames renders it.
//   5. ffmpeg encodes the WebM/MP4 pair, the poster, and the WebVTT captions.
// Nothing is sent to an external service except Google Fonts (DM Sans) and the
// GSAP/Lucide CDN scripts the pages and compositions load while rendering.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TOUR_SCENES, tourCueKey } from '../../src/public/shared/onboarding.js';
import { buildTimeline } from './timeline.mjs';
import { RATE, mixTour, readMonoWav, trimSilence, writeStereoWav } from './audio.mjs';
import { captureScreens } from './capture.mjs';
import { composeProject } from './compose.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT_DIR = join(ROOT, 'src/public/assets/onboarding/tour');
const MANIFEST = join(ROOT, 'src/public/shared/onboarding-tour-media.js');
const PUBLIC_PREFIX = '/assets/onboarding/tour';
const HYPERFRAMES = ['-y', 'hyperframes@0.9.31'];

const VOICES = {
  pt: { voice: 'pm_santa', lang: 'pt-br', whisper: 'pt' },
  en: { voice: 'am_michael', lang: 'en-us', whisper: 'en' },
};
// Spoken spellings only; captions and the transcript keep the written text.
// "Kinésis" gives the Portuguese voice an open, stressed é (ki-NÉ-zis).
const RESPELL = {
  pt: [[/\bKinesis\b/g, 'Kinésis'], [/\bIA\b/g, 'I A'], [/\bFIT\b/g, 'fít']],
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
  if (!out.python || !out.kokoro || !out['whisper-model']) {
    console.error('Usage: build.mjs --python <venv python> --kokoro <model dir> --whisper-model <ggml model> [--lang pt,en] [--work <dir>] [--preview]');
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
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: ['ignore', 'ignore', 'inherit'], ...opts });

// Speaks every cue of one language and returns { samples, words } per cue key.
function narrate(options, lang, cueText, work) {
  const voice = VOICES[lang];
  const dir = join(work, 'tts'); mkdirSync(dir, { recursive: true });
  const jobs = Object.entries(cueText).map(([key, text]) => {
    const spoken = RESPELL[lang].reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
    return { key, id: sha(`kokoro-v1.0|${voice.voice}|${spoken}`).slice(0, 16), text: spoken, voice: voice.voice, lang: voice.lang };
  });
  run(options.python, ['-I', join(HERE, 'kokoro_tts.py'), join(options.kokoro, 'kokoro-v1.0.onnx'), join(options.kokoro, 'voices-v1.0.bin'), dir],
    { input: JSON.stringify(jobs), stdio: ['pipe', 'ignore', 'ignore'] });
  const clips = {};
  for (const job of jobs) {
    const wav = join(dir, `${job.id}.48k.wav`);
    if (!existsSync(wav)) run('ffmpeg', ['-v', 'error', '-y', '-i', join(dir, `${job.id}.wav`), '-ac', '1', '-ar', String(RATE), '-c:a', 'pcm_s16le', wav]);
    const samples = trimSilence(readMonoWav(wav));
    // Word timings are measured on the trimmed clip, exactly as it is mixed.
    const trimmed = join(dir, `${job.id}.trim.wav`);
    writeStereoWav(trimmed, samples, samples);
    const base = join(dir, `${job.id}.words`);
    if (!existsSync(`${base}.json`)) {
      const mono16 = join(dir, `${job.id}.16k.wav`);
      run('ffmpeg', ['-v', 'error', '-y', '-i', trimmed, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', mono16]);
      run('whisper-cli', ['-m', options['whisper-model'], '-l', voice.whisper, '-ml', '1', '-sow', '-oj', '-of', base, '-np', '-f', mono16]);
    }
    const words = JSON.parse(readFileSync(`${base}.json`, 'utf8')).transcription
      .map((seg) => ({ text: seg.text.trim(), start: seg.offsets.from / 1000, end: seg.offsets.to / 1000 }))
      .filter((w) => w.text && /[\p{L}\p{N}]/u.test(w.text));
    clips[job.key] = { samples, words, heard: words.map((w) => w.text).join(' ') };
  }
  return clips;
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

function buildVtt(timeline, cueText) {
  const cues = timeline.scenes.flatMap((scene) => scene.cues.map((cue) => ({
    start: scene.start + cue.start, end: scene.start + cue.end, text: cueText[cue.key],
  })));
  const lines = ['WEBVTT', ''];
  cues.forEach((cue, i) => {
    const next = cues[i + 1];
    const end = Math.min(cue.end + 0.4, next ? next.start - 0.05 : timeline.duration);
    lines.push(String(i + 1), `${vttTime(Math.max(0, cue.start - 0.05))} --> ${vttTime(end)}`, wrapCaption(cue.text), '');
  });
  return lines.join('\n');
}

// DM Sans (the Kinesis typeface), latin subset, fetched once into the work dir.
async function dmSans(work) {
  const file = join(work, 'dm-sans.woff2');
  if (existsSync(file)) return file;
  const css = await (await fetch('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,100..1000&display=swap', {
    headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' },
  })).text();
  const latin = css.split('@font-face').find((block) => /unicode-range:\s*U\+0000-00FF/.test(block));
  const url = latin?.match(/url\((https:[^)]+\.woff2)\)/)?.[1];
  if (!url) throw new Error('Could not find the DM Sans latin font file.');
  writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
  return file;
}

function hyperframes(dir, argv) {
  execFileSync('npx', [...HYPERFRAMES, ...argv], { cwd: dir, stdio: 'inherit', env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1' } });
}

function encode(rendered, lang, duration) {
  const base = join(OUT_DIR, `kinesis-tour-${lang}`);
  const common = ['-v', 'error', '-y', '-i', rendered, '-t', duration.toFixed(3), '-vf', 'scale=1280:720:flags=lanczos'];
  run('ffmpeg', [...common, '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '96k', `${base}.webm`]);
  run('ffmpeg', [...common, '-c:v', 'libopenh264', '-b:v', '1100k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', `${base}.mp4`]);
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
  const fontFile = await dmSans(work);
  const manifest = existsSync(join(work, 'manifest.json')) ? JSON.parse(readFileSync(join(work, 'manifest.json'), 'utf8')) : {};
  for (const lang of languages) {
    const messages = JSON.parse(readFileSync(join(ROOT, `src/public/locales/${lang}.json`), 'utf8'));
    const cueText = Object.fromEntries(TOUR_SCENES.flatMap((scene) => scene.cues).map((cue) => [cue, lookup(messages, tourCueKey(cue))]));

    console.log(`[${lang}] narration`);
    const clips = narrate(options, lang, cueText, join(work, lang));
    for (const [key, clip] of Object.entries(clips)) console.log(`  ${key}: ${clip.heard}`);
    const timeline = buildTimeline(TOUR_SCENES, Object.fromEntries(Object.entries(clips).map(([key, clip]) => [key, clip.samples.length / RATE])));
    console.log(`[${lang}] ${timeline.duration.toFixed(2)}s`);

    console.log(`[${lang}] screens`);
    const shots = await captureScreens(lang, join(work, lang, 'shots'));
    for (const [id, shot] of Object.entries(shots)) if (!shot.lang.startsWith(lang)) throw new Error(`${id} was captured in ${shot.lang}`);

    console.log(`[${lang}] compose`);
    const project = join(work, lang, 'video');
    rmSync(project, { recursive: true, force: true });
    const words = Object.fromEntries(Object.entries(clips).map(([key, clip]) => [key, clip.words]));
    const { sounds } = composeProject({ lang, dir: project, timeline, words, cueText, shots, fontFile, logoFile: join(ROOT, 'src/public/assets/brand/logo-mark.png') });
    const narration = timeline.scenes.flatMap((scene) => scene.cues.map((cue) => ({ time: scene.start + cue.start, samples: clips[cue.key].samples })));
    const [left, right] = mixTour({ duration: timeline.duration, narration, sounds });
    const mixed = join(work, lang, 'mix.wav');
    writeStereoWav(mixed, left, right);
    run('ffmpeg', ['-v', 'error', '-y', '-i', mixed, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', String(RATE), join(project, 'assets/narration.wav')]);
    hyperframes(project, ['check']);
    if (options.preview) {
      console.log(`[${lang}] project ready for review in ${project}`);
      continue;
    }

    console.log(`[${lang}] render`);
    const rendered = join(work, lang, 'render.mp4');
    hyperframes(project, ['render', '--quality', 'delivery', '-o', rendered]);

    console.log(`[${lang}] encode`);
    encode(rendered, lang, timeline.duration);
    writeFileSync(join(OUT_DIR, `kinesis-tour-${lang}.vtt`), buildVtt(timeline, cueText));
    const intro = timeline.scenes[0];
    run('ffmpeg', ['-v', 'error', '-y', '-ss', String(intro.end - 0.45), '-i', rendered, '-frames:v', '1', '-vf', 'scale=1280:720:flags=lanczos', '-q:v', '3', join(OUT_DIR, `kinesis-tour-${lang}-poster.jpg`)]);

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
  if (options.preview) return;
  const ordered = Object.fromEntries(['pt', 'en'].filter((l) => manifest[l]).map((l) => [l, manifest[l]]));
  writeFileSync(MANIFEST, `// Generated by scripts/onboarding-tour/build.mjs. Do not edit by hand.\n// Media, captions and scene boundaries of the narrated welcome tour.\nexport const TOUR_MEDIA = ${JSON.stringify(ordered, null, 2)};\n`);
  console.log(`Wrote ${MANIFEST}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
