// Builds the tour timeline from the measured narration clips. Scene length
// follows the narration, so Portuguese and English get their own timing while
// every animation stays anchored to the cue (and word) it illustrates.

export const FPS = 30;
const LEAD_FIRST = 1.0;
const LEAD = 0.45;
const CUE_GAP = 0.35;
const TAIL = 0.7;
const OUTRO_TAIL = 2.4;
const MIN_SCENE = { intro: 5, watch: 4.5, outro: 5 };

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
    const length = Math.max(MIN_SCENE[scene.id] ?? 4, local - CUE_GAP + tail);
    result.push({ id: scene.id, start, end: start + length, length, cues });
    cursor += length;
  }
  return { duration: cursor, scenes: result };
}
