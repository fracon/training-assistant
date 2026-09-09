// Static, auditable catalog of manufacturer export guidance. No provider API,
// login, remote content, or user data is involved in this client-only guide.
export const WORKOUT_IMPORT_PROVIDERS = Object.freeze([
  {
    id: 'garmin', name: 'Garmin', compatibility: 'direct',
    formats: ['fit', 'zip-fit'], source: 'https://support.garmin.com/en-US/?faq=W1TvTPW8JZ6LfJSfK512Q8', verifiedAt: '2026-09-09',
    stepCount: 6,
  },
  {
    id: 'coros', name: 'COROS', compatibility: 'direct',
    formats: ['fit'], source: 'https://support.coros.com/hc/en-us/articles/360043975752-Exporting-Workout-Data-and-Uploading-to-3rd-Party-Apps', verifiedAt: '2026-09-09',
    stepCount: 6,
  },
  {
    id: 'polar', name: 'Polar', compatibility: 'direct',
    formats: ['fit', 'zip-fit'], source: 'https://support.polar.com/us-en/export-training-sessions-flow', verifiedAt: '2026-09-09',
    stepCount: 5,
  },
  {
    id: 'amazfit-zepp', name: 'Amazfit/Zepp', compatibility: 'unverified',
    formats: [], source: 'https://support.amazfit.com/en/', verifiedAt: '2026-09-09',
    stepCount: 0,
  },
  {
    id: 'huawei', name: 'Huawei', compatibility: 'unsupported',
    formats: ['gpx'], source: 'https://consumer.huawei.com/pt/support/content/pt-pt15893332/', verifiedAt: '2026-09-09',
    stepCount: 2,
  },
  {
    id: 'apple', name: 'Apple', compatibility: 'unsupported',
    formats: ['xml'], source: 'https://support.apple.com/guide/iphone/share-your-health-data-iph5ede58c3d/26/ios/26', verifiedAt: '2026-09-09',
    stepCount: 3,
  },
  {
    id: 'samsung', name: 'Samsung', compatibility: 'unsupported',
    formats: ['gpx'], source: 'https://www.samsung.com/us/support/answer/ANS10003407/', verifiedAt: '2026-09-09',
    stepCount: 3,
  },
]);

const COMPATIBILITIES = new Set(['direct', 'conditional', 'unsupported', 'unverified']);

export function providerById(id) {
  return WORKOUT_IMPORT_PROVIDERS.find((provider) => provider.id === id) ?? WORKOUT_IMPORT_PROVIDERS[0];
}

export function normalizeProvider(provider) {
  if (!provider || !COMPATIBILITIES.has(provider.compatibility)) return providerById('garmin');
  return provider;
}

export function providerStatusKey(provider) {
  return `session.importHelp.status.${normalizeProvider(provider).compatibility}`;
}

export function providerFormatKeys(provider) {
  return normalizeProvider(provider).formats.map((format) => `session.importHelp.formats.${format}`);
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// Mounts the accessible dialog and returns a small controller used by the page.
export function createImportGuidance({ trigger, dialog, translate, onManual }) {
  const closeButton = dialog.querySelector('[data-import-help-close]');
  const providerList = dialog.querySelector('[data-import-help-providers]');
  const title = dialog.querySelector('[data-import-help-title]');
  const description = dialog.querySelector('[data-import-help-description]');
  const status = dialog.querySelector('[data-import-help-status]');
  const formats = dialog.querySelector('[data-import-help-formats]');
  const steps = dialog.querySelector('[data-import-help-steps]');
  const sourceLink = dialog.querySelector('[data-import-help-source]');
  const manualTitle = dialog.querySelector('[data-import-help-manual-title]');
  const manualDescription = dialog.querySelector('[data-import-help-manual-description]');
  const manualButton = dialog.querySelector('[data-import-help-manual]');
  let selectedId = WORKOUT_IMPORT_PROVIDERS[0].id;
  let lastFocus = null;

  const t = (key) => translate(key);
  const render = () => {
    const provider = normalizeProvider(providerById(selectedId));
    title.textContent = t('session.importHelp.title');
    description.textContent = t('session.importHelp.description');
    status.textContent = t(providerStatusKey(provider));
    status.dataset.compatibility = provider.compatibility;
    formats.textContent = providerFormatKeys(provider).map((key) => t(key)).join(', ') || t('session.importHelp.noCompatibleFormat');
    steps.replaceChildren();
    if (provider.stepCount === 0) {
      const item = makeElement('li', '', t(`session.importHelp.providers.${provider.id}.unverified`));
      steps.appendChild(item);
    } else {
      for (let index = 1; index <= provider.stepCount; index += 1) {
        steps.appendChild(makeElement('li', '', t(`session.importHelp.providers.${provider.id}.step${index}`)));
      }
    }
    sourceLink.href = provider.source;
    sourceLink.textContent = t('session.importHelp.openOfficial');
    sourceLink.setAttribute('aria-label', `${t('session.importHelp.openOfficial')} (${t('session.importHelp.newTab')})`);
    manualTitle.textContent = t('session.importHelp.manualTitle');
    manualDescription.textContent = t('session.importHelp.manualDescription');
    manualButton.textContent = t('session.importHelp.manualAction');
    providerList.querySelectorAll('[data-provider-id]').forEach((button) => {
      const active = button.dataset.providerId === provider.id;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  };
  const close = () => {
    dialog.hidden = true;
    document.body.classList.remove('import-help-open');
    dialog.removeEventListener('keydown', onKeydown);
    lastFocus?.focus();
  };
  const onKeydown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button, a[href]')].filter((element) => {
      if (element.disabled || element.hidden || element.getAttribute('tabindex') === '-1') return false;
      return !element.closest('[hidden]');
    });
    if (focusable.length === 0) return;
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const open = () => {
    lastFocus = document.activeElement;
    render();
    dialog.hidden = false;
    document.body.classList.add('import-help-open');
    dialog.addEventListener('keydown', onKeydown);
    closeButton.focus();
  };
  providerList.querySelectorAll('[data-provider-id]').forEach((button) => button.addEventListener('click', () => {
    selectedId = button.dataset.providerId;
    render();
  }));
  trigger.addEventListener('click', open);
  closeButton.addEventListener('click', close);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  manualButton.addEventListener('click', () => { close(); onManual(); });
  return { open, close, render };
}
