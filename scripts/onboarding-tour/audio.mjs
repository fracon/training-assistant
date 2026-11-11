// Sound for the tour: the narration plus a few quiet, synthesized effects.
// Following the motion-graphics guide used for this video, there is no music
// bed and no whooshes: only a soft tick when an item lands or a value counts,
// and one chime at the end, all about 20 dB under the voice.
import { readFileSync, writeFileSync } from 'node:fs';

export const RATE = 48000;
const EFFECT_GAIN = 0.1; // about -20 dB relative to the narration

const buffer = (seconds) => new Float32Array(Math.ceil(seconds * RATE));

function tone(out, { start = 0, freq, freqEnd = freq, dur, gain = 1, attack = 0.002, decay = dur }) {
  let phase = 0;
  const offset = Math.floor(start * RATE);
  const n = Math.min(out.length - offset, Math.ceil(dur * RATE));
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    phase += (2 * Math.PI * freq * Math.pow(freqEnd / freq, t / dur)) / RATE;
    out[offset + i] += Math.sin(phase) * Math.min(1, t / attack) * Math.exp(-t / (decay / 4.6)) * gain;
  }
  return out;
}

function bell(out, start, freq, gain, decay = 1.4) {
  tone(out, { start, freq, dur: decay, gain, decay });
  tone(out, { start, freq: freq * 2.01, dur: decay * 0.6, gain: gain * 0.35, decay: decay * 0.6 });
  tone(out, { start, freq: freq * 3.98, dur: decay * 0.3, gain: gain * 0.12, decay: decay * 0.3 });
}

export const SFX = {
  tick: () => tone(buffer(0.06), { freq: 2600, freqEnd: 2300, dur: 0.05, gain: 0.5, decay: 0.03 }),
  chime: () => {
    const out = buffer(3);
    [659.25, 783.99, 1046.5].forEach((f, i) => bell(out, i * 0.08, f, 0.5, 2.4));
    return out;
  },
};

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

// Mixes narration and effects. `narration` is [{ time, samples }] and
// `sounds` is [{ time, sfx }], both in absolute seconds.
export function mixTour({ duration, narration, sounds }) {
  const left = buffer(duration); const right = buffer(duration);
  for (const clip of narration) {
    const off = Math.floor(clip.time * RATE);
    for (let i = 0; i < clip.samples.length && off + i < left.length; i += 1) {
      left[off + i] += clip.samples[i]; right[off + i] += clip.samples[i];
    }
  }
  for (const { time, sfx } of sounds) {
    const make = SFX[sfx];
    if (!make) throw new Error(`Unknown sound effect ${sfx}`);
    const clip = make();
    const off = Math.floor(time * RATE);
    for (let i = 0; i < clip.length && off + i < left.length; i += 1) {
      left[off + i] += clip[i] * EFFECT_GAIN; right[off + i] += clip[i] * EFFECT_GAIN;
    }
  }
  return [left, right];
}
