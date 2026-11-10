// Deterministic motion graphic for the Kinesis welcome tour. The build script
// sets window.TOUR = { lang, strings, timeline, logo } and calls init(), then
// renderAt(t) for every frame. Nothing here depends on wall-clock time, so
// each frame is reproducible.

const ICONS = {
  shoe: '<path d="M2 15.5h17.5a2.5 2.5 0 0 0 2.5-2.5c0-1.4-1-2.3-2.8-2.8L14 8.8 11.6 5H8.4L7 7.2 3.2 6.2 2 8.8z"/><path d="M2 15.5V18h20v-2.6"/><path d="M9.5 9.5l1.5-1M11.5 11l1.5-1"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  sparkles: '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4M22 5h-4"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>',
  sheet: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 12h8M8 16h8M12 12v8"/>',
  pointer: '<path d="M4 3l6.5 17 2.3-7.2L20 10.5z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  memory: '<path d="M12 5a3 3 0 1 0-5.99.13 4 4 0 0 0-2.53 5.77 4 4 0 0 0 .55 6.6A4 4 0 1 0 12 18z"/><path d="M12 5a3 3 0 1 1 5.99.13 4 4 0 0 1 2.53 5.77 4 4 0 0 1-.55 6.6A4 4 0 1 1 12 18z"/><path d="M12 5v13"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const prog = (t, start, dur) => clamp((t - start) / dur);
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const back = (x) => { const c1 = 1.5, c3 = c1 + 1; return x <= 0 ? 0 : 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const lerp = (a, b, x) => a + (b - a) * x;

function place(el, { o = 1, x = 0, y = 0, s = 1, r = 0 } = {}) {
  el.style.opacity = String(o);
  el.style.transform = `translate(${x}px, ${y}px) scale(${s}) rotate(${r}deg)`;
}
// Standard "pop in" used by most elements: fade, rise and a little overshoot.
function popIn(el, t, at, { dur = 0.5, dist = 18, scale = 0.92 } = {}) {
  const p = prog(t, at, dur);
  place(el, { o: easeOut(p), y: (1 - easeOut(p)) * dist, s: lerp(scale, 1, back(p)) });
}
function slideIn(el, t, at, { dur = 0.6, dx = 60 } = {}) {
  const p = easeOut(prog(t, at, dur));
  place(el, { o: p, x: (1 - p) * dx });
}
// Brief press feedback for buttons.
function press(el, t, at) {
  const d = t - at;
  const s = d < 0 || d > 0.3 ? 1 : d < 0.1 ? lerp(1, 0.92, d / 0.1) : lerp(0.92, 1, back((d - 0.1) / 0.2));
  el.style.transform = `scale(${s})`;
}

function h(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}
const $ = (root, sel) => root.querySelector(sel);
const $$ = (root, sel) => [...root.querySelectorAll(sel)];

let T; let S; let stage; const scenes = new Map(); let chrome;

function weekdayNames(locale) {
  const monday = Date.UTC(2026, 10, 9);
  return Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' })
    .format(new Date(monday + i * 86400000)).replace('.', ''));
}

function copyBlock(id) {
  const c = S.scenes[id];
  return `<div class="abs copy"><p class="eyebrow"><b>${c.eyebrow}</b><span>${c.nav}</span></p><h1 class="title">${c.title}</h1><div class="underline"></div></div>`;
}

// ---------- Scene builders: each returns { root, draw(lt, beats, scene) } ----------

function buildIntro() {
  const root = h(`<div class="layer">
    <div class="abs" data-logo style="left:540px;top:150px;width:200px;height:200px"><img src="${T.logo}" style="width:200px;height:200px" alt=""></div>
    <div class="abs" data-word style="left:0;right:0;top:372px;text-align:center;font-size:84px;font-weight:700;letter-spacing:0.01em">${[...'Kinesis'].map((ch) => `<span style="display:inline-block">${ch}</span>`).join('')}</div>
    <div class="abs" data-tag style="left:0;right:0;top:484px;text-align:center;font-size:28px;font-weight:500;color:var(--accent-deep)">${S.tagline}</div>
    <div class="abs" data-ring style="left:520px;top:130px;width:240px;height:240px;border-radius:50%;border:3px solid var(--accent)"></div>
  </div>`);
  return {
    root,
    draw(lt, b) {
      const logo = $(root, '[data-logo]');
      const p = prog(lt, b.logo, 0.7);
      place(logo, { o: easeOut(p), s: lerp(0.4, 1, back(p)), r: (1 - easeOut(p)) * -12, y: Math.sin(lt * 1.6) * 3 * p });
      const ring = $(root, '[data-ring]');
      const rp = prog(lt, b.logoShine, 1.1);
      place(ring, { o: (1 - rp) * 0.7 * (rp > 0 ? 1 : 0), s: lerp(0.8, 1.45, easeOut(rp)) });
      $$(root, '[data-word] span').forEach((span, i) => {
        const sp = prog(lt, b.word + i * 0.06, 0.5);
        place(span, { o: easeOut(sp), y: (1 - easeOut(sp)) * 36 });
      });
      popIn($(root, '[data-tag]'), lt, b.tagline, { dist: 14, scale: 1 });
    },
  };
}

function buildShoes() {
  const s = S.shoes;
  const root = h(`<div class="layer">${copyBlock('shoes')}
    <div class="card" data-card style="left:600px;top:170px;width:590px">
      <h3>${icon('shoe')}${S.scenes.shoes.nav}</h3>
      <div class="shoe-row" data-row1>
        <div class="shoe-icon">${icon('shoe')}</div><div class="shoe-name">${s.name1}</div><span class="badge">${s.active}</span>
        <div class="shoe-km" data-km1 style="grid-column:2/4"></div><div class="bar"><i data-bar1></i></div>
      </div>
      <div class="shoe-row" data-row2>
        <div class="shoe-icon">${icon('shoe')}</div><div class="shoe-name">${s.name2}</div><span class="badge warn" data-warn>${s.retire}</span>
        <div class="shoe-km" style="grid-column:2/4">652 / 700 ${s.unit}</div><div class="bar"><i class="warn" style="width:93%"></i></div>
      </div>
    </div></div>`);
  const fmt = new Intl.NumberFormat(S.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return {
    root,
    draw(lt, b) {
      slideIn($(root, '[data-card]'), lt, b.card, { dx: 80 });
      popIn($(root, '[data-row2]'), lt, b.shoe2);
      const f = easeInOut(prog(lt, b.fillStart, b.fillEnd - b.fillStart));
      const km = lerp(372.4, 384.4, f);
      $(root, '[data-km1]').textContent = `${fmt.format(km)} / 700 ${s.unit}`;
      $(root, '[data-bar1]').style.width = `${(km / 700) * 100}%`;
      popIn($(root, '[data-warn]'), lt, b.badge, { dist: 6, scale: 0.6 });
    },
  };
}

function buildCycle() {
  const s = S.cycle;
  const date = new Intl.DateTimeFormat(S.locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2027, 2, 14)));
  const colors = ['#8fae8f', '#6f9070', '#4c6e51', '#c87457'];
  const weeks = [4, 4, 3, 1];
  const root = h(`<div class="layer">${copyBlock('cycle')}
    <div class="card" data-card style="left:600px;top:120px;width:590px">
      <h3>${icon('repeat')}${s.newCycle}</h3>
      <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:16px;margin-top:18px">
        <div><p class="label">${s.nameLabel}</p><div class="field"><span data-typed></span><span class="caret" data-caret></span></div></div>
        <div><p class="label">${s.dateLabel}</p><div class="field" style="gap:10px">${icon('calendar').replace('class="icon"', 'class="icon" style="width:20px;height:20px;color:var(--accent-deep)"')}<span data-date>${date}</span></div></div>
      </div>
      <p data-hint style="margin-top:12px"><span class="badge">${icon('check')}${s.raceOrGoal}</span></p>
      <div style="margin-top:22px"><span class="btn" data-ai>${icon('sparkles')}${s.aiButton}</span></div>
      <div class="phases" data-phases>${s.phases.map((name, i) => `<div class="phase" data-phase style="flex:${weeks[i]};background:${colors[i]}">${name}<small>${weeks[i]} ${s.weeks}</small></div>`).join('')}</div>
    </div></div>`);
  return {
    root,
    draw(lt, b) {
      slideIn($(root, '[data-card]'), lt, b.card, { dx: 80 });
      const chars = [...s.goal];
      const n = Math.round(chars.length * prog(lt, b.typeStart, b.typeEnd - b.typeStart));
      $(root, '[data-typed]').textContent = chars.slice(0, n).join('');
      $(root, '[data-caret]').style.opacity = lt > b.typeEnd + 0.6 ? 0 : (Math.floor(lt * 2.5) % 2 === 0 || (lt > b.typeStart && lt < b.typeEnd) ? 1 : 0.15);
      popIn($(root, '[data-date]'), lt, b.date, { dist: 0, scale: 0.7 });
      popIn($(root, '[data-hint]'), lt, b.goal, { dist: 10 });
      const ai = $(root, '[data-ai]');
      popIn(ai.parentElement, lt, b.goal + 0.4, { dist: 12, scale: 1 });
      press(ai, lt, b.aiPress);
      $$(root, '[data-phase]').forEach((phase, i) => {
        const p = prog(lt, b[`phase${i}`], 0.5);
        phase.style.opacity = String(easeOut(p));
        phase.style.transform = `scaleX(${lerp(0.2, 1, back(p))})`;
      });
    },
  };
}

function buildRequest() {
  const s = S.request;
  const days = weekdayNames(S.locale);
  const onDays = [0, 1, 3, 5, 6];
  const minutes = [45, 50, 40, 45, 90];
  const root = h(`<div class="layer">${copyBlock('request')}
    <div class="card" data-avail style="left:600px;top:88px;width:600px;padding:20px 22px">
      <h3>${icon('calendar')}${s.availability}</h3>
      <div class="days">${days.map((d, i) => `<div class="day" data-day="${i}"><span>${d}</span><small data-day-info></small></div>`).join('')}</div>
    </div>
    <div class="card" data-proposal style="left:600px;top:318px;width:600px;padding:20px 22px">
      <div style="display:flex;justify-content:space-between;align-items:center"><h3>${icon('sparkles')}${s.proposal}</h3><span class="badge" data-weather>${icon('sun')}${s.weather}</span></div>
      ${s.workouts.map((w, i) => `<div class="workout" data-workout="${i}"><span class="wday">${days[[0, 3, 6][i]]}</span><span class="wname">${w}</span><span class="wmeta">${[45, 40, 90][i]} ${s.minutes} · RPE ${[2, 4, 3][i]}</span></div>`).join('')}
      <div style="display:flex;justify-content:flex-end;margin-top:14px"><span class="btn" data-apply><span data-apply-label>${s.apply}</span></span></div>
    </div>
    <div class="abs" data-sheet-target style="left:96px;top:560px"><span class="btn quiet">${icon('sheet')}${s.import}</span></div>
    <div class="abs file-chip" data-sheet style="left:120px;top:470px">${icon('sheet')}${s.sheet}</div>
  </div>`);
  return {
    root,
    draw(lt, b, scene) {
      slideIn($(root, '[data-avail]'), lt, b.card, { dx: 80 });
      $$(root, '[data-day]').forEach((el, i) => {
        const k = onDays.indexOf(i);
        const on = k >= 0 && lt >= b[`day${k}`];
        el.classList.toggle('on', on);
        const info = $(el, '[data-day-info]');
        info.innerHTML = on ? `${s.periods[k]}<br>${minutes[k]} ${s.minutes}` : '';
        if (k >= 0) press(el, lt, b[`day${k}`]);
        info.style.opacity = on ? String(easeOut(prog(lt, b.minutes, 0.4))) : '0';
      });
      slideIn($(root, '[data-proposal]'), lt, b.weather - 0.25, { dx: 80 });
      popIn($(root, '[data-weather]'), lt, b.weather, { dist: 0, scale: 0.7 });
      $$(root, '[data-workout]').forEach((el, i) => slideIn(el, lt, b[`proposal${i}`], { dx: 40, dur: 0.5 }));
      const apply = $(root, '[data-apply]');
      popIn(apply.parentElement, lt, b.proposal2 + 0.2, { dist: 8, scale: 1 });
      press(apply, lt, b.apply);
      const applied = lt >= b.applied;
      apply.style.background = applied ? 'var(--ok)' : '';
      $(root, '[data-apply-label]').innerHTML = applied ? `${icon('check').replace('class="icon"', 'class="icon" style="width:18px;height:18px;margin-right:6px;vertical-align:-3px"')}${s.applied}` : s.apply;
      // Spreadsheet alternative: a file flies in and lands on the import action.
      const target = $(root, '[data-sheet-target]');
      popIn(target, lt, b.sheet - 0.2, { dist: 10, scale: 1 });
      const sheet = $(root, '[data-sheet]');
      const fp = easeInOut(prog(lt, b.sheet, b.sheetDrop - b.sheet));
      const gone = prog(lt, b.sheetDrop, 0.25);
      place(sheet, { o: (lt >= b.sheet ? 1 : 0) * (1 - gone), x: lerp(260, 40, fp), y: lerp(-140, 70, fp), s: lerp(1, 0.6, gone), r: lerp(10, 0, fp) });
      void scene;
    },
  };
}

function buildCalendar() {
  const s = S.calendar;
  const days = weekdayNames(S.locale);
  const cells = Array.from({ length: 14 }, (_, i) => 9 + i);
  const placement = [0, 2, 4, 8, 12];
  const root = h(`<div class="layer">${copyBlock('calendar')}
    <div class="card" data-card style="left:568px;top:150px;width:640px;padding:22px 22px">
      <h3>${icon('calendar')}${S.scenes.calendar.nav}</h3>
      <div class="cal">${days.map((d) => `<div class="head">${d}</div>`).join('')}${cells.map((n) => `<div class="cell">${n}</div>`).join('')}</div>
    </div>
    <div class="abs" data-chips></div>
    <div class="cursor" data-cursor>${icon('pointer')}</div>
  </div>`);
  const chipLayer = $(root, '[data-chips]');
  s.chips.forEach((name, i) => chipLayer.appendChild(h(`<div class="chip" data-chip="${i}" style="position:absolute;right:auto;bottom:auto;width:72px">${name}</div>`)));
  let geometry = null;
  function measure() {
    const all = $$(root, '.cal .cell');
    const rootRect = stage.getBoundingClientRect();
    geometry = all.map((cell) => { const r = cell.getBoundingClientRect(); return { x: r.left - rootRect.left, y: r.top - rootRect.top, w: r.width, h: r.height }; });
  }
  return {
    root,
    draw(lt, b) {
      const card = $(root, '[data-card]');
      slideIn(card, lt, b.card, { dx: 80 });
      if (!geometry) { const prev = card.style.transform; card.style.transform = 'none'; measure(); card.style.transform = prev; }
      const offset = (1 - easeOut(prog(lt, b.card, 0.6))) * 80;
      const cardOpacity = easeOut(prog(lt, b.card, 0.6));
      const dragP = easeInOut(prog(lt, b.grab + 0.15, b.dragEnd - b.grab - 0.15));
      $$(chipLayer, '[data-chip]').forEach((chip, i) => {
        let cellIndex = placement[i];
        const cell = geometry[cellIndex];
        let x = cell.x + 6 + offset; let y = cell.y + 28;
        let lift = 0;
        if (i === 4) {
          const to = geometry[13];
          x = lerp(cell.x, to.x, dragP) + 6 + offset;
          y = lerp(cell.y, to.y, dragP) + 28;
          lift = lt >= b.grab && lt < b.drop ? 1 : prog(lt, b.drop, 0.2) < 1 ? 1 - prog(lt, b.drop, 0.2) : 0;
          if (lt < b.grab) lift = 0;
        }
        chip.style.left = `${x}px`; chip.style.top = `${y}px`; chip.style.width = `${cell.w - 12}px`;
        const p = prog(lt, b[`chip${i}`], 0.45);
        chip.style.opacity = String(easeOut(p) * cardOpacity);
        chip.style.transform = `scale(${lerp(0.6, 1, back(p)) * (1 + lift * 0.08)}) rotate(${lift * -3}deg)`;
        chip.style.boxShadow = lift > 0 ? `0 ${10 * lift}px ${22 * lift}px rgba(60,53,42,${0.22 * lift})` : 'none';
        chip.style.zIndex = i === 4 ? '3' : '1';
      });
      // Cursor glides to the long run, drags it one day later, then leaves.
      const cursor = $(root, '[data-cursor]');
      const from = geometry[12]; const to = geometry[13];
      const approach = easeInOut(prog(lt, b.grab - 0.8, 0.8));
      const leave = easeInOut(prog(lt, b.drop + 0.3, 0.7));
      let cx = lerp(from.x + 150, from.x + from.w / 2, approach); let cy = lerp(from.y + 190, from.y + from.h - 22, approach);
      if (lt >= b.grab) { cx = lerp(from.x, to.x, dragP) + from.w / 2; cy = lerp(from.y, to.y, dragP) + from.h - 22; }
      cx += leave * 90 + offset; cy += leave * 120;
      cursor.style.left = `${cx}px`; cursor.style.top = `${cy}px`;
      cursor.style.opacity = String(Math.min(approach * 1.4, 1) * (1 - leave));
      press(cursor, lt, b.grab);
    },
  };
}

function buildResult() {
  const s = S.result;
  const colors = ['#8fae8f', '#6f9070', '#4c6e51', '#c87457', '#a5492f'];
  const root = h(`<div class="layer">${copyBlock('result')}
    <div class="card" data-card style="left:600px;top:110px;width:590px">
      <h3>${icon('activity')}${s.runName}<span class="badge" data-done style="margin-left:auto">${icon('check')}${s.done}</span></h3>
      <div class="dropzone" data-zone>${icon('upload')}<span>${s.dropzone}</span><small style="font-size:14px;font-weight:500">${s.manual}</small></div>
      <div class="stats" data-stats>
        <div class="stat"><span>${s.distance}</span><b data-dist></b></div>
        <div class="stat"><span>${s.time}</span><b data-time></b></div>
        <div class="stat"><span>${s.pace}</span><b data-pace></b></div>
      </div>
      <div data-rpe style="margin-top:20px"><p class="label">${s.effort}</p><div class="rpe">${[1, 2, 3, 4, 5].map((n) => `<i data-rpe-option="${n}">${n}</i>`).join('')}</div></div>
    </div>
    <div class="abs file-chip" data-file style="left:780px;top:200px">${icon('file')}${s.file}</div>
  </div>`);
  const fmt = new Intl.NumberFormat(S.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    root,
    draw(lt, b) {
      slideIn($(root, '[data-card]'), lt, b.card, { dx: 80 });
      const file = $(root, '[data-file]');
      const fp = easeInOut(prog(lt, b.file, b.fileDrop - b.file));
      const absorbed = prog(lt, b.fileDrop, 0.3);
      place(file, { o: (lt >= b.file ? 1 : 0) * (1 - absorbed), x: lerp(260, 0, fp), y: lerp(-160, 0, fp), s: lerp(1.05, 0.7, absorbed), r: lerp(14, 0, fp) });
      const zone = $(root, '[data-zone]');
      zone.style.borderColor = lt > b.file + 0.3 && lt < b.fileDrop + 0.2 ? 'var(--accent)' : '';
      const collapse = easeInOut(prog(lt, b.fileDrop + 0.1, 0.4));
      zone.style.height = `${lerp(150, 0, collapse)}px`;
      zone.style.opacity = String(1 - collapse);
      zone.style.marginTop = `${lerp(16, 0, collapse)}px`;
      zone.style.borderWidth = collapse >= 1 ? '0' : '2px';
      const stats = $(root, '[data-stats]');
      popIn(stats, lt, b.statsStart - 0.15, { dist: 12, scale: 1 });
      const sp = easeOut(prog(lt, b.statsStart, b.statsEnd - b.statsStart));
      $(root, '[data-dist]').textContent = `${fmt.format(8.02 * sp)} km`;
      const secs = Math.round(2535 * sp);
      $(root, '[data-time]').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      const pace = Math.round(lerp(420, 316, sp));
      $(root, '[data-pace]').textContent = `${Math.floor(pace / 60)}:${String(pace % 60).padStart(2, '0')}${s.paceUnit}`;
      const rpe = $(root, '[data-rpe]');
      popIn(rpe, lt, b.rpe, { dist: 12, scale: 1 });
      $$(root, '[data-rpe-option]').forEach((el, i) => {
        const on = i === 2 && lt >= b.rpePick;
        el.style.background = on ? colors[i] : '#fff';
        el.style.borderColor = on ? colors[i] : 'var(--line-strong)';
        el.style.color = on ? '#fbfaf5' : 'var(--ink)';
        const p = prog(lt, b.rpe + i * 0.08, 0.4);
        el.style.opacity = String(easeOut(p));
        el.style.transform = `scale(${lerp(0.6, 1, back(p)) * (on ? 1 + 0.12 * (1 - prog(lt, b.rpePick, 0.4)) : 1)})`;
      });
      popIn($(root, '[data-done]'), lt, b.done, { dist: 0, scale: 0.5 });
    },
  };
}

function buildInsights() {
  const s = S.insights;
  const root = h(`<div class="layer">${copyBlock('insights')}
    <div class="card" data-analysis style="left:600px;top:96px;width:590px;padding:20px 24px">
      <div style="display:flex;justify-content:space-between;align-items:center"><h3>${icon('sparkles')}${s.analysis}</h3><span class="btn" data-analyze style="font-size:15px;padding:9px 16px">${icon('activity')}${s.analysisButton}</span></div>
      ${s.lines.map((line, i) => `<div class="line-item" data-line="${i}">${icon('check')}<span>${line}</span></div>`).join('')}
    </div>
    <div class="card" data-memory style="left:600px;top:372px;width:590px;padding:20px 24px">
      <h3>${icon('memory')}${s.memory}</h3>
      <div data-sources>${s.sources.map((src, i) => `<span class="source" data-source="${i}">${src}</span>`).join('')}</div>
    </div>
  </div>`);
  return {
    root,
    draw(lt, b) {
      slideIn($(root, '[data-analysis]'), lt, b.card, { dx: 80 });
      press($(root, '[data-analyze]'), lt, b.analysisPress);
      $$(root, '[data-line]').forEach((el, i) => {
        const p = easeOut(prog(lt, b[`line${i}`], 0.6));
        el.style.opacity = String(p);
        el.style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`;
      });
      slideIn($(root, '[data-memory]'), lt, b.memory, { dx: 80 });
      $$(root, '[data-source]').forEach((el, i) => popIn(el, lt, b[`source${i}`], { dist: 8, scale: 0.7 }));
    },
  };
}

function buildOutro() {
  const s = S.outro;
  const glyphs = ['shoe', 'repeat', 'calendar'];
  const root = h(`<div class="layer">
    <div class="abs" data-steps style="left:0;right:0;top:150px;display:flex;justify-content:center;gap:90px">
      ${s.steps.map((name, i) => `<div data-step="${i}" style="display:flex;flex-direction:column;align-items:center;gap:16px"><div class="step-ring">${icon(glyphs[i])}<span class="step-check" data-check>${icon('check')}</span></div><b style="font-size:22px">${name}</b></div>`).join('')}
    </div>
    <div class="abs" data-final style="left:0;right:0;top:420px;display:flex;flex-direction:column;align-items:center;gap:14px">
      <div style="display:flex;align-items:center;gap:18px"><img src="${T.logo}" style="width:84px;height:84px" alt=""><span style="font-size:64px;font-weight:700">Kinesis</span></div>
      <span style="font-size:26px;font-weight:500;color:var(--accent-deep)">${S.tagline}</span>
    </div>
  </div>`);
  return {
    root,
    draw(lt, b) {
      $$(root, '[data-step]').forEach((el, i) => {
        popIn(el, lt, 0.05 + i * 0.12, { dist: 20 });
        const ring = $(el, '.step-ring');
        const on = lt >= b[`check${i}`];
        ring.style.borderColor = on ? 'var(--accent-deep)' : 'var(--line-strong)';
        popIn($(el, '[data-check]'), lt, b[`check${i}`], { dist: 0, scale: 0.3, dur: 0.45 });
      });
      popIn($(root, '[data-final]'), lt, b.logo, { dist: 26, scale: 0.96, dur: 0.7 });
    },
  };
}

const BUILDERS = { intro: buildIntro, shoes: buildShoes, cycle: buildCycle, request: buildRequest, calendar: buildCalendar, result: buildResult, insights: buildInsights, outro: buildOutro };

function buildChrome() {
  const route = 'M -40 668 C 160 600, 300 716, 470 646 S 760 580, 900 640 S 1160 712, 1330 600';
  const root = h(`<div class="layer">
    <div id="bg-blob1"></div><div id="bg-blob2"></div>
    <svg id="route" viewBox="0 0 1280 720"><path d="${route}"/><path class="drawn" d="${route}"/><circle r="9" fill="#c87457"/></svg>
    <div class="abs" id="brand"><img src="${T.logo}" alt=""><span>Kinesis</span></div>
    <div class="abs" id="progress">${Array.from({ length: 6 }, () => '<span><i></i></span>').join('')}</div>
  </div>`);
  stage.appendChild(root);
  const drawn = $(root, '.drawn');
  const length = drawn.getTotalLength();
  drawn.style.strokeDasharray = `${length}`;
  return { root, drawn, length, dot: $(root, 'circle') };
}

export function init() {
  T = window.TOUR; S = T.strings; stage = document.getElementById('stage');
  document.documentElement.lang = S.locale;
  chrome = buildChrome();
  for (const scene of T.timeline.scenes) {
    const built = BUILDERS[scene.id]();
    stage.appendChild(built.root);
    scenes.set(scene.id, { ...built, scene });
  }
}

export function renderAt(t) {
  const { timeline } = T;
  const total = timeline.duration;
  // Background drift and the route that runs through the whole tour.
  place(document.getElementById('bg-blob1'), { x: 760 + Math.sin(t * 0.25) * 60, y: -160 + Math.cos(t * 0.2) * 40 });
  place(document.getElementById('bg-blob2'), { x: -120 + Math.cos(t * 0.22) * 50, y: 380 + Math.sin(t * 0.3) * 40 });
  const routeP = easeInOut(clamp(t / (total - 1.5)));
  chrome.drawn.style.strokeDashoffset = String(chrome.length * (1 - routeP));
  const point = chrome.drawn.getPointAtLength(chrome.length * routeP);
  chrome.dot.setAttribute('cx', point.x); chrome.dot.setAttribute('cy', point.y);
  chrome.dot.style.opacity = t > 0.3 ? '1' : '0';

  const first = timeline.scenes[0]; const last = timeline.scenes[timeline.scenes.length - 1];
  const brandIn = easeOut(prog(t, first.end - 0.2, 0.6)) * (1 - easeOut(prog(t, last.start - 0.3, 0.5)));
  place(document.getElementById('brand'), { o: brandIn, y: (1 - brandIn) * -10 });
  const middle = timeline.scenes.slice(1, -1);
  const progress = document.getElementById('progress');
  progress.style.opacity = String(brandIn);
  $$(progress, 'i').forEach((bar, i) => {
    const sc = middle[i];
    bar.style.width = `${clamp((t - sc.start) / sc.length) * 100}%`;
  });

  for (const [index, scene] of timeline.scenes.entries()) {
    const entry = scenes.get(scene.id);
    const lt = t - scene.start;
    const visible = lt > -0.05 && lt < scene.length + 0.6;
    entry.root.style.display = visible ? 'block' : 'none';
    if (!visible) continue;
    const enter = index === 0 ? 1 : easeOut(prog(lt, 0, 0.55));
    const isLast = index === timeline.scenes.length - 1;
    const exit = isLast ? 0 : easeInOut(prog(lt, scene.length - 0.45, 0.45));
    place(entry.root, { o: enter * (1 - exit), y: exit * -24 });
    const copy = $(entry.root, '.copy');
    if (copy) {
      popIn($(copy, '.eyebrow'), lt, 0.05, { dist: 16, scale: 1 });
      popIn($(copy, '.title'), lt, 0.15, { dist: 26, scale: 1 });
      const u = $(copy, '.underline');
      const up = easeOut(prog(lt, 0.45, 0.6));
      u.style.opacity = String(up); u.style.transform = `scaleX(${up})`;
    }
    entry.draw(lt, scene.beats, scene);
  }
}

window.init = init;
window.renderAt = renderAt;
window.tourReady = true;
