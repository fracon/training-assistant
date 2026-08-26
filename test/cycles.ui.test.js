'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const publicDir = join(__dirname, '..', 'src', 'public');

const en = JSON.parse(readFileSync(join(publicDir, 'locales', 'en.json'), 'utf8'));
const pt = JSON.parse(readFileSync(join(publicDir, 'locales', 'pt.json'), 'utf8'));

/* ── HTML structure ── */

test('cycles.html wires the shell, lucide and the full page', () => {
  const html = readFileSync(join(publicDir, 'cycles.html'), 'utf8');

  assert.match(html, /shared\/shell\.css/);
  assert.match(html, /cycles\.css/);
  assert.match(html, /unpkg\.com\/lucide@latest/);
  assert.match(html, /shared\/shell\.js" type="module"/);
  assert.match(html, /cycles\.js" type="module"/);
  assert.match(html, /id="appView"/);

  assert.match(
    html,
    /<title data-i18n="cycles\.pageTitle">Training Cycles • Kinesis<\/title>/,
    'the browser tab title is i18n-bound with the Kinesis suffix'
  );
  assert.match(html, /<h1 data-i18n="cycles\.title">Training Cycles<\/h1>/);
  assert.match(html, /id="addCycleBtn"/);
  assert.match(html, /data-lucide="plus"/);
  assert.match(html, /id="cycleEmpty"/);
  assert.match(html, /id="cycleList"/);
  assert.match(html, /id="cycleModal"/);
  assert.match(html, /id="cycleForm"/);
  assert.match(html, /id="cycleObjective"/);
  assert.match(html, /id="cycleTargetDate"/);
  assert.match(html, /id="cycleDistance"/);
  assert.match(html, /id="cycleRunBefore"/);
  assert.match(html, /id="cycleRunCount"/);
  assert.match(html, /id="cycleStartDate"/);
  assert.match(html, /id="cyclePrimaryGoal"/);
  assert.match(html, /id="cycleSecondaryGoal"/);
  assert.match(html, /id="cycleOtherEvents"/);
  assert.match(html, /id="cycleSaveBtn"/);
  assert.match(html, /id="cycleCancelBtn"/);
  assert.match(html, /id="cycleModalCloseBtn"/);
  assert.match(html, /id="promptModal"/);
  assert.match(html, /id="promptCloseBtn"/);
  assert.match(html, /id="promptCopyBtn"/);
  assert.match(html, /id="promptOutput"/);
  assert.match(html, /id="toast"/);
});

test('cycles.html toast element supports icon and text structure', () => {
  const html = readFileSync(join(publicDir, 'cycles.html'), 'utf8');
  assert.match(html, /id="toast" class="toast" role="status" aria-live="polite"/);
  assert.match(html, /class="toast-icon"/);
  assert.match(html, /data-lucide="check-circle"/);
  assert.match(html, /class="toast-text"/);
});

test('cycles.html has subtitle and empty state', () => {
  const html = readFileSync(join(publicDir, 'cycles.html'), 'utf8');
  assert.match(html, /class="cycles-subtitle" data-i18n="cycles\.subtitle"/);
  assert.match(html, /class="cycles-empty hidden"/);
  assert.match(html, /data-i18n="cycles\.emptyHint"/);
  assert.match(html, /data-lucide="repeat"/);
});

test('cycles.html form fields use data-i18n attributes for labels and placeholders', () => {
  const html = readFileSync(join(publicDir, 'cycles.html'), 'utf8');
  assert.match(html, /data-i18n="cycles\.objective"/);
  assert.match(html, /data-i18n-placeholder="cycles\.objectivePlaceholder"/);
  assert.match(html, /data-i18n="cycles\.targetDate"/);
  assert.match(html, /data-i18n="cycles\.distance"/);
  assert.match(html, /<select id="cycleDistance">/, 'distance field is a select dropdown');
  assert.match(html, /data-i18n="cycles\.runBefore"/);
  assert.match(html, /data-i18n="cycles\.runCount"/);
  assert.match(html, /data-i18n="cycles\.startDate"/);
  assert.match(html, /data-i18n="cycles\.primaryGoal"/);
  assert.match(html, /data-i18n="cycles\.secondaryGoal"/);
  assert.match(html, /data-i18n="cycles\.otherEvents"/);
  assert.match(html, /data-i18n="cycles\.cancelForm"/);
  assert.match(html, /data-i18n="cycles\.saveCycle"/);
});

test('cycles.html distance select has predefined options with i18n keys', () => {
  const html = readFileSync(join(publicDir, 'cycles.html'), 'utf8');
  const distanceBlock = html.slice(
    html.indexOf('id="cycleDistance"'),
    html.indexOf('</select>', html.indexOf('id="cycleDistance"')) + '</select>'.length
  );
  const options = ['1km', '3km', '5km', '10km', '15km', 'half_marathon', 'marathon'];
  for (const value of options) {
    assert.match(distanceBlock, new RegExp(`value="${value}"`), `has option value="${value}"`);
    assert.match(distanceBlock, new RegExp(`data-i18n="cycles\\.distances\\.${value}"`), `option ${value} has i18n key`);
  }
  assert.match(distanceBlock, /<option value="">–<\/option>/, 'empty default option exists');
});

test('cycles.html addCycleBtn is wrapped with a custom tooltip', () => {
  const html = readFileSync(join(publicDir, 'cycles.html'), 'utf8');
  assert.match(html, /class="add-cycle-wrapper"/, 'addCycleBtn has a tooltip wrapper');
  assert.match(html, /<span class="add-cycle-wrapper">\s*<button[^>]*id="addCycleBtn"/, 'wrapper encloses the add button');
  assert.match(html, /<div class="custom-tooltip"><\/div>\s*<\/span>/, 'custom-tooltip div is a sibling inside the wrapper');
  assert.doesNotMatch(html, /id="addCycleBtn"[^>]*title=/, 'addCycleBtn must not have a native title attribute');
});

test('cycles.html modal is at body root level outside main', () => {
  const html = readFileSync(join(publicDir, 'cycles.html'), 'utf8');
  const mainClose = html.indexOf('</main>');
  const modalOpen = html.indexOf('id="cycleModal"');
  assert.ok(modalOpen > mainClose, 'cycleModal sits outside <main>');
  const promptModalOpen = html.indexOf('id="promptModal"');
  assert.ok(promptModalOpen > mainClose, 'promptModal sits outside <main>');
});

/* ── CSS patterns ── */

test('cycles.css imports theme.css and follows the Kinesis design tokens', () => {
  const css = readFileSync(join(publicDir, 'cycles.css'), 'utf8');
  assert.match(css, /@import url\('\.\/shared\/theme\.css'\)/);
  assert.match(css, /background:\s*var\(--card\)/);
  assert.match(css, /border:\s*1px solid var\(--line\)/);
  assert.match(css, /border-radius:\s*14px/);
});

test('cycles.css has subtitle style matching shoes.css pattern', () => {
  const css = readFileSync(join(publicDir, 'cycles.css'), 'utf8');
  assert.match(css, /\.cycles-subtitle \{/);
  assert.match(css, /\.cycles-subtitle \{[^}]*color:\s*var\(--muted\)/);
  assert.match(css, /\.cycles-subtitle \{[^}]*font-size:\s*0\.86rem/);
});

test('cycles.css has empty state styles matching shoes.css pattern', () => {
  const css = readFileSync(join(publicDir, 'cycles.css'), 'utf8');
  assert.match(css, /\.cycles-empty \{/);
  assert.match(css, /\.cycles-empty \{[^}]*text-align:\s*center/);
  assert.match(css, /\.cycles-empty \{[^}]*padding:\s*3rem 1rem/);
  assert.match(css, /\.cycles-empty svg \{/);
  assert.match(css, /\.cycles-empty-hint \{/);
});

test('cycles.css status badges use subtle pill style like shoes', () => {
  const css = readFileSync(join(publicDir, 'cycles.css'), 'utf8');
  assert.match(css, /\.status-active \{[^}]*color:\s*var\(--ok\)/);
  assert.match(css, /\.status-completed \{[^}]*color:\s*var\(--muted\)/);
  assert.match(css, /\.status-cancelled \{[^}]*color:\s*var\(--muted\)/);
  assert.match(css, /\.status-cancelled \{[^}]*text-decoration:\s*line-through/);
});

test('cycles.css card action buttons match shoes btn-icon pattern', () => {
  const css = readFileSync(join(publicDir, 'cycles.css'), 'utf8');
  assert.match(css, /\.btn-icon \{/);
  assert.match(css, /\.btn-icon \{[^}]*width:\s*32px/);
  assert.match(css, /\.btn-icon \{[^}]*border-radius:\s*8px/);
  assert.match(css, /\.btn-icon\.btn-warn:hover \{[^}]*color:\s*var\(--danger\)/);
  assert.match(css, /\.btn-icon\.btn-ok:hover \{[^}]*color:\s*var\(--ok\)/);
});

test('cycles.css prompt modal uses shared modal-backdrop pattern', () => {
  const css = readFileSync(join(publicDir, 'cycles.css'), 'utf8');
  assert.match(css, /\.prompt-modal-card \{/);
  assert.match(css, /\.prompt-output \{/);
  assert.match(css, /\.prompt-output \{[^}]*white-space:\s*pre-wrap/);
  assert.match(css, /\.prompt-output \{[^}]*background:\s*var\(--bg\)/);
  assert.match(css, /\.prompt-modal-actions \{/);
});

test('cycles.css add-cycle-wrapper tooltip shows only when button is disabled AND hovered', () => {
  const css = readFileSync(join(publicDir, 'cycles.css'), 'utf8');
  assert.match(css, /\.add-cycle-wrapper \{/);
  assert.match(css, /\.add-cycle-wrapper \{[^}]*position:\s*relative/);
  assert.match(css, /\.add-cycle-wrapper \{[^}]*display:\s*inline-flex/);
  assert.match(css, /\.add-cycle-wrapper \.custom-tooltip \{/);
  assert.match(css, /\.add-cycle-wrapper \.custom-tooltip \{[^}]*background:\s*var\(--ink\)/, 'tooltip uses dark ink background');
  assert.match(css, /\.add-cycle-wrapper:hover button:disabled \+ \.custom-tooltip \{/);
  assert.match(css, /button:disabled \+ \.custom-tooltip \{[^}]*opacity:\s*1/);
  assert.match(css, /\.add-cycle-wrapper button:disabled \{/);
  assert.match(css, /button:disabled \{[^}]*cursor:\s*not-allowed/, 'disabled button uses not-allowed cursor');
});

test('cycles.css form modal matches shoes.css modal-backdrop structure', () => {
  const css = readFileSync(join(publicDir, 'cycles.css'), 'utf8');
  assert.match(css, /\.modal-backdrop \{/);
  assert.match(css, /\.modal-backdrop \{[^}]*position:\s*fixed/);
  assert.match(css, /\.modal-backdrop \{[^}]*z-index:\s*9999/);
  assert.match(css, /\.modal-backdrop\.hidden \{/);
  assert.match(css, /\.modal-card \{/);
  assert.match(css, /\.modal-card \{[^}]*max-width:\s*440px/);
  assert.match(css, /\.modal-card \{[^}]*border-radius:\s*20px/);
  assert.match(css, /@keyframes modal-rise/);
  assert.match(css, /\.modal-header \{/);
  assert.match(css, /\.modal-header h2 \{/);
  assert.match(css, /\.modal-close \{/);
  assert.match(css, /\.modal-close:hover \{/);
  assert.match(css, /\.modal-card \.field \{/);
  assert.match(css, /\.form-actions \{/);
  assert.match(css, /\.btn-secondary \{/);
  assert.match(css, /\.form-error \{/);
  assert.match(css, /\.form-error\.hidden \{/);
});

test('cycles.html modal structure mirrors shoes.html', () => {
  const html = readFileSync(join(publicDir, 'cycles.html'), 'utf8');
  assert.match(html, /id="cycleModal" class="modal-backdrop hidden"/);
  assert.match(html, /class="modal-card" role="dialog" aria-modal="true"/);
  assert.match(html, /class="modal-header"/);
  assert.match(html, /class="modal-close"/);
  assert.match(html, /class="form-actions"/);
  assert.match(html, /class="btn-secondary"/);
  assert.match(html, /class="form-error hidden"/);
});

/* ── cycles.js wiring ── */

test('cycles.js wires the shell, language change listener, and i18n attributes', () => {
  const js = readFileSync(join(publicDir, 'cycles.js'), 'utf8');

  assert.match(js, /import.*initShell.*from.*shared\/shell\.js/);
  assert.match(js, /import.*showConfirm.*from.*shared\/shell\.js/);
  assert.match(js, /import.*getShellI18n/);
  assert.match(js, /import.*refreshIcons.*from.*shared\/shell\.js/);
  assert.match(js, /import.*translate.*from.*shared\/i18n\.js/);
  assert.match(js, /fetchCycles[\s\S]*?from\s+['"]\.\/shared\/api\.js['"]/);
  assert.match(js, /\bcreateCycle\b/);
  assert.match(js, /\bupdateCycle\b/);
  assert.match(js, /\bdeleteCycle\b/);
  assert.match(js, /\brequestJson\b/);
  assert.match(js, /initShell\(\{\s*active:\s*'cycles'\s*\}\)/);
  assert.match(js, /addEventListener\('app:languagechange'/);
  assert.match(js, /renderList\(cycles,\s*msgs\)/);
});

test('cycles.js exports the expected pure functions', () => {
  const js = readFileSync(join(publicDir, 'cycles.js'), 'utf8');
  assert.match(js, /export async function initCyclesPage/);
});

test('cycles.js modal opens for add and edit with correct titles', () => {
  const js = readFileSync(join(publicDir, 'cycles.js'), 'utf8');

  assert.match(js, /openModal\('add',\s*null/);
  assert.match(js, /openModal\('edit',\s*cycle/);
  assert.match(js, /data-i18n',\s*'cycles\.formTitleAdd'/);
  assert.match(js, /data-i18n',\s*'cycles\.formTitleEdit'/);
});

test('cycles.js handles complete, cancel, and prompt actions', () => {
  const js = readFileSync(join(publicDir, 'cycles.js'), 'utf8');

  assert.match(js, /data-action="edit"/);
  assert.match(js, /data-action="complete"/);
  assert.match(js, /data-action="cancel"/);
  assert.match(js, /data-action="prompt"/);
  assert.match(js, /status:\s*'completed'/);
  assert.match(js, /status:\s*'cancelled'/);
});

test('cycles.js action handlers use i18n.messages not a stale closure', () => {
  const js = readFileSync(join(publicDir, 'cycles.js'), 'utf8');

  assert.doesNotMatch(js, /const messages = i18n\.messages/);

  assert.match(js, /openModal\('add',\s*null,\s*i18n\.messages\)/);
  assert.match(js, /handleSubmit\(cycles,\s*i18n\.messages\)/);
  assert.match(js, /handleAction\(btn\.dataset\.action,\s*btn\.dataset\.id,\s*cycles,\s*i18n\.messages\)/);
  assert.match(js, /renderList\(cycles,\s*i18n\.messages\)/);

  assert.match(js, /const msgs = i18n\.messages/);
});

test('cycles.js uses showConfirm for cancel action instead of native confirm', () => {
  const js = readFileSync(join(publicDir, 'cycles.js'), 'utf8');
  assert.doesNotMatch(js, /window\.confirm/);
  assert.match(js, /await showConfirm/);
  assert.match(js, /cycles\.deleteConfirm/);
  assert.match(js, /shell\.confirm\.yes/);
  assert.match(js, /shell\.confirm\.no/);
});

test('cycles.js validates objective before submit', () => {
  const js = readFileSync(join(publicDir, 'cycles.js'), 'utf8');
  assert.match(js, /!objective/);
  assert.match(js, /showFormError\('cycles\.errors\.objectiveRequired'/);
});

test('cycles.js shows form errors using cycles.errors.* keys', () => {
  const js = readFileSync(join(publicDir, 'cycles.js'), 'utf8');
  assert.match(js, /showFormError\('cycles\.errors\.save',\s*messages\)/);
  assert.match(js, /showToast\(messages,\s*'cycles\.errors\.prompt',\s*2500,\s*'error'\)/);
});

test('cycles.js uses cycles.success.* keys for success toasts', () => {
  const js = readFileSync(join(publicDir, 'cycles.js'), 'utf8');
  assert.match(js, /showToast\(messages,\s*'cycles\.success\.add'\)/);
  assert.match(js, /showToast\(messages,\s*'cycles\.success\.edit'\)/);
  assert.match(js, /showToast\(messages,\s*'cycles\.success\.delete'\)/);
});

test('cycles.js renders toast icon via lucide.createIcons', () => {
  const js = readFileSync(join(publicDir, 'cycles.js'), 'utf8');
  assert.match(js, /lucide\.createIcons\(\{ nodes: \[toast\] \}\)/);
});

test('cycles.js showToast accepts a type parameter and toggles toast-error class', () => {
  const js = readFileSync(join(publicDir, 'cycles.js'), 'utf8');
  assert.match(js, /function showToast\(messages,\s*messageKey,\s*duration = 2500,\s*type = 'success'\)/);
  assert.match(js, /toast\.classList\.toggle\('toast-error',\s*type === 'error'\)/);
  assert.match(js, /type === 'error' \? 'x-circle' : 'check-circle'/);
});

test('theme.css defines toast-error variant with danger border and icon color', () => {
  const theme = readFileSync(join(publicDir, 'shared', 'theme.css'), 'utf8');
  assert.match(theme, /\.toast\.toast-error \{/);
  assert.match(theme, /\.toast\.toast-error \{[^}]*border-left-color:\s*var\(--danger\)/);
  assert.match(theme, /\.toast\.toast-error \.toast-icon \{[^}]*color:\s*var\(--danger\)/);
});

test('cycles.js self-invokes initCyclesPage when appView exists', () => {
  const js = readFileSync(join(publicDir, 'cycles.js'), 'utf8');
  assert.match(js, /if\s*\(typeof document !== 'undefined' && document\.getElementById\('appView'\)\)/);
  assert.match(js, /initCyclesPage\(\)\.catch\(\(\) => window\.location\.replace\('\/login\.html'\)\)/);
});

test('cycles.js handles prompt modal open and copy actions', () => {
  const js = readFileSync(join(publicDir, 'cycles.js'), 'utf8');
  assert.match(js, /showPromptModal/);
  assert.match(js, /hidePromptModal/);
  assert.match(js, /handleCopyPrompt/);
  assert.match(js, /promptCloseBtn/);
  assert.match(js, /promptCopyBtn/);
  assert.match(js, /navigator\.clipboard\.writeText/);
});

test('cycles.js prompt catch logs the error before showing toast', () => {
  const js = readFileSync(join(publicDir, 'cycles.js'), 'utf8');
  assert.match(js, /console\.error\('Prompt generation failed:',\s*error\)/);
});

test('cycles.js prompt request passes lng query parameter from i18n.language', () => {
  const js = readFileSync(join(publicDir, 'cycles.js'), 'utf8');
  assert.match(js, /i18n\.language === 'pt-BR'\) \? 'pt' : 'en'/);
  assert.match(js, /\/api\/cycles\/\$\{id\}\/prompt\?lng=\$\{lng\}/);
});

test('prompts.js exports DISTANCE_TRANSLATIONS and translateDistance', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'prompts.js'), 'utf8');
  assert.match(js, /const DISTANCE_TRANSLATIONS/);
  assert.match(js, /function translateDistance\(lang,\s*distance\)/);
  assert.match(js, /module\.exports.*DISTANCE_TRANSLATIONS/);
  assert.match(js, /module\.exports.*translateDistance/);
});

test('prompts.js buildMacrocyclePrompt uses translateDistance for distance', () => {
  const js = readFileSync(join(__dirname, '..', 'src', 'prompts.js'), 'utf8');
  assert.match(js, /translateDistance\(lang,\s*cycle\.distance\)/);
});

test('cycles.js translates distance keys via translateDistance helper', () => {
  const js = readFileSync(join(publicDir, 'cycles.js'), 'utf8');
  assert.match(js, /function translateDistance\(messages,\s*distance\)/);
  assert.match(js, /cycles\.distances\.\$\{distance\}/);
  assert.match(js, /translated !== key/);
  assert.match(js, /displayDistance/);
});

test('cycles.js checks active cycle and disables add button when active exists', () => {
  const js = readFileSync(join(publicDir, 'cycles.js'), 'utf8');
  assert.match(js, /checkActiveCycle/);
  assert.match(js, /fetchActiveCycle/);
  assert.match(js, /addBtn\.disabled = true/);
  assert.match(js, /cycles\.disabledTooltip/);
  assert.doesNotMatch(js, /addBtn\.title/, 'must not use native title attribute');
  assert.match(js, /\.custom-tooltip/, 'writes tooltip text via custom-tooltip class');
});

/* ── Locale parity ── */

test('locale files expose every cycles string in both languages', () => {
  for (const messages of [en, pt]) {
    assert.equal(typeof messages.cycles.title, 'string');
    assert.equal(typeof messages.cycles.pageTitle, 'string');
    assert.equal(typeof messages.cycles.subtitle, 'string');
    assert.equal(typeof messages.cycles.addCycle, 'string');
    assert.equal(typeof messages.cycles.empty, 'string');
    assert.equal(typeof messages.cycles.emptyHint, 'string');
    assert.equal(typeof messages.cycles.objective, 'string');
    assert.equal(typeof messages.cycles.objectivePlaceholder, 'string');
    assert.equal(typeof messages.cycles.targetDate, 'string');
    assert.equal(typeof messages.cycles.distance, 'string');
    assert.equal(typeof messages.cycles.distancePlaceholder, 'string');
    assert.equal(typeof messages.cycles.runBefore, 'string');
    assert.equal(typeof messages.cycles.runCount, 'string');
    assert.equal(typeof messages.cycles.startDate, 'string');
    assert.equal(typeof messages.cycles.primaryGoal, 'string');
    assert.equal(typeof messages.cycles.secondaryGoal, 'string');
    assert.equal(typeof messages.cycles.otherEvents, 'string');
    assert.equal(typeof messages.cycles.disabledTooltip, 'string');
    assert.equal(typeof messages.cycles.edit, 'string');
    assert.equal(typeof messages.cycles.complete, 'string');
    assert.equal(typeof messages.cycles.cancel, 'string');
    assert.equal(typeof messages.cycles.generatePrompt, 'string');
    assert.equal(typeof messages.cycles.cancelForm, 'string');
    assert.equal(typeof messages.cycles.saveCycle, 'string');
    assert.equal(typeof messages.cycles.formTitleAdd, 'string');
    assert.equal(typeof messages.cycles.formTitleEdit, 'string');
    assert.equal(typeof messages.cycles.saving, 'string');
    assert.equal(typeof messages.cycles.promptTitle, 'string');
    assert.equal(typeof messages.cycles.copyPrompt, 'string');
    assert.equal(typeof messages.cycles.deleteConfirm, 'string');
    assert.equal(typeof messages.cycles.status.active, 'string');
    assert.equal(typeof messages.cycles.status.completed, 'string');
    assert.equal(typeof messages.cycles.status.cancelled, 'string');
    assert.equal(typeof messages.cycles.success.add, 'string');
    assert.equal(typeof messages.cycles.success.edit, 'string');
    assert.equal(typeof messages.cycles.success.delete, 'string');
    assert.equal(typeof messages.cycles.errors.objectiveRequired, 'string');
    assert.equal(typeof messages.cycles.errors.save, 'string');
    assert.equal(typeof messages.cycles.errors.prompt, 'string');
    assert.equal(typeof messages.cycles.distances['1km'], 'string');
    assert.equal(typeof messages.cycles.distances['3km'], 'string');
    assert.equal(typeof messages.cycles.distances['5km'], 'string');
    assert.equal(typeof messages.cycles.distances['10km'], 'string');
    assert.equal(typeof messages.cycles.distances['15km'], 'string');
    assert.equal(typeof messages.cycles.distances.half_marathon, 'string');
    assert.equal(typeof messages.cycles.distances.marathon, 'string');
    assert.equal(typeof messages.shell.nav.cycles, 'string');
    assert.equal(typeof messages.shell.noCycle, 'string');
  }

  assert.notEqual(en.cycles.title, pt.cycles.title);
  assert.match(en.cycles.pageTitle, /• Kinesis$/);
  assert.match(pt.cycles.pageTitle, /• Kinesis$/);
  assert.equal(en.cycles.pageTitle, 'Training Cycles • Kinesis');
  assert.equal(pt.cycles.pageTitle, 'Ciclos de Treino • Kinesis');
  assert.equal(en.shell.nav.cycles, 'Training Cycles');
  assert.equal(pt.shell.nav.cycles, 'Ciclos de Treino');
});

/* ── API client functions ── */

test('api.js exports the cycles API client functions', () => {
  const js = readFileSync(join(publicDir, 'shared', 'api.js'), 'utf8');

  assert.match(js, /export async function fetchCycles/);
  assert.match(js, /export async function fetchActiveCycle/);
  assert.match(js, /export function createCycle/);
  assert.match(js, /export function updateCycle/);
  assert.match(js, /export function deleteCycle/);
  assert.match(js, /\/api\/cycles/);
});

test('api.js fetchCycles returns empty array on failure', () => {
  const js = readFileSync(join(publicDir, 'shared', 'api.js'), 'utf8');
  const fetchCyclesStart = js.indexOf('export async function fetchCycles');
  const fetchCyclesBody = js.slice(fetchCyclesStart, js.indexOf('\nexport', fetchCyclesStart + 1));
  assert.match(fetchCyclesBody, /return \[\]/);
});

test('api.js createCycle and updateCycle use requestJson', () => {
  const js = readFileSync(join(publicDir, 'shared', 'api.js'), 'utf8');
  assert.match(js, /export function createCycle\(body\)[\s\S]*?return requestJson\('\/api\/cycles',\s*body\)/);
  assert.match(js, /export function updateCycle\(id,\s*body\)[\s\S]*?return requestJson\(`\/api\/cycles\/\$\{id\}`,\s*body,\s*'PUT'\)/);
  assert.match(js, /export function deleteCycle\(id\)[\s\S]*?return requestJson\(`\/api\/cycles\/\$\{id\}`,\s*null,\s*'DELETE'\)/);
});

test('api.js requestJson omits body for GET requests', () => {
  const js = readFileSync(join(publicDir, 'shared', 'api.js'), 'utf8');
  assert.match(js, /if\s*\(method !== 'GET'\)/);
  assert.match(js, /options\.body = JSON\.stringify\(body\)/);
});
