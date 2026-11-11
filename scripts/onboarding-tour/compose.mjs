// Writes the HyperFrames project for one language: index.html mounts one
// sub-composition per tour scene plus the mixed narration track. Every move is
// anchored to the word the narrator says (whisper word timings), screens are
// real Kinesis captures (capture.mjs) shown in one framed "stage", and the
// camera zooms into the control being described: one idea per screen.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOUR_STRINGS } from './strings.mjs';

const W = 1920;
const H = 1080;
// The stage that frames every screenshot: 16:9, inside the 90% action-safe box,
// leaving the top band for the scene headline.
const STAGE = { x: 186, y: 182, w: 1548, h: 871 };
const BASE = STAGE.w / W;
const TOKENS = {
  bg: '#f4f0e8', card: '#fdfbf6', ink: '#3c352a', muted: '#8b8172',
  line: '#e6dfd1', accent: '#6f9070', accentDeep: '#4c6e51',
};

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fix = (n) => Number(n.toFixed(3));
const fold = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

function union(boxes) {
  const x = Math.min(...boxes.map((b) => b.x)); const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}
const pad = (b, p) => ({ x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p });

// Camera state that centres `box` in the stage at `fill` of its size, clamped
// so the screenshot always covers the whole stage.
function cam(box, fill = 0.9, maxZoom = 2.4) {
  if (!box) return { x: 0, y: 0, scale: fix(BASE) };
  const zoom = Math.max(1, Math.min(maxZoom, (STAGE.w * fill) / (box.w * BASE), (STAGE.h * fill) / (box.h * BASE)));
  const scale = BASE * zoom;
  const clamp = (v, size, view) => Math.min(0, Math.max(view - size * scale, v));
  return {
    x: fix(clamp(STAGE.w / 2 - (box.x + box.w / 2) * scale, W, STAGE.w)),
    y: fix(clamp(STAGE.h / 2 - (box.y + box.h / 2) * scale, H, STAGE.h)),
    scale: fix(scale),
  };
}

// Absolute scene-local time of a spoken word: the first word of the cue whose
// folded text starts with `word`, else a proportional estimate from the text.
function wordClock(scene, words, cueText) {
  return (key, word, which = 0) => {
    const cue = scene.cues.find((c) => c.key === key);
    if (!cue) throw new Error(`Scene ${scene.id} has no cue ${key}`);
    const target = fold(word);
    const list = words[key] ?? [];
    const matches = list.filter((w) => fold(w.text).startsWith(target) || (target.length > 3 && fold(w.text).includes(target)));
    if (matches[which]) return fix(cue.start + matches[which].start);
    const text = fold(cueText[key]);
    const index = text.indexOf(target);
    const share = index >= 0 ? index / Math.max(1, text.length) : 0.5;
    return fix(cue.start + share * (cue.end - cue.start));
  };
}

const FONT_FACE = "@font-face { font-family: 'DM Sans'; src: url('assets/fonts/dm-sans.woff2') format('woff2'); font-weight: 100 1000; font-style: normal; }";

function headlineMarkup(id, text, length) {
  const words = text.split(' ').map((w, i) => `<span class="hw" id="${id}-w${i}">${esc(w)}</span>`).join(' ');
  return `<h2 id="${id}" class="clip headline" data-start="0" data-duration="${fix(length)}" data-track-index="1">${words}</h2>`;
}

// Shared scene builder for the screenshot scenes. `plan` returns the shots,
// rings, ghosts and camera keys for the scene.
function stageScene(sceneId, length, headline, plan) {
  const { shots, rings = [], camera = [], ghosts = [], covers = [], sounds = [], extra = '' } = plan;
  const imgs = shots.map((s, i) => `<img id="${sceneId}-shot${i}" class="shot" src="assets/shots/${s.id}.png" alt="" data-layout-ignore>`).join('\n          ');
  const ringEls = rings.map((r, i) => `<div id="${sceneId}-ring${i}" class="ring" style="left:${r.box.x}px;top:${r.box.y}px;width:${r.box.w}px;height:${r.box.h}px"></div>`).join('\n          ');
  const coverEls = covers.map((c, i) => `<div id="${sceneId}-cover${i}" class="crop" style="left:${c.at.x}px;top:${c.at.y}px;width:${c.from.w}px;height:${c.from.h}px;background-image:url('assets/shots/${c.shot}.png');background-position:-${c.from.x}px -${c.from.y}px"></div>`).join('\n          ');
  const ghostEls = ghosts.map((g, i) => `<div id="${sceneId}-ghost${i}" class="crop ghost" style="left:${g.from.x}px;top:${g.from.y}px;width:${g.from.w}px;height:${g.from.h}px;background-image:url('assets/shots/${g.shot}.png');background-position:-${g.from.x}px -${g.from.y}px"></div>`).join('\n          ');
  const tl = [];
  tl.push(`tl.fromTo('#${sceneId}-stage-in', { opacity: 0, filter: 'blur(10px)' }, { opacity: 1, filter: 'blur(0px)', duration: 0.35, ease: 'expo.out' }, 0);`);
  tl.push(`tl.to('#${sceneId}-stage-in', { opacity: 0, filter: 'blur(8px)', duration: 0.2, ease: 'power3.in' }, ${fix(length - 0.22)});`);
  tl.push(`tl.fromTo('#${sceneId} .hw', { opacity: 0, filter: 'blur(6px)' }, { opacity: 1, filter: 'blur(0px)', duration: 0.16, ease: 'power4.out', stagger: 0.07 }, 0.15);`);
  tl.push(`tl.to('#${sceneId}-head', { opacity: 0, filter: 'blur(6px)', duration: 0.18, ease: 'power3.in' }, ${fix(length - 0.22)});`);
  const first = camera[0]?.state ?? cam(null);
  tl.push(`tl.set('#${sceneId}-cam', { x: ${first.x}, y: ${first.y}, scale: ${first.scale} }, 0);`);
  // Camera moves never overlap: each one ends before the next begins.
  const moves = camera.slice(1).map((step) => ({ ...step, at: Math.max(0.05, step.at) })).sort((a, b) => a.at - b.at);
  moves.forEach((step, i) => {
    const room = (moves[i + 1]?.at ?? length) - step.at - 0.03;
    const duration = fix(Math.max(0.25, Math.min(step.duration ?? 0.9, room)));
    tl.push(`tl.to('#${sceneId}-cam', { x: ${step.state.x}, y: ${step.state.y}, scale: ${step.state.scale}, duration: ${duration}, ease: '${step.ease ?? 'power2.inOut'}' }, ${fix(step.at)});`);
  });
  shots.forEach((s, i) => {
    tl.push(`tl.set('#${sceneId}-shot${i}', { opacity: ${i === 0 ? 1 : 0} }, 0);`);
    if (i > 0) tl.push(`tl.fromTo('#${sceneId}-shot${i}', { opacity: 0, filter: 'blur(8px)' }, { opacity: 1, filter: 'blur(0px)', duration: 0.3, ease: 'power2.out' }, ${fix(s.at)});`);
    if (i > 0) tl.push(`tl.to('#${sceneId}-shot${i - 1}', { opacity: 0, duration: 0.3, ease: 'power2.in' }, ${fix(s.at)});`);
  });
  rings.forEach((r, i) => {
    tl.push(`tl.fromTo('#${sceneId}-ring${i}', { opacity: 0, scale: 1.08 }, { opacity: 1, scale: 1, duration: 0.35, ease: 'expo.out' }, ${fix(r.at)});`);
    if (r.until) tl.push(`tl.to('#${sceneId}-ring${i}', { opacity: 0, duration: 0.2, ease: 'power2.in' }, ${fix(r.until)});`);
    sounds.push({ time: r.at, sfx: r.click ? 'click' : 'pop' });
  });
  // A cursor travels to each "click" ring and presses it. It lives outside the
  // camera, so its position is the box centre under the camera state in effect.
  const camAt = (t) => [camera[0], ...moves.filter((m) => m.at + 0.02 <= t)].at(-1).state;
  const clicks = rings.filter((r) => r.click);
  clicks.forEach((r) => {
    const st = camAt(r.at - 0.9);
    const px = fix(st.x + (r.box.x + r.box.w / 2) * st.scale); const py = fix(st.y + (r.box.y + r.box.h / 2) * st.scale);
    tl.push(`tl.fromTo('#${sceneId}-cursor', { x: ${fix(px + 170)}, y: ${fix(py + 120)}, opacity: 0, scale: 1 }, { x: ${fix(px - 9)}, y: ${fix(py - 5)}, opacity: 1, duration: 0.7, ease: 'power3.out', immediateRender: false }, ${fix(r.at - 0.85)});`);
    tl.push(`tl.to('#${sceneId}-cursor', { scale: 0.86, duration: 0.07, ease: 'power2.in' }, ${fix(r.at - 0.07)});`);
    tl.push(`tl.to('#${sceneId}-cursor', { scale: 1, duration: 0.14, ease: 'power2.out' }, ${fix(r.at)});`);
    tl.push(`tl.to('#${sceneId}-cursor', { opacity: 0, duration: 0.2, ease: 'power2.in' }, ${fix(r.at + 0.6)});`);
  });
  covers.forEach((c, i) => {
    tl.push(`tl.set('#${sceneId}-cover${i}', { opacity: 0 }, 0);`);
    tl.push(`tl.set('#${sceneId}-cover${i}', { opacity: 1 }, ${fix(c.at.time)});`);
  });
  ghosts.forEach((g, i) => {
    tl.push(`tl.set('#${sceneId}-ghost${i}', { opacity: 0, x: 0, y: 0, scale: 1 }, 0);`);
    tl.push(`tl.set('#${sceneId}-ghost${i}', { opacity: 1 }, ${fix(g.lift)});`);
    tl.push(`tl.to('#${sceneId}-ghost${i}', { scale: 1.06, boxShadow: '0 18px 36px rgba(60,53,42,0.28)', duration: 0.25, ease: 'power2.out' }, ${fix(g.lift)});`);
    tl.push(`tl.to('#${sceneId}-ghost${i}', { x: ${g.to.x - g.from.x}, y: ${g.to.y - g.from.y}, duration: 0.7, ease: 'power2.inOut' }, ${fix(g.lift + 0.2)});`);
    tl.push(`tl.to('#${sceneId}-ghost${i}', { scale: 1, boxShadow: '0 0 0 rgba(60,53,42,0)', duration: 0.3, ease: 'expo.out' }, ${fix(g.lift + 0.9)});`);
    sounds.push({ time: g.lift, sfx: 'clickSoft' }, { time: g.lift + 0.9, sfx: 'pop' });
  });
  return { sounds, html: `<template>
  <style>
    ${FONT_FACE}
    #root { position: absolute; inset: 0; font-family: 'DM Sans', sans-serif; color: ${TOKENS.ink}; }
    .headline { position: absolute; left: ${STAGE.x}px; right: ${STAGE.x}px; top: 66px; margin: 0; font-size: 62px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; color: ${TOKENS.ink}; }
    .hw { display: inline-block; }
    .stage { position: absolute; left: ${STAGE.x}px; top: ${STAGE.y}px; width: ${STAGE.w}px; height: ${STAGE.h}px; }
    .stage-in { position: absolute; inset: 0; border-radius: 22px; overflow: hidden; background: ${TOKENS.card}; box-shadow: 0 30px 80px rgba(60,53,42,0.16), 0 0 0 1px ${TOKENS.line}; }
    .cam { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; transform-origin: 0 0; }
    .shot { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; }
    .ring { position: absolute; border-radius: 14px; box-shadow: 0 0 0 4px ${TOKENS.accent}, 0 0 0 12px rgba(111,144,112,0.22); }
    .crop { position: absolute; background-size: ${W}px ${H}px; background-repeat: no-repeat; border-radius: 10px; }
    .cursor { position: absolute; left: 0; top: 0; width: 44px; height: 44px; transform-origin: 6px 4px; filter: drop-shadow(0 4px 8px rgba(60,53,42,0.35)); opacity: 0; }
  </style>
  <div id="root" data-composition-id="${sceneId}" data-width="${W}" data-height="${H}">
    ${headlineMarkup(`${sceneId}-head`, headline, length)}
    <div id="${sceneId}-stage" class="clip stage" data-start="0" data-duration="${fix(length)}" data-track-index="2" data-layout-allow-overflow>
      <div id="${sceneId}-stage-in" class="stage-in">
        <div id="${sceneId}-cam" class="cam">
          ${imgs}
          ${coverEls}
          ${ghostEls}
          ${ringEls}
        </div>
        ${rings.some((r) => r.click) ? `<svg id="${sceneId}-cursor" class="cursor" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 8-6.2 1.6L9.6 19z" fill="#fdfbf6" stroke="#3c352a" stroke-width="1.6" stroke-linejoin="round"/></svg>` : ''}
      </div>
    </div>
    ${extra}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    ${tl.join('\n    ')}
    window.__timelines["${sceneId}"] = tl;
  </script>
</template>
` };
}

function introScene(scene, at, strings) {
  const L = scene.length;
  const name = 'Kinesis'.split('').map((c, i) => `<span class="ch" id="intro-c${i}">${c}</span>`).join('');
  const tag = strings.tagline.map((w, i) => `<span class="tw" id="intro-t${i}">${esc(w)}</span>`).join(' ');
  const kinesisAt = at('intro1', 'kinesis');
  const tagAt = strings.taglineAnchors.map((w) => at('intro2', w));
  const sounds = [...tagAt.map((t) => ({ time: t, sfx: 'clickSoft' }))];
  return { sounds, html: `<template>
  <style>
    ${FONT_FACE}
    #root { position: absolute; inset: 0; font-family: 'DM Sans', sans-serif; color: ${TOKENS.ink}; }
    .mark { position: absolute; left: 50%; top: 300px; width: 180px; height: 180px; margin-left: -90px; }
    .name { position: absolute; left: 0; right: 0; top: 500px; margin: 0; text-align: center; font-size: 128px; font-weight: 700; letter-spacing: -0.03em; }
    .ch { display: inline-block; }
    .tag { position: absolute; left: 0; right: 0; top: 690px; margin: 0; text-align: center; font-size: 54px; font-weight: 500; color: ${TOKENS.accentDeep}; }
    .tw { display: inline-block; margin: 0 14px; }
  </style>
  <div id="root" data-composition-id="intro" data-width="${W}" data-height="${H}">
    <img id="intro-mark" class="clip mark" src="assets/logo-mark.png" alt="" data-start="0" data-duration="${fix(L)}" data-track-index="1">
    <h1 id="intro-name" class="clip name" data-start="0" data-duration="${fix(L)}" data-track-index="2">${name}</h1>
    <p id="intro-tag" class="clip tag" data-start="0" data-duration="${fix(L)}" data-track-index="3">${tag}</p>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.fromTo('#intro-mark', { opacity: 1, scale: 0.86 }, { opacity: 1, scale: 1, duration: 0.9, ease: 'expo.out' }, 0);
    tl.fromTo('#intro .ch', { opacity: 0.0, filter: 'blur(6px)' }, { opacity: 1, filter: 'blur(0px)', duration: 0.2, ease: 'power4.out', stagger: 0.06 }, ${fix(Math.max(0.6, kinesisAt - 0.25))});
    ${tagAt.map((t, i) => `tl.fromTo('#intro-t${i}', { opacity: 0, y: 18, filter: 'blur(6px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.3, ease: 'expo.out' }, ${fix(t)});`).join('\n    ')}
    tl.to(['#intro-mark', '#intro-name', '#intro-tag'], { opacity: 0, filter: 'blur(8px)', duration: 0.22, ease: 'power3.in' }, ${fix(L - 0.24)});
    window.__timelines["intro"] = tl;
  </script>
</template>
` };
}

function watchScene(scene, at, strings, shots) {
  const L = scene.length;
  const chip = shots.calendar.boxes.first;
  const land = at('watch1', 'direto') ?? 1.5;
  const go = Math.max(0.6, land - 0.9);
  const sounds = [{ time: land, sfx: 'notify' }];
  const s = strings.watch;
  const face = 420;
  const cx = W / 2 + 180; const cy = 640;
  const chipScale = 1.9;
  const chipW = chip.w * chipScale; const chipH = chip.h * chipScale;
  const startX = 260; const startY = cy - chipH / 2;
  return { sounds, html: `<template>
  <style>
    ${FONT_FACE}
    #root { position: absolute; inset: 0; font-family: 'DM Sans', sans-serif; color: ${TOKENS.ink}; }
    .headline { position: absolute; left: ${STAGE.x}px; right: ${STAGE.x}px; top: 66px; margin: 0; font-size: 62px; font-weight: 700; letter-spacing: -0.02em; }
    .hw { display: inline-block; }
    .watch { position: absolute; left: ${cx - face / 2}px; top: ${cy - face / 2}px; width: ${face}px; height: ${face}px; }
    .strap { position: absolute; left: ${face * 0.22}px; width: ${face * 0.56}px; height: 230px; background: ${TOKENS.accentDeep}; border-radius: 40px; }
    .strap.top { top: -170px; } .strap.bottom { bottom: -170px; }
    .bezel { position: absolute; inset: 0; border-radius: 50%; background: ${TOKENS.ink}; box-shadow: 0 30px 70px rgba(60,53,42,0.28); }
    .screen { position: absolute; inset: 26px; border-radius: 50%; background: #1f1b16; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: #f4f0e8; }
    .status { font-size: 28px; color: #a9c4a7; font-weight: 600; letter-spacing: 0.02em; }
    .workout { font-size: 46px; font-weight: 700; margin-top: 10px; }
    .idle { position: absolute; inset: 26px; display: flex; align-items: center; justify-content: center; font-size: 96px; font-weight: 600; color: #f4f0e8; letter-spacing: -0.02em; z-index: 1; }
    .detail { font-size: 34px; font-weight: 500; margin-top: 6px; color: #d9d1c2; }
    .button { position: absolute; right: -14px; top: ${face / 2 - 34}px; width: 22px; height: 68px; border-radius: 8px; background: ${TOKENS.ink}; }
    .chip { position: absolute; left: ${startX}px; top: ${startY}px; width: ${chipW}px; height: ${chipH}px; border-radius: 14px; background-image: url('assets/shots/calendar.png'); background-size: ${W * chipScale}px ${H * chipScale}px; background-position: -${chip.x * chipScale}px -${chip.y * chipScale}px; box-shadow: 0 18px 40px rgba(60,53,42,0.2); }
  </style>
  <div id="root" data-composition-id="watch" data-width="${W}" data-height="${H}">
    ${headlineMarkup('watch-head', strings.headlines.watch, L)}
    <div id="watch-body" class="clip watch" data-start="0" data-duration="${fix(L)}" data-track-index="2" data-layout-allow-overflow>
      <div class="strap top"></div><div class="strap bottom"></div>
      <div class="bezel"></div><div class="button"></div>
      <div id="watch-idle" class="idle">06:30</div>
      <div class="screen">
        <div id="watch-status" class="status">${esc(s.status)}</div>
        <div id="watch-workout" class="workout">${esc(s.workout)}</div>
        <div id="watch-detail" class="detail">${esc(s.detail)}</div>
      </div>
    </div>
    <div id="watch-chip" class="clip chip" data-start="0" data-duration="${fix(L)}" data-track-index="3"></div>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.fromTo('#watch .hw', { opacity: 0, filter: 'blur(6px)' }, { opacity: 1, filter: 'blur(0px)', duration: 0.16, ease: 'power4.out', stagger: 0.07 }, 0.15);
    tl.fromTo('#watch-body .bezel, #watch-body .strap, #watch-body .button, #watch-body .screen, #watch-idle', { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.6, ease: 'expo.out' }, 0.1);
    tl.fromTo('#watch-chip', { opacity: 0, x: -40 }, { opacity: 1, x: 0, duration: 0.45, ease: 'expo.out' }, 0.3);
    tl.set(['#watch-status', '#watch-workout', '#watch-detail'], { opacity: 0 }, 0);
    tl.to('#watch-chip', { x: ${fix(cx - startX - chipW / 2)}, y: 0, scale: 0.35, opacity: 0, duration: 0.85, ease: 'power3.in' }, ${fix(go)});
    tl.to('#watch-idle', { opacity: 0, filter: 'blur(6px)', duration: 0.15, ease: 'power3.in' }, ${fix(land - 0.15)});
    tl.fromTo(['#watch-status', '#watch-workout', '#watch-detail'], { opacity: 0, filter: 'blur(6px)' }, { opacity: 1, filter: 'blur(0px)', duration: 0.25, ease: 'power4.out', stagger: 0.09 }, ${fix(land)});
    tl.to(['#watch-head', '#watch-body'], { opacity: 0, filter: 'blur(8px)', duration: 0.2, ease: 'power3.in' }, ${fix(L - 0.22)});
    window.__timelines["watch"] = tl;
  </script>
</template>
` };
}

function outroScene(scene, at, strings) {
  const L = scene.length;
  const o = strings.outro;
  const closeAt = at('outro2', o.closing.split(' ')[0]);
  const checks = o.steps.map((_, i) => fix(0.12 + i * 0.3));
  const sounds = [...checks.map((t) => ({ time: t, sfx: 'pop' })), { time: closeAt - 0.3, sfx: 'riser' }, { time: closeAt, sfx: 'chime' }];
  const stepHtml = o.steps.map((label, i) => `<li class="step" id="outro-s${i}"><span class="check">✓</span>${esc(label)}</li>`).join('');
  return { sounds, html: `<template>
  <style>
    ${FONT_FACE}
    #root { position: absolute; inset: 0; font-family: 'DM Sans', sans-serif; color: ${TOKENS.ink}; }
    .steps { position: absolute; left: 0; right: 0; top: 250px; margin: 0; padding: 0; list-style: none; display: flex; justify-content: center; gap: 28px; }
    .step { display: flex; align-items: center; gap: 14px; padding: 18px 30px; border-radius: 999px; background: ${TOKENS.card}; box-shadow: 0 0 0 1px ${TOKENS.line}; font-size: 38px; font-weight: 600; }
    .check { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 50%; background: ${TOKENS.accent}; color: #fff; font-size: 26px; }
    .title { position: absolute; left: 0; right: 0; top: 420px; margin: 0; text-align: center; font-size: 96px; font-weight: 700; letter-spacing: -0.03em; }
    .mark { position: absolute; left: 50%; top: 600px; width: 120px; height: 120px; margin-left: -60px; }
    .closing { position: absolute; left: 0; right: 0; top: 760px; margin: 0; text-align: center; font-size: 56px; font-weight: 600; color: ${TOKENS.accentDeep}; }
  </style>
  <div id="root" data-composition-id="outro" data-width="${W}" data-height="${H}">
    <ul id="outro-steps" class="clip steps" data-start="0" data-duration="${fix(L)}" data-track-index="1">${stepHtml}</ul>
    <h2 id="outro-title" class="clip title" data-start="0" data-duration="${fix(L)}" data-track-index="2">${esc(o.title)}</h2>
    <img id="outro-mark" class="clip mark" src="assets/logo-mark.png" alt="" data-start="0" data-duration="${fix(L)}" data-track-index="3">
    <p id="outro-closing" class="clip closing" data-start="0" data-duration="${fix(L)}" data-track-index="4">${esc(o.closing)}</p>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    ${checks.map((t, i) => `tl.fromTo('#outro-s${i}', { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.4, ease: 'expo.out' }, ${t});`).join('\n    ')}
    tl.fromTo('#outro-title', { opacity: 0, filter: 'blur(8px)' }, { opacity: 1, filter: 'blur(0px)', duration: 0.2, ease: 'power4.out' }, ${fix(Math.max(0.3, at('outro1', o.title.split(' ')[0]) - 0.05))});
    tl.fromTo('#outro-mark', { opacity: 0, scale: 0.7 }, { opacity: 1, scale: 1, duration: 0.6, ease: 'expo.out' }, ${fix(closeAt - 0.3)});
    tl.fromTo('#outro-closing', { opacity: 0, filter: 'blur(8px)' }, { opacity: 1, filter: 'blur(0px)', duration: 0.2, ease: 'power4.out' }, ${fix(closeAt)});
    window.__timelines["outro"] = tl;
  </script>
</template>
` };
}

// The per-scene plans for the screenshot scenes.
function screenPlan(id, at, shots, cueAt) {
  const S = shots;
  const b = (shot, name) => S[shot].boxes[name];
  switch (id) {
    case 'shoes': {
      const list = pad(b('shoes', 'list'), 24);
      return {
        shots: [{ id: 'shoes' }],
        camera: [{ state: cam(null) }, { at: at('shoes1', 'tenis') - 0.3, state: cam(list, 0.8) }],
        rings: [{ box: pad(b('shoes', 'list'), 10), at: at('shoes2', 'rodagem') }],
      };
    }
    case 'cycle': {
      const card = pad(b('cycles', 'card'), 24);
      const planning = b('cycles', 'planning');
      const actions = b('cycles', 'actions');
      const modal = b('planning', 'modal');
      const generate = b('planning', 'generate');
      const press = at('cycle3', 'planejamento');
      return {
        shots: [{ id: 'cycles' }, { id: 'planning', at: press + 0.25 }],
        camera: [{ state: cam(null) }, { at: at('cycle1', 'objetivo') - 0.3, state: cam(card, 0.8) },
          { at: at('cycle2', 'meta') - 0.3, state: cam({ ...card, w: card.w * 0.6, h: card.h * 0.6 }, 0.85, 2.6), duration: 1.1 },
          { at: cueAt('cycle3') - 0.1, state: cam({ x: card.x, y: card.y + card.h * 0.3, w: card.w * 0.62, h: card.h * 0.7 }, 0.92, 2.2), duration: 0.8 },
          { at: press + 0.3, state: cam(pad({ x: modal.x, y: modal.y + modal.h * 0.45, w: modal.w, h: modal.h * 0.55 }, 20), 0.92, 1.6), duration: 0.7 }],
        rings: [{ box: pad(b('cycles', 'card'), 8), at: at('cycle1', 'data'), until: cueAt('cycle3') - 0.15 },
          { box: pad(planning, 6), at: press, until: press + 0.45, click: true },
          { box: pad(generate, 8), at: at('cycle3', 'fases') }],
      };
    }
    case 'request': {
      const days = pad(b('request', 'days'), 20);
      const generate = b('generate', 'generate');
      const imp = b('calendar', 'import');
      return {
        shots: [{ id: 'request' }, { id: 'generate', at: cueAt('request2') - 0.2 }, { id: 'calendar', at: cueAt('request3') - 0.2 }],
        camera: [{ state: cam(null) }, { at: cueAt('request1') + 0.2, state: cam({ ...b('request', 'availability'), h: 420 }, 0.9, 1.5), duration: 1 },
          { at: at('request1', 'dias') - 0.35, state: cam(days, 0.85, 1.6) },
          { at: cueAt('request2') - 0.25, state: cam(pad(generate, 260), 0.9), duration: 0.6 },
          { at: at('request2', 'revisar') - 0.3, state: cam(pad(generate, 420), 0.9), duration: 0.9 },
          { at: cueAt('request3') - 0.25, state: cam(pad(imp, 360), 0.9), duration: 0.6 },
          { at: at('request3', 'planilha') - 0.35, state: cam(pad(imp, 160), 0.9), duration: 0.7 }],
        rings: [{ box: pad(b('request', 'days'), 6), at: at('request1', 'tempo'), until: cueAt('request2') - 0.25 },
          { box: pad(generate, 8), at: at('request2', 'proposta'), until: cueAt('request3') - 0.25, click: true },
          { box: pad(imp, 8), at: at('request3', 'montar') }],
      };
    }
    case 'calendar': {
      const chips = pad(b('calendar', 'chips'), 30);
      const chip = b('calendar', 'first');
      const cells = b('calendar', 'cells');
      const home = cells.findIndex((c) => chip.x >= c.x && chip.x < c.x + c.w && chip.y >= c.y && chip.y < c.y + c.h);
      const target = cells[home + 1];
      const dx = chip.x - cells[home].x; const dy = chip.y - cells[home].y;
      const lift = at('calendar2', 'arrast') - 0.15;
      return {
        shots: [{ id: 'calendar' }],
        camera: [{ state: cam(null) }, { at: at('calendar1', 'calend') - 0.35, state: cam(pad(union([chips, cells[home], target]), 20), 0.95) }],
        covers: [{ shot: 'calendar', from: { x: target.x + dx, y: target.y + dy, w: chip.w, h: chip.h }, at: { x: chip.x, y: chip.y, time: lift } }],
        ghosts: [{ shot: 'calendar', from: chip, to: { x: target.x + dx, y: target.y + dy }, lift }],
        rings: [{ box: pad(b('calendar', 'chips'), 8), at: at('calendar1', 'calend'), until: lift - 0.2 }],
      };
    }
    case 'result': {
      const source = b('upload', 'source'); const drop = b('upload', 'dropzone');
      const emojis = b('rpe', 'emojis');
      return {
        shots: [{ id: 'upload' }, { id: 'rpe', at: cueAt('result2') - 0.2 }],
        camera: [{ state: cam(null) }, { at: at('result1', 'import') - 0.35, state: cam(pad(union([source, drop]), 30), 0.85) },
          { at: cueAt('result2') - 0.25, state: cam(pad(b('rpe', 'rpe'), 120), 0.85), duration: 0.6 }],
        rings: [{ box: pad(source, 6), at: at('result1', 'relogio'), until: at('result1', 'fit') - 0.1 },
          { box: pad(drop, 6), at: at('result1', 'fit'), until: cueAt('result2') - 0.25 },
          { box: pad(emojis[2], 6), at: at('result2', 'esforco') }],
      };
    }
    case 'insights': {
      const generate = b('analysis', 'generate');
      const sections = b('memory', 'sections').filter((s) => s.y < H - 100).map((s) => ({ ...s, h: Math.min(s.h, H - 40 - s.y) }));
      const area = union(sections);
      return {
        shots: [{ id: 'analysis' }, { id: 'memory', at: cueAt('insights2') - 0.2 }],
        camera: [{ state: cam(null) }, { at: at('insights1', 'analise') - 0.4, state: cam(pad(generate, 220), 0.9) },
          { at: cueAt('insights2') - 0.25, state: cam(pad(area, 10), 0.95, 1.3), duration: 0.6 }],
        rings: [{ box: pad(generate, 8), at: at('insights1', 'analise'), until: cueAt('insights2') - 0.25, click: true },
          ...sections.slice(0, 2).map((s, i) => ({ box: pad(s, 6), at: at('insights2', i === 0 ? 'historico' : 'informacao') }))],
      };
    }
    default:
      throw new Error(`No plan for scene ${id}`);
  }
}

// English anchors for the same moves, keyed by the Portuguese word used above.
const EN_WORDS = {
  tenis: 'shoes', planejamento: 'plan', fases: 'phases', rodagem: 'mileage', objetivo: 'goal', data: 'date', dias: 'days', tempo: 'long', meta: 'personal', montar: 'build', revisar: 'review',
  proposta: 'proposal', planilha: 'spreadsheet', calend: 'calendar', arrast: 'drag', direto: 'straight',
  import: 'import', relogio: 'watch', fit: 'fit', esforco: 'effort', analise: 'analysis', historico: 'history',
  informacao: 'detail',
};

// The mixed narration must be written to <dir>/assets/narration.wav afterwards;
// the returned `sounds` are the effects to mix under it.
export function composeProject({ lang, dir, timeline, words, cueText, shots, fontFile, logoFile }) {
  const strings = TOUR_STRINGS[lang];
  mkdirSync(join(dir, 'compositions'), { recursive: true });
  mkdirSync(join(dir, 'assets/shots'), { recursive: true });
  mkdirSync(join(dir, 'assets/fonts'), { recursive: true });
  for (const [id, shot] of Object.entries(shots)) copyFileSync(shot.file, join(dir, 'assets/shots', `${id}.png`));
  copyFileSync(fontFile, join(dir, 'assets/fonts/dm-sans.woff2'));
  copyFileSync(logoFile, join(dir, 'assets/logo-mark.png'));

  const sounds = [];
  const hosts = [];
  for (const [index, scene] of timeline.scenes.entries()) {
    const clock = wordClock(scene, words, cueText);
    const at = (key, word, which) => clock(key, lang === 'en' ? (EN_WORDS[word] ?? word) : word, which);
    const cueAt = (key) => scene.cues.find((c) => c.key === key).start;
    let built;
    if (scene.id === 'intro') built = introScene(scene, at, strings);
    else if (scene.id === 'watch') built = watchScene(scene, at, strings, shots);
    else if (scene.id === 'outro') built = outroScene(scene, at, strings);
    else built = stageScene(scene.id, scene.length, strings.headlines[scene.id], screenPlan(scene.id, at, shots, cueAt));
    writeFileSync(join(dir, 'compositions', `${scene.id}.html`), built.html);
    sounds.push(...built.sounds.map((s) => ({ ...s, time: fix(scene.start + s.time) })));
    // A soft whoosh on every cut, rotating three takes so it never repeats back to back.
    if (index > 0) sounds.push({ time: fix(scene.start + 0.05), sfx: `whoosh${(index % 3) + 1}` });
    hosts.push(`<div id="${scene.id}" data-composition-id="${scene.id}" data-composition-src="compositions/${scene.id}.html" data-start="${fix(scene.start)}" data-duration="${fix(scene.length)}" data-track-index="1" data-track-kind="graphics" data-width="${W}" data-height="${H}"></div>`);
  }
  const duration = fix(timeline.duration);
  writeFileSync(join(dir, 'index.html'), `<!doctype html>
<html lang="${lang === 'pt' ? 'pt-BR' : 'en-US'}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      ${FONT_FACE}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: ${TOKENS.bg}; }
      #root { width: 100%; height: 100%; font-family: 'DM Sans', sans-serif; }
      #ground { position: absolute; inset: 0; background: radial-gradient(1200px 700px at 78% 18%, rgba(111,144,112,0.16), transparent 70%), ${TOKENS.bg}; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${W}" data-height="${H}">
      <div id="ground" class="clip" data-start="0" data-duration="${duration}" data-track-index="0"></div>
      ${hosts.join('\n      ')}
      <audio id="narration" class="clip" src="assets/narration.wav" data-start="0" data-duration="${duration}" data-track-index="9" data-volume="1"></audio>
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`);
  writeFileSync(join(dir, 'hyperframes.json'), JSON.stringify({ $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json', paths: { blocks: 'compositions', assets: 'assets' }, media: { autoProxy: true } }, null, 2));
  return { sounds };
}
