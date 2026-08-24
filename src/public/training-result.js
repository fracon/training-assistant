import { initShell, getShellI18n } from './shared/shell.js';
import { translate } from './shared/i18n.js';
import { fetchTraining, saveTrainingFeedback } from './shared/api.js';

// Sessions open contextually via /training-result.html?id=<id>; without an
// id there is nothing to show, so the page bounces back to the calendar.
export function resolveSessionId(search) {
  const raw = new URLSearchParams(search).get('id');
  const id = raw === null ? '' : raw.trim();
  return id === '' ? null : id;
}

export function formatDateLabel(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

export function plannedValue(training, field) {
  const value = training?.[field];
  return value === null || value === undefined || value === '' ? '-' : String(value);
}

// '' / blank -> null (unanswered), integer 1..5 kept, anything else -> NaN.
export function normalizeFeedbackRpe(raw) {
  const trimmed = String(raw ?? '').trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : NaN;
}

const PLANNED_FIELDS = [
  ['tipo', 'plannedTipo'],
  ['treino', 'plannedTreino'],
  ['detalhes', 'plannedDetalhes'],
  ['fc_alvo', 'plannedFcAlvo'],
  ['rpe', 'plannedRpe'],
  ['tenis', 'plannedTenis'],
];

async function initTrainingResult() {
  const statusEl = document.getElementById('status');
  const dateEl = document.getElementById('sessionDate');
  const saveBtn = document.getElementById('saveBtn');
  const rpeInput = document.getElementById('feedbackRpe');
  const notesInput = document.getElementById('feedbackNotas');

  let i18n = null;
  const t = (key) => translate(i18n ? i18n.messages : {}, key);

  const setStatus = (message, tone = '') => {
    statusEl.textContent = message;
    statusEl.dataset.tone = tone;
  };

  const id = resolveSessionId(window.location.search);
  if (!id) {
    window.location.href = '/calendar.html';
    return;
  }

  await initShell();
  i18n = getShellI18n();
  document.title = t('training.title');

  setStatus(t('session.loading'));
  let training;
  try {
    training = await fetchTraining(id);
  } catch {
    setStatus(t('session.errors.load'), 'error');
    return;
  }
  if (!training) {
    setStatus(t('session.errors.notFound'), 'error');
    return;
  }

  dateEl.textContent = formatDateLabel(training.dia);
  for (const [field, elementId] of PLANNED_FIELDS) {
    document.getElementById(elementId).textContent = plannedValue(training, field);
  }
  rpeInput.value = training.feedback_rpe ?? '';
  notesInput.value = training.feedback_notas ?? '';
  setStatus('');

  saveBtn.addEventListener('click', async () => {
    const feedbackRpe = normalizeFeedbackRpe(rpeInput.value);
    if (Number.isNaN(feedbackRpe)) {
      setStatus(t('session.errors.rpe'), 'error');
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = t('session.saving');
    try {
      await saveTrainingFeedback(id, {
        feedbackRpe,
        feedbackNotes: notesInput.value,
      });
      window.location.href = '/calendar.html';
    } catch {
      saveBtn.disabled = false;
      saveBtn.textContent = t('session.save');
      setStatus(t('session.errors.save'), 'error');
    }
  });

  document.addEventListener('app:languagechange', () => {
    document.title = t('training.title');
    if (!saveBtn.disabled) saveBtn.textContent = t('session.save');
  });
}

if (typeof document !== 'undefined' && document.getElementById('appView')) {
  initTrainingResult();
}
