import { formatDate as formatLocalizedDate } from './date.js';
import { formatDistance, distancePromptUnit, temperaturePromptUnit } from './units.js';

// Localized Portuguese and English briefings for the external AI Coach.
// Keep their meaning and placeholder contracts aligned; placeholders are
// replaced at generation time using the current account preferences/state.
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

Planeje treinos somente em dias marcados como disponíveis. Se algum dia estiver sem configuração estruturada, não presuma disponibilidade e peça confirmação. Cada dia disponível tem um único período preferencial; use-o como janela de horário local para a previsão horária. O tempo informado é o limite máximo total da sessão, incluindo aquecimento e volta à calma; não é meta. Nunca interprete a janela do período como duração do treino.

VERIFICAÇÃO OBRIGATÓRIA DA PREVISÃO DO TEMPO

Faça esta pesquisa autonomamente, usando as ferramentas de pesquisa e navegação disponíveis. Não peça ao usuário para confirmar fontes, localidade, datas, horários ou fuso, nem autorização para pesquisar. Se não houver ferramentas ou acesso, não afirme que pesquisou: informe essa limitação e continue o planejamento sem interromper para pedir confirmação.

Antes de marcar a previsão como indisponível:
1. Abra e consulte o conteúdo da página ou os dados da fonte de previsão; não use somente resumos de resultados de busca.
2. Verifique se os dados correspondem à localidade informada para aquele dia, à data local do treino e às horas necessárias do período preferencial. Confira o fuso horário da fonte, inclusive indicações locais no cabeçalho ou nos metadados.
3. Use o fuso da localidade do treino e o horário de verão vigente naquela data. Para localidades em Portugal continental, incluindo Fânzeres, Gondomar, use Europe/Lisbon. Converta horários quando a fonte identificar explicitamente outro fuso. Não aplique Europe/Lisbon a localidades de outros fusos.
4. Se a primeira fonte não permitir verificar localidade, data, cobertura horária ou fuso, consulte pelo menos uma segunda fonte de previsão horária, se houver ferramenta e acesso disponíveis.
5. Diferencie limitação da fonte consultada de ausência de previsão: falhar em verificar uma fonte não demonstra que não exista previsão em outra.

Selecione somente horas verificadas dentro do período preferencial daquele dia, sempre no horário local:
- Antes das 8h: 00:00 ≤ hora < 08:00.
- Entre 8h e 12h: 08:00 ≤ hora < 12:00.
- Entre 12h e 14h: 12:00 ≤ hora < 14:00.
- Entre 14h e 18h: 14:00 ≤ hora < 18:00.
- Após as 18h: 18:00 ≤ hora < 24:00, ainda na data local do treino.

Informe a faixa de temperaturas das horas verificadas, usando {{TEMPERATURE_UNIT_LABEL}}, e use a maior temperatura verificada nessa janela para avaliar o calor e ajustar o treino. Nunca substitua essa máxima pela máxima diária nem por temperaturas fora do período. Se a cobertura for parcial, declare a limitação; não apresente a maior temperatura observada como máxima de toda a janela sem cobertura suficiente.

O período é uma preferência de horário, não a duração disponível para treinar. Respeite separadamente o tempo máximo informado, incluindo aquecimento e volta à calma. Não invente um horário exato de início. Preserve a data efetiva de cada dia da semana e a localidade informada para esse dia.

Se, depois da pesquisa, os dados continuarem insuficientes, marque a previsão como indisponível e diga brevemente o que não foi verificado: localidade, data, cobertura horária ou fuso. Se o motivo for falta de ferramentas de navegação, falha de acesso ou data além do horizonte de previsão, informe-o. Não invente dados e não interrompa a elaboração da planilha para pedir confirmação ao usuário. Registre a previsão verificada ou a condição de indisponibilidade na coluna existente “Previsão do tempo”, sem alterar as 12 colunas nem o formato de importação do Kinesis. Cite a fonte consultada, preferencialmente com link direto, e a data e hora da consulta com o fuso correspondente na resposta que acompanha a planilha, não em novas colunas ou linhas. Preencha essa coluna no Excel antes de entregá-lo.

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
8. Não determine que eu persiga pace nas subidas. FC pode subir significativamente nesses trechos; considere principalmente esforço e respiração.
9. Considere temperatura e condições meteorológicas conforme a VERIFICAÇÃO OBRIGATÓRIA DA PREVISÃO DO TEMPO. Ajuste o treino ao calor quando necessário; não presuma condições quando a previsão estiver indisponível.
10. Não use máximas ou mínimas diárias como substitutas da previsão horária do período preferencial e não invente horário exato de início.
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

Use as datas efetivas da semana começando em {{DATA_DA_SEGUNDA}}, no formato DD/MM/YYYY. Calcule a data de cada treino pelo dia da semana, usando essa segunda-feira como referência: segunda +0 dias, terça +1, quarta +2, quinta +3, sexta +4, sábado +5 e domingo +6. Dias omitidos ou sem treino não alteram as datas dos demais; a ordem ou quantidade de linhas não determina a data. Mais de um treino no mesmo dia usa a mesma data. A previsão do tempo deve corresponder à mesma data local atribuída ao treino. Exemplo de cálculo (não é a semana solicitada): com início em 05/10/2026, treinos somente na segunda e na quarta usam 05/10/2026 e 07/10/2026. Em "Período", use o horário/período real esperado (ex: 12h–14h), sem inventar o horário exato de início. Em "Localização", copie exatamente a localidade informada para cada dia, preservando acentos, espaços, pontuação e nomes em outros idiomas, sem traduzir, normalizar, geocodificar, substituir pela localidade habitual ou inferir a partir da previsão do tempo. Em "Previsão do tempo", informe de maneira compacta {{WEATHER_EXAMPLE}} com a faixa observada e a máxima da janela quando a cobertura permitir; se indisponível ou parcial, registre também essa condição e seu motivo de forma breve. Não inclua linhas para musculação.

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

Plan sessions only on days marked available. If any day is unconfigured, do not assume availability and ask the user to confirm it. Each available day has one preferred training period; use it as the local-time window for the hourly forecast. The available time is the maximum total session duration, including warm-up and cool-down; it is a ceiling, not a target. Never interpret the period window as workout duration.

MANDATORY WEATHER FORECAST VERIFICATION

Perform this research autonomously using the available search and browsing tools. Do not ask the user to confirm sources, locations, dates, times, or time zones, or to authorize research. If browsing tools or access are unavailable, do not claim to have researched; state that limitation and continue planning without stopping to request confirmation.

Before marking the forecast unavailable:
1. Open and inspect the forecast page or source data; do not rely only on search-result summaries.
2. Verify that the data matches the location given for that day, the local training date, and the required hours in the preferred period. Check the source time zone, including local-time indications in its header or metadata.
3. Use the training location's time zone and the daylight-saving rules in effect on that date. For locations in mainland Portugal, including Fânzeres, Gondomar, use Europe/Lisbon. Convert times if the source explicitly identifies a different time zone. Do not apply Europe/Lisbon to locations in other time zones.
4. If the first source cannot verify the location, date, hourly coverage, or time zone, consult at least one second hourly-forecast source when tools and access are available.
5. Distinguish a limitation of the source consulted from a lack of forecasts: being unable to verify one source does not show that another has no forecast.

Select only verified hours within that day's preferred period, using local time:
- Before 08:00: 00:00 ≤ hour < 08:00.
- 08:00 to 12:00: 08:00 ≤ hour < 12:00.
- 12:00 to 14:00: 12:00 ≤ hour < 14:00.
- 14:00 to 18:00: 14:00 ≤ hour < 18:00.
- After 18:00: 18:00 ≤ hour < 24:00, still on the training's local date.

Report the temperature range for the verified hours in {{TEMPERATURE_UNIT_LABEL}}, and use the highest verified temperature in that window to assess heat and adjust the workout. Never replace this maximum with a daily maximum or temperatures outside the period. If coverage is partial, state that limitation; do not present the highest observed temperature as the maximum for the whole window without sufficient coverage.

The period is a time preference, not the available training duration. Separately respect the stated maximum time, including warm-up and cool-down. Do not invent an exact start time. Preserve the actual date of each weekday and the location supplied for that day.

If the data remain insufficient after research, mark the forecast unavailable and briefly state what could not be verified: location, date, hourly coverage, or time zone. If the reason is unavailable browsing tools, access failure, or a date beyond the forecast horizon, state that reason. Do not invent data or interrupt spreadsheet preparation to ask the user for confirmation. Record the verified forecast or unavailable condition in the existing “Weather Forecast” column without changing the 12 columns or the Kinesis import format. Cite the source, preferably with a direct link, and the lookup date and time with its time zone in the response accompanying the spreadsheet, not in new columns or rows. Fill this column in the Excel file before delivering it.

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
8. Do not dictate that I chase pace on uphills. HR may rise significantly in these sections; consider effort and breathing primarily.
9. Consider temperature and weather conditions according to MANDATORY WEATHER FORECAST VERIFICATION. Adapt the workout to heat when needed; do not assume conditions when the forecast is unavailable.
10. Do not use daily maxima or minima as a substitute for the hourly forecast in the preferred period, and do not invent an exact start time.
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

Use the actual dates of the week starting on {{DATA_DA_SEGUNDA}}, in DD/MM/YYYY format. Calculate each workout date from its weekday using that Monday as the reference: Monday +0 days, Tuesday +1, Wednesday +2, Thursday +3, Friday +4, Saturday +5, and Sunday +6. Omitted days or days without a workout do not change the dates of other workouts; row order or row count does not determine a date. Multiple workouts on the same weekday use the same date. The weather forecast must match the same local date assigned to the workout. Calculation example (not the requested week): for a week starting on 05/10/2026, workouts only on Monday and Wednesday use 05/10/2026 and 07/10/2026. In "Period", use the actual expected time/period (e.g., 12:00–14:00), without inventing an exact start time. In "Location", copy the location provided for each day exactly, preserving accents, spaces, punctuation, and names in other languages, without translating, normalizing, geocoding, replacing it with the usual location, or inferring it from the weather forecast. In "Weather Forecast", report compactly {{WEATHER_EXAMPLE}} with the observed range and window maximum when coverage supports it; if unavailable or partial, briefly record that status and its reason too. Do not include rows for strength training.

EXCEL FILE

After defining the plan, generate an Excel (.xlsx) file for download maintaining the visual style (highlighted header, readable text, adequate column width, text wrapping). Before generating the Excel, briefly analyze the recent load internally and determine whether the week represents maintenance, progression, or recovery.

STRICT RULE: NEVER add note rows, observations, footers, or merged cells inside the spreadsheet. The spreadsheet must EXCLUSIVELY contain the header row and the training rows. Any extra explanations must go only in the text of your response, never in the file.

In your response, provide:
1. a short explanation of the week's goal and what changed compared to the previous one;
2. the complete table;
3. the link to download the Excel file.
If recent data indicates that the originally expected plan should be altered, prioritize the correct adaptation rather than simply repeating the previous week's structure.`;

export const DAY_KEYS = ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo'];
export const DAY_DB_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
export const PERIOD_KEYS = ['before_08', '08_12', '12_14', '14_18', 'after_18'];
export const MAX_AVAILABLE_MINUTES = 720;
export const MAX_LOCATION_LENGTH = 200;

export function isValidAvailableMinutes(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_AVAILABLE_MINUTES;
}

export function getLocationValidationError(location) {
  if (typeof location !== 'string' || !location.trim()) return 'availabilityNeedsLocation';
  if (location.trim().length > MAX_LOCATION_LENGTH) return 'availabilityLocationTooLong';
  return null;
}

export function validateAvailabilityDay(record) {
  if (record?.can_train === false) return [];
  if (record?.can_train !== true) return ['availability'];
  const errors = [];
  if (!Array.isArray(record.available_periods) || record.available_periods.length !== 1 ||
      !record.available_periods.every((period) => PERIOD_KEYS.includes(period))) {
    errors.push('availabilityNeedsSinglePeriod');
  }
  if (!isValidAvailableMinutes(record.available_minutes)) errors.push('availabilityNeedsDuration');
  const locationError = getLocationValidationError(record.location);
  if (locationError) errors.push(locationError);
  return errors;
}

export const DAY_LOCALE_KEYS = {
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

export function contextValue(value) {
  return value === null || value === undefined || String(value).trim() === '' ? '-' : String(value).trim();
}

export function formatContextDate(value, lang) {
  return formatLocalizedDate(value, lang) || contextValue(value);
}

export function formatCycleContext(cycle = {}, previousWeek = {}, lang = 'pt-BR', preferences = {}) {
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

export function unitInstruction(lang, preferences = {}) {
  const distance = preferences.distance_unit === 'mi'
    ? (lang === 'pt-BR' ? 'milhas' : 'miles')
    : (lang === 'pt-BR' ? 'quilômetros' : 'kilometers');
  const temperature = preferences.temperature_unit === 'F' ? '°F' : '°C';
  if (lang === 'pt-BR') {
    return `Use ${distance} para todas as distâncias e ${temperature} para todas as temperaturas no plano e na previsão do tempo.`;
  }
  return `Use ${distance} for all distances and ${temperature} for all temperatures in the plan and weather forecast.`;
}

export function weatherExample(lang, preferences = {}) {
  const range = preferences.temperature_unit === 'F' ? '73–75 °F' : '23–24 °C';
  const windowHigh = preferences.temperature_unit === 'F' ? '75 °F' : '24 °C';
  return lang === 'pt-BR'
    ? `(ex.: ${range}, parcialmente nublado; janela 12h–14h, máxima da janela ${windowHigh})`
    : `(e.g., ${range}, partly cloudy; 12:00–14:00 window, window high ${windowHigh})`;
}

export const DAY_MS = 86400000;

export function isoDateValue(date) {
  return dateInputValue(date);
}

export function addDays(date, days) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setDate(result.getDate() + days);
  return result;
}

export function metricDurationSeconds(value) {
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
    // The form starts with unchecked days treated as unavailable. The API
    // still uses null for missing persisted rows and needsReview for the
    // unsaved first configuration.
    can_train: false, available_periods: [], available_minutes: null, location: '',
  }]));
}

export function replaceAll(text, token, value) {
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
    // The week anchor uses the same unambiguous day-first format required by
    // the Excel import schema in both prompt languages.
    formatDiaSlashes(targetDate)
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
    if (!Array.isArray(record.available_periods) || record.available_periods.length !== 1) {
      return `- ${dayName}: ${labels.availabilityNeedsSinglePeriod || 'Choose exactly one preferred period before planning'}`;
    }
    const period = (record.available_periods ?? [])[0];
    const periods = labels.periods?.[period] || period || '';
    const location = String(record.location ?? '');
    return `- ${dayName}: ${labels.canTrainLabel || 'Can train'}: ${labels.yes || 'yes'}; ${labels.periodsLabel || 'Periods available'}: ${periods}; ${labels.durationPromptLabel || 'Maximum session time'}: ${record.available_minutes} ${labels.minutes || 'minutes'}; ${labels.locationLabel || 'Location'}: ${location}`;
  });
  prompt = replaceAll(prompt, '{{AVAILABILITY_BLOCK}}', lines.join('\n'));
  const notes = String(contexto).trim();
  prompt = replaceAll(prompt, '{{CONTEXTO_OPCIONAL}}', notes === '' ? '-' : notes);
  prompt = replaceAll(prompt, '{{SHOES_BLOCK}}', formatShoesBlock(shoes, messages, preferences));
  return prompt;
}

export function parseInputDate(value) {
  const [year, month, day] = String(value ?? '').split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
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
