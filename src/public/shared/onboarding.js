export const ONBOARDING_TOTAL_STEPS = 3;
export const ONBOARDING_STEP_KEYS = ['shoes', 'cycle', 'trainings'];

export function calculateOnboardingProgress(state = {}) {
  const source = state.steps ?? state;
  const steps = {
    shoes: Boolean(source.shoes),
    cycle: Boolean(source.cycle),
    trainings: Boolean(source.trainings),
  };
  const completed = ONBOARDING_STEP_KEYS.filter((key) => steps[key]).length;
  return {
    steps,
    completed,
    total: ONBOARDING_TOTAL_STEPS,
    complete: completed === ONBOARDING_TOTAL_STEPS,
    nextStep: ONBOARDING_STEP_KEYS.find((key) => !steps[key]) ?? null,
  };
}

export function renderOnboardingStepStates(root, steps = {}, nextStep = null) {
  const cards = root?.querySelectorAll?.('[data-onboarding-step]');
  if (!cards) return 0;
  cards.forEach((card) => {
    const key = card.dataset.onboardingStep;
    const complete = Boolean(steps[key]);
    const next = !complete && key === nextStep;
    const completedBadge = card.querySelector('[data-onboarding-complete]');
    const nextBadge = card.querySelector('[data-onboarding-next]');
    const actions = card.querySelector('[data-onboarding-actions]');
    card.classList.toggle('is-complete', complete);
    card.setAttribute('aria-current', next ? 'step' : 'false');
    if (completedBadge) {
      completedBadge.hidden = !complete;
      if (complete && completedBadge.id) card.setAttribute('aria-describedby', completedBadge.id);
      else card.removeAttribute('aria-describedby');
    }
    if (nextBadge) nextBadge.hidden = !next;
    if (actions) actions.hidden = complete;
  });
  return cards.length;
}

export function shouldShowWelcome(state) {
  return state?.status === 'new' && !calculateOnboardingProgress(state).complete;
}

export function updateOnboardingDialogA11y(dialog, content) {
  if (!dialog || !content) return false;
  const title = content.querySelector('h2[id]');
  const description = content.querySelector('[data-onboarding-description][id]');
  if (!title || !description) return false;
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.setAttribute('aria-describedby', description.id);
  return true;
}

export function visibleOnboardingFocusableElements(dialog) {
  return [...(dialog?.querySelectorAll('a, button, video[controls]') ?? [])].filter((element) => {
    return !element.disabled && !element.closest('[hidden]');
  });
}

export function trapOnboardingFocus(event, dialog, activeTitle) {
  if (event.key !== 'Tab') return false;
  const focusables = visibleOnboardingFocusableElements(dialog);
  if (focusables.length === 0) return false;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === activeTitle)) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (active === last || active === activeTitle)) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

export function createWelcomeSession() {
  let suppressAutomaticWelcome = false;
  return {
    suppressAutomatic() {
      suppressAutomaticWelcome = true;
    },
    ensureAutomatic(onboarding) {
      return !suppressAutomaticWelcome && shouldShowWelcome(onboarding);
    },
  };
}

export function onboardingPresentation(state = {}, explicitlyOpen = false) {
  const progress = calculateOnboardingProgress(state);
  const hasKnownStatus = ['new', 'active'].includes(state?.status);
  const automaticallyVisible = hasKnownStatus && !progress.complete && !state.guideHidden;
  return {
    ...progress,
    guideVisible: hasKnownStatus && (explicitlyOpen || automaticallyVisible),
  };
}

export function consumeSetupGuideSignal(href, replaceUrl) {
  const url = new URL(href);
  if (url.searchParams.get('openSetupGuide') !== '1') return false;
  url.searchParams.delete('openSetupGuide');
  replaceUrl(`${url.pathname}${url.search}${url.hash}`);
  return true;
}

export function backgroundInertTargets(elements, modal) {
  return [...(elements ?? [])].filter(
    (element) => element !== modal && !element.hasAttribute('inert')
  );
}
