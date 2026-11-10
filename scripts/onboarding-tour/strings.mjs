// On-screen copy rendered into the tour frames. Only the narration lives in
// the application dictionaries (it is reused by the dialog transcript); these
// labels exist solely inside the video and are baked into each language file.
// Navigation names mirror `shell.nav.*` so the video matches the real menu.

export const TOUR_STRINGS = {
  pt: {
    locale: 'pt-BR',
    tagline: 'Planeje. Registre. Entenda.',
    scenes: {
      shoes: { eyebrow: '01', nav: 'Rotação de Tênis', title: 'Seus tênis, sua rodagem' },
      cycle: { eyebrow: '02', nav: 'Ciclos de Treino', title: 'Um objetivo, uma data' },
      request: { eyebrow: '03', nav: 'Solicitar Treinos', title: 'Sua semana, seu plano' },
      calendar: { eyebrow: '04', nav: 'Treinos', title: 'Tudo no calendário' },
      result: { eyebrow: '05', nav: 'Resultado do treino', title: 'Registre cada corrida' },
      insights: { eyebrow: '06', nav: 'Memória de treino', title: 'Aprenda com seus treinos' },
    },
    shoes: { name1: 'Pegasus 41', name2: 'Novablast 5', active: 'Ativo', retire: 'Perto de aposentar', unit: 'km', of: 'de' },
    cycle: {
      newCycle: 'Novo ciclo', nameLabel: 'Objetivo', goal: 'Correr 10 km', dateLabel: 'Data-alvo',
      raceOrGoal: 'Prova ou meta pessoal', aiButton: 'Gerar planejamento',
      phases: ['Base', 'Construção', 'Pico', 'Polimento'], weeks: 'sem.',
    },
    request: {
      availability: 'Disponibilidade', minutes: 'min', periods: ['até 8h', '8–12h', '18h+', '8–12h', 'até 8h'],
      proposal: 'Proposta semanal', weather: '18–24 °C · céu limpo',
      workouts: ['Rodagem leve', 'Intervalado 6×400 m', 'Longão'], apply: 'Aplicar proposta', applied: 'Aplicada',
      sheet: 'planilha-treinos.xlsx', import: 'Importar planilha',
    },
    calendar: { chips: ['Leve', 'Tiros', 'Trote', 'Ritmo', 'Longão'] },
    result: {
      runName: 'Rodagem leve', dropzone: 'Arquivo FIT ou ZIP', file: 'corrida.fit', distance: 'Distância', time: 'Tempo', pace: 'Pace',
      paceUnit: '/km', effort: 'Esforço percebido', done: 'Concluído', manual: 'ou registre manualmente',
    },
    insights: {
      analysisButton: 'Analisar treino', analysis: 'Análise do treino',
      lines: ['Pace estável nos intervalos', 'Esforço 3 de 5, como planejado', 'Próximo longão: manter ritmo leve'],
      memory: 'Memória de treino', sources: ['Objetivo · Ciclo', 'Disponibilidade · Solicitar Treinos', 'Relato · treino de hoje'],
    },
    outro: { steps: ['Tênis', 'Ciclo', 'Treinos'] },
  },
  en: {
    locale: 'en-US',
    tagline: 'Plan. Record. Understand.',
    scenes: {
      shoes: { eyebrow: '01', nav: 'Shoe Rotation', title: 'Your shoes, your mileage' },
      cycle: { eyebrow: '02', nav: 'Training Cycles', title: 'One goal, one date' },
      request: { eyebrow: '03', nav: 'Request Workouts', title: 'Your week, your plan' },
      calendar: { eyebrow: '04', nav: 'Workouts', title: 'All in the calendar' },
      result: { eyebrow: '05', nav: 'Workout result', title: 'Record every run' },
      insights: { eyebrow: '06', nav: 'Training memory', title: 'Learn from your training' },
    },
    shoes: { name1: 'Pegasus 41', name2: 'Novablast 5', active: 'Active', retire: 'Close to retiring', unit: 'km', of: 'of' },
    cycle: {
      newCycle: 'New cycle', nameLabel: 'Goal', goal: 'Run 10 km', dateLabel: 'Target date',
      raceOrGoal: 'Race or personal goal', aiButton: 'Generate plan',
      phases: ['Base', 'Build', 'Peak', 'Taper'], weeks: 'wk',
    },
    request: {
      availability: 'Availability', minutes: 'min', periods: ['by 8am', '8–12', '6pm+', '8–12', 'by 8am'],
      proposal: 'Weekly proposal', weather: '64–75 °F · clear sky',
      workouts: ['Easy run', 'Intervals 6×400 m', 'Long run'], apply: 'Apply proposal', applied: 'Applied',
      sheet: 'training-plan.xlsx', import: 'Import a spreadsheet',
    },
    calendar: { chips: ['Easy', 'Speed', 'Jog', 'Tempo', 'Long run'] },
    result: {
      runName: 'Easy run', dropzone: 'FIT or ZIP file', file: 'run.fit', distance: 'Distance', time: 'Time', pace: 'Pace',
      paceUnit: '/km', effort: 'Perceived effort', done: 'Completed', manual: 'or enter it manually',
    },
    insights: {
      analysisButton: 'Analyze workout', analysis: 'Workout analysis',
      lines: ['Steady pace across intervals', 'Effort 3 of 5, as planned', 'Next long run: keep it easy'],
      memory: 'Training memory', sources: ['Goal · Cycle', 'Availability · Request Workouts', 'Report · today’s run'],
    },
    outro: { steps: ['Shoes', 'Cycle', 'Workouts'] },
  },
};
