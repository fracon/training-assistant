import { initShell, getShellI18n, refreshIcons } from './shared/shell.js';
import { translate } from './shared/i18n.js';
import { fetchShoes, createShoe, updateShoe, deleteShoe } from './shared/api.js';

const STATUS_ACTIVE = 'active';
const STATUS_RETIRED = 'retired';

function t(messages, key) {
  return translate(messages, key);
}

function showToast(messages, messageKey, duration = 2500) {
  const toast = document.getElementById('toast');
  toast.textContent = t(messages, messageKey);
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), duration);
}

function parseMileage(value) {
  const num = Number(value);
  if (Number.isNaN(num) || num < 0) return null;
  return Math.round(num * 10) / 10;
}

function parseTargetMileage(value) {
  if (value === '' || value === null || value === undefined) return null;
  const num = Number(value);
  if (Number.isNaN(num) || num <= 0) return null;
  return Math.round(num * 10) / 10;
}

export function validateShoeForm(brand, model, mileage, targetMileage) {
  const errors = [];
  if (!brand || !brand.trim()) errors.push('brandRequired');
  if (!model || !model.trim()) errors.push('modelRequired');
  if (mileage === null) errors.push('mileageInvalid');
  if (targetMileage !== null && targetMileage <= 0) errors.push('targetMileageInvalid');
  return errors;
}

export function buildMileageDisplay(shoe, messages) {
  if (shoe.target_mileage != null && shoe.target_mileage > 0) {
    return t(messages, 'shoes.progress')
      .replace('{current}', String(shoe.mileage ?? 0))
      .replace('{target}', String(shoe.target_mileage));
  }
  return `${shoe.mileage ?? 0} km`;
}

export function buildProgressPercent(shoe) {
  if (shoe.target_mileage == null || shoe.target_mileage <= 0) return null;
  const pct = ((shoe.mileage ?? 0) / shoe.target_mileage) * 100;
  return Math.min(Math.round(pct * 10) / 10, 100);
}

function renderShoeCard(shoe, messages) {
  const card = document.createElement('div');
  card.className = 'shoe-card';
  card.dataset.shoeId = shoe.id;

  const statusClass = shoe.status === STATUS_ACTIVE ? 'status-active' : 'status-retired';
  const statusLabel = shoe.status === STATUS_ACTIVE ? t(messages, 'shoes.active') : t(messages, 'shoes.retired');

  let progressHtml = '';
  const pct = buildProgressPercent(shoe);
  if (pct !== null) {
    progressHtml = `
      <div class="shoe-progress">
        <div class="shoe-progress-bar">
          <div class="shoe-progress-fill" style="width: ${pct}%"></div>
        </div>
        <span class="shoe-progress-text">${buildMileageDisplay(shoe, messages)}</span>
      </div>`;
  } else {
    progressHtml = `<span class="shoe-mileage-only">${shoe.mileage ?? 0} km</span>`;
  }

  card.innerHTML = `
    <div class="shoe-card-main">
      <div class="shoe-card-info">
        <div class="shoe-card-brand-model">
          <span class="shoe-card-brand">${escapeHtml(shoe.brand)}</span>
          <span class="shoe-card-model">${escapeHtml(shoe.model)}</span>
        </div>
        ${progressHtml}
      </div>
      <span class="shoe-status ${statusClass}">${statusLabel}</span>
    </div>
    <div class="shoe-card-actions">
      <button type="button" class="btn-icon" data-action="edit" data-id="${shoe.id}" aria-label="${t(messages, 'shoes.edit')}">
        <i data-lucide="pencil"></i>
      </button>
      ${shoe.status === STATUS_ACTIVE
        ? `<button type="button" class="btn-icon btn-warn" data-action="retire" data-id="${shoe.id}" aria-label="${t(messages, 'shoes.retire')}">
            <i data-lucide="pause"></i>
          </button>`
        : `<button type="button" class="btn-icon btn-ok" data-action="reactivate" data-id="${shoe.id}" aria-label="${t(messages, 'shoes.reactivate')}">
            <i data-lucide="play"></i>
          </button>`
      }
      <button type="button" class="btn-icon btn-danger" data-action="delete" data-id="${shoe.id}" aria-label="${t(messages, 'shoes.delete')}">
        <i data-lucide="trash-2"></i>
      </button>
    </div>`;

  return card;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderList(shoes, messages) {
  const listEl = document.getElementById('shoeList');
  const emptyEl = document.getElementById('shoeEmpty');
  listEl.innerHTML = '';

  if (shoes.length === 0) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  for (const shoe of shoes) {
    listEl.appendChild(renderShoeCard(shoe, messages));
  }
  refreshIcons();
}

function openModal(mode, shoe, messages) {
  const modal = document.getElementById('shoeModal');
  const titleEl = document.getElementById('modalTitle');
  const form = document.getElementById('shoeForm');
  const saveLabel = document.getElementById('formSaveLabel');
  const errorEl = document.getElementById('formError');

  errorEl.classList.add('hidden');
  errorEl.textContent = '';
  form.dataset.mode = mode;
  form.dataset.shoeId = shoe ? shoe.id : '';

  if (mode === 'edit') {
    titleEl.setAttribute('data-i18n', 'shoes.formTitleEdit');
    titleEl.textContent = t(messages, 'shoes.formTitleEdit');
    saveLabel.setAttribute('data-i18n', 'shoes.save');
    saveLabel.textContent = t(messages, 'shoes.save');
    document.getElementById('shoeBrand').value = shoe.brand ?? '';
    document.getElementById('shoeModel').value = shoe.model ?? '';
    document.getElementById('shoeMileage').value = shoe.mileage ?? 0;
    document.getElementById('shoeTargetMileage').value = shoe.target_mileage ?? '';
  } else {
    titleEl.setAttribute('data-i18n', 'shoes.formTitleAdd');
    titleEl.textContent = t(messages, 'shoes.formTitleAdd');
    saveLabel.setAttribute('data-i18n', 'shoes.save');
    saveLabel.textContent = t(messages, 'shoes.save');
    form.reset();
    document.getElementById('shoeMileage').value = '0';
  }

  modal.classList.remove('hidden');
  document.getElementById('shoeBrand').focus();
}

function closeModal() {
  document.getElementById('shoeModal').classList.add('hidden');
}

function showFormError(messageKey, messages) {
  const errorEl = document.getElementById('formError');
  errorEl.textContent = t(messages, messageKey);
  errorEl.classList.remove('hidden');
}

async function handleSubmit(shoes, messages) {
  const form = document.getElementById('shoeForm');
  const mode = form.dataset.mode;
  const brand = document.getElementById('shoeBrand').value;
  const model = document.getElementById('shoeModel').value;
  const mileage = parseMileage(document.getElementById('shoeMileage').value);
  const targetMileage = parseTargetMileage(document.getElementById('shoeTargetMileage').value);

  const errors = validateShoeForm(brand, model, mileage, targetMileage);
  if (errors.length > 0) {
    showFormError(`shoes.errors.${errors[0]}`, messages);
    return;
  }

  const payload = {
    brand: brand.trim(),
    model: model.trim(),
    mileage,
    target_mileage: targetMileage,
  };

  const saveBtn = document.getElementById('formSaveBtn');
  const saveLabel = document.getElementById('formSaveLabel');
  saveBtn.disabled = true;
  saveLabel.textContent = t(messages, 'shoes.saving');

  try {
    if (mode === 'add') {
      await createShoe(payload);
    } else {
      await updateShoe(form.dataset.shoeId, payload);
    }
    closeModal();
    const updated = await fetchShoes();
    shoes.length = 0;
    shoes.push(...updated);
    renderList(shoes, messages);
    showToast(messages, mode === 'add' ? 'shoes.addNew' : 'shoes.edit');
  } catch {
    showFormError('shoes.errors.save', messages);
  } finally {
    saveBtn.disabled = false;
    saveLabel.textContent = t(messages, 'shoes.save');
  }
}

async function handleAction(action, id, shoes, messages) {
  if (action === 'edit') {
    const shoe = shoes.find((s) => s.id === id);
    if (shoe) openModal('edit', shoe, messages);
    return;
  }

  if (action === 'retire' || action === 'reactivate') {
    const newStatus = action === 'retire' ? STATUS_RETIRED : STATUS_ACTIVE;
    try {
      await updateShoe(id, { status: newStatus });
      const updated = await fetchShoes();
      shoes.length = 0;
      shoes.push(...updated);
      renderList(shoes, messages);
    } catch {
      showToast(messages, 'shoes.errors.save');
    }
    return;
  }

  if (action === 'delete') {
    if (!window.confirm(t(messages, 'shoes.deleteConfirm'))) return;
    try {
      await deleteShoe(id);
      const updated = await fetchShoes();
      shoes.length = 0;
      shoes.push(...updated);
      renderList(shoes, messages);
      showToast(messages, 'shoes.delete');
    } catch {
      showToast(messages, 'shoes.errors.delete');
    }
  }
}

export async function initShoesPage() {
  const user = await initShell({ active: 'shoes' });
  if (!user) return null;

  const i18n = getShellI18n();
  const messages = i18n.messages;
  const shoes = [];

  const addBtn = document.getElementById('addShoeBtn');
  const modalCloseBtn = document.getElementById('modalCloseBtn');
  const formCancelBtn = document.getElementById('formCancelBtn');
  const form = document.getElementById('shoeForm');
  const shoeListEl = document.getElementById('shoeList');

  addBtn.addEventListener('click', () => openModal('add', null, messages));
  modalCloseBtn.addEventListener('click', closeModal);
  formCancelBtn.addEventListener('click', closeModal);

  document.getElementById('shoeModal').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) closeModal();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSubmit(shoes, messages);
  });

  shoeListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    handleAction(btn.dataset.action, btn.dataset.id, shoes, messages);
  });

  document.addEventListener('app:languagechange', () => {
    const updated = i18n.messages;
    document.title = translate(updated, 'shoes.pageTitle');
    renderList(shoes, updated);
  });

  try {
    const fetched = await fetchShoes();
    shoes.push(...fetched);
    renderList(shoes, messages);
  } catch {
    showToast(messages, 'shoes.errors.load');
  }

  return user;
}

export function formatShoePayload(brand, model, mileage, targetMileage) {
  return {
    brand: brand.trim(),
    model: model.trim(),
    mileage: mileage ?? 0,
    target_mileage: targetMileage ?? null,
  };
}

if (typeof document !== 'undefined' && document.getElementById('appView')) {
  initShoesPage().catch(() => window.location.replace('/login.html'));
}
