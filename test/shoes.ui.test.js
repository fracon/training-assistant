'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const publicDir = join(__dirname, '..', 'src', 'public');

const {
  validateShoeForm,
  buildMileageDisplay,
  buildProgressPercent,
  formatShoePayload,
} = require('../src/public/shoes.js');

const en = JSON.parse(readFileSync(join(publicDir, 'locales', 'en.json'), 'utf8'));
const pt = JSON.parse(readFileSync(join(publicDir, 'locales', 'pt.json'), 'utf8'));

/* ── HTML structure ── */

test('shoes.html wires the shell, lucide and the full page', () => {
  const html = readFileSync(join(publicDir, 'shoes.html'), 'utf8');

  assert.match(html, /shared\/shell\.css/);
  assert.match(html, /shoes\.css/);
  assert.match(html, /unpkg\.com\/lucide@latest/);
  assert.match(html, /shared\/shell\.js" type="module"/);
  assert.match(html, /shoes\.js" type="module"/);
  assert.match(html, /id="appView"/);

  assert.match(
    html,
    /<title data-i18n="shoes\.pageTitle">Shoes • Kinesis<\/title>/,
    'the browser tab title is i18n-bound with the Kinesis suffix'
  );
  assert.match(html, /<h1 data-i18n="shoes\.title">Shoes<\/h1>/);
  assert.match(html, /id="addShoeBtn"/);
  assert.match(html, /data-lucide="plus"/);
  assert.match(html, /id="shoeEmpty"/);
  assert.match(html, /id="shoeList"/);
  assert.match(html, /id="shoeModal"/);
  assert.match(html, /id="shoeForm"/);
  assert.match(html, /id="shoeBrand"/);
  assert.match(html, /id="shoeModel"/);
  assert.match(html, /id="shoeMileage"/);
  assert.match(html, /id="shoeTargetMileage"/);
  assert.match(html, /id="formSaveBtn"/);
  assert.match(html, /id="formCancelBtn"/);
  assert.match(html, /id="modalCloseBtn"/);
  assert.match(html, /id="toast"/);
});

test('shoes.html toast element supports icon and text structure', () => {
  const html = readFileSync(join(publicDir, 'shoes.html'), 'utf8');
  assert.match(html, /id="toast" class="toast" role="status" aria-live="polite"/);
  assert.match(html, /class="toast-icon"/);
  assert.match(html, /data-lucide="check-circle"/);
  assert.match(html, /class="toast-text"/);
});

test('shoes.css toast slides in from the right at the top', () => {
  const theme = readFileSync(join(publicDir, 'shared', 'theme.css'), 'utf8');
  assert.match(theme, /\.toast \{[^}]*top:\s*5rem/);
  assert.match(theme, /\.toast \{[^}]*right:\s*1\.5rem/);
  assert.match(theme, /\.toast \{[^}]*z-index:\s*10000/);
  assert.match(theme, /\.toast\.visible \{[^}]*transform:\s*translateX\(0\)/);
  assert.match(theme, /\.toast-icon svg \{[^}]*width:\s*18px/);
});
test('shoes.html form fields use earthy surface styling from theme.css', () => {
  const theme = readFileSync(join(publicDir, 'shared', 'theme.css'), 'utf8');
  const shoesCss = readFileSync(join(publicDir, 'shoes.css'), 'utf8');

  assert.match(
    theme,
    /input\[type="text"\],[\s\S]*?background:\s*var\(--bg\)/,
    'the shared theme applies earthy bg to text inputs'
  );
  assert.match(
    shoesCss,
    /\.modal-card input\[type="text"\],[\s\S]*?background:\s*var\(--bg\)/,
    'the modal inputs also use earthy bg'
  );
});

test('shoes.html submit button matches the shared primary button contract', () => {
  const html = readFileSync(join(publicDir, 'shoes.html'), 'utf8');
  const theme = readFileSync(join(publicDir, 'shared', 'theme.css'), 'utf8');

  assert.match(html, /type="submit" id="formSaveBtn" class="btn-primary"/);
  assert.match(
    theme,
    /\.btn-primary \{[^}]*display:\s*inline-flex;\s*\n\s*align-items:\s*center;\s*\n\s*justify-content:\s*center;\s*\n\s*gap:\s*0\.5rem/,
    'icon and label share one strict flex centering rule'
  );
});

/* ── CSS patterns ── */

test('shoes.css imports theme.css and follows the Kinesis design tokens', () => {
  const css = readFileSync(join(publicDir, 'shoes.css'), 'utf8');
  assert.match(css, /@import url\('\.\/shared\/theme\.css'\)/);
  assert.match(css, /background:\s*var\(--card\)/);
  assert.match(css, /border:\s*1px solid var\(--line\)/);
  assert.match(css, /border-radius:\s*14px/);
});

test('shoes.css hides the modal with display:none', () => {
  const css = readFileSync(join(publicDir, 'shoes.css'), 'utf8');
  assert.match(css, /\.modal-backdrop\.hidden\s*\{[^}]*display:\s*none/);
});

test('shoes.css styles status badges with correct colors', () => {
  const css = readFileSync(join(publicDir, 'shoes.css'), 'utf8');
  assert.match(css, /\.status-active\s*\{[^}]*color:\s*var\(--ok\)/);
  assert.match(css, /\.status-retired\s*\{[^}]*color:\s*var\(--muted\)/);
});

test('shoes.css uses smooth hover animation on primary buttons via theme.css', () => {
  const theme = readFileSync(join(publicDir, 'shared', 'theme.css'), 'utf8');
  assert.match(
    theme,
    /\.btn-primary \{[^}]*transition:\s*all 0\.2s ease/,
    'the shared primary button contract includes one smooth animation curve'
  );
});

test('shoes.css overrides .btn-danger pill styles for the delete icon button', () => {
  const css = readFileSync(join(publicDir, 'shoes.css'), 'utf8');
  assert.match(css, /\.btn-icon\.btn-danger \{[^}]*padding:\s*0/);
  assert.match(css, /\.btn-icon\.btn-danger \{[^}]*border-radius:\s*8px/);
  assert.match(css, /\.btn-icon\.btn-danger \{[^}]*background:\s*transparent/);
  assert.match(css, /\.btn-icon\.btn-danger:hover \{[^}]*transform:\s*none/);
  assert.match(css, /\.btn-icon\.btn-danger:hover \{[^}]*box-shadow:\s*none/);
});

/* ── validateShoeForm ── */

test('validateShoeForm accepts valid input', () => {
  const errors = validateShoeForm('Nike', 'Pegasus', 100, 500);
  assert.deepEqual(errors, []);
});

test('validateShoeForm accepts empty targetMileage', () => {
  assert.deepEqual(validateShoeForm('Nike', 'Pegasus', 0, null), []);
  assert.deepEqual(validateShoeForm('Nike', 'Pegasus', 0, undefined), []);
});

test('validateShoeForm rejects missing brand', () => {
  const errors = validateShoeForm('', 'Pegasus', 0, null);
  assert.ok(errors.includes('brandRequired'));
});

test('validateShoeForm rejects blank-only brand', () => {
  const errors = validateShoeForm('   ', 'Pegasus', 0, null);
  assert.ok(errors.includes('brandRequired'));
});

test('validateShoeForm rejects missing model', () => {
  const errors = validateShoeForm('Nike', '', 0, null);
  assert.ok(errors.includes('modelRequired'));
});

test('validateShoeForm rejects null mileage', () => {
  const errors = validateShoeForm('Nike', 'Pegasus', null, null);
  assert.ok(errors.includes('mileageInvalid'));
});

test('validateShoeForm rejects non-positive targetMileage', () => {
  const errors = validateShoeForm('Nike', 'Pegasus', 0, 0);
  assert.ok(errors.includes('targetMileageInvalid'));
  const errors2 = validateShoeForm('Nike', 'Pegasus', 0, -100);
  assert.ok(errors2.includes('targetMileageInvalid'));
});

test('validateShoeForm aggregates multiple errors', () => {
  const errors = validateShoeForm('', '', null, 0);
  assert.ok(errors.includes('brandRequired'));
  assert.ok(errors.includes('modelRequired'));
  assert.ok(errors.includes('mileageInvalid'));
  assert.ok(errors.includes('targetMileageInvalid'));
});

/* ── buildMileageDisplay ── */

test('buildMileageDisplay shows plain km when no target', () => {
  const shoe = { mileage: 320, target_mileage: null };
  assert.equal(buildMileageDisplay(shoe, en), '320 km');
});

test('buildMileageDisplay shows progress when target is set', () => {
  const shoe = { mileage: 300, target_mileage: 800 };
  assert.equal(buildMileageDisplay(shoe, en), '300 / 800 km');
  assert.equal(buildMileageDisplay(shoe, pt), '300 / 800 km');
});

test('buildMileageDisplay uses zero for missing mileage', () => {
  const shoe = { mileage: undefined, target_mileage: 500 };
  assert.equal(buildMileageDisplay(shoe, en), '0 / 500 km');
});

/* ── buildProgressPercent ── */

test('buildProgressPercent returns null when no target', () => {
  assert.equal(buildProgressPercent({ mileage: 100, target_mileage: null }), null);
  assert.equal(buildProgressPercent({ mileage: 100, target_mileage: 0 }), null);
});

test('buildProgressPercent calculates percentage correctly', () => {
  const pct = buildProgressPercent({ mileage: 300, target_mileage: 800 });
  assert.equal(pct, 37.5);
});

test('buildProgressPercent caps at 100', () => {
  const pct = buildProgressPercent({ mileage: 900, target_mileage: 800 });
  assert.equal(pct, 100);
});

test('buildProgressPercent handles zero mileage', () => {
  assert.equal(buildProgressPercent({ mileage: 0, target_mileage: 500 }), 0);
});

/* ── formatShoePayload ── */

test('formatShoePayload trims and normalizes input', () => {
  const result = formatShoePayload('  Nike  ', '  Pegasus 41  ', 120, 800);
  assert.deepEqual(result, {
    brand: 'Nike',
    model: 'Pegasus 41',
    mileage: 120,
    target_mileage: 800,
  });
});

test('formatShoePayload defaults mileage to 0 and target to null', () => {
  const result = formatShoePayload('Asics', 'Nimbus', null, undefined);
  assert.deepEqual(result, {
    brand: 'Asics',
    model: 'Nimbus',
    mileage: 0,
    target_mileage: null,
  });
});

/* ── Locale parity ── */

test('locale files expose every shoes string in both languages', () => {
  for (const messages of [en, pt]) {
    assert.equal(typeof messages.shoes.title, 'string');
    assert.equal(typeof messages.shoes.pageTitle, 'string');
    assert.equal(typeof messages.shoes.subtitle, 'string');
    assert.equal(typeof messages.shoes.addNew, 'string');
    assert.equal(typeof messages.shoes.empty, 'string');
    assert.equal(typeof messages.shoes.emptyHint, 'string');
    assert.equal(typeof messages.shoes.brand, 'string');
    assert.equal(typeof messages.shoes.model, 'string');
    assert.equal(typeof messages.shoes.mileage, 'string');
    assert.equal(typeof messages.shoes.targetMileage, 'string');
    assert.equal(typeof messages.shoes.targetMileageHint, 'string');
    assert.equal(typeof messages.shoes.status.active, 'string');
    assert.equal(typeof messages.shoes.status.retired, 'string');
    assert.equal(typeof messages.shoes.progress, 'string');
    assert.equal(typeof messages.shoes.edit, 'string');
    assert.equal(typeof messages.shoes.retire, 'string');
    assert.equal(typeof messages.shoes.reactivate, 'string');
    assert.equal(typeof messages.shoes.delete, 'string');
    assert.equal(typeof messages.shoes.deleteConfirm, 'string');
    assert.equal(typeof messages.shoes.formTitleAdd, 'string');
    assert.equal(typeof messages.shoes.formTitleEdit, 'string');
    assert.equal(typeof messages.shoes.save, 'string');
    assert.equal(typeof messages.shoes.saving, 'string');
    assert.equal(typeof messages.shoes.cancel, 'string');
    assert.equal(typeof messages.shoes.success.add, 'string');
    assert.equal(typeof messages.shoes.success.edit, 'string');
    assert.equal(typeof messages.shoes.success.delete, 'string');
    assert.equal(typeof messages.shoes.errors.brandRequired, 'string');
    assert.equal(typeof messages.shoes.errors.modelRequired, 'string');
    assert.equal(typeof messages.shoes.errors.mileageInvalid, 'string');
    assert.equal(typeof messages.shoes.errors.targetMileageInvalid, 'string');
    assert.equal(typeof messages.shoes.errors.load, 'string');
    assert.equal(typeof messages.shoes.errors.save, 'string');
    assert.equal(typeof messages.shoes.errors.delete, 'string');
    assert.equal(typeof messages.shell.nav.shoes, 'string');
  }

  assert.notEqual(en.shoes.title, pt.shoes.title);
  assert.match(en.shoes.pageTitle, /• Kinesis$/);
  assert.match(pt.shoes.pageTitle, /• Kinesis$/);
  assert.equal(en.shoes.pageTitle, 'Shoes • Kinesis');
  assert.equal(pt.shoes.pageTitle, 'Tênis • Kinesis');
  assert.equal(en.shell.nav.shoes, 'Shoes');
  assert.equal(pt.shell.nav.shoes, 'Tênis');
});

/* ── shoes.js wiring ── */

test('shoes.js wires the shell, language change listener, and i18n attributes', () => {
  const js = readFileSync(join(publicDir, 'shoes.js'), 'utf8');

  assert.match(js, /import.*initShell.*from.*shared\/shell\.js/);
  assert.match(js, /import.*showConfirm.*from.*shared\/shell\.js/);
  assert.match(js, /import.*getShellI18n/);
  assert.match(js, /import.*fetchShoes.*from.*shared\/api\.js/);
  assert.match(js, /import.*createShoe/);
  assert.match(js, /import.*updateShoe/);
  assert.match(js, /import.*deleteShoe/);
  assert.match(js, /initShell\(\{\s*active:\s*'shoes'\s*\}\)/);
  assert.match(js, /addEventListener\('app:languagechange'/);
  assert.match(js, /renderList\(shoes,\s*msgs\)/);
});

test('shoes.js exports the expected pure functions', () => {
  const js = readFileSync(join(publicDir, 'shoes.js'), 'utf8');

  assert.match(js, /export function validateShoeForm/);
  assert.match(js, /export function buildMileageDisplay/);
  assert.match(js, /export function buildProgressPercent/);
  assert.match(js, /export function formatShoePayload/);
  assert.match(js, /export async function initShoesPage/);
});

test('shoes.js modal opens for add and edit with correct titles', () => {
  const js = readFileSync(join(publicDir, 'shoes.js'), 'utf8');

  assert.match(js, /openModal\('add',\s*null/);
  assert.match(js, /openModal\('edit',\s*shoe/);
  assert.match(js, /data-i18n', 'shoes\.formTitleAdd'/);
  assert.match(js, /data-i18n', 'shoes\.formTitleEdit'/);
});

test('shoes.js handles retire, reactivate, and delete actions', () => {
  const js = readFileSync(join(publicDir, 'shoes.js'), 'utf8');

  assert.match(js, /data-action="retire"/);
  assert.match(js, /data-action="reactivate"/);
  assert.match(js, /data-action="delete"/);
  assert.match(js, /data-action="edit"/);
  assert.match(js, /STATUS_ACTIVE = 'active'/);
  assert.match(js, /STATUS_RETIRED = 'retired'/);
  assert.match(js, /data-lucide="trash-2"/);
});

test('shoes.js action handlers use i18n.messages not a stale closure', () => {
  const js = readFileSync(join(publicDir, 'shoes.js'), 'utf8');

  // initShoesPage must not capture a stale messages snapshot
  assert.doesNotMatch(js, /const messages = i18n\.messages/);

  // Event handlers must read i18n.messages at call time
  assert.match(js, /openModal\('add',\s*null,\s*i18n\.messages\)/);
  assert.match(js, /handleSubmit\(shoes,\s*i18n\.messages\)/);
  assert.match(js, /handleAction\(btn\.dataset\.action,\s*btn\.dataset\.id,\s*shoes,\s*i18n\.messages\)/);
  assert.match(js, /renderList\(shoes,\s*i18n\.messages\)/);

  // Language change handler must use a local msgs variable from i18n.messages
  assert.match(js, /const msgs = i18n\.messages/);
});

test('shoes.js translates status badges via dynamic i18n key', () => {
  const js = readFileSync(join(publicDir, 'shoes.js'), 'utf8');
  assert.match(js, /`shoes\.status\.\$\{shoe\.status\}`/);
});

test('shoes.js uses showConfirm for delete action instead of native confirm', () => {
  const js = readFileSync(join(publicDir, 'shoes.js'), 'utf8');
  assert.doesNotMatch(js, /window\.confirm/);
  assert.match(js, /await showConfirm/);
  assert.match(js, /shoes\.deleteConfirm/);
  assert.match(js, /shell\.confirm\.yes/);
  assert.match(js, /shell\.confirm\.no/);
});

test('shoes.js validates the form with validateShoeForm before submit', () => {
  const js = readFileSync(join(publicDir, 'shoes.js'), 'utf8');
  assert.match(js, /validateShoeForm\(brand,\s*model,\s*mileage,\s*targetMileage\)/);
});

test('shoes.js shows form errors using dynamic shoes.errors.* keys', () => {
  const js = readFileSync(join(publicDir, 'shoes.js'), 'utf8');
  assert.match(js, /showFormError\(`shoes\.errors\.\$\{errors\[0\]\}`, messages\)/);
  assert.match(js, /showFormError\('shoes\.errors\.save', messages\)/);
  assert.match(js, /showToast\(messages, 'shoes\.errors\.delete'\)/);
  assert.match(js, /showToast\(i18n\.messages, 'shoes\.errors\.load'\)/);
});

test('shoes.js uses shoes.success.* keys for success toasts', () => {
  const js = readFileSync(join(publicDir, 'shoes.js'), 'utf8');
  assert.match(js, /showToast\(messages, mode === 'add' \? 'shoes\.success\.add' : 'shoes\.success\.edit'\)/);
  assert.match(js, /showToast\(messages, 'shoes\.success\.delete'\)/);
});

test('shoes.js renders toast icon via lucide.createIcons', () => {
  const js = readFileSync(join(publicDir, 'shoes.js'), 'utf8');
  assert.match(js, /lucide\.createIcons\(\{ nodes: \[toast\] \}\)/);
});

test('shoes.js self-invokes initShoesPage when appView exists', () => {
  const js = readFileSync(join(publicDir, 'shoes.js'), 'utf8');
  assert.match(js, /if\s*\(typeof document !== 'undefined' && document\.getElementById\('appView'\)\)/);
  assert.match(js, /initShoesPage\(\)\.catch\(\(\) => window\.location\.replace\('\/login\.html'\)\)/);
});

/* ── API client functions ── */

test('api.js exports the shoes API client functions', () => {
  const js = readFileSync(join(publicDir, 'shared', 'api.js'), 'utf8');

  assert.match(js, /export async function fetchShoes/);
  assert.match(js, /export function createShoe/);
  assert.match(js, /export function updateShoe/);
  assert.match(js, /export function deleteShoe/);
  assert.match(js, /\/api\/shoes/);
});

test('api.js fetchShoes returns empty array on failure', () => {
  const js = readFileSync(join(publicDir, 'shared', 'api.js'), 'utf8');
  const fetchShoesStart = js.indexOf('export async function fetchShoes');
  const fetchShoesBody = js.slice(fetchShoesStart, js.indexOf('\nexport', fetchShoesStart + 1));
  assert.match(fetchShoesBody, /return \[\]/);
});

test('api.js createShoe and updateShoe use requestJson', () => {
  const js = readFileSync(join(publicDir, 'shared', 'api.js'), 'utf8');
  assert.match(js, /export function createShoe\(body\)[\s\S]*?return requestJson\('\/api\/shoes', body\)/);
  assert.match(js, /export function updateShoe\(id, body\)[\s\S]*?return requestJson\(`\/api\/shoes\/\$\{id\}`, body, 'PUT'\)/);
  assert.match(js, /export function deleteShoe\(id\)[\s\S]*?return requestJson\(`\/api\/shoes\/\$\{id\}`, null, 'DELETE'\)/);
});
