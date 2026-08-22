'use strict';

const WEEKDAYS = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
];

const UNINFORMED = 'não informado';
const NO_DISCOMFORT = 'Nenhum relatado';

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatMetric(value) {
  return value === null || value === undefined ? '-' : String(value);
}

const TABLE_HEADER =
  '| Step | Lap | Time | Cumulative | Distance (km) | Avg Pace | Best Pace | Avg HR | Max HR | Ascent | Descent | Avg Cadence | Max Cadence | Stride (m) | Calories |';

const TABLE_DIVIDER = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';

function toRow(lap) {
  const cells = [
    lap.stepType,
    lap.lap,
    lap.durationLabel,
    lap.cumulativeLabel,
    lap.distanceLabel,
    lap.avgPaceLabel,
    lap.bestPaceLabel,
    formatMetric(lap.avgHeartRate),
    formatMetric(lap.maxHeartRate),
    formatMetric(lap.ascentMeters),
    formatMetric(lap.descentMeters),
    formatMetric(lap.avgCadenceSpm),
    formatMetric(lap.maxCadenceSpm),
    formatMetric(lap.strideMeters),
    formatMetric(lap.calories),
  ];
  return `| ${cells.map(escapeCell).join(' | ')} |`;
}

function buildLapsTable(laps) {
  if (!laps.length) return '_Nenhum dado detalhado de laps disponível._';
  return [TABLE_HEADER, TABLE_DIVIDER, ...laps.map(toRow)].join('\n');
}

function orUninformed(value) {
  if (value === null || value === undefined) return UNINFORMED;
  const text = String(value).trim();
  return text === '' ? UNINFORMED : escapeCell(text);
}

function orNoneReported(value) {
  if (value === null || value === undefined) return NO_DISCOMFORT;
  const text = String(value).trim();
  return text === '' ? NO_DISCOMFORT : escapeCell(text);
}

function rpeLabel(value) {
  return value === null || value === undefined ? UNINFORMED : `${value}/10`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseDate(iso) {
  if (typeof iso !== 'string') return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function plannedDate(iso) {
  const date = parseDate(iso);
  if (!date) return UNINFORMED;
  return `${pad2(date.getUTCDate())}/${pad2(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

function weekdayLabel(iso) {
  const date = parseDate(iso);
  return date ? WEEKDAYS[date.getUTCDay()] : UNINFORMED;
}

function timeOfDay(iso) {
  const date = parseDate(iso);
  return date ? `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}` : UNINFORMED;
}

function informedDuration(label) {
  return typeof label === 'string' && label !== '--:--' && label !== '' ? label : UNINFORMED;
}

function buildValues(summary, feedback) {
  const activity = summary.activity ?? {};
  const totals = summary.totals ?? {};
  const startTime = activity.startTime;
  return {
    '{{DATA}}': plannedDate(startTime),
    '{{DIA_SEMANA}}': weekdayLabel(startTime),
    '{{TIPO_TREINO}}': orUninformed(feedback.tipoTreino),
    '{{TREINO_PLANEJADO}}': orUninformed(feedback.treinoPlanejado),
    '{{FC_ALVO}}': orUninformed(feedback.fcAlvo),
    '{{RPE_ALVO}}': rpeLabel(feedback.rpeAlvo),
    '{{TENIS}}': orUninformed(feedback.tenis),
    '{{DURACAO}}': informedDuration(totals.durationLabel),
    '{{DISTANCIA}}': totals.distanceKm == null ? UNINFORMED : `${totals.distanceKm.toFixed(2)} km`,
    '{{PACE_MEDIO}}':
      totals.avgPaceSecondsPerKm == null ? UNINFORMED : `${totals.avgPaceLabel} min/km`,
    '{{FC_MEDIA}}': totals.avgHeartRate == null ? UNINFORMED : `${totals.avgHeartRate} bpm`,
    '{{FC_MAXIMA}}': totals.maxHeartRate == null ? UNINFORMED : `${totals.maxHeartRate} bpm`,
    '{{DESNIVEL_POSITIVO}}': totals.ascentMeters == null ? UNINFORMED : `${totals.ascentMeters} m`,
    '{{TENIS_UTILIZADO}}': orUninformed(feedback.tenis),
    '{{FONTE_FC}}': orUninformed(feedback.fonteFc),
    '{{CLIMA}}': orUninformed(feedback.clima),
    '{{TERRENO}}': orUninformed(feedback.terreno),
    '{{HORARIO}}': timeOfDay(startTime),
    '{{RPE_PERCEBIDO}}': rpeLabel(feedback.rpePercebido),
    '{{RESPIRACAO}}': orUninformed(feedback.respiracao),
    '{{SENSACAO_MUSCULAR}}': orUninformed(feedback.sensacaoMuscular),
    '{{ENERGIA_FINAL}}': orUninformed(feedback.energiaFinal),
    '{{DOR_DESCONFORTO}}': orNoneReported(feedback.dorDesconforto),
    '{{FEEDBACK}}': orUninformed(feedback.feedbackLivre),
    '{{ANEXAR_SCREENSHOT_GARMIN_OU_INSERIR_DADOS_DE_LAPS_AQUI}}': buildLapsTable(
      Array.isArray(summary.laps) ? summary.laps : [],
    ),
  };
}

const PROMPT_TEMPLATE = `Analise o treino de corrida abaixo considerando todo o histórico do meu treinamento, minha evolução recente, os treinos anteriores, o planejamento atual e minhas provas-alvo.

Quero que você aja como meu treinador de corrida e mantenha continuidade com o planejamento que já estamos seguindo.

DADOS DO TREINO PLANEJADO

Data: {{DATA}}
Dia da semana: {{DIA_SEMANA}}
Tipo de treino: {{TIPO_TREINO}}
Treino planejado: {{TREINO_PLANEJADO}}
FC alvo: {{FC_ALVO}}
RPE alvo: {{RPE_ALVO}}
Tênis: {{TENIS}}

DADOS DO TREINO REALIZADO

Duração total: {{DURACAO}}
Distância total: {{DISTANCIA}}
Pace médio: {{PACE_MEDIO}}
FC média: {{FC_MEDIA}}
FC máxima: {{FC_MAXIMA}}
Desnível positivo: {{DESNIVEL_POSITIVO}}
Tênis utilizado: {{TENIS_UTILIZADO}}

Fonte da frequência cardíaca:
{{FONTE_FC}}

Condições:
Temperatura e Clima: {{CLIMA}}
Terreno/percurso: {{TERRENO}}
Horário: {{HORARIO}}

Percepção do treino:
RPE percebido: {{RPE_PERCEBIDO}}
Respiração: {{RESPIRACAO}}
Sensação muscular: {{SENSACAO_MUSCULAR}}
Energia ao terminar: {{ENERGIA_FINAL}}

Dor ou desconforto:
{{DOR_DESCONFORTO}}

Feedback livre:
{{FEEDBACK}}

DADOS DETALHADOS

{{ANEXAR_SCREENSHOT_GARMIN_OU_INSERIR_DADOS_DE_LAPS_AQUI}}

INSTRUÇÕES PARA A ANÁLISE

1. Compare o treino realizado com o treino planejado.
2. Analise pace, FC, percepção de esforço, duração, distância, altimetria, cadência e demais métricas disponíveis.
3. Não interprete pace isoladamente. Considere altimetria, temperatura, vento, terreno e percepção de esforço.
4. Para treinos controlados, intervalados ou progressivos, analise cada bloco separadamente e compare a consistência entre os blocos.
5. Para longos, analise também deriva de FC, evolução do pace, fadiga muscular, energia no final e capacidade aparente de continuar.
6. Dê maior importância à percepção de esforço quando:
   - estiver muito quente;
   - houver muitas subidas;
   - a FC tiver sido medida apenas pelo sensor óptico;
   - houver sinais de leitura inconsistente da FC.
7. Considere meu histórico recente de dores/desconfortos e observe especialmente qualquer recorrência ou mudança de padrão. Não presuma que um desconforto antigo voltou se eu não relatar sintomas.
8. Diferencie desconforto passageiro, fadiga normal de treinamento e sinais que justifiquem redução/interrupção da carga. Não faça diagnóstico médico a partir dos dados.
9. Compare o treino com sessões semelhantes que já fiz anteriormente quando isso trouxer informação útil sobre minha evolução.
10. Avalie se o treino confirma, melhora ou piora nossa leitura atual do meu condicionamento e da preparação para minhas provas-alvo.
11. Não altere automaticamente os próximos treinos só porque o treino de hoje foi muito bom. A progressão deve continuar conservadora e coerente com a carga acumulada.
12. Se houver motivo para modificar o próximo treino ou o restante da semana, explique exatamente o que mudaria e por quê. Caso contrário, confirme que o planejamento permanece.
13. Quando houver dados suficientes, destaque tendências relevantes de evolução, mas não extrapole pace de intervalos diretamente para pace de prova.
14. Ao final, dê uma conclusão curta classificando o treino, por exemplo:
   - abaixo do esperado;
   - adequado;
   - bom;
   - muito bom;
   - excelente.
15. Termine informando:
   - estado de recuperação/carga que o treino sugere;
   - se o próximo treino permanece igual ou precisa ser ajustado;
   - qualquer ponto específico que devemos observar nas próximas 24–48 horas.

Não preciso que você repita todos os números que enviei. Quero interpretação, comparação com meu histórico e implicações para o planejamento.`;

function generateMarkdown(summary, feedback = {}) {
  const values = buildValues(summary ?? {}, feedback);
  return PROMPT_TEMPLATE.replace(/\{\{[A-Z_]+\}\}/g, (token) => values[token]);
}

module.exports = {
  PROMPT_TEMPLATE,
  generateMarkdown,
  escapeCell,
  formatMetric,
};
