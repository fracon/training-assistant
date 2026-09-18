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
