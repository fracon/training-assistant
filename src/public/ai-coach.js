import { initShell, getShellI18n, getUserPreferences, refreshIcons } from './shared/shell.js';
import { translate, normalizeClientLanguage } from './shared/i18n.js';
import { fetchShoes } from './shared/api.js';
import { fetchActiveCycle, fetchCalendarTrainings } from './shared/api.js';
import { formatDate as formatLocalizedDate, parseLocalizedDate } from './shared/date.js';
import { formatDistance, distancePromptUnit, temperaturePromptUnit } from './shared/units.js';
import { createDatePicker, readDatePickerValue } from './shared/datepicker.js';

// Verbatim Portuguese briefing for the external AI Coach.
// The wording below is a hard requirement — do not translate, rewrite
// or "improve" it. Only the {{PLACEHOLDER}} tokens are replaced at
// generation time; the template itself stays Portuguese regardless of
// the UI language.
export const PROMPT_TEMPLATE = `Quero que você gere minha planilha de treinos de corrida para a próxima semana, dando continuidade ao planejamento que já estamos seguindo.

CONTEXTO DO CICLO ATUAL

{{UNIT_INSTRUCTION}}

Nome do ciclo: {{CYCLE_NAME}}
Meta do ciclo: {{CYCLE_GOAL}}
Data da prova-alvo: {{TARGET_RACE_DATE}}
Semana atual: {{CURRENT_WEEK}}
Dias restantes: {{DAYS_REMAINING}}
Treinos concluídos na semana anterior: {{PREV_WEEK_TRAININGS}}
Distância total da semana anterior ({{DISTANCE_UNIT_LABEL}}): {{PREV_WEEK_DISTANCE_KM}}
Tempo total da semana anterior (minutos): {{PREV_WEEK_TIME_MINUTES}}

Use TODO o contexto disponível do meu treinamento, especialmente:
- os treinos realizados nas últimas semanas;
- meu feedback subjetivo após cada treino;
- evolução de volume, intensidade e duração dos longos;
- resposta aos treinos de qualidade;
- fadiga e recuperação;
- histórico recente de dores ou desconfortos;
- adaptação aos diferentes tênis;
- condições climáticas;
- minhas provas-alvo e o estágio atual da preparação.

Não crie uma semana isolada ou genérica. A semana deve ser uma progressão coerente do ciclo atual.

DATA DA SEMANA

A semana a ser planejada começa em:
{{DATA_DA_SEGUNDA}}

{{SHOES_BLOCK}}

DISPONIBILIDADE

- Segunda-feira: {{DISP_SEG}} (Local: {{LOCAL_SEG}})
- Terça-feira: {{DISP_TER}} (Local: {{LOCAL_TER}})
- Quarta-feira: {{DISP_QUA}} (Local: {{LOCAL_QUA}})
- Quinta-feira: {{DISP_QUI}} (Local: {{LOCAL_QUI}})
- Sexta-feira: {{DISP_SEX}} (Local: {{LOCAL_SEX}})
- Sábado: {{DISP_SAB}} (Local: {{LOCAL_SAB}})
- Domingo: {{DISP_DOM}} (Local: {{LOCAL_DOM}})

Se eu não informar nenhuma restrição especial, considere minha rotina normal de corrida.

CONTEXTO ADICIONAL DESTA SEMANA

{{CONTEXTO_OPCIONAL}}

INSTRUÇÕES PARA MONTAR A SEMANA

1. Planeje SOMENTE os treinos de corrida. Não inclua musculação.
2. Mantenha a estrutura geral que já utilizamos quando ela continuar fazendo sentido, mas não fique preso a ela. Ajuste dias, intensidade, volume ou recuperação de acordo com o histórico recente.
3. Considere a carga acumulada. Não aumente simultaneamente várias dimensões importantes da carga sem necessidade, como duração, intensidade e volume do longo.
4. Use os resultados reais dos últimos treinos para decidir a progressão. Um treino excepcionalmente bom não deve provocar automaticamente um salto agressivo de carga.
5. Nos treinos leves, priorize esforço e FC em vez de pace.
6. Nos treinos de qualidade, especifique claramente: aquecimento; quantidade e duração dos blocos; recuperação; intensidade/FC/RPE; desaquecimento.
7. Nos longos, especifique claramente cada parte do treino. Caso exista bloco controlado/progressivo, deixe explícito que ele deve ser realizado por esforço e indique o RPE esperado.
8. Considere que meu percurso habitual possui bastante subida. Não determine que eu persiga pace nas subidas. FC pode subir significativamente nesses trechos; considere principalmente esforço e respiração.
9. Considere temperatura e condições meteorológicas. Pesquise a previsão para Fânzeres, Gondomar, Portugal, especificamente no horário aproximado do treino: treinos durante a semana: aproximadamente 12h; longo de domingo: entre 8h e 9h.
10. A previsão deve corresponder ao horário do treino, e não simplesmente à mínima/máxima diária.
11. Se houver previsão de calor forte, adapte o treino quando necessário e deixe isso explícito nas observações. Não prescreva intensidade inadequada apenas para manter o planejamento original.
12. Escolha o tênis mais apropriado para cada sessão considerando os tênis que tenho disponíveis, o tipo de treino e nosso histórico recente com cada um.
13. Considere qualquer dor ou desconforto recente, mas não continue tratando uma lesão antiga como ativa se os treinos posteriores demonstrarem recuperação completa.
14. Se houver algum sinal recente que justifique cautela, faça a adaptação necessária e explique-a nas observações.
15. O objetivo não é maximizar cada treino individualmente. O objetivo é construir consistência e chegar às provas-alvo na melhor condição possível.

FORMATO DA PLANILHA

Mantenha EXATAMENTE o formato de tabela que já utilizamos, adicionando apenas "Data" como a PRIMEIRA coluna.
As colunas devem ser, nesta ordem: Data, Dia, Período, Tipo, Treino, Detalhes, FC alvo, RPE, Tênis, Localização, Previsão do tempo, Observações.

Exemplo estrutural:
| Data | Dia | Período | Tipo | Treino | Detalhes | FC alvo | RPE | Tênis | Localização | Previsão do tempo | Observações |

Use datas no formato DD/MM/YYYY. Em "Período", use o horário/período real esperado (ex: ~12h). Em "Localização", copie exatamente a localidade informada para cada dia, preservando acentos, espaços, pontuação e nomes em outros idiomas, sem traduzir, normalizar, geocodificar, substituir pela localidade habitual ou inferir a partir da previsão do tempo. Em "Previsão do tempo", informe de maneira compacta {{WEATHER_EXAMPLE}}. Não inclua linhas para musculação.

ARQUIVO EXCEL

Depois de definir o planejamento, gere um arquivo Excel (.xlsx) para download mantendo o estilo visual (cabeçalho destacado, texto legível, largura adequada, quebra automática). Antes de gerar o Excel, faça uma breve análise interna da carga recente e determine se a semana representa manutenção, progressão ou recuperação.

REGRA ESTRITA: NUNCA adicione linhas de notas, observações, rodapés ou células mescladas na planilha. A planilha deve conter EXCLUSIVAMENTE a linha de cabeçalho e as linhas de treino. Qualquer explicação extra deve ir apenas no texto da sua resposta, nunca no arquivo.

Na resposta, apresente:
1. uma explicação curta sobre o objetivo da semana e o que mudou em relação à anterior;
2. a tabela completa;
3. o link para download do arquivo Excel.`;

// Verbatim English briefing, selected when the active UI language is
// English. Placeholder names stay identical to the Portuguese template so
// the replacement logic never changes.
export const PROMPT_TEMPLATE_EN = `I want you to generate my running training schedule for next week, continuing the plan we are currently following.

CURRENT CYCLE CONTEXT

{{UNIT_INSTRUCTION}}

Cycle name: {{CYCLE_NAME}}
Cycle goal: {{CYCLE_GOAL}}
Target race date: {{TARGET_RACE_DATE}}
Current week: {{CURRENT_WEEK}}
Days remaining: {{DAYS_REMAINING}}
Completed trainings in the previous week: {{PREV_WEEK_TRAININGS}}
Previous week total distance ({{DISTANCE_UNIT_LABEL}}): {{PREV_WEEK_DISTANCE_KM}}
Previous week total time (minutes): {{PREV_WEEK_TIME_MINUTES}}

Use ALL available context from my training, especially:
- the workouts completed in recent weeks;
- my subjective feedback after each session;
- progression of volume, intensity, and duration of long runs;
- response to quality workouts;
- fatigue and recovery;
- recent history of aches or discomforts;
- adaptation to different shoes;
- weather conditions;
- my goal races and current preparation stage.

Do not create an isolated or generic week. The week must be a coherent progression of the current cycle.

WEEK DATE

The week to be planned starts on:
{{DATA_DA_SEGUNDA}}

{{SHOES_BLOCK}}

AVAILABILITY

- Monday: {{DISP_SEG}} (Location: {{LOCAL_SEG}})
- Tuesday: {{DISP_TER}} (Location: {{LOCAL_TER}})
- Wednesday: {{DISP_QUA}} (Location: {{LOCAL_QUA}})
- Thursday: {{DISP_QUI}} (Location: {{LOCAL_QUI}})
- Friday: {{DISP_SEX}} (Location: {{LOCAL_SEX}})
- Saturday: {{DISP_SAB}} (Location: {{LOCAL_SAB}})
- Sunday: {{DISP_DOM}} (Location: {{LOCAL_DOM}})

If I do not provide any special restrictions, assume my normal running routine.

ADDITIONAL CONTEXT FOR THIS WEEK

{{CONTEXTO_OPCIONAL}}

INSTRUCTIONS FOR PLANNING THE WEEK

1. Plan ONLY running workouts. Do not include strength training.
2. Keep the general structure we've been using when it still makes sense, but don't be strictly bound by it. Adjust days, intensity, volume, or recovery based on recent history.
3. Consider the accumulated load. Do not simultaneously increase multiple important load dimensions unnecessarily (like duration, intensity, and long run volume).
4. Use the actual results of recent workouts to decide progression. An exceptionally good workout should not automatically trigger an aggressive jump in load.
5. On easy runs, prioritize effort and HR over pace.
6. For quality workouts, clearly specify: warm-up; number and duration of blocks; recovery; intensity/HR/RPE; cool-down.
7. For long runs, clearly specify each part of the workout. If there is a controlled/progressive block, make it explicit that it should be done by effort and indicate the expected RPE.
8. Consider that my usual route has plenty of hills. Do not dictate that I chase pace on uphills. HR may rise significantly in these sections; consider effort and breathing primarily.
9. Consider temperature and weather conditions. Check the forecast for Fânzeres, Gondomar, Portugal, specifically around the workout time: weekday runs: approximately 12 PM; Sunday long run: between 8 AM and 9 AM.
10. The forecast must match the workout time, not just the daily min/max.
11. If strong heat is forecasted, adapt the workout when necessary and make this explicit in the notes. Do not prescribe inappropriate intensity just to maintain the original plan.
12. Choose the most appropriate shoe for each session considering the shoes I have available, the type of workout, and our recent history with each.
13. Consider any recent pain or discomfort, but do not continue treating an old injury as active if subsequent workouts demonstrate full recovery.
14. If there is any recent sign that warrants caution, make the necessary adaptation and explain it in the notes.
15. The goal is not to maximize each individual workout. The goal is to build consistency and arrive at goal races in the best possible condition.

SPREADSHEET FORMAT

Keep EXACTLY the table format we already use, adding only "Data" (Date) as the FIRST column.
The columns must be, in this order: Date, Day, Period, Type, Workout, Details, Target HR, RPE, Shoe, Location, Weather Forecast, Notes.

Structural example:
| Date | Day | Period | Type | Workout | Details | Target HR | RPE | Shoe | Location | Weather Forecast | Notes |

Use dates in DD/MM/YYYY format. In "Period", use the actual expected time/period (e.g., ~12h or 8-9h). In "Location", copy the location provided for each day exactly, preserving accents, spaces, punctuation, and names in other languages, without translating, normalizing, geocoding, replacing it with the usual location, or inferring it from the weather forecast. In "Weather Forecast", report compactly {{WEATHER_EXAMPLE}}. Do not include rows for strength training.

EXCEL FILE

After defining the plan, generate an Excel (.xlsx) file for download maintaining the visual style (highlighted header, readable text, adequate column width, text wrapping). Before generating the Excel, briefly analyze the recent load internally and determine whether the week represents maintenance, progression, or recovery.

STRICT RULE: NEVER add note rows, observations, footers, or merged cells inside the spreadsheet. The spreadsheet must EXCLUSIVELY contain the header row and the training rows. Any extra explanations must go only in the text of your response, never in the file.

In your response, provide:
1. a short explanation of the week's goal and what changed compared to the previous one;
2. the complete table;
3. the link to download the Excel file.
If recent data indicates that the originally expected plan should be altered, prioritize the correct adaptation rather than simply repeating the previous week's structure.`;

const DAY_KEYS = ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo'];

const DAY_LOCALE_KEYS = {
  segunda: 'monday',
  terca: 'tuesday',
  quarta: 'wednesday',
  quinta: 'thursday',
  sexta: 'friday',
  sabado: 'saturday',
  domingo: 'sunday',
};

export function orderedDayKeys(weekStart = 'Monday') {
  return weekStart === 'Sunday'
    ? [DAY_KEYS[6], ...DAY_KEYS.slice(0, 6)]
    : [...DAY_KEYS];
}

export const DEFAULT_ROUTINE_BY_LANG = {
  'en-US': 'Normal routine',
  'pt-BR': 'Rotina normal',
};

// The prompt template keeps its historical Portuguese fallback for unknown
// languages; availability defaults follow the app-wide en-US fallback.
export const TEMPLATE_BY_LANG = {
  'pt-BR': PROMPT_TEMPLATE,
  'en-US': PROMPT_TEMPLATE_EN,
};

export function resolveTemplateLang(lang) {
  return Object.prototype.hasOwnProperty.call(TEMPLATE_BY_LANG, lang)
    ? lang
    : 'pt-BR';
}

export function defaultRoutineFor(lang) {
  return DEFAULT_ROUTINE_BY_LANG[normalizeClientLanguage(lang)];
}

export const PLACEHOLDERS = {
  segunda: '{{DISP_SEG}}',
  terca: '{{DISP_TER}}',
  quarta: '{{DISP_QUA}}',
  quinta: '{{DISP_QUI}}',
  sexta: '{{DISP_SEX}}',
  sabado: '{{DISP_SAB}}',
  domingo: '{{DISP_DOM}}',
};

export const LOCATION_PLACEHOLDERS = {
  segunda: '{{LOCAL_SEG}}',
  terca: '{{LOCAL_TER}}',
  quarta: '{{LOCAL_QUA}}',
  quinta: '{{LOCAL_QUI}}',
  sexta: '{{LOCAL_SEX}}',
  sabado: '{{LOCAL_SAB}}',
  domingo: '{{LOCAL_DOM}}',
};

export function pad2(value) {
  return String(value).padStart(2, '0');
}

// Next Monday strictly after the reference date (a Monday rolls to the
// following week's Monday).
export function nextMonday(from = new Date()) {
  const date = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const daysAhead = (8 - date.getDay()) % 7 || 7;
  date.setDate(date.getDate() + daysAhead);
  return date;
}

// DD/MM/YYYY — the format expected by {{DATA_DA_SEGUNDA}}.
export function formatDiaSlashes(date) {
  return formatLocalizedDate(date, 'pt-BR');
}

function contextValue(value) {
  return value === null || value === undefined || String(value).trim() === '' ? '-' : String(value).trim();
}

function formatContextDate(value, lang) {
  return formatLocalizedDate(value, lang) || contextValue(value);
}

function formatCycleContext(cycle = {}, previousWeek = {}, lang = 'pt-BR', preferences = {}) {
  const currentWeek = cycle.currentWeek ?? cycle.current_week;
  const totalWeeks = cycle.totalWeeks ?? cycle.total_weeks;
  const weekText = currentWeek != null && totalWeeks != null
    ? (lang === 'pt-BR' ? `Semana ${currentWeek} de ${totalWeeks}` : `Week ${currentWeek} of ${totalWeeks}`)
    : contextValue(currentWeek);
  return {
    '{{UNIT_INSTRUCTION}}': unitInstruction(lang, preferences),
    '{{WEATHER_EXAMPLE}}': weatherExample(lang, preferences),
    '{{CYCLE_NAME}}': contextValue(cycle.name ?? cycle.objective),
    '{{CYCLE_GOAL}}': contextValue(cycle.goal ?? cycle.primary_goal),
    '{{TARGET_RACE_DATE}}': formatContextDate(cycle.targetRaceDate ?? cycle.target_date, lang),
    '{{CURRENT_WEEK}}': weekText,
    '{{DAYS_REMAINING}}': contextValue(cycle.daysRemaining ?? cycle.days_remaining),
    '{{PREV_WEEK_TRAININGS}}': contextValue(previousWeek.completedTrainingsCount ?? previousWeek.completed_trainings_count),
    '{{DISTANCE_UNIT_LABEL}}': distancePromptUnit(preferences.distance_unit),
    '{{TEMPERATURE_UNIT_LABEL}}': temperaturePromptUnit(preferences.temperature_unit),
    '{{PREV_WEEK_DISTANCE_KM}}': (() => {
      const distance = previousWeek.totalDistanceKm ?? previousWeek.total_distance_km;
      return distance == null || String(distance).trim() === ''
        ? '-'
        : preferences.distance_unit === 'mi'
          ? formatDistance(distance, 'mi')
          : contextValue(distance);
    })(),
    '{{PREV_WEEK_TIME_MINUTES}}': contextValue(previousWeek.totalTimeMinutes ?? previousWeek.total_time_minutes),
  };
}

function unitInstruction(lang, preferences = {}) {
  const distance = preferences.distance_unit === 'mi'
    ? (lang === 'pt-BR' ? 'milhas' : 'miles')
    : (lang === 'pt-BR' ? 'quilômetros' : 'kilometers');
  const temperature = preferences.temperature_unit === 'F' ? '°F' : '°C';
  if (lang === 'pt-BR') {
    return `Use ${distance} para todas as distâncias e ${temperature} para todas as temperaturas no plano e na previsão do tempo.`;
  }
  return `Use ${distance} for all distances and ${temperature} for all temperatures in the plan and weather forecast.`;
}

function weatherExample(lang, preferences = {}) {
  const range = preferences.temperature_unit === 'F' ? '73–75 °F' : '23–24 °C';
  return lang === 'pt-BR'
    ? `(ex: ${range}, parcialmente nublado (~12h))`
    : `(e.g., ${range}, partly cloudy (~12h))`;
}

const DAY_MS = 86400000;

function isoDateValue(date) {
  return dateInputValue(date);
}

function addDays(date, days) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setDate(result.getDate() + days);
  return result;
}

function metricDurationSeconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value !== 'string' || value.trim() === '') return 0;
  const parts = value.split(':').map(Number);
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function previousWeekSummary(trainings = [], targetDate) {
  const weekEnd = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate() - 1);
  const weekStart = addDays(weekEnd, -6);
  const rows = Array.isArray(trainings)
    ? trainings.filter((training) => training && typeof training.dia === 'string' &&
      training.dia >= isoDateValue(weekStart) && training.dia <= isoDateValue(weekEnd))
    : [];
  let totalDistanceKm = 0;
  let totalTimeMinutes = 0;
  let completedTrainingsCount = 0;
  for (const training of rows) {
    const distance = Number(training.fit_distance ?? training.distance);
    const durationSeconds = metricDurationSeconds(training.fit_duration ?? training.duration);
    const completed = training.completed === true || training.completed === 1 ||
      (Number.isFinite(distance) && distance > 0) || durationSeconds > 0;
    if (!completed) continue;
    completedTrainingsCount += 1;
    if (Number.isFinite(distance) && distance > 0) totalDistanceKm += distance;
    totalTimeMinutes += durationSeconds / 60;
  }
  return { completedTrainingsCount, totalDistanceKm, totalTimeMinutes };
}

export function cycleContext(cycle = {}, today = new Date()) {
  const start = parseInputDate(cycle.start_date ?? cycle.startDate);
  const target = parseInputDate(cycle.target_date ?? cycle.targetRaceDate);
  const currentDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const currentWeek = cycle.currentWeek ?? cycle.current_week ??
    (start ? Math.max(1, Math.floor((currentDay - start) / (7 * DAY_MS)) + 1) : undefined);
  const totalWeeks = cycle.totalWeeks ?? cycle.total_weeks ??
    (start && target ? Math.max(1, Math.ceil((target - start) / (7 * DAY_MS))) : undefined);
  const daysRemaining = cycle.daysRemaining ?? cycle.days_remaining ??
    (target ? Math.max(0, Math.ceil((target - currentDay) / DAY_MS)) : undefined);
  return {
    ...cycle,
    name: cycle.name ?? cycle.objective,
    goal: cycle.goal ?? cycle.primary_goal,
    targetRaceDate: cycle.targetRaceDate ?? cycle.target_date,
    currentWeek,
    totalWeeks,
    daysRemaining,
  };
}

export function buildPromptContext({ cycle = {}, trainings = [], targetDate, today = new Date(), preferences = {} }) {
  return {
    cycle: cycleContext(cycle, today),
    previousWeek: previousWeekSummary(trainings, targetDate),
    preferences,
  };
}

// yyyy-mm-dd — the value format accepted by <input type="date">.
export function dateInputValue(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function availabilityDefaults(lang = 'pt-BR') {
  const routine = defaultRoutineFor(lang);
  return {
    segunda: routine,
    terca: routine,
    quarta: routine,
    quinta: routine,
    sexta: routine,
    sabado: routine,
    domingo: routine,
  };
}

// Swaps only the values still holding the previous language's default
// routine, so anything the user typed stays untouched.
export function applyRoutineDefault(values, previousDefault, nextDefault) {
  const updated = {};
  for (const [day, value] of Object.entries(values)) {
    updated[day] = value === previousDefault ? nextDefault : value;
  }
  return updated;
}

function replaceAll(text, token, value) {
  return text.split(token).join(value);
}

// Formats a shoe list block for the AI prompt. Each active shoe gets a
// bullet line; when no active shoes exist a single fallback line is
// returned instead. The block always includes the section title from the
// locale messages.
export function formatShoesBlock(shoes = [], messages = {}, preferences = {}) {
  const title = messages.aiCoach?.shoesSectionTitle || 'SHOES AVAILABLE FOR ROTATION';
  const fallback =
    messages.aiCoach?.shoesFallback || 'No specific shoes registered; use standard rotation.';
  const targetLabel = messages.aiCoach?.shoesTarget || 'Target: {target} km';

  const activeShoes = shoes.filter((s) => s.status === 'active');
  let lines;
  if (activeShoes.length === 0) {
    lines = [`- ${fallback}`];
  } else {
    lines = activeShoes.map((s) => {
      const distanceUnit = preferences.distance_unit === 'mi' ? 'mi' : 'km';
      const distanceDecimals = distanceUnit === 'mi' ? 2 : 0;
      const currentMileage = formatDistance(s.mileage ?? 0, distanceUnit, distanceDecimals);
      const targetPrefix = targetLabel.split('{target}')[0];
      let line = `- ${s.brand} ${s.model} (Current mileage: ${currentMileage}`;
      if (s.target_mileage) {
        line += `, ${targetPrefix}${formatDistance(s.target_mileage, distanceUnit, distanceDecimals)}`;
      }
      line += ')';
      return line;
    });
  }
  return `${title}\n\n${lines.join('\n')}`;
}

export function buildPrompt({ targetDate, disponibilidade = {}, localizacao = {}, contexto = '', lang = 'pt-BR', shoes = [], messages = {}, cycle = {}, previousWeek = {}, preferences = {} }) {
  const templateLang = resolveTemplateLang(lang);
  const template = TEMPLATE_BY_LANG[templateLang];
  let prompt = replaceAll(
    template,
    '{{DATA_DA_SEGUNDA}}',
    formatLocalizedDate(targetDate, templateLang)
  );
  for (const [token, value] of Object.entries(formatCycleContext(cycle, previousWeek, templateLang, preferences))) {
    prompt = replaceAll(prompt, token, value);
  }
  const availability = { ...availabilityDefaults(templateLang), ...disponibilidade };
  for (const day of DAY_KEYS) {
    prompt = replaceAll(prompt, PLACEHOLDERS[day], String(availability[day] ?? '').trim());
    const location = String(localizacao[day] ?? '').trim();
    prompt = replaceAll(prompt, LOCATION_PLACEHOLDERS[day], location === '' ? '-' : location);
  }
  const notes = String(contexto).trim();
  prompt = replaceAll(prompt, '{{CONTEXTO_OPCIONAL}}', notes === '' ? '-' : notes);
  prompt = replaceAll(prompt, '{{SHOES_BLOCK}}', formatShoesBlock(shoes, messages, preferences));
  return prompt;
}

// Copies through the async Clipboard API. Returns true on success so the
// UI can flip to its "Copied!" feedback state.
export async function copyPromptText(text, clipboard = globalThis.navigator?.clipboard) {
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    return false;
  }
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Parses 'yyyy-mm-dd' from <input type="date"> as a LOCAL date.
// valueAsDate is UTC-based and shifts days on negative timezones.
export function parseInputDate(value) {
  const [year, month, day] = String(value ?? '').split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function normalizeTargetDate(value, language) {
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = parseInputDate(text);
    return date && dateInputValue(date) === text ? text : '';
  }
  return parseLocalizedDate(text, language);
}

// The DatePicker owns the ISO value; never read the localized display input
// when building the prompt. Its getter also keeps this binding resilient to
// future DatePicker implementations that do not expose a dataset value.
export function readTargetDateIso(input, picker, language = 'pt-BR') {
  const pickerValue = picker?.getValue?.();
  return pickerValue || readDatePickerValue(input) || normalizeTargetDate(input?.value, language);
}

export const DAY_INPUT_IDS = {
  segunda: 'dispSeg',
  terca: 'dispTer',
  quarta: 'dispQua',
  quinta: 'dispQui',
  sexta: 'dispSex',
  sabado: 'dispSab',
  domingo: 'dispDom',
};

export const LOCATION_INPUT_IDS = {
  segunda: 'locSeg',
  terca: 'locTer',
  quarta: 'locQua',
  quinta: 'locQui',
  sexta: 'locSex',
  sabado: 'locSab',
  domingo: 'locDom',
};

export function validatePromptFields({ targetDate = '', language = 'pt-BR', baseLocation = '', disponibilidade = {}, localizacao = {} } = {}) {
  const missing = [];
  if (!normalizeTargetDate(targetDate, language)) missing.push('targetDate');
  if (!DAY_KEYS.every((day) => String(disponibilidade[day] ?? '').trim())) missing.push('availability');
  const hasBaseLocation = String(baseLocation ?? '').trim() !== '';
  const hasDailyLocations = DAY_KEYS.every((day) => String(localizacao[day] ?? '').trim() !== '');
  if (!hasBaseLocation && !hasDailyLocations) missing.push('location');
  return { valid: missing.length === 0, missing };
}

export function buildDayRowHtml(day, { dayLabel, routine, locationPlaceholder }) {
  return `<div class="day-row">
  <label for="${DAY_INPUT_IDS[day]}" class="day-label"><span data-i18n="aiCoach.days.${DAY_LOCALE_KEYS[day]}">${dayLabel}</span><span class="required-mark" aria-hidden="true">*</span></label>
  <input type="text" id="${DAY_INPUT_IDS[day]}" value="${routine}" autocomplete="off" required>
  <input type="text" id="${LOCATION_INPUT_IDS[day]}" data-i18n-placeholder="aiCoach.location" placeholder="${locationPlaceholder}" autocomplete="off" required>
</div>`;
}

export function readDayInputState(getValue) {
  const state = {};
  for (const day of DAY_KEYS) {
    state[day] = {
      availability: getValue(DAY_INPUT_IDS[day]),
      location: getValue(LOCATION_INPUT_IDS[day]),
    };
  }
  return state;
}

export function applyDayInputState(state, setValue) {
  for (const day of DAY_KEYS) {
    const record = state[day] ?? {};
    if (record.availability !== undefined) {
      setValue(DAY_INPUT_IDS[day], record.availability);
    }
    if (record.location !== undefined) {
      setValue(LOCATION_INPUT_IDS[day], record.location);
    }
  }
}

export function renderDayGrid({ weekStart = 'Monday', routine = '', dayLabel = (day) => day, locationPlaceholder = 'Location', grid, getValue, setValue }) {
  const previous = readDayInputState(getValue);
  grid.innerHTML = orderedDayKeys(weekStart)
    .map((day) => buildDayRowHtml(day, {
      dayLabel: dayLabel(day),
      routine,
      locationPlaceholder,
    }))
    .join('');
  applyDayInputState(previous, setValue);
  return grid.innerHTML;
}

const COPY_FEEDBACK_MS = 2000;

function setupAiCoachPage() {
  const i18n = getShellI18n();

  function t(key) {
    return translate(i18n.messages, key);
  }

  const form = document.getElementById('promptForm');
  const targetDateInput = document.getElementById('targetDate');
  const targetDateDisplay = document.getElementById('targetDateDisplay');
  const optionalContextInput = document.getElementById('optionalContext');
  const baseLocationInput = document.getElementById('baseLocation');
  const availabilityGrid = document.getElementById('availabilityGrid');
  const resultSection = document.getElementById('resultSection');
  const promptOutput = document.getElementById('promptOutput');
  const copyBtn = document.getElementById('copyBtn');
  const copyIconSlot = copyBtn.querySelector('.copy-icon');
  const copyLabel = document.getElementById('copyLabel');
  const generateBtn = document.getElementById('generateBtn');

  targetDateInput.dataset.iso = dateInputValue(nextMonday());
  targetDateInput.value = targetDateInput.dataset.iso;
  const targetDatePicker = createDatePicker(targetDateDisplay, {
    isoInput: targetDateInput,
    getLanguage: () => i18n.language,
    getWeekStart: () => getUserPreferences().first_day_of_week,
    onChange: () => updateValidation(),
  });

  let lastRoutineDefault = t('aiCoach.defaultRoutine') || defaultRoutineFor(i18n.language);
  function renderDayRows() {
    renderDayGrid({
      weekStart: getUserPreferences().first_day_of_week,
      routine: lastRoutineDefault,
      dayLabel: (day) => t(`aiCoach.days.${DAY_LOCALE_KEYS[day]}`) || day,
      locationPlaceholder: t('aiCoach.location') || 'Location',
      grid: availabilityGrid,
      getValue: (id) => document.getElementById(id)?.value,
      setValue: (id, value) => {
        const input = document.getElementById(id);
        if (input) input.value = value;
      },
    });
  }
  renderDayRows();

  function readFormFields() {
    const disponibilidade = {};
    for (const [day, inputId] of Object.entries(DAY_INPUT_IDS)) {
      const input = document.getElementById(inputId);
      if (input) disponibilidade[day] = input.value;
    }
    const localizacao = {};
    for (const [day, inputId] of Object.entries(LOCATION_INPUT_IDS)) {
      const input = document.getElementById(inputId);
      if (input) localizacao[day] = input.value;
    }
    return { disponibilidade, localizacao };
  }

  function updateValidation() {
    const { disponibilidade, localizacao } = readFormFields();
    const validation = validatePromptFields({
      targetDate: readTargetDateIso(targetDateInput, targetDatePicker, i18n.language),
      language: i18n.language,
      baseLocation: baseLocationInput.value,
      disponibilidade,
      localizacao,
    });
    generateBtn.disabled = !validation.valid;
    generateBtn.setAttribute('aria-disabled', String(!validation.valid));
    targetDateInput.setAttribute('aria-invalid', String(validation.missing.includes('targetDate')));
    baseLocationInput.setAttribute('aria-invalid', String(validation.missing.includes('location')));
    return validation;
  }

  updateValidation();

  document.addEventListener('kinesis:preferences-changed', (event) => {
    const next = event.detail?.first_day_of_week;
    if (next === 'Monday' || next === 'Sunday') renderDayRows();
  });

  // The base location cascades to every day's location input. Each day can
  // still be overridden manually afterwards — a later base-location edit
  // simply rewrites all days again.
  baseLocationInput.addEventListener('input', () => {
    for (const inputId of Object.values(LOCATION_INPUT_IDS)) {
      const input = document.getElementById(inputId);
      if (input) input.value = baseLocationInput.value;
    }
    updateValidation();
  });
  availabilityGrid.addEventListener('input', updateValidation);

  document.addEventListener('app:languagechange', () => {
    const nextDefault = t('aiCoach.defaultRoutine') || defaultRoutineFor(i18n.language);
    const currentValues = {};
    for (const [day, inputId] of Object.entries(DAY_INPUT_IDS)) {
      const input = document.getElementById(inputId);
      if (input) currentValues[day] = input.value;
    }
    const updated = applyRoutineDefault(currentValues, lastRoutineDefault, nextDefault);
    for (const [day, value] of Object.entries(updated)) {
      const input = document.getElementById(DAY_INPUT_IDS[day]);
      if (input) input.value = value;
    }
    lastRoutineDefault = nextDefault;
    const targetIso = readTargetDateIso(targetDateInput, targetDatePicker, i18n.language);
    targetDateInput.dataset.iso = targetIso;
    targetDateInput.value = targetIso;
    targetDatePicker.refresh();
    updateValidation();
  });

  let copiedTimer = null;

  function setCopyFeedback(copied) {
    copyLabel.textContent = copied ? t('aiCoach.copied') : t('aiCoach.copy');
    copyBtn.classList.toggle('copied', copied);
    copyIconSlot.innerHTML = `<i data-lucide="${copied ? 'check' : 'copy'}"></i>`;
    refreshIcons();
  }

  async function handleCopy() {
    const copied = await copyPromptText(promptOutput.textContent);
    if (!copied) return;
    setCopyFeedback(true);
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => setCopyFeedback(false), COPY_FEEDBACK_MS);
  }

  async function handleGenerate(event) {
    event.preventDefault();
    const { disponibilidade, localizacao } = readFormFields();
    const validation = updateValidation();
    if (!validation.valid) return;
    const targetIso = readTargetDateIso(targetDateInput, targetDatePicker, i18n.language);
    const targetDate = parseInputDate(targetIso);

    generateBtn.disabled = true;
    let shoes = [];
    let cycle = {};
    let trainings = [];
    try {
      shoes = await fetchShoes();
      cycle = await fetchActiveCycle();
      trainings = await fetchCalendarTrainings(
        isoDateValue(addDays(targetDate, -7)),
        isoDateValue(addDays(targetDate, -1))
      );
    } catch {
      // Any unavailable context keeps prompt generation usable with dashes.
    }
    updateValidation();

    const preferences = getUserPreferences();
    const promptContext = buildPromptContext({ cycle: cycle || {}, trainings, targetDate, preferences });

    promptOutput.textContent = buildPrompt({
      targetDate,
      disponibilidade,
      localizacao,
      contexto: optionalContextInput.value,
      lang: i18n.language,
      shoes,
      messages: i18n.messages,
      ...promptContext,
    });
    resultSection.classList.remove('hidden');
    promptOutput.scrollTop = 0;
  }

  form.addEventListener('submit', handleGenerate);
  copyBtn.addEventListener('click', handleCopy);
}

export async function initAiCoach() {
  const user = await initShell({ active: 'ai-coach' });
  if (!user) return null;
  setupAiCoachPage();
  return user;
}

if (typeof document !== 'undefined' && document.getElementById('appView')) {
  initAiCoach().catch(() => window.location.replace('/login.html'));
}
