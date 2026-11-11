// Sound for the tour: the narration, a few sound effects with a visible cause
// on screen, and an optional music bed mixed later by build.mjs. Effects come
// from the Pixabay-licensed library bundled with the HyperFrames media skill
// (free for commercial use, no attribution required); they are decoded at
// build time and never committed. Each effect is placed so its peak lands one
// frame after the picture, at a fixed level well under the voice.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RATE = 48000;
const FRAME = 1 / 30;

// name -> [file, gain]. Gains are relative to a peak-normalized effect.
export const SFX = {
  whoosh1: ['whoosh-short.mp3', 0.16],
  whoosh2: ['whoosh.mp3', 0.12],
  whoosh3: ['whoosh-cinematic.mp3', 0.1],
  pop: ['pop.mp3', 0.2],
  click: ['click.mp3', 0.26],
  clickSoft: ['click-soft.mp3', 0.22],
  notify: ['notification.mp3', 0.2],
  riser: ['riser.mp3', 0.14],
  chime: ['chime.mp3', 0.26],
};

// Decodes each effect once to 48 kHz mono and records where its peak is.
export function loadSfx(libraryDir, workDir) {
  mkdirSync(workDir, { recursive: true });
  const bank = {};
  for (const [name, [file, gain]] of Object.entries(SFX)) {
    const source = join(libraryDir, file);
    if (!existsSync(source)) throw new Error(`Sound effect ${source} not found; pass --sfx <HyperFrames media-use sfx folder>.`);
    const wav = join(workDir, `${file}.wav`);
    if (!existsSync(wav)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', source, '-ac', '1', '-ar', String(RATE), '-c:a', 'pcm_s16le', wav]);
    const samples = readMonoWav(wav);
    let peak = 0; let at = 0;
    for (let i = 0; i < samples.length; i += 1) if (Math.abs(samples[i]) > peak) { peak = Math.abs(samples[i]); at = i; }
    bank[name] = { samples, scale: peak > 0 ? gain / peak : 0, peakOffset: at / RATE };
  }
  return bank;
}

export function readMonoWav(path) {
  const data = readFileSync(path);
  let offset = 12; let format = null; let samples = null;
  while (offset < data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (id === 'fmt ') format = { channels: data.readUInt16LE(offset + 10), rate: data.readUInt32LE(offset + 12), bits: data.readUInt16LE(offset + 22) };
    if (id === 'data') samples = data.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!format || !samples || format.bits !== 16 || format.channels !== 1 || format.rate !== RATE) {
    throw new Error(`Unexpected WAV format in ${path}`);
  }
  const out = new Float32Array(samples.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = samples.readInt16LE(i * 2) / 32768;
  return out;
}

// Trims leading/trailing near-silence so cue timings match audible speech.
export function trimSilence(samples, threshold = 0.012) {
  let start = 0; let end = samples.length - 1;
  while (start < end && Math.abs(samples[start]) < threshold) start += 1;
  while (end > start && Math.abs(samples[end]) < threshold) end -= 1;
  const pad = Math.floor(0.03 * RATE);
  return samples.subarray(Math.max(0, start - pad), Math.min(samples.length, end + pad));
}

export function writeStereoWav(path, left, right) {
  const n = left.length;
  const data = Buffer.alloc(44 + n * 4);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 4, 4); data.write('WAVE', 8);
  data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22);
  data.writeUInt32LE(RATE, 24); data.writeUInt32LE(RATE * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i += 1) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), 44 + i * 4);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), 46 + i * 4);
  }
  writeFileSync(path, data);
}

// Mixes narration and effects. `narration` is [{ time, samples }]; `sounds` is
// [{ time, sfx }] where `time` is when the picture happens (the effect's peak
// lands one frame later).
export function mixTour({ duration, narration, sounds, bank }) {
  const length = Math.ceil(duration * RATE);
  const left = new Float32Array(length); const right = new Float32Array(length);
  for (const clip of narration) {
    const off = Math.floor(clip.time * RATE);
    for (let i = 0; i < clip.samples.length && off + i < length; i += 1) {
      left[off + i] += clip.samples[i]; right[off + i] += clip.samples[i];
    }
  }
  for (const { time, sfx } of sounds) {
    const effect = bank[sfx];
    if (!effect) throw new Error(`Unknown sound effect ${sfx}`);
    const off = Math.round((time + FRAME - effect.peakOffset) * RATE);
    for (let i = Math.max(0, -off); i < effect.samples.length && off + i < length; i += 1) {
      const v = effect.samples[i] * effect.scale;
      left[off + i] += v; right[off + i] += v;
    }
  }
  return [left, right];
}
