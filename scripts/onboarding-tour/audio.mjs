// Procedural sound design for the tour: every effect and the music bed are
// synthesized here, so the video carries no third-party audio samples.
import { readFileSync, writeFileSync } from 'node:fs';

export const RATE = 48000;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const buffer = (seconds) => new Float32Array(Math.ceil(seconds * RATE));

function tone(out, { start = 0, freq, freqEnd = freq, dur, gain = 1, attack = 0.002, decay = dur, type = 'sine' }) {
  let phase = 0;
  const n = Math.min(out.length - Math.floor(start * RATE), Math.ceil(dur * RATE));
  const offset = Math.floor(start * RATE);
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    const f = freq * Math.pow(freqEnd / freq, t / dur);
    phase += (2 * Math.PI * f) / RATE;
    const env = Math.min(1, t / attack) * Math.exp(-t / (decay / 4.6));
    const wave = type === 'triangle' ? (2 / Math.PI) * Math.asin(Math.sin(phase)) : Math.sin(phase);
    out[offset + i] += wave * env * gain;
  }
  return out;
}

// State-variable band-pass over white noise with a moving centre frequency.
function filteredNoise(out, { start = 0, dur, gain = 1, from, peak, to, q = 1.4, attack = 0.3, seed = 7 }) {
  const random = rng(seed);
  let low = 0; let band = 0;
  const n = Math.ceil(dur * RATE);
  const offset = Math.floor(start * RATE);
  for (let i = 0; i < n && offset + i < out.length; i += 1) {
    const x = i / n;
    const cutoff = x < attack ? from + (peak - from) * (x / attack) : peak + (to - peak) * ((x - attack) / (1 - attack));
    const f = 2 * Math.sin((Math.PI * Math.min(cutoff, RATE / 6)) / RATE);
    const input = random() * 2 - 1;
    low += f * band;
    const high = input - low - band / q;
    band += f * high;
    const env = x < attack ? Math.sin((x / attack) * Math.PI * 0.5) : Math.pow(1 - (x - attack) / (1 - attack), 1.6);
    out[offset + i] += band * env * gain;
  }
  return out;
}

function bell(out, start, freq, gain, decay = 1.4) {
  tone(out, { start, freq, dur: decay, gain, decay });
  tone(out, { start, freq: freq * 2.01, dur: decay * 0.6, gain: gain * 0.35, decay: decay * 0.6 });
  tone(out, { start, freq: freq * 3.98, dur: decay * 0.3, gain: gain * 0.12, decay: decay * 0.3 });
}

export const SFX = {
  pop: () => tone(buffer(0.16), { freq: 980, freqEnd: 480, dur: 0.14, gain: 0.55, decay: 0.12 }),
  tick: () => tone(buffer(0.05), { freq: 3200, freqEnd: 2800, dur: 0.04, gain: 0.25, decay: 0.025 }),
  key: (seed = 1) => filteredNoise(buffer(0.05), { dur: 0.045, gain: 0.9, from: 2500 + seed * 90, peak: 3800, to: 2000, q: 3, attack: 0.05, seed }),
  click: () => {
    const out = buffer(0.08);
    tone(out, { freq: 1900, freqEnd: 1500, dur: 0.03, gain: 0.35, decay: 0.02 });
    tone(out, { freq: 520, freqEnd: 300, dur: 0.07, gain: 0.45, decay: 0.05 });
    return out;
  },
  whoosh: (seed = 3) => filteredNoise(buffer(0.6), { dur: 0.6, gain: 1.6, from: 300, peak: 2600, to: 600, q: 1.2, attack: 0.38, seed }),
  whooshSmall: (seed = 5) => filteredNoise(buffer(0.34), { dur: 0.34, gain: 1.1, from: 700, peak: 3600, to: 1400, q: 1.6, attack: 0.4, seed }),
  swoosh: (seed = 9) => filteredNoise(buffer(0.45), { dur: 0.45, gain: 1.2, from: 900, peak: 4200, to: 1600, q: 2, attack: 0.55, seed }),
  drop: () => {
    const out = buffer(0.3);
    tone(out, { freq: 150, freqEnd: 55, dur: 0.24, gain: 0.85, decay: 0.2 });
    filteredNoise(out, { dur: 0.08, gain: 0.5, from: 1200, peak: 900, to: 400, q: 1, attack: 0.1, seed: 11 });
    return out;
  },
  chime: () => { const out = buffer(1.6); bell(out, 0, 1318.5, 0.28); return out; },
  success: () => { const out = buffer(1.8); bell(out, 0, 1046.5, 0.26); bell(out, 0.12, 1568, 0.24); return out; },
  finale: () => {
    const out = buffer(3.4);
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => bell(out, i * 0.09, f, 0.2, 2.6));
    return out;
  },
};

// Soft ambient bed: a slow pad progression plus a quiet plucked arpeggio,
// with a gentle fade in, and a resolution on the tonic at the end.
function music(duration) {
  const left = buffer(duration); const right = buffer(duration);
  const bar = 2.5;
  const chords = [
    [261.63, 329.63, 392.0, 493.88], // Cmaj7
    [220.0, 261.63, 329.63, 392.0], // Am7
    [174.61, 220.0, 261.63, 329.63], // Fmaj7
    [196.0, 246.94, 293.66, 392.0], // G
  ];
  const bars = Math.ceil(duration / bar);
  for (let b = 0; b < bars; b += 1) {
    const last = b === bars - 1;
    const chord = last ? chords[0] : chords[b % chords.length];
    const start = b * bar;
    const len = Math.min(bar + 0.8, duration - start);
    if (len <= 0) continue;
    chord.forEach((f, i) => {
      for (const [out, detune] of [[left, 0.998], [right, 1.002]]) {
        const n = Math.ceil(len * RATE); const off = Math.floor(start * RATE);
        for (let k = 0; k < n && off + k < out.length; k += 1) {
          const t = k / RATE;
          const env = Math.min(1, t / 0.9) * Math.min(1, (len - t) / 0.8);
          const lfo = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.2 * (start + t) + i);
          out[off + k] += Math.sin(2 * Math.PI * f * detune * t) * 0.03 * env * lfo
            + Math.sin(2 * Math.PI * f * 0.5 * t) * 0.012 * env;
        }
      }
    });
    if (!last) {
      const notes = [...chord, chord[2] * 2, chord[1] * 2, chord[3], chord[1]];
      notes.forEach((f, i) => {
        const at = start + i * (bar / 8);
        tone(i % 2 ? right : left, { start: at, freq: f * 2, dur: 0.5, gain: 0.03, decay: 0.45, type: 'triangle' });
        tone(i % 2 ? left : right, { start: at, freq: f * 2, dur: 0.5, gain: 0.012, decay: 0.45, type: 'triangle' });
      });
    }
  }
  const fadeIn = 1.5 * RATE; const fadeOut = 2.2 * RATE;
  for (let i = 0; i < left.length; i += 1) {
    const g = Math.min(1, i / fadeIn) * Math.min(1, (left.length - i) / fadeOut);
    left[i] *= g; right[i] *= g;
  }
  return [left, right];
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

// Mixes narration, effects and music. `narration` is [{ time, samples }],
// `sounds` is [{ time, sfx, gain }] in absolute seconds.
export function mixTour({ duration, narration, sounds }) {
  const [musicL, musicR] = music(duration);
  const voice = buffer(duration);
  for (const clip of narration) {
    const off = Math.floor(clip.time * RATE);
    for (let i = 0; i < clip.samples.length && off + i < voice.length; i += 1) voice[off + i] += clip.samples[i];
  }
  // Duck the music while the narrator speaks (smoothed envelope follower).
  const duck = new Float32Array(voice.length);
  let env = 0;
  for (let i = 0; i < voice.length; i += 1) {
    const level = Math.abs(voice[i]) > 0.02 ? 1 : 0;
    env += (level - env) * (level > env ? 1 / (0.05 * RATE) : 1 / (0.6 * RATE));
    duck[i] = 1 - 0.55 * Math.min(1, env * 1.5);
  }
  const left = buffer(duration); const right = buffer(duration);
  for (let i = 0; i < left.length; i += 1) {
    left[i] = voice[i] * 0.92 + musicL[i] * duck[i];
    right[i] = voice[i] * 0.92 + musicR[i] * duck[i];
  }
  let seed = 1;
  for (const { time, sfx, gain } of sounds) {
    const make = SFX[sfx];
    if (!make) throw new Error(`Unknown sound effect ${sfx}`);
    const clip = make((seed += 1));
    const pan = Math.sin(seed * 1.7) * 0.25;
    const off = Math.floor(time * RATE);
    for (let i = 0; i < clip.length && off + i < left.length; i += 1) {
      left[off + i] += clip[i] * gain * 0.8 * (1 - pan);
      right[off + i] += clip[i] * gain * 0.8 * (1 + pan);
    }
  }
  // Gentle soft clip, then normalize the peak to about -1 dBFS.
  let peak = 0;
  for (let i = 0; i < left.length; i += 1) {
    left[i] = Math.tanh(left[i] * 1.1) / 1.1; right[i] = Math.tanh(right[i] * 1.1) / 1.1;
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  const norm = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < left.length; i += 1) { left[i] *= norm; right[i] *= norm; }
  return [left, right];
}
