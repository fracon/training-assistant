function focusableElements(dialog) {
  return [...dialog.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')]
    .filter((element) => {
      if (element.disabled || element.hidden || element.getAttribute('tabindex') === '-1') return false;
      return !element.closest('[hidden]') && getComputedStyle(element).display !== 'none';
    });
}

function bodyRootsOutside(dialog) {
  const roots = [];
  for (const element of document.body.children) {
    if (element === dialog || element.contains(dialog)) continue;
    roots.push(element);
  }
  return roots;
}

// Keeps a modal isolated even when a click or script moves focus away from it.
// The body roots are inerted only for the lifetime of this controller activation.
export function createDialogFocusTrap(dialog) {
  let active = false;
  let previousInert = [];

  const focusFirst = () => focusableElements(dialog)[0]?.focus();
  const focusLast = () => focusableElements(dialog).at(-1)?.focus();

  const onFocusIn = (event) => {
    if (active && !dialog.contains(event.target)) focusFirst();
  };

  const onKeydown = (event) => {
    if (!active || event.key !== 'Tab') return;
    const focusable = focusableElements(dialog);
    if (!focusable.length) return;
    if (!dialog.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? focusLast : focusFirst)();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const activate = () => {
    if (active) return;
    previousInert = bodyRootsOutside(dialog).map((element) => ({
      element,
      hadAttribute: element.hasAttribute('inert'),
      value: element.inert,
    }));
    previousInert.forEach(({ element }) => { element.setAttribute('inert', ''); });
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('keydown', onKeydown, true);
    active = true;
  };

  const deactivate = () => {
    if (!active) return;
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('keydown', onKeydown, true);
    previousInert.forEach(({ element, hadAttribute, value }) => {
      if (hadAttribute) element.setAttribute('inert', '');
      else {
        element.removeAttribute('inert');
        element.inert = value;
      }
    });
    previousInert = [];
    active = false;
  };

  return { activate, deactivate, isActive: () => active };
}
