// Static, auditable guidance for creating structured workouts. This catalog
// contains no vendor API calls, credentials, telemetry, or user data.
import { createDialogFocusTrap } from './dialog-focus.js';

export const WORKOUT_CREATION_PLATFORMS = Object.freeze([
  {
    id: 'garmin', name: 'Garmin Connect', compatibility: 'full',
    source: 'https://support.garmin.com/en-CA/?faq=wZ52AaLbLG2GC1Lxu2l4k7&identifier=777730&tab=topics', verifiedAt: '2026-09-22', stepCount: 6,
  },
  {
    id: 'apple', name: 'Apple Watch / iPhone', compatibility: 'full',
    source: 'https://support.apple.com/en-mn/guide/watch/create-a-custom-workout-apd66fcd5c5c/watchos', verifiedAt: '2026-09-22', stepCount: 6,
  },
  {
    id: 'coros', name: 'COROS', compatibility: 'full',
    source: 'https://support.coros.com/hc/en-us/articles/47285577958932-Create-Custom-Workouts-in-Your-COROS-App', verifiedAt: '2026-09-22', stepCount: 6,
  },
  {
    id: 'polar', name: 'Polar Flow', compatibility: 'full',
    source: 'https://support.polar.com/us-en/how_do_i_create_training_targets', verifiedAt: '2026-09-22', stepCount: 6,
  },
  {
    id: 'suunto', name: 'Suunto', compatibility: 'conditional',
    source: 'https://www.suunto.com/Support/faq-articles/suunto-app/how-can-i-create-structured-workouts-with-suunto-app/', verifiedAt: '2026-09-22', stepCount: 6,
  },
  {
    id: 'samsung', name: 'Samsung Health / Galaxy Watch', compatibility: 'conditional',
    source: 'https://www.samsung.com/us/support/answer/ANS10006858/', verifiedAt: '2026-09-22', stepCount: 5,
  },
  {
    id: 'xiaomi', name: 'Xiaomi / Mi Fitness', compatibility: 'model-dependent',
    source: 'https://www.mi.com/global/support/article/KA-108986/', verifiedAt: '2026-09-22', stepCount: 0,
  },
  {
    id: 'huawei', name: 'Huawei Health', compatibility: 'model-dependent',
    source: 'https://consumer.huawei.com/en/support/content/en-us15850729/', verifiedAt: '2026-09-22', stepCount: 5,
  },
]);

const COMPATIBILITIES = new Set(['full', 'conditional', 'model-dependent']);

export function creationPlatformById(id) {
  return WORKOUT_CREATION_PLATFORMS.find((platform) => platform.id === id) ?? WORKOUT_CREATION_PLATFORMS[0];
}

export function normalizeCreationPlatform(platform) {
  if (!platform || !COMPATIBILITIES.has(platform.compatibility)) return creationPlatformById('garmin');
  return platform;
}

export function creationCompatibilityKey(platform) {
  return `session.workoutCreation.compatibility.${normalizeCreationPlatform(platform).compatibility}`;
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function createWorkoutCreationGuidance({ trigger, dialog, translate }) {
  const closeButton = dialog.querySelector('[data-workout-create-close]');
  const platformList = dialog.querySelector('[data-workout-create-platforms]');
  const title = dialog.querySelector('[data-workout-create-title]');
  const description = dialog.querySelector('[data-workout-create-description]');
  const status = dialog.querySelector('[data-workout-create-status]');
  const steps = dialog.querySelector('[data-workout-create-steps]');
  const note = dialog.querySelector('[data-workout-create-note]');
  const sourceLink = dialog.querySelector('[data-workout-create-source]');
  let selectedId = WORKOUT_CREATION_PLATFORMS[0].id;
  let lastFocus = null;
  const focusTrap = createDialogFocusTrap(dialog, () => close());

  const t = (key) => translate(key);
  const render = () => {
    const platform = normalizeCreationPlatform(creationPlatformById(selectedId));
    title.textContent = t(`session.workoutCreation.platforms.${platform.id}.title`);
    description.textContent = t('session.workoutCreation.description');
    platformList.setAttribute('aria-label', t('session.workoutCreation.platformsLabel'));
    status.textContent = t(creationCompatibilityKey(platform));
    status.dataset.compatibility = platform.compatibility;
    steps.replaceChildren();
    if (platform.stepCount === 0) {
      steps.appendChild(makeElement('li', '', t(`session.workoutCreation.platforms.${platform.id}.fallback`)));
    } else {
      for (let index = 1; index <= platform.stepCount; index += 1) {
        steps.appendChild(makeElement('li', '', t(`session.workoutCreation.platforms.${platform.id}.step${index}`)));
      }
    }
    note.textContent = t(`session.workoutCreation.platforms.${platform.id}.note`);
    sourceLink.href = platform.source;
    sourceLink.textContent = t('session.workoutCreation.learnMore');
    sourceLink.setAttribute('aria-label', `${t('session.workoutCreation.learnMore')} (${t('session.workoutCreation.newTab')})`);
    platformList.querySelectorAll('[data-workout-create-platform]').forEach((button) => {
      const active = button.dataset.workoutCreatePlatform === platform.id;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  };
  const close = () => {
    dialog.hidden = true;
    document.body.classList.remove('workout-creation-open');
    focusTrap.deactivate();
    lastFocus?.focus();
  };
  const open = () => {
    lastFocus = document.activeElement;
    render();
    dialog.hidden = false;
    document.body.classList.add('workout-creation-open');
    focusTrap.activate();
    closeButton.focus();
  };
  platformList.querySelectorAll('[data-workout-create-platform]').forEach((button) => button.addEventListener('click', () => {
    selectedId = button.dataset.workoutCreatePlatform;
    render();
  }));
  trigger.addEventListener('click', open);
  closeButton.addEventListener('click', close);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  return { open, close, render, selectedPlatform: () => selectedId };
}
