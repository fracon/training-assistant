import { initShell, getShellI18n } from './shared/shell.js';

const $ = (id) => document.getElementById(id);

const form = $('workoutForm');
const dropzone = $('dropzone');
const dropTitle = $('dropTitle');
const dropSub = $('dropSub');
const fileInput = $('fileInput');
const statusEl = $('status');
const rpeRow = $('rpeRow');
const generateBtn = $('generateBtn');
const metaRow = $('metaRow');
const lapsHead = $('lapsHead');
const lapsBody = $('lapsBody');
const resultsFlow = $('resultsFlow');
const previewEl = $('markdownPreview');
const copyBtn = $('copyBtn');
const copyLabel = $('copyLabel');

const COLUMNS = [
  'Step', 'Lap', 'Time', 'Cumulative', 'Dist (km)', 'Avg Pace', 'Best Pace',
  'Avg HR', 'Max HR', 'Asc (m)', 'Desc (m)', 'Avg Cad', 'Max Cad', 'Stride (m)', 'kcal',
];

const REMEMBERED_FIELDS = ['tenis', 'fonte_fc', 'terreno'];
const STORAGE_KEY = 'training-assistant:prefs';
const COPY_RESET_MS = 1600;
const RPE_MAX = 5;

let selectedRpe = null;
let selectedFile = null;
let lastPayload = null;

const i18n = getShellI18n();

COLUMNS.forEach((title) => {
  const th = document.createElement('th');
  th.textContent = title;
  lapsHead.appendChild(th);
});

for (let value = 1; value <= RPE_MAX; value += 1) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `rpe-btn tone-${value}`;
  btn.textContent = String(value);
  btn.setAttribute('aria-pressed', 'false');
  btn.addEventListener('click', () => {
    selectedRpe = value;
    rpeRow.querySelectorAll('.rpe-btn').forEach((other) => {
      other.classList.toggle('selected', other === btn);
      other.setAttribute('aria-pressed', String(other === btn));
    });
  });
  rpeRow.appendChild(btn);
}

document.querySelectorAll('textarea.auto-grow').forEach((el) => {
  const grow = () => {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  el.addEventListener('input', grow);
});

const setStatus = (message, tone = '') => {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
};

const fmt = (value) => (value === null || value === undefined ? '-' : value);

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '-');

function loadPrefs() {
  let prefs = {};
  try {
    prefs = JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    prefs = {};
  }
  REMEMBERED_FIELDS.forEach((fieldName) => {
    const saved = prefs[fieldName];
    if (typeof saved === 'string' && saved !== '') {
      $(`#${fieldName}`).value = saved;
    }
  });
}

function savePrefs() {
  const prefs = {};
  REMEMBERED_FIELDS.forEach((fieldName) => {
    prefs[fieldName] = $(`#${fieldName}`).value;
  });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable - preferences simply won't persist */
  }
}

function refreshDynamicTexts() {
  document.title = i18n.t('training.title');
  if (lastPayload) {
    renderMeta(lastPayload);
  }
}

const refreshSubmitState = () => {
  generateBtn.disabled = !FormState.isSubmittable({ rpe: selectedRpe, file: selectedFile });
};

const attachFile = (file) => {
  if (!file) return;
  if (!/\.fit$/i.test(file.name)) {
    setStatus(i18n.t('training.errorNotFit'), 'error');
    return;
  }
  selectedFile = file;
  dropzone.classList.add('attached');
  dropTitle.textContent = i18n.t('training.dropReady', { name: file.name });
  dropSub.textContent = i18n.t('training.dropReplace');
  setStatus('');
  refreshSubmitState();
};

const handleFiles = (list) => {
  attachFile(list && list[0]);
};

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => handleFiles(fileInput.files));

['dragenter', 'dragover'].forEach((type) => {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('dragging');
  });
});

['dragleave', 'drop'].forEach((type) => {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
  });
});

dropzone.addEventListener('drop', (event) => handleFiles(event.dataTransfer.files));

function chip(label, value) {
  const span = document.createElement('span');
  span.className = 'chip';
  const strong = document.createElement('b');
  strong.textContent = `${label}:`;
  span.appendChild(strong);
  span.appendChild(document.createTextNode(String(value)));
  return span;
}

function renderMeta(payload) {
  metaRow.innerHTML = '';
  [
    [i18n.t('training.metaSport'), payload.activity.sport ?? '-'],
    [i18n.t('training.metaStart'), fmtDate(payload.activity.startTime)],
    [i18n.t('training.metaEnd'), fmtDate(payload.activity.endTime)],
    [i18n.t('training.metaDuration'), payload.totals?.durationLabel ?? '-'],
    [
      i18n.t('training.metaDistance'),
      payload.totals?.distanceLabel !== undefined ? payload.totals.distanceLabel : '-',
    ],
    [i18n.t('training.metaLaps'), payload.laps.length],
  ].forEach(([label, value]) => metaRow.appendChild(chip(label, value)));
}

function renderLaps(payload) {
  lapsBody.innerHTML = '';
  payload.laps.forEach((lap) => {
    const tr = document.createElement('tr');
    [
      lap.stepType, lap.lap, lap.durationLabel, lap.cumulativeLabel,
      lap.distanceLabel, lap.avgPaceLabel, lap.bestPaceLabel,
      fmt(lap.avgHeartRate), fmt(lap.maxHeartRate),
      fmt(lap.ascentMeters), fmt(lap.descentMeters),
      fmt(lap.avgCadenceSpm), fmt(lap.maxCadenceSpm),
      fmt(lap.strideMeters), fmt(lap.calories),
    ].forEach((cell) => {
      const td = document.createElement('td');
      td.textContent = String(cell);
      tr.appendChild(td);
    });
    const stepTd = tr.firstChild;
    stepTd.innerHTML = '';
    const badge = document.createElement('span');
    badge.className = `badge-${lap.stepType.toLowerCase()}`;
    badge.textContent = lap.stepType;
    stepTd.appendChild(badge);
    lapsBody.appendChild(tr);
  });
}

function render(payload) {
  renderMeta(payload);
  renderLaps(payload);
  resultsFlow.classList.add('visible');
  previewEl.value = payload.markdown;
  copyBtn.classList.add('visible');
}

async function submitWorkout(event) {
  event.preventDefault();
  if (generateBtn.disabled || !selectedFile) return;
  generateBtn.disabled = true;
  generateBtn.textContent = i18n.t('training.generating');
  resultsFlow.classList.remove('visible');
  copyBtn.classList.remove('visible');
  setStatus(i18n.t('training.statusProcessing', { name: selectedFile.name }));
  const formData = new FormData(form);
  formData.append('file', selectedFile, selectedFile.name);
  formData.append('rpe_percebido', selectedRpe === null ? '' : String(selectedRpe));
  try {
    const response = await fetch('/api/fit/parse', { method: 'POST', body: formData });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || i18n.t('training.statusFailed'));
    savePrefs();
    lastPayload = payload;
    render(payload);
    setStatus(i18n.t('training.statusSuccess', { name: payload.fileName }), 'ok');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    generateBtn.textContent = i18n.t('training.generate');
    refreshSubmitState();
  }
}

form.addEventListener('submit', submitWorkout);

let copyResetTimer = null;

copyBtn.addEventListener('click', async () => {
  const text = previewEl.value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
  }
  copyBtn.classList.add('copied');
  copyLabel.textContent = i18n.t('training.copied');
  clearTimeout(copyResetTimer);
  copyResetTimer = setTimeout(() => {
    copyBtn.classList.remove('copied');
    copyLabel.textContent = i18n.t('training.copyPrompt');
  }, COPY_RESET_MS);
});

loadPrefs();
refreshSubmitState();

const user = await initShell({ active: 'training-result' });
if (user) {
  document.addEventListener('app:languagechange', refreshDynamicTexts);
  refreshDynamicTexts();
}
