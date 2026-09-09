// Shared confirmation dialog used by destructive and state-changing actions.
// Keeping the DOM and lifecycle here prevents each page from inventing its own
// modal while still allowing localized, action-specific copy and styling.
export function showConfirm({
  title,
  message,
  icon = 'trash-2',
  confirmText,
  cancelText,
  confirmButtonClass = 'btn-danger',
  onConfirm,
  // Backwards-compatible aliases for existing callers while they migrate.
  confirmLabel = confirmText,
  cancelLabel = cancelText,
} = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';

    const card = document.createElement('div');
    card.className = 'confirm-card';
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'confirmTitle');

    const header = document.createElement('div');
    header.className = 'confirm-header';
    const headerIcon = document.createElement('span');
    headerIcon.className = 'confirm-icon';
    if (icon) {
      const iconEl = document.createElement('i');
      iconEl.setAttribute('data-lucide', icon);
      iconEl.setAttribute('aria-hidden', 'true');
      headerIcon.appendChild(iconEl);
    }
    header.appendChild(headerIcon);

    const titleEl = document.createElement('h3');
    titleEl.className = 'confirm-title';
    titleEl.id = 'confirmTitle';
    titleEl.textContent = title;
    header.appendChild(titleEl);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'confirm-body';
    const msg = document.createElement('p');
    msg.className = 'confirm-message';
    msg.textContent = message;
    body.appendChild(msg);
    card.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = cancelText ?? cancelLabel ?? '';
    cancelBtn.id = 'confirmCancelBtn';
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = `btn ${confirmButtonClass}`;
    confirmBtn.textContent = confirmText ?? confirmLabel ?? '';
    confirmBtn.id = 'confirmOkBtn';
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    card.appendChild(actions);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    if (globalThis.lucide && typeof globalThis.lucide.createIcons === 'function') {
      globalThis.lucide.createIcons({ nodes: [backdrop] });
    }

    function cleanup(result) {
      backdrop.remove();
      resolve(result);
    }

    confirmBtn.addEventListener('click', async () => {
      try {
        if (typeof onConfirm === 'function') await onConfirm();
        cleanup(true);
      } catch {
        cleanup(false);
      }
    }, { once: true });
    cancelBtn.addEventListener('click', () => cleanup(false), { once: true });
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) cleanup(false);
    }, { once: true });
  });
}
