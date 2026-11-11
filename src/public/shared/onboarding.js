export const ONBOARDING_TOTAL_STEPS = 3;
export const ONBOARDING_STEP_KEYS = ['shoes', 'cycle', 'trainings'];

// The welcome tour is one narrated video per language. Each scene lists the
// locale keys of its narration cues (`home.onboarding.tour.cues.<key>`). The
// same keys drive the build script (speech and WebVTT captions) and the
// transcript rendered in the dialog, so the three never drift apart.
export const TOUR_SCENES = [
  { id: 'intro', cues: ['intro1', 'intro2'] },
  { id: 'shoes', cues: ['shoes1', 'shoes2'] },
  { id: 'cycle', cues: ['cycle1', 'cycle2', 'cycle3'] },
  { id: 'request', cues: ['request1', 'request2', 'request3'] },
  { id: 'calendar', cues: ['calendar1', 'calendar2'] },
  { id: 'watch', cues: ['watch1'] },
  { id: 'result', cues: ['result1', 'result2'] },
  { id: 'insights', cues: ['insights1', 'insights2'] },
  { id: 'outro', cues: ['outro1', 'outro2'] },
];

export const TOUR_MEDIA_LANGUAGES = { 'pt-BR': 'pt', 'en-US': 'en' };

export function tourCueKey(cue) {
  return `home.onboarding.tour.cues.${cue}`;
}

export function tourMediaLanguage(language) {
  return TOUR_MEDIA_LANGUAGES[language] ?? 'en';
}

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

export function shouldShowWelcome(state) {
  return state?.status === 'new';
}

// The tour's single call to action follows the backend-derived progress. The
// workouts step needs an active cycle, so without one it points to cycles.
export function onboardingNextAction(state, hasActiveCycle) {
  const { nextStep } = calculateOnboardingProgress(state ?? {});
  if (nextStep === 'shoes') return { href: '/shoes.html', key: 'home.onboarding.shoesAction' };
  if (nextStep === 'cycle' || (nextStep === 'trainings' && !hasActiveCycle)) {
    return { href: '/cycles.html', key: 'home.onboarding.cycleAction' };
  }
  if (nextStep === 'trainings') return { href: '/ai-coach.html', key: 'home.onboarding.planAction' };
  return null;
}

// Maps a playback position between two language versions of the tour. The
// narration lengths differ, so the position is carried as "scene index plus
// fraction of that scene" rather than as absolute seconds.
export function mapTourTime(fromScenes, toScenes, time) {
  if (!Array.isArray(fromScenes) || !Array.isArray(toScenes) || toScenes.length === 0) return 0;
  const seconds = Number.isFinite(time) && time > 0 ? time : 0;
  let index = fromScenes.findIndex((scene) => seconds < scene.end);
  if (index === -1) index = fromScenes.length - 1;
  const from = fromScenes[index];
  const target = toScenes[Math.min(index, toScenes.length - 1)];
  if (!from || !target) return 0;
  const span = from.end - from.start;
  const fraction = span > 0 ? Math.max(0, Math.min(1, (seconds - from.start) / span)) : 0;
  return target.start + fraction * (target.end - target.start);
}

// Tracks why the tour is open during this page visit. An explicit request from
// the user menu suppresses the automatic opening, so closing an explicitly
// opened tour never reopens it as the automatic welcome.
export function createTourSession() {
  let explicit = false;
  let suppressAutomatic = false;
  let dismissedAutomatic = false;
  return {
    get explicit() { return explicit; },
    requestExplicit() {
      explicit = true;
      suppressAutomatic = true;
    },
    close() {
      explicit = false;
      dismissedAutomatic = true;
    },
    shouldOpen(onboarding) {
      if (explicit) return true;
      return !suppressAutomatic && !dismissedAutomatic && shouldShowWelcome(onboarding);
    },
  };
}

export function consumeSetupGuideSignal(href, replaceUrl) {
  const url = new URL(href);
  if (url.searchParams.get('openSetupGuide') !== '1') return false;
  url.searchParams.delete('openSetupGuide');
  replaceUrl(`${url.pathname}${url.search}${url.hash}`);
  return true;
}
