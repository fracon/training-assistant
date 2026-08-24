import { initShell, getShellI18n, refreshIcons } from './shared/shell.js';
import { translate } from './shared/i18n.js';

// Verbatim Portuguese briefing for the external AI Coach.
// The wording below is a hard requirement — do not translate, rewrite
// or "improve" it. Only the {{PLACEHOLDER}} tokens are replaced at
// generation time; the template itself stays Portuguese regardless of
// the UI language.
export const PROMPT_TEMPLATE = `Quero que você gere minha planilha de treinos de corrida para a próxima semana, dando continuidade ao planejamento que já estamos seguindo.

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

DISPONIBILIDADE

Segunda: {{DISP_SEG}}
Terça: {{DISP_TER}}
Quarta: {{DISP_QUA}}
Quinta: {{DISP_QUI}}
Sexta: {{DISP_SEX}}
Sábado: {{DISP_SAB}}
Domingo: {{DISP_DOM}}

Se eu não informar nenhuma restrição especial, considere minha rotina normal de corrida.

CONTEXTO ADICIONAL DESTA SEMANA

{{CONTEXTO_OPCIONAL}}

Exemplos:
- viagem;
- alteração de horário;
- pouco sono;
- fadiga;
- dor/desconforto;
- compromisso de trabalho;
- impossibilidade de correr determinado dia;
- preferência de tênis;
- qualquer outra circunstância relevante.

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
As colunas devem ser, nesta ordem: Data, Dia, Período, Tipo, Treino, Detalhes, FC alvo, RPE, Tênis, Previsão do tempo, Observações.

Exemplo estrutural:
| Data | Dia | Período | Tipo | Treino | Detalhes | FC alvo | RPE | Tênis | Previsão do tempo | Observações |

Use datas no formato DD/MM/YYYY. Em "Período", use o horário/período real esperado (ex: ~12h). Em "Previsão do tempo", informe de maneira compacta (ex: 23–24 °C, parcialmente nublado (~12h)). Não inclua linhas para musculação.

ARQUIVO EXCEL

Depois de definir o planejamento, gere um arquivo Excel (.xlsx) para download mantendo o estilo visual (cabeçalho destacado, texto legível, largura adequada, quebra automática). Antes de gerar o Excel, faça uma breve análise interna da carga recente e determine se a semana representa manutenção, progressão ou recuperação.

Na resposta, apresente:
1. uma explicação curta sobre o objetivo da semana e o que mudou em relação à anterior;
2. a tabela completa;
3. o link para download do arquivo Excel.`;

const DAY_KEYS = ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo'];
const DEFAULT_AVAILABILITY = 'Rotina normal';

export const PLACEHOLDERS = {
  segunda: '{{DISP_SEG}}',
  terca: '{{DISP_TER}}',
  quarta: '{{DISP_QUA}}',
  quinta: '{{DISP_QUI}}',
  sexta: '{{DISP_SEX}}',
  sabado: '{{DISP_SAB}}',
  domingo: '{{DISP_DOM}}',
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
  return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
}

// yyyy-mm-dd — the value format accepted by <input type="date">.
export function dateInputValue(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function availabilityDefaults() {
  return {
    segunda: DEFAULT_AVAILABILITY,
    terca: DEFAULT_AVAILABILITY,
    quarta: DEFAULT_AVAILABILITY,
    quinta: DEFAULT_AVAILABILITY,
    sexta: DEFAULT_AVAILABILITY,
    sabado: DEFAULT_AVAILABILITY,
    domingo: DEFAULT_AVAILABILITY,
  };
}

function replaceAll(text, token, value) {
  return text.split(token).join(value);
}

export function buildPrompt({ targetDate, disponibilidade = {}, contexto = '' }) {
  let prompt = replaceAll(
    PROMPT_TEMPLATE,
    '{{DATA_DA_SEGUNDA}}',
    formatDiaSlashes(targetDate)
  );
  const availability = { ...availabilityDefaults(), ...disponibilidade };
  for (const day of DAY_KEYS) {
    prompt = replaceAll(prompt, PLACEHOLDERS[day], String(availability[day] ?? '').trim());
  }
  const notes = String(contexto).trim();
  return replaceAll(prompt, '{{CONTEXTO_OPCIONAL}}', notes === '' ? '-' : notes);
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

const DAY_INPUT_IDS = {
  segunda: 'dispSeg',
  terca: 'dispTer',
  quarta: 'dispQua',
  quinta: 'dispQui',
  sexta: 'dispSex',
  sabado: 'dispSab',
  domingo: 'dispDom',
};

const COPY_FEEDBACK_MS = 2000;

function setupAiCoachPage() {
  let i18n = null;

  function t(key) {
    return translate(i18n ? i18n.messages : {}, key);
  }

  const form = document.getElementById('promptForm');
  const targetDateInput = document.getElementById('targetDate');
  const optionalContextInput = document.getElementById('optionalContext');
  const resultSection = document.getElementById('resultSection');
  const resultPlaceholder = document.getElementById('resultPlaceholder');
  const promptOutput = document.getElementById('promptOutput');
  const copyBtn = document.getElementById('copyBtn');
  const copyIconSlot = copyBtn.querySelector('.copy-icon');
  const copyLabel = document.getElementById('copyLabel');

  targetDateInput.value = dateInputValue(nextMonday());

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

  function handleGenerate(event) {
    event.preventDefault();
    const disponibilidade = {};
    for (const [day, inputId] of Object.entries(DAY_INPUT_IDS)) {
      const input = document.getElementById(inputId);
      if (input) disponibilidade[day] = input.value;
    }
    const targetDate =
      parseInputDate(targetDateInput.value) ?? nextMonday();
    promptOutput.textContent = buildPrompt({
      targetDate,
      disponibilidade,
      contexto: optionalContextInput.value,
    });
    resultSection.classList.remove('hidden');
    resultPlaceholder.classList.add('hidden');
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
