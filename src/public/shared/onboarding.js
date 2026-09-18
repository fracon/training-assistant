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
