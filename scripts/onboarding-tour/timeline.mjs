// Builds the tour timeline from the measured narration clips. Scene length
// follows the narration, and every visual "beat" is placed relative to the
// cue it illustrates, so animation and sound effects stay in sync in both
// languages even though the Portuguese and English clips differ in length.

export const FPS = 30;
const LEAD_FIRST = 1.1;
const LEAD = 0.75;
const CUE_GAP = 0.5;
const TAIL = 1.0;
const OUTRO_TAIL = 2.6;
const MIN_SCENE = { intro: 5.5, shoes: 6, cycle: 9, request: 11, calendar: 6.5, result: 8.5, insights: 7.5, outro: 5 };

export function buildTimeline(scenes, cueDurations) {
  let cursor = 0;
  const result = [];
  for (const [index, scene] of scenes.entries()) {
    const start = cursor;
    let local = index === 0 ? LEAD_FIRST : LEAD;
    const cues = scene.cues.map((key) => {
      const duration = cueDurations[key];
      if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Missing narration for ${key}`);
      const cue = { key, start: local, end: local + duration };
      local = cue.end + CUE_GAP;
      return cue;
    });
    const tail = index === scenes.length - 1 ? OUTRO_TAIL : TAIL;
    const length = Math.max(MIN_SCENE[scene.id] ?? 5, local - CUE_GAP + tail);
    const entry = { id: scene.id, start, end: start + length, length, cues };
    entry.beats = sceneBeats(entry);
    result.push(entry);
    cursor += length;
  }
  return { duration: cursor, scenes: result };
}

function between(a, b, count) {
  if (count <= 1) return [a];
  return Array.from({ length: count }, (_, i) => a + ((b - a) * i) / (count - 1));
}

// Local beat times (seconds from scene start) consumed by scene.js. Each beat
// may carry a sound effect; `sounds` lists them for the audio mixer.
function sceneBeats(scene) {
  const c = scene.cues;
  const b = {};
  const sounds = [];
  const at = (name, time, sfx, gain = 1) => {
    b[name] = time;
    if (sfx) sounds.push({ time, sfx, gain });
  };
  switch (scene.id) {
    case 'intro':
      at('logo', 0.35, 'pop', 0.9);
      at('logoShine', 0.55, 'chime', 0.6);
      at('word', 0.95, 'whoosh', 0.5);
      at('tagline', c[1].start - 0.1);
      at('route', 0.2);
      break;
    case 'shoes':
      at('card', 0.15, 'whoosh', 0.8);
      at('shoe2', 0.55, 'pop', 0.5);
      at('fillStart', c[1].start + 0.2);
      at('fillEnd', Math.min(c[1].end, c[1].start + 2.4));
      between(b.fillStart, b.fillEnd, 10).forEach((t) => sounds.push({ time: t, sfx: 'tick', gain: 0.45 }));
      at('badge', b.fillEnd + 0.05, 'pop', 0.7);
      break;
    case 'cycle':
      at('card', 0.15, 'whoosh', 0.8);
      at('typeStart', c[0].start + 0.5);
      at('typeEnd', c[0].start + 1.6);
      between(b.typeStart, b.typeEnd, 7).forEach((t) => sounds.push({ time: t, sfx: 'key', gain: 0.35 }));
      at('date', c[0].end - 0.35, 'pop', 0.6);
      at('goal', c[1].start + 0.4, 'pop', 0.5);
      at('aiPress', c[2].start + 0.6, 'click', 0.8);
      [0, 1, 2, 3].forEach((i) => at(`phase${i}`, b.aiPress + 0.45 + i * 0.32, 'pop', 0.45));
      at('aiDone', b.phase3 + 0.35, 'chime', 0.55);
      break;
    case 'request':
      at('card', 0.15, 'whoosh', 0.8);
      [0, 1, 2, 3, 4].forEach((i) => at(`day${i}`, c[0].start + 0.5 + i * 0.32, 'click', 0.4));
      at('minutes', b.day4 + 0.35, 'pop', 0.4);
      at('weather', c[1].start + 0.1, 'pop', 0.5);
      [0, 1, 2].forEach((i) => at(`proposal${i}`, c[1].start + 0.6 + i * 0.35, 'whooshSmall', 0.45));
      at('apply', Math.max(b.proposal2 + 0.9, c[1].end - 0.7), 'click', 0.8);
      at('applied', b.apply + 0.25, 'success', 0.6);
      at('sheet', c[2].start + 0.2, 'whoosh', 0.55);
      at('sheetDrop', c[2].start + 1.0, 'drop', 0.5);
      break;
    case 'calendar':
      at('card', 0.15, 'whoosh', 0.8);
      [0, 1, 2, 3, 4].forEach((i) => at(`chip${i}`, 0.65 + i * 0.22, 'pop', 0.35));
      at('grab', c[1].start + 0.55, 'click', 0.5);
      at('dragEnd', b.grab + 1.1, 'swoosh', 0.45);
      at('drop', b.dragEnd + 0.02, 'drop', 0.55);
      break;
    case 'result':
      at('card', 0.15, 'whoosh', 0.8);
      at('file', c[0].start + 0.5, 'whooshSmall', 0.5);
      at('fileDrop', b.file + 0.7, 'drop', 0.7);
      at('statsStart', b.fileDrop + 0.25);
      at('statsEnd', b.statsStart + 1.3);
      between(b.statsStart, b.statsEnd, 8).forEach((t) => sounds.push({ time: t, sfx: 'tick', gain: 0.35 }));
      at('rpe', c[1].start + 0.1, 'pop', 0.5);
      at('rpePick', c[1].start + 1.5, 'click', 0.8);
      at('done', b.rpePick + 0.4, 'success', 0.65);
      break;
    case 'insights':
      at('card', 0.15, 'whoosh', 0.8);
      at('analysisPress', c[0].start + 0.9, 'click', 0.7);
      [0, 1, 2].forEach((i) => at(`line${i}`, b.analysisPress + 0.4 + i * 0.4, 'pop', 0.3));
      at('memory', c[1].start + 0.1, 'whooshSmall', 0.55);
      [0, 1, 2].forEach((i) => at(`source${i}`, c[1].start + 0.8 + i * 0.4, 'pop', 0.45));
      break;
    case 'outro':
      [0, 1, 2].forEach((i) => at(`check${i}`, 0.35 + i * 0.4, 'chime', 0.4 + i * 0.1));
      at('logo', c[1].start - 0.25, 'whoosh', 0.45);
      at('final', c[1].start + 0.1, 'finale', 0.8);
      break;
    default:
      break;
  }
  b.sounds = sounds;
  return b;
}
