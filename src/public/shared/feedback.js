import { createDialogFocusTrap } from './dialog-focus.js';
import { sendFeedback } from './api.js';
import { translate } from './i18n.js';

const MAX_DESCRIPTION_LENGTH = 5000;

function icon(name) {
  const element = document.createElement('i');
  element.setAttribute('data-lucide', name);
  element.setAttribute('aria-hidden', 'true');
  return element;
}

function applyTranslations(root, messages) {
  root.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = translate(messages, element.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
    element.placeholder = translate(messages, element.dataset.i18nPlaceholder);
  });
  root.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
    element.setAttribute('aria-label', translate(messages, element.dataset.i18nAriaLabel));
  });
}

function buildModal(messages) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop feedback-modal-backdrop hidden';
  backdrop.id = 'feedbackModal';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-labelledby', 'feedbackTitle');
  backdrop.setAttribute('aria-describedby', 'feedbackDescription');

  const card = document.createElement('div');
  card.className = 'modal-card feedback-modal-card';
  const header = document.createElement('header');
  header.className = 'modal-header';
  const title = document.createElement('h2');
  title.id = 'feedbackTitle';
  title.dataset.i18n = 'globalFeedback.title';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'modal-close';
  close.id = 'feedbackClose';
  close.dataset.i18nAriaLabel = 'globalFeedback.close';
  close.appendChild(icon('x'));
  header.append(title, close);
  card.appendChild(header);

  const intro = document.createElement('p');
  intro.id = 'feedbackDescription';
  intro.className = 'feedback-intro';
  intro.dataset.i18n = 'globalFeedback.intro';
  card.appendChild(intro);

  const form = document.createElement('form');
  form.id = 'feedbackForm';
  form.noValidate = true;
  const typeField = document.createElement('div');
  typeField.className = 'field';
  const typeLabel = document.createElement('label');
  typeLabel.className = 'field-label';
  typeLabel.htmlFor = 'feedbackType';
  typeLabel.dataset.i18n = 'globalFeedback.type';
  const type = document.createElement('select');
  type.id = 'feedbackType';
  type.name = 'type';
  for (const [value, key] of [['bug', 'globalFeedback.types.bug'], ['suggestion', 'globalFeedback.types.suggestion'], ['other', 'globalFeedback.types.other']]) {
    const option = document.createElement('option');
    option.value = value;
    option.dataset.i18n = key;
    type.appendChild(option);
  }
  typeField.append(typeLabel, type);
  form.appendChild(typeField);

  const descriptionField = document.createElement('div');
  descriptionField.className = 'field';
  const descriptionLabel = document.createElement('label');
  descriptionLabel.className = 'field-label';
  descriptionLabel.htmlFor = 'feedbackText';
  descriptionLabel.dataset.i18n = 'globalFeedback.description';
  const textarea = document.createElement('textarea');
  textarea.id = 'feedbackText';
  textarea.name = 'description';
  textarea.rows = 6;
  textarea.maxLength = MAX_DESCRIPTION_LENGTH;
  textarea.required = true;
  textarea.dataset.i18nPlaceholder = 'globalFeedback.descriptionPlaceholder';
  const count = document.createElement('span');
  count.className = 'feedback-count';
  count.id = 'feedbackCount';
  descriptionField.append(descriptionLabel, textarea, count);
  form.appendChild(descriptionField);

  const source = document.createElement('p');
  source.className = 'feedback-source';
  const sourceLabel = document.createElement('span');
  sourceLabel.dataset.i18n = 'globalFeedback.source';
  const sourceValue = document.createElement('code');
  sourceValue.id = 'feedbackSourceValue';
  source.append(sourceLabel, ' ', sourceValue);
  form.appendChild(source);

  const error = document.createElement('div');
  error.className = 'form-error hidden';
  error.id = 'feedbackError';
  error.setAttribute('role', 'alert');
  error.tabIndex = -1;
  form.appendChild(error);

  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn-secondary';
  cancel.id = 'feedbackCancel';
  cancel.dataset.i18n = 'globalFeedback.cancel';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn-primary';
  submit.id = 'feedbackSubmit';
  const submitLabel = document.createElement('span');
  submitLabel.dataset.i18n = 'globalFeedback.submit';
  submit.appendChild(submitLabel);
  actions.append(cancel, submit);
  form.appendChild(actions);
  card.appendChild(form);
  backdrop.appendChild(card);
  applyTranslations(backdrop, messages);
  return backdrop;
}

export function wireFeedback({ getMessages, refreshIcons = () => {}, showSuccess, showError } = {}) {
  const trigger = document.getElementById('feedbackTrigger');
  if (!trigger || trigger.dataset.feedbackWired === 'true') return;
  trigger.dataset.feedbackWired = 'true';
  let modal;
  let trap;
  let previousFocus;
  let sourcePath = '';
  let pending = false;
  let errorKey;

  const messages = () => getMessages();
  const close = () => {
    if (!modal || pending) return;
    modal.classList.add('hidden');
    trap?.deactivate();
    previousFocus?.focus?.();
  };
  const open = () => {
    if (!modal) {
      modal = buildModal(messages());
      document.body.appendChild(modal);
      trap = createDialogFocusTrap(modal, close);
      const form = modal.querySelector('#feedbackForm');
      const text = modal.querySelector('#feedbackText');
      const count = modal.querySelector('#feedbackCount');
      const updateCount = () => { count.textContent = `${text.value.length}/${MAX_DESCRIPTION_LENGTH}`; };
      text.addEventListener('input', updateCount);
      modal.querySelector('#feedbackClose').addEventListener('click', close);
      modal.querySelector('#feedbackCancel').addEventListener('click', close);
      modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (pending) return;
        const activeMessages = messages();
        const description = text.value.trim();
        if (!description) {
          errorKey = 'globalFeedback.required';
          modal.querySelector('#feedbackError').textContent = translate(activeMessages, errorKey);
          modal.querySelector('#feedbackError').classList.remove('hidden');
          modal.querySelector('#feedbackError').focus();
          return;
        }
        pending = true;
        modal.querySelector('#feedbackSubmit').disabled = true;
        modal.querySelector('#feedbackCancel').disabled = true;
        modal.querySelector('#feedbackClose').disabled = true;
        try {
          await sendFeedback({ type: modal.querySelector('#feedbackType').value, description, pathname: sourcePath });
          form.reset();
          updateCount();
          pending = false;
          close();
          showSuccess?.();
        } catch (error) {
          errorKey = 'globalFeedback.sendError';
          modal.querySelector('#feedbackError').textContent = translate(messages(), errorKey);
          modal.querySelector('#feedbackError').classList.remove('hidden');
          modal.querySelector('#feedbackError').focus();
        } finally {
          pending = false;
          modal.querySelector('#feedbackSubmit').disabled = false;
          modal.querySelector('#feedbackCancel').disabled = false;
          modal.querySelector('#feedbackClose').disabled = false;
        }
      });
    }
    sourcePath = window.location.pathname;
    modal.querySelector('#feedbackSourceValue').textContent = sourcePath;
    errorKey = null;
    modal.querySelector('#feedbackError').classList.add('hidden');
    modal.classList.remove('hidden');
    previousFocus = document.activeElement;
    trap.activate();
    modal.querySelector('#feedbackType').focus();
    refreshIcons();
  };

  trigger.addEventListener('click', open);
  document.addEventListener('app:languagechange', () => {
    if (!modal) return;
    applyTranslations(modal, messages());
    if (!modal.querySelector('#feedbackError').classList.contains('hidden')) {
      modal.querySelector('#feedbackError').textContent = translate(messages(), errorKey || 'globalFeedback.sendError');
    }
    refreshIcons();
  });
  trigger._openFeedback = open;
  trigger._feedbackClose = close;
  trigger._feedbackShowError = showError;
}
