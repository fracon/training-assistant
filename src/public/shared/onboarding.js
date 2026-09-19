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

export function isNewUserOnboarding(state) {
  return state?.status === 'new' || state?.status === 'active';
}

export function shouldShowWelcome(state) {
  return isNewUserOnboarding(state) && state?.status === 'new';
}

export function onboardingSlideNavigation(index, total = ONBOARDING_TOTAL_STEPS) {
  const last = Math.max(0, total - 1);
  const current = Math.max(0, Math.min(Number(index) || 0, last));
  return {
    current,
    previous: Math.max(0, current - 1),
    next: Math.min(last, current + 1),
    isFirst: current === 0,
    isLast: current === last,
  };
}

export function onboardingPlanActions(hasActiveCycle) {
  if (hasActiveCycle) {
    return { primaryHref: '/ai-coach.html', primaryKey: 'aiAction', secondaryHref: '/calendar.html' };
  }
  return { primaryHref: '/cycles.html', primaryKey: 'planCycleAction', secondaryHref: null };
}

export function updateOnboardingDialogA11y(dialog, slide) {
  if (!dialog || !slide) return false;
  const title = slide.querySelector('h2[id]');
  const description = slide.querySelector('[id^="onboardingWelcomeDescription"]');
  if (!title || !description) return false;
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.setAttribute('aria-describedby', description.id);
  return true;
}

export function visibleOnboardingFocusableElements(dialog) {
  return [...(dialog?.querySelectorAll('a, button') ?? [])].filter((element) => {
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

export function createWelcomePreviewSession() {
  let mode = null;
  let slide = 0;
  let suppressAutomaticWelcome = false;
  return {
    get mode() { return mode; },
    get slide() { return slide; },
    openPreview() {
      mode = 'preview';
      slide = 0;
    },
    openAutomatic() {
      mode = 'automatic';
      slide = 0;
    },
    setSlide(index, total) {
      slide = onboardingSlideNavigation(index, total).current;
      return slide;
    },
    ensureAutomatic(onboarding) {
      if (mode === null && !suppressAutomaticWelcome && shouldShowWelcome(onboarding)) {
        mode = 'automatic';
        slide = 0;
      }
      return mode === 'preview' || (mode === 'automatic' && shouldShowWelcome(onboarding));
    },
    close() {
      const closedMode = mode;
      if (mode === 'preview') suppressAutomaticWelcome = true;
      mode = null;
      return { closedMode, mode, slide, suppressAutomaticWelcome };
    },
  };
}

export function onboardingPresentation(state = {}) {
  const progress = calculateOnboardingProgress(state);
  if (!isNewUserOnboarding(state)) {
    return { ...progress, guideOpen: false, guideVisible: false, completionVisible: false, reopenVisible: false };
  }
  const guideOpen = progress.complete ? Boolean(state.guideOpen) : !state.guideHidden;
  return {
    ...progress,
    guideOpen,
    guideVisible: guideOpen,
    completionVisible: progress.complete && !guideOpen,
    reopenVisible: !progress.complete && !guideOpen,
  };
}

export function backgroundInertTargets(elements, modal) {
  return [...(elements ?? [])].filter(
    (element) => element !== modal && !element.hasAttribute('inert')
  );
}
