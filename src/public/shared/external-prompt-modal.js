function element(tag, className, text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function createExternalPromptModal({
  id,
  titleId,
  title,
  closeLabel,
  copyLabel,
  root = null,
  closeButtonId = '',
  closeActionId = '',
  copyButtonId = '',
  outputId = '',
  statusId = '',
}) {
  const dialog = root || document.createElement('div');
  dialog.id = id;
  dialog.className = 'external-prompt-backdrop';
  dialog.hidden = true;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);

  const card = element('section', 'external-prompt-card');
  card.setAttribute('role', 'document');
  const header = element('header', 'external-prompt-header');
  const heading = element('h2', '', title);
  heading.id = titleId;
  const closeButton = element('button', 'modal-close');
  closeButton.type = 'button';
  if (closeButtonId) closeButton.id = closeButtonId;
  closeButton.setAttribute('aria-label', closeLabel);
  const closeIcon = element('i');
  closeIcon.dataset.lucide = 'x';
  closeIcon.setAttribute('aria-hidden', 'true');
  closeButton.append(closeIcon);
  header.append(heading, closeButton);

  const status = element('p', 'external-prompt-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  if (statusId) status.id = statusId;

  const output = element('textarea', 'external-prompt-text');
  output.readOnly = true;
  output.spellcheck = false;
  output.wrap = 'soft';
  output.setAttribute('aria-label', title);
  if (outputId) output.id = outputId;

  const actions = element('footer', 'external-prompt-actions confirm-actions');
  const closeAction = element('button', 'btn btn-secondary', closeLabel);
  closeAction.type = 'button';
  if (closeActionId) closeAction.id = closeActionId;
  const copyAction = element('button', 'btn btn-primary', copyLabel);
  copyAction.type = 'button';
  if (copyButtonId) copyAction.id = copyButtonId;
  actions.append(closeAction, copyAction);

  card.append(header, status, output, actions);
  dialog.replaceChildren(card);
  if (!root) document.body.append(dialog);

  return {
    dialog,
    card,
    heading,
    closeButton,
    status,
    output,
    closeAction,
    copyAction,
    setLabels({ title: nextTitle, close: nextClose, copy: nextCopy }) {
      heading.textContent = nextTitle;
      closeButton.setAttribute('aria-label', nextClose);
      closeAction.textContent = nextClose;
      copyAction.textContent = nextCopy;
      output.setAttribute('aria-label', nextTitle);
    },
    setPrompt(text) {
      const value = String(text ?? '');
      output.textContent = value;
      output.value = value;
      output.scrollTop = 0;
    },
    setStatus(text) {
      status.textContent = String(text ?? '');
    },
  };
}
