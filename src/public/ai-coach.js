import { initShell, getShellI18n, getUserPreferences, refreshIcons } from './shared/shell.js';
import { translate } from './shared/i18n.js';
import { fetchShoes, fetchAiCoachAvailability, saveAiCoachAvailability } from './shared/api.js';
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

{{AVAILABILITY_BLOCK}}

Planeje treinos somente em dias marcados como disponíveis. Se algum dia estiver sem configuração estruturada, não presuma disponibilidade e peça confirmação. Períodos múltiplos são alternativas para uma sessão naquele dia, não autorização para treinos múltiplos; escolha o período mais adequado. O tempo informado é o limite máximo total da sessão, incluindo aquecimento e volta à calma; não é meta. Nunca interprete a janela do período como duração do treino. Considere o horário local da localidade. Use previsão somente quando houver dados válidos, nunca invente condições meteorológicas e informe quando não houver previsão válida.

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
9. Considere temperatura e condições meteorológicas. Use previsão somente quando houver dados válidos para a localidade informada e horário dentro do período disponível. Não invente horário exato dentro da faixa nem condições meteorológicas. Sem previsão válida, informe a ausência e não presuma o clima.
10. A previsão precisa ter dados válidos de horário compatíveis com o período escolhido. Se não for possível confirmá-los, trate a previsão como indisponível; não use apenas mínima/máxima diária nem invente horário exato.
11. Se houver previsão de calor forte, adapte o treino quando necessário e deixe isso explícito nas observações. Não prescreva intensidade inadequada apenas para manter o planejamento original.
12. Escolha o tênis mais apropriado para cada sessão considerando os tênis que tenho disponíveis, o tipo de treino e nosso histórico recente com cada um.
13. Considere qualquer dor ou desconforto recente, mas não continue tratando uma lesão antiga como ativa se os treinos posteriores demonstrarem recuperação completa.
14. Se houver algum sinal recente que justifique cautela, faça a adaptação necessária e explique-a nas observações.
15. O objetivo não é maximizar cada treino individualmente. O objetivo é construir consistência e chegar às provas-alvo na melhor condição possível.

FORMATO DA PLANILHA

Use exatamente o formato de 12 colunas definido abaixo.
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

{{AVAILABILITY_BLOCK}}

Plan sessions only on days marked available. If any day is unconfigured, do not assume availability and ask the user to confirm it. Multiple periods are alternatives for one session that day, not permission for multiple sessions; choose the most appropriate period. The available time is the maximum total session duration, including warm-up and cool-down; it is a ceiling, not a target. Never interpret the period window as workout duration. Consider the local time at the stated location. Use forecasts only when valid data exists, never invent weather, and state when no valid forecast is available.

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
9. Consider temperature and weather conditions. Use a forecast only when valid data exists for the stated location and a time within the available period. Do not invent an exact time within the window or weather conditions. Without a valid forecast, state that it is unavailable and do not assume weather.
10. The forecast must have valid time-specific data within the selected period. If that cannot be confirmed, treat the forecast as unavailable; do not rely only on daily min/max or invent an exact time.
11. If strong heat is forecasted, adapt the workout when necessary and make this explicit in the notes. Do not prescribe inappropriate intensity just to maintain the original plan.
12. Choose the most appropriate shoe for each session considering the shoes I have available, the type of workout, and our recent history with each.
13. Consider any recent pain or discomfort, but do not continue treating an old injury as active if subsequent workouts demonstrate full recovery.
14. If there is any recent sign that warrants caution, make the necessary adaptation and explain it in the notes.
15. The goal is not to maximize each individual workout. The goal is to build consistency and arrive at goal races in the best possible condition.

SPREADSHEET FORMAT

Use exactly the 12-column format defined below.
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
const DAY_DB_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const PERIOD_KEYS = ['before_08', '08_12', '12_14', '14_18', 'after_18'];
const MAX_AVAILABLE_MINUTES = 720;
const MAX_LOCATION_LENGTH = 200;

function isValidAvailableMinutes(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_AVAILABLE_MINUTES;
}

function getLocationValidationError(location) {
  if (typeof location !== 'string' || !location.trim()) return 'availabilityNeedsLocation';
  if (location.trim().length > MAX_LOCATION_LENGTH) return 'availabilityLocationTooLong';
  return null;
}

export function validateAvailabilityDay(record) {
  if (record?.can_train === false) return [];
  if (record?.can_train !== true) return ['availability'];
  const errors = [];
  if (!Array.isArray(record.available_periods) || !record.available_periods.some((period) => PERIOD_KEYS.includes(period))) {
    errors.push('availabilityNeedsPeriods');
  }
  if (!isValidAvailableMinutes(record.available_minutes)) errors.push('availabilityNeedsDuration');
  const locationError = getLocationValidationError(record.location);
  if (locationError) errors.push(locationError);
  return errors;
}

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

export const TEMPLATE_BY_LANG = {
  'pt-BR': PROMPT_TEMPLATE,
  'en-US': PROMPT_TEMPLATE_EN,
};

export function resolveTemplateLang(lang) {
  return Object.prototype.hasOwnProperty.call(TEMPLATE_BY_LANG, lang)
    ? lang
    : 'pt-BR';
}

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

export function availabilityDefaults() {
  return Object.fromEntries(DAY_KEYS.map((day) => [day, {
    can_train: null, available_periods: [], available_minutes: null, location: '',
  }]));
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

export function buildPrompt({ targetDate, disponibilidade = {}, contexto = '', lang = 'pt-BR', shoes = [], messages = {}, cycle = {}, previousWeek = {}, preferences = {} }) {
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
  const availability = Array.isArray(disponibilidade)
    ? Object.fromEntries(disponibilidade.map((record) => [DAY_KEYS[DAY_DB_KEYS.indexOf(record.day)], record]))
    : disponibilidade;
  const labels = messages.aiCoach ?? {};
  const lines = DAY_KEYS.map((day, index) => {
    const record = availability[day] ?? {};
    const dayName = labels.days?.[DAY_LOCALE_KEYS[day]] || DAY_DB_KEYS[index];
    if (record.can_train === false) return `- ${dayName}: ${labels.canTrainLabel || 'Can train'}: ${labels.no || 'no'}`;
    if (record.can_train !== true) return `- ${dayName}: ${labels.availabilityUnconfigured || 'Availability not configured; ask for confirmation'}`;
    const periods = (record.available_periods ?? []).map((period) => labels.periods?.[period] || period).join('; ');
    const location = String(record.location ?? '');
    return `- ${dayName}: ${labels.canTrainLabel || 'Can train'}: ${labels.yes || 'yes'}; ${labels.periodsLabel || 'Periods available'}: ${periods}; ${labels.durationPromptLabel || 'Maximum session time'}: ${record.available_minutes} ${labels.minutes || 'minutes'}; ${labels.locationLabel || 'Location'}: ${location}`;
  });
  prompt = replaceAll(prompt, '{{AVAILABILITY_BLOCK}}', lines.join('\n'));
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

export function validatePromptFields({ targetDate = '', language = 'pt-BR', disponibilidade = {} } = {}) {
  const missing = [];
  if (!normalizeTargetDate(targetDate, language)) missing.push('targetDate');
  const availability = Array.isArray(disponibilidade)
    ? Object.fromEntries(disponibilidade.map((record) => [DAY_KEYS[DAY_DB_KEYS.indexOf(record.day)], record]))
    : disponibilidade;
  const hasAllDays = DAY_KEYS.every((day) => validateAvailabilityDay(availability[day]).length === 0);
  if (!hasAllDays) missing.push('availability');
  return { valid: missing.length === 0, missing };
}

function daySummary(state, messages) {
  if (state.can_train === false) return { text: messages.dayUnavailable || '', incomplete: false };
  if (state.can_train !== true) return { text: messages.dayNotConfigured || '', incomplete: false };
  const periods = (state.available_periods || []).map((period) => messages.periods?.[period] || period);
  const duration = Number.isInteger(state.available_minutes) ? `${state.available_minutes} ${messages.minutesUnit || messages.minutes || ''}` : '';
  const text = [periods.join('; '), duration].filter(Boolean).join(' · ') || messages.dayAvailable || '';
  const incomplete = validateAvailabilityDay(state).length > 0;
  return { text, incomplete };
}

export function buildDayRowHtml(day, { dayLabel, messages = {}, state = {} }) {
  const dbDay = DAY_DB_KEYS[DAY_KEYS.indexOf(day)];
  const periods = PERIOD_KEYS.map((period) => `<label class="period-option"><input type="checkbox" data-period="${period}" ${state.available_periods?.includes(period) ? 'checked' : ''}><span>${messages.periods?.[period] || period}</span></label>`).join('');
  const duration = state.available_minutes ?? '';
  const summary = daySummary(state, messages);
  const available = state.can_train === true;
  const expanded = available && state.expanded === true;
  const detailsId = `availability-details-${dbDay}`;
  const durationId = `availability-${dbDay}-duration`;
  const durationHintId = `availability-${dbDay}-duration-hint`;
  const locationId = `availability-${dbDay}-location`;
  const configured = state.can_train !== null && state.can_train !== undefined;
  const expandLabel = `${expanded ? (messages.dayCollapse || '') : (messages.dayExpand || '')} ${dayLabel}`.trim();
  const copyAction = day === 'segunda' ? `<button type="button" id="applyWeekdays" class="day-copy-action"><i data-lucide="copy" aria-hidden="true"></i><span>${messages.applyWeekdays || ''}</span></button>` : '';
  return `<fieldset class="day-row" data-day="${dbDay}">
  <div class="day-summary">
    <label class="day-toggle"><input type="checkbox" data-can-train aria-label="${dayLabel}" ${available ? 'checked' : ''} aria-controls="${detailsId}" ${configured ? 'data-configured="true"' : ''}><span class="day-label">${dayLabel}</span></label>
    <div class="day-summary-copy"><span data-day-summary>${summary.text}</span>${summary.incomplete ? `<span class="day-incomplete" data-day-incomplete>${messages.dayIncomplete || ''}</span>` : ''}</div>
    <button type="button" class="day-expand" data-expand aria-label="${expandLabel}" aria-controls="${detailsId}" aria-expanded="${expanded ? 'true' : 'false'}" ${available ? '' : 'disabled'}><span aria-hidden="true">${expanded ? '⌃' : '⌄'}</span></button>
  </div>
  <div class="day-details" id="${detailsId}" ${expanded ? '' : 'hidden'}>
    <fieldset class="period-group"><legend>${messages.periodsLabel || ''}</legend><div class="period-list">${periods}</div></fieldset>
    <div class="field availability-day-field"><label class="field-label" for="${durationId}">${messages.durationLabel || ''}</label><input id="${durationId}" type="number" data-duration data-hint-id="${durationHintId}" min="1" max="${MAX_AVAILABLE_MINUTES}" step="1" inputmode="numeric" value="${duration}" placeholder="${messages.durationPlaceholder || ''}" aria-describedby="${durationHintId}"><p class="field-hint" id="${durationHintId}">${messages.durationHint || ''}</p></div>
    <div class="field availability-day-field"><label class="field-label" for="${locationId}">${messages.locationLabel || ''}</label><input id="${locationId}" type="text" data-location value="${String(state.location || '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}" autocomplete="off"></div>
  <p class="day-error" id="availability-error-${dbDay}" data-day-error hidden></p>
  ${copyAction}
  </div>
</fieldset>`;
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
  const saveAvailabilityButton = document.getElementById('saveAvailability');
  const availabilityStatus = document.getElementById('availabilityStatus');
  const availabilityError = document.getElementById('availabilityError');
  const availabilityReview = document.getElementById('availabilityReview');
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

  function readFormFields() {
    return Object.fromEntries(DAY_KEYS.map((day, index) => {
      const dbDay = DAY_DB_KEYS[index];
      const row = availabilityGrid.querySelector(`[data-day="${dbDay}"]`);
      const toggle = row?.querySelector('[data-can-train]');
      const selected = toggle?.checked;
      const configured = row?.dataset.configured === 'true' || toggle?.dataset.configured === 'true';
      return [day, {
        can_train: selected ? true : configured ? false : null,
        available_periods: selected
          ? [...(row?.querySelectorAll('[data-period]:checked') || [])].map((input) => input.dataset.period)
          : [],
        available_minutes: selected && row?.querySelector('[data-duration]')?.value
          ? Number(row.querySelector('[data-duration]').value) : null,
        location: selected ? row?.querySelector('[data-location]')?.value || '' : '',
      }];
    }));
  }

  function captureDailyFocus() {
    const active = document.activeElement;
    const row = active?.closest?.('.day-row');
    if (!row || !availabilityGrid.contains(active)) return null;

    let control = null;
    let selection = null;
    if (active.matches('[data-location]')) control = { type: 'location' };
    else if (active.matches('[data-duration]')) control = { type: 'duration' };
    else if (active.matches('[data-period]')) control = { type: 'period', period: active.dataset.period };
    else if (active.matches('[data-can-train]')) control = { type: 'can-train' };
    if (!control) return null;

    if (active instanceof HTMLInputElement && active.type === 'text' &&
        typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number') {
      selection = {
        start: active.selectionStart,
        end: active.selectionEnd,
        direction: active.selectionDirection,
      };
    }
    return { day: row.dataset.day, control, selection, scrollX: window.scrollX, scrollY: window.scrollY };
  }

  function restoreDailyFocus(snapshot) {
    if (!snapshot) return;
    const row = availabilityGrid.querySelector(`[data-day="${snapshot.day}"]`);
    if (!row) return;
    const { control } = snapshot;
    const target = control.type === 'location' ? row.querySelector('[data-location]')
      : control.type === 'duration' ? row.querySelector('[data-duration]')
        : control.type === 'period' ? [...row.querySelectorAll('[data-period]')].find((input) => input.dataset.period === control.period)
          : row.querySelector('[data-can-train]');
    if (!target) return;
    const details = target.closest('.day-details');
    if (details?.hidden && row.querySelector('[data-can-train]')?.checked) {
      details.hidden = false;
      row.querySelector('[data-expand]')?.setAttribute('aria-expanded', 'true');
    }
    if (target.disabled || target.closest('[hidden]') || target.getClientRects().length === 0) return;

    if (document.activeElement !== target) {
      try {
        target.focus({ preventScroll: true });
      } catch {
        target.focus();
        window.scrollTo(snapshot.scrollX, snapshot.scrollY);
      }
    }
    if (snapshot.selection && target instanceof HTMLInputElement && target.type === 'text' &&
        typeof target.setSelectionRange === 'function') {
      try {
        target.setSelectionRange(snapshot.selection.start, snapshot.selection.end, snapshot.selection.direction);
      } catch {
        // The control may not support text selection in this browser.
      }
    }
  }

  let lastDailyFocus = null;

  function renderDayRows(states = readFormFields(), { preserveDays = [], focusSnapshot } = {}) {
    const messages = i18n.messages.aiCoach;
    const days = orderedDayKeys(getUserPreferences().first_day_of_week);
    const focused = focusSnapshot === undefined ? captureDailyFocus() : focusSnapshot;
    const expandedDays = new Set([...availabilityGrid.querySelectorAll('.day-row')]
      .filter((row) => row.querySelector('[data-expand]')?.getAttribute('aria-expanded') === 'true')
      .map((row) => DAY_KEYS[DAY_DB_KEYS.indexOf(row.dataset.day)]));
    if (focused?.day) expandedDays.add(DAY_KEYS[DAY_DB_KEYS.indexOf(focused.day)]);
    const currentRows = [...availabilityGrid.querySelectorAll('.day-row')];
    const currentOrder = currentRows.map((row) => DAY_KEYS[DAY_DB_KEYS.indexOf(row.dataset.day)]);
    const canPreserveRows = currentRows.length === days.length && currentOrder.every((day, index) => day === days[index]);
    if (canPreserveRows) {
      for (let index = 0; index < days.length; index += 1) {
        const day = days[index];
        if (preserveDays.includes(day)) continue;
        const row = currentRows[index];
        const template = document.createElement('template');
        template.innerHTML = buildDayRowHtml(day, {
          dayLabel: t(`aiCoach.days.${DAY_LOCALE_KEYS[day]}`), messages,
          state: { ...(states[day] || {}), expanded: expandedDays.has(day) },
        });
        row.replaceWith(template.content.firstElementChild);
      }
    } else {
      availabilityGrid.innerHTML = days.map((day) =>
        buildDayRowHtml(day, { dayLabel: t(`aiCoach.days.${DAY_LOCALE_KEYS[day]}`), messages, state: { ...(states[day] || {}), expanded: expandedDays.has(day) } })
      ).join('');
    }
    availabilityGrid.querySelectorAll('.day-row').forEach((row) => {
      const selected = row.querySelector('[data-can-train]')?.checked;
      const details = row.querySelector('.day-details');
      const focusedInside = row.contains(document.activeElement) && details.contains(document.activeElement);
      if (focusedInside) row.querySelector('[data-expand]')?.setAttribute('aria-expanded', 'true');
      details.hidden = !selected || (!focusedInside && row.querySelector('[data-expand]')?.getAttribute('aria-expanded') !== 'true');
      details.querySelectorAll('input, select').forEach((input) => { input.disabled = !selected; });
      row.dataset.configured = row.querySelector('[data-can-train]')?.dataset.configured === 'true' || selected ? 'true' : (row.dataset.configured || 'false');
      const expand = row.querySelector('[data-expand]');
      if (expand) expand.disabled = !selected;
    });
    if (globalThis.lucide && typeof globalThis.lucide.createIcons === 'function') globalThis.lucide.createIcons();
    restoreDailyFocus(focused);
    if (focused) requestAnimationFrame(() => {
      if (document.activeElement === document.body || !availabilityGrid.contains(document.activeElement)) restoreDailyFocus(focused);
    });
  }

  let availabilityRevision = 0;
  let lastAvailabilitySnapshot = '';

  function currentAvailabilitySnapshot() {
    return JSON.stringify(readFormFields());
  }

  function daysEditedSince(snapshot) {
    const before = JSON.parse(snapshot);
    const current = readFormFields();
    return DAY_KEYS.filter((day) => JSON.stringify(before[day]) !== JSON.stringify(current[day]));
  }

  function applyAvailabilityState(week, { preserveDays = [] } = {}) {
    const states = availabilityDefaults();
    for (const record of week.days || []) {
      const day = DAY_KEYS[DAY_DB_KEYS.indexOf(record.day)];
      if (day) states[day] = record;
    }
    const current = readFormFields();
    for (const day of preserveDays) states[day] = current[day];
    renderDayRows(states, { preserveDays });
    lastAvailabilitySnapshot = currentAvailabilitySnapshot();
    availabilityReview.hidden = !week.needsReview;
    availabilityReview.textContent = t('aiCoach.availabilityReview');
  }

  let availabilityStatusKey = '';
  function setAvailabilityStatus(key) {
    availabilityStatusKey = key;
    availabilityStatus.textContent = key ? t(`aiCoach.${key}`) : '';
  }

  function noteAvailabilityEdit() {
    const snapshot = currentAvailabilitySnapshot();
    if (snapshot === lastAvailabilitySnapshot) return false;
    lastAvailabilitySnapshot = snapshot;
    availabilityRevision += 1;
    setAvailabilityStatus('');
    return true;
  }

  async function loadAvailability() {
    const requestedRevision = availabilityRevision;
    const requestedSnapshot = lastAvailabilitySnapshot;
    try {
      const saved = await fetchAiCoachAvailability();
      const preserveDays = availabilityRevision === requestedRevision ? [] : daysEditedSince(requestedSnapshot);
      applyAvailabilityState(saved, { preserveDays });
      setAvailabilityStatus('');
    } catch {
      setAvailabilityStatus('availabilityLoadError');
    }
    updateValidation();
  }

  async function persistAvailability() {
    const submittedRevision = availabilityRevision;
    const submittedSnapshot = currentAvailabilitySnapshot();
    const fields = readFormFields();
    const validation = validatePromptFields({ targetDate: readTargetDateIso(targetDateInput, targetDatePicker, i18n.language), language: i18n.language, disponibilidade: fields });
    if (validation.missing.includes('availability')) {
      availabilityError.textContent = t('aiCoach.availabilityValidation');
      return false;
    }
    const days = DAY_KEYS.map((day, index) => ({ day: DAY_DB_KEYS[index], ...fields[day] }));
    try {
      const saved = await saveAiCoachAvailability(days);
      const preserveDays = availabilityRevision === submittedRevision ? [] : daysEditedSince(submittedSnapshot);
      const unchanged = preserveDays.length === 0;
      const active = document.activeElement;
      const captured = captureDailyFocus();
      const focused = captured || (preserveDays.length &&
        (active === document.body || active === saveAvailabilityButton) ? lastDailyFocus : null);
      applyAvailabilityState(saved, { preserveDays });
      if (focused) requestAnimationFrame(() => restoreDailyFocus(focused));
      availabilityError.textContent = '';
      setAvailabilityStatus(unchanged ? 'availabilitySaved' : 'availabilityEditedDuringSave');
      if (!unchanged) updateValidation();
      return unchanged;
    } catch {
      setAvailabilityStatus('availabilitySaveError');
      return false;
    }
  }

  renderDayRows();
  lastAvailabilitySnapshot = currentAvailabilitySnapshot();
  void loadAvailability();

  function updateValidation() {
    const disponibilidade = readFormFields();
    const validation = validatePromptFields({
      targetDate: readTargetDateIso(targetDateInput, targetDatePicker, i18n.language),
      language: i18n.language,
      disponibilidade,
    });
    generateBtn.disabled = !validation.valid;
    generateBtn.setAttribute('aria-disabled', String(!validation.valid));
    targetDateInput.setAttribute('aria-invalid', String(validation.missing.includes('targetDate')));
    availabilityGrid.setAttribute('aria-invalid', String(validation.missing.includes('availability')));
    availabilityGrid.setAttribute('aria-describedby', availabilityError.id);
    availabilityError.textContent = validation.missing.includes('availability') ? t('aiCoach.availabilityValidation') : '';
    availabilityGrid.querySelectorAll('.day-row').forEach((row) => {
      const dayIndex = DAY_DB_KEYS.indexOf(row.dataset.day);
      const day = DAY_KEYS[dayIndex];
      const unset = disponibilidade[day].can_train === null;
      const toggle = row.querySelector('[data-can-train]');
      toggle?.setAttribute('aria-invalid', String(unset));
      toggle?.setAttribute('aria-describedby', availabilityError.id);
    });
    for (const [day, dayIndex] of DAY_KEYS.map((day, index) => [day, index])) {
      const record = disponibilidade[day];
      const row = availabilityGrid.querySelector(`[data-day="${DAY_DB_KEYS[dayIndex]}"]`);
      if (!row) continue;
      const summary = daySummary(record, i18n.messages.aiCoach);
      const summaryText = row.querySelector('[data-day-summary]');
      if (summaryText) summaryText.textContent = summary.text;
      const incomplete = row.querySelector('[data-day-incomplete]');
      if (summary.incomplete && !incomplete) {
        const marker = document.createElement('span');
        marker.className = 'day-incomplete';
        marker.dataset.dayIncomplete = '';
        marker.textContent = t('aiCoach.dayIncomplete');
        row.querySelector('.day-summary-copy')?.append(marker);
      } else if (!summary.incomplete && incomplete) incomplete.remove();
      if (record.can_train !== true) {
        const error = row.querySelector('[data-day-error]');
        error.hidden = true;
        error.textContent = '';
        continue;
      }
      const periods = row.querySelector('.period-group');
      const duration = row.querySelector('[data-duration]');
      const location = row.querySelector('[data-location]');
      const dayErrorKeys = validateAvailabilityDay(record).filter((key) => key !== 'availability');
      const errors = dayErrorKeys.map((key) => t(`aiCoach.${key}`));
      const error = row.querySelector('[data-day-error]');
      error.textContent = errors.join(' ');
      error.hidden = errors.length === 0;
      const errorId = error.id;
      periods.setAttribute('aria-invalid', String(dayErrorKeys.includes('availabilityNeedsPeriods')));
      if (dayErrorKeys.length) periods.setAttribute('aria-describedby', errorId);
      else periods.removeAttribute('aria-describedby');
      periods.querySelectorAll('input').forEach((input) => {
        input.setAttribute('aria-invalid', String(dayErrorKeys.includes('availabilityNeedsPeriods')));
        if (dayErrorKeys.length) input.setAttribute('aria-describedby', errorId);
        else input.removeAttribute('aria-describedby');
      });
      duration.setAttribute('aria-invalid', String(dayErrorKeys.includes('availabilityNeedsDuration')));
      const durationDescribedBy = [duration.dataset.hintId, dayErrorKeys.length ? errorId : ''].filter(Boolean).join(' ');
      if (durationDescribedBy) duration.setAttribute('aria-describedby', durationDescribedBy);
      else duration.removeAttribute('aria-describedby');
      location.setAttribute('aria-invalid', String(dayErrorKeys.includes('availabilityNeedsLocation') || dayErrorKeys.includes('availabilityLocationTooLong')));
      if (dayErrorKeys.length) location.setAttribute('aria-describedby', errorId);
      else location.removeAttribute('aria-describedby');
    }
    return validation;
  }

  updateValidation();

  availabilityGrid.addEventListener('focusin', () => {
    const focused = captureDailyFocus();
    if (focused) lastDailyFocus = focused;
  });

  document.addEventListener('kinesis:preferences-changed', (event) => {
    const next = event.detail?.first_day_of_week;
    if (next === 'Monday' || next === 'Sunday') renderDayRows();
  });

  // A base location is an explicit user supplied convenience, copied into
  // available day inputs. Each day remains independent afterwards.
  baseLocationInput.addEventListener('change', () => {
    availabilityGrid.querySelectorAll('[data-location]').forEach((input) => {
      if (!input.disabled && !input.value.trim()) input.value = baseLocationInput.value;
    });
    updateValidation();
  });
  availabilityGrid.addEventListener('change', (event) => {
    const row = event.target.closest('.day-row');
    if (row && event.target.matches('[data-can-train]')) {
      row.dataset.configured = 'true';
      const details = row.querySelector('.day-details');
      const available = event.target.checked;
      const expand = row.querySelector('[data-expand]');
      if (expand) {
        expand.setAttribute('aria-expanded', String(available));
        expand.setAttribute('aria-label', `${t(available ? 'aiCoach.dayCollapse' : 'aiCoach.dayExpand')} ${row.querySelector('.day-label')?.textContent || ''}`.trim());
        expand.querySelector('[aria-hidden]')?.replaceChildren(document.createTextNode(available ? '⌃' : '⌄'));
      }
      if (!available && document.activeElement && details.contains(document.activeElement)) row.querySelector('[data-can-train]')?.focus();
      details.hidden = !available || expand?.getAttribute('aria-expanded') !== 'true';
      details.querySelectorAll('input, select').forEach((input) => { input.disabled = !available; });
      if (available) {
        const location = row.querySelector('[data-location]');
        if (location && !location.value.trim()) location.value = baseLocationInput.value;
      } else {
        details.querySelectorAll('[data-period]').forEach((input) => { input.checked = false; });
        row.querySelector('[data-duration]').value = '';
        row.querySelector('[data-location]').value = '';
      }
    }
    if (row && event.target.matches('[data-period], [data-duration], [data-location]')) row.dataset.configured = 'true';
    noteAvailabilityEdit();
    updateValidation();
  });
  availabilityGrid.addEventListener('input', () => {
    noteAvailabilityEdit();
    updateValidation();
  });
  availabilityGrid.addEventListener('click', (event) => {
    const expand = event.target.closest('[data-expand]');
    if (expand) {
      const row = expand.closest('.day-row');
      if (!row || expand.disabled) return;
      const details = row.querySelector('.day-details');
      const expanded = expand.getAttribute('aria-expanded') === 'true';
      if (expanded && details.contains(document.activeElement)) row.querySelector('[data-expand]')?.focus({ preventScroll: true });
      expand.setAttribute('aria-expanded', String(!expanded));
      details.hidden = expanded;
      expand.setAttribute('aria-label', `${t(expanded ? 'aiCoach.dayExpand' : 'aiCoach.dayCollapse')} ${row.querySelector('.day-label')?.textContent || ''}`.trim());
      expand.querySelector('[aria-hidden]')?.replaceChildren(document.createTextNode(expanded ? '⌄' : '⌃'));
      return;
    }
    if (!event.target.closest('#applyWeekdays')) return;
    const states = readFormFields();
    const monday = states.segunda;
    if (monday.can_train === null) {
      setAvailabilityStatus('availabilityNoMonday');
      return;
    }
    for (const day of ['terca', 'quarta', 'quinta', 'sexta']) states[day] = structuredClone(monday);
    renderDayRows(states);
    noteAvailabilityEdit();
    updateValidation();
  });
  saveAvailabilityButton.addEventListener('click', () => { void persistAvailability(); });

  document.addEventListener('app:languagechange', () => {
    const focusSnapshot = lastDailyFocus;
    renderDayRows(readFormFields(), { focusSnapshot });
    if (focusSnapshot) requestAnimationFrame(() => restoreDailyFocus(focusSnapshot));
    saveAvailabilityButton.textContent = t('aiCoach.saveAvailability');
    availabilityReview.textContent = t('aiCoach.availabilityReview');
    if (availabilityStatusKey) availabilityStatus.textContent = t(`aiCoach.${availabilityStatusKey}`);
    const targetIso = readTargetDateIso(targetDateInput, targetDatePicker, i18n.language);
    targetDateInput.dataset.iso = targetIso;
    targetDateInput.value = targetIso;
    targetDatePicker.refresh();
    updateValidation();
  });

  saveAvailabilityButton.textContent = t('aiCoach.saveAvailability');

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
    const disponibilidade = readFormFields();
    const validation = updateValidation();
    if (!validation.valid) return;
    const targetIso = readTargetDateIso(targetDateInput, targetDatePicker, i18n.language);
    const targetDate = parseInputDate(targetIso);
    const submittedSnapshot = currentAvailabilitySnapshot();

    generateBtn.disabled = true;
    if (!await persistAvailability()) {
      updateValidation();
      return;
    }
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
    if (currentAvailabilitySnapshot() !== submittedSnapshot) {
      setAvailabilityStatus('availabilityEditedDuringSave');
      updateValidation();
      return;
    }
    updateValidation();

    const preferences = getUserPreferences();
    const promptContext = buildPromptContext({ cycle: cycle || {}, trainings, targetDate, preferences });

    promptOutput.textContent = buildPrompt({
      targetDate,
      disponibilidade,
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
