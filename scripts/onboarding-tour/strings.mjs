// On-screen copy baked into the tour video. The narration itself lives in the
// application dictionaries (`home.onboarding.tour.cues.*`), which also feed the
// captions and the dialog transcript; these short lines exist only in the
// frames. One short headline per scene, following "one idea per screen".
// `anchor` is the spoken word (start of a word, accents ignored) the scene's
// main move lands on; see compose.mjs.

export const TOUR_STRINGS = {
  pt: {
    tagline: ['Planeje.', 'Registre.', 'Entenda.'],
    taglineAnchors: ['planeja', 'registra', 'entende'],
    headlines: {
      shoes: 'Seus tênis, sua rodagem',
      cycle: 'Um objetivo, uma data',
      request: 'Sua semana, seu plano',
      calendar: 'Tudo no calendário',
      watch: 'Do calendário para o pulso',
      result: 'Registre cada corrida',
      insights: 'Aprenda com seus treinos',
    },
    watch: { workout: 'Rodagem leve', detail: '40 min', status: 'Treino de hoje' },
    outro: { title: 'Tudo pronto', steps: ['Tênis', 'Ciclo', 'Treinos'], closing: 'Bons treinos!' },
  },
  en: {
    tagline: ['Plan.', 'Record.', 'Understand.'],
    taglineAnchors: ['plan', 'record', 'understand'],
    headlines: {
      shoes: 'Your shoes, your mileage',
      cycle: 'One goal, one date',
      request: 'Your week, your plan',
      calendar: 'All in the calendar',
      watch: 'From calendar to wrist',
      result: 'Record every run',
      insights: 'Learn from your training',
    },
    watch: { workout: 'Easy run', detail: '40 min', status: 'Today’s workout' },
    outro: { title: 'You’re all set', steps: ['Shoes', 'Cycle', 'Workouts'], closing: 'Happy running!' },
  },
};
