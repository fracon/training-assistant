'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const publicDir = join(__dirname, '..', 'src', 'public');

const {
  resolveSessionId,
  formatDateLabel,
  plannedValue,
  normalizeFeedbackRpe,
  isFitFieldVisible,
  weekdayLabel,
  resolveTemplateLang,
  templateFor,
  buildAnalysisPrompt,
  collectPromptValues,
  painPromptText,
  copyAnalysisPrompt,
  escapeHtmlText,
  fitDropzonePrimaryHtml,
  PROMPT_TEMPLATE_PT,
  PROMPT_TEMPLATE_EN,
} = require('../src/public/training-result.js');
const en = require('../src/public/locales/en.json');
const pt = require('../src/public/locales/pt.json');

test('resolveSessionId extracts the contextual id from the query string', () => {
  assert.equal(resolveSessionId('?id=42'), '42');
  assert.equal(resolveSessionId('?id=%20%207%20'), '7', 'surrounding whitespace is trimmed');
});

test('resolveSessionId bounces to the calendar when no id is present', () => {
  for (const search of ['', '?', '?other=1', '?id=', '?id=%20%20']) {
    assert.equal(resolveSessionId(search), null, `search=${search || '<empty>'}`);
  }
});

test('formatDateLabel renders DD/MM/YYYY labels', () => {
  assert.equal(formatDateLabel('2026-08-24'), '24/08/2026');
  assert.equal(formatDateLabel('1999-12-01'), '01/12/1999');
});

test('formatDateLabel degrades gracefully on unexpected dia values', () => {
  for (const value of [null, undefined, '', 'junk', '2026-8-4', '2026-08-24T07:00:00']) {
    assert.equal(formatDateLabel(value), '', `value=${String(value)}`);
  }
});

test('plannedValue renders a dash placeholder for empty planned fields', () => {
  const training = { tipo: 'Corrida', treino: null, detalhes: '', rpe: 4 };
  assert.equal(plannedValue(training, 'tipo'), 'Corrida');
  assert.equal(plannedValue(training, 'rpe'), '4', 'numbers are stringified');
  assert.equal(plannedValue(training, 'treino'), '-');
  assert.equal(plannedValue(training, 'detalhes'), '-');
  assert.equal(plannedValue(training, 'fc_alvo'), '-');
  assert.equal(plannedValue(undefined, 'tipo'), '-');
});

test('normalizeFeedbackRpe keeps blank answers as null and valid integers as numbers', () => {
  assert.equal(normalizeFeedbackRpe(''), null);
  assert.equal(normalizeFeedbackRpe('   '), null);
  assert.equal(normalizeFeedbackRpe(null), null);
  assert.equal(normalizeFeedbackRpe(undefined), null);
  assert.equal(normalizeFeedbackRpe('3'), 3);
  assert.equal(normalizeFeedbackRpe(' 4 '), 4);
  assert.equal(normalizeFeedbackRpe(5), 5);
});

test('normalizeFeedbackRpe flags out-of-range or non-integer answers', () => {
  for (const raw of ['0', '6', '-1', '2.5', 'abc']) {
    assert.ok(Number.isNaN(normalizeFeedbackRpe(raw)), `raw=${raw}`);
  }
});

test('.FIT upload visibility follows the smartwatch answer', () => {
  assert.equal(isFitFieldVisible('sim'), true);
  assert.equal(isFitFieldVisible('nao'), false);
  assert.equal(isFitFieldVisible(''), false);
  assert.equal(isFitFieldVisible(undefined), false);
});

test('weekdayLabel resolves localized weekday names from ISO dates', () => {
  assert.equal(weekdayLabel('2026-08-24', 'pt-BR'), 'segunda-feira');
  assert.equal(weekdayLabel('2026-08-24', 'en-US'), 'Monday');
  assert.equal(
    weekdayLabel('2026-08-23', 'pt-BR'),
    'domingo',
    'local parsing never shifts the day across timezones'
  );
});

test('weekdayLabel degrades gracefully on unexpected dia values', () => {
  assert.equal(weekdayLabel(null, 'pt-BR'), '');
  assert.equal(weekdayLabel('junk', 'pt-BR'), '');
});

test('resolveTemplateLang keeps Portuguese as the fallback language', () => {
  assert.equal(resolveTemplateLang('pt-BR'), 'pt-BR');
  assert.equal(resolveTemplateLang('en-US'), 'en-US');
  assert.equal(resolveTemplateLang('fr-FR'), 'pt-BR');
  assert.equal(resolveTemplateLang(undefined), 'pt-BR');
});

test('templateFor picks the verbatim bilingual briefing', () => {
  assert.equal(templateFor('pt-BR'), PROMPT_TEMPLATE_PT);
  assert.equal(templateFor('en-US'), PROMPT_TEMPLATE_EN);
  assert.equal(templateFor('es-ES'), PROMPT_TEMPLATE_PT, 'unknown languages fall back to Portuguese');
});

const SHARED_PLACEHOLDERS = [
  'DATA',
  'DIA_SEMANA',
  'TIPO_TREINO',
  'TREINO_PLANEJADO',
  'FC_ALVO',
  'RPE_ALVO',
  'TENIS',
  'DURACAO',
  'DISTANCIA',
  'PACE_MEDIO',
  'FC_MEDIA',
  'FC_MAXIMA',
  'DESNIVEL_POSITIVO',
  'TENIS_UTILIZADO',
  'FONTE_FC',
  'TEMPERATURA_CLIMA',
  'TERRENO',
  'RPE_PERCEBIDO',
  'RESPIRACAO',
  'SENSACAO_MUSCULAR',
  'ENERGIA_FINAL',
  'DOR_DESCONFORTO',
  'FEEDBACK',
  'ANEXAR_SCREENSHOT_GARMIN_OU_INSERIR_DADOS_DE_LAPS_AQUI',
];

function placeholdersOf(template) {
  return [...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((match) => match[1]);
}

test('both prompt templates carry the identical shared placeholder contract', () => {
  const ptPlaceholders = placeholdersOf(PROMPT_TEMPLATE_PT);
  const enPlaceholders = placeholdersOf(PROMPT_TEMPLATE_EN);

  assert.deepEqual([...new Set(ptPlaceholders)], SHARED_PLACEHOLDERS);
  assert.deepEqual([...new Set(enPlaceholders)], SHARED_PLACEHOLDERS);

  for (const key of SHARED_PLACEHOLDERS) {
    assert.equal(
      ptPlaceholders.filter((token) => token === key).length,
      1,
      `${key} appears exactly once in the PT template`
    );
    assert.equal(
      enPlaceholders.filter((token) => token === key).length,
      1,
      `${key} appears exactly once in the EN template`
    );
  }
});

test('the embedded briefings stay verbatim with their fifteen instructions', () => {
  assert.match(PROMPT_TEMPLATE_PT, /^Analise o treino de corrida abaixo considerando todo o histórico/);
  assert.match(PROMPT_TEMPLATE_EN, /^Analyze the running workout below considering my entire training history/);

  for (let step = 1; step <= 15; step += 1) {
    assert.match(PROMPT_TEMPLATE_PT, new RegExp(`^${step}\\. `, 'm'));
    assert.match(PROMPT_TEMPLATE_EN, new RegExp(`^${step}\\. `, 'm'));
  }

  assert.ok(PROMPT_TEMPLATE_PT.includes('nas próximas 24–48 horas.'));
  assert.ok(PROMPT_TEMPLATE_EN.includes('over the next 24-48 hours.'));

  assert.match(PROMPT_TEMPLATE_PT, /Não preciso que você repita todos os números que enviei\./);
  assert.match(PROMPT_TEMPLATE_EN, /I do not need you to repeat all the numbers I sent\./);
});

test('buildAnalysisPrompt fills every placeholder and dashes out blank answers', () => {
  const values = Object.fromEntries(SHARED_PLACEHOLDERS.map((key, index) => [key, index === 0 ? '' : `v-${index}`]));
  const output = buildAnalysisPrompt(PROMPT_TEMPLATE_PT, values);

  assert.ok(!output.includes('{{'), 'no placeholder survives');
  assert.ok(output.includes('Data: -'), 'blank values become dashes');
  assert.ok(output.includes('Dia da semana: v-1'));

  const numeric = buildAnalysisPrompt('RPE percebido: {{RPE_PERCEBIDO}}', { RPE_PERCEBIDO: 4 });
  assert.equal(numeric, 'RPE percebido: 4', 'numbers are stringified');
});

test('buildAnalysisPrompt leaves unrelated prose untouched', () => {
  const output = buildAnalysisPrompt('Pace médio: {{PACE_MEDIO}} e nada mais', { PACE_MEDIO: '4:30/km' });
  assert.equal(output, 'Pace médio: 4:30/km e nada mais');
});

function baseForm(overrides = {}) {
  return {
    feedback_rpe: 3,
    feedback_notas: 'Boa sensação',
    feedback_shoe: 'Nimbus 26',
    hr_source_label: 'Cinta peitoral',
    terrain_label: 'Asfalto',
    feedback_weather: '22°C nublado',
    feedback_breathing: 'controlled',
    breathing_label: 'Controlada',
    feedback_muscle: 'light',
    muscle_label: 'Leve',
    feedback_energy: 'surplus',
    energy_label: 'Sobrava energia',
    feedback_has_pain: 'yes',
    feedback_pain: 'Pontada leve no Aquiles direito',
    pain_description: 'Pontada leve no Aquiles direito',
    language: 'pt-BR',
    fitAttached: false,
    ...overrides,
  };
}

const baseTraining = {
  dia: '2026-08-24',
  periodo: 'Manhã',
  tipo: 'Corrida',
  treino: '6 × 1 km forte',
  detalhes: 'Aquecer 15 min',
  fc_alvo: '150-160 bpm',
  rpe: '4',
  tenis: 'Nimbus 26',
};

test('collectPromptValues maps planned data, form state and FIT placeholders', () => {
  const values = collectPromptValues({ training: baseTraining, form: baseForm() });

  assert.equal(values.DATA, '24/08/2026');
  assert.equal(values.DIA_SEMANA, 'segunda-feira');
  assert.equal(values.TIPO_TREINO, 'Corrida');
  assert.equal(values.TREINO_PLANEJADO, '6 × 1 km forte');
  assert.equal(values.FC_ALVO, '150-160 bpm');
  assert.equal(values.RPE_ALVO, '4');
  assert.equal(values.TENIS, 'Nimbus 26');

  for (const metric of ['DURACAO', 'DISTANCIA', 'PACE_MEDIO', 'FC_MEDIA', 'FC_MAXIMA', 'DESNIVEL_POSITIVO']) {
    assert.equal(values[metric], '-', `${metric} stays dashed until FIT parsing lands`);
  }

  assert.equal(values.TENIS_UTILIZADO, 'Nimbus 26');
  assert.equal(values.FONTE_FC, 'Cinta peitoral');
  assert.equal(values.TEMPERATURA_CLIMA, '22°C nublado');
  assert.equal(values.TERRENO, 'Asfalto');
  assert.equal(values.RPE_PERCEBIDO, 3);
  assert.equal(
    values.RESPIRACAO,
    'Controlada',
    'the prompt shows the localized breathing label, not the stored token'
  );
  assert.equal(values.SENSACAO_MUSCULAR, 'Leve');
  assert.equal(values.ENERGIA_FINAL, 'Sobrava energia');
  assert.equal(
    values.DOR_DESCONFORTO,
    'Pontada leve no Aquiles direito',
    'a reported pain flows straight into the briefing'
  );
  assert.equal(values.FEEDBACK, 'Boa sensação');
  assert.equal(values.ANEXAR_SCREENSHOT_GARMIN_OU_INSERIR_DADOS_DE_LAPS_AQUI, '-');
});

test('painPromptText reports no pain unless the user answered yes', () => {
  const t = (key) => `t:${key}`;

  for (const answer of ['no', '', null, undefined, 'junk']) {
    assert.equal(
      painPromptText(answer, 'ignored description', t),
      't:feedback.noPainReported',
      `answer=${String(answer)} renders the no-pain marker`
    );
  }
});

test('painPromptText shows the description for a yes answer', () => {
  const t = (key) => `t:${key}`;

  assert.equal(painPromptText('yes', 'Pontada no Aquiles', t), 'Pontada no Aquiles');
  assert.equal(painPromptText('yes', '  Pontada no Aquiles  ', t), 'Pontada no Aquiles', 'descriptions are trimmed');
});

test('painPromptText marks a bare yes without any typed description', () => {
  const t = (key) => `t:${key}`;

  assert.equal(painPromptText('yes', '', t), 't:feedback.yesWithoutDescription');
  assert.equal(painPromptText('yes', '   ', t), 't:feedback.yesWithoutDescription', 'whitespace-only descriptions count as blank');
  assert.equal(painPromptText('yes', null, t), 't:feedback.yesWithoutDescription');
  assert.equal(painPromptText('yes', undefined, t), 't:feedback.yesWithoutDescription');
});

test('collectPromptValues points detailed data at the attachment only with a FIT file', () => {
  const attached = collectPromptValues({
    training: baseTraining,
    form: baseForm({ fitAttached: true }),
  });
  assert.equal(attached.ANEXAR_SCREENSHOT_GARMIN_OU_INSERIR_DADOS_DE_LAPS_AQUI, 'Ver anexo');

  const english = collectPromptValues({
    training: baseTraining,
    form: baseForm({ language: 'en-US' }),
  });
  assert.equal(english.DIA_SEMANA, 'Monday');
});

test('copyAnalysisPrompt writes through the Clipboard API and reports failures', async () => {
  let written = null;
  const clipboard = {
    writeText: async (text) => {
      written = text;
    },
  };

  assert.equal(await copyAnalysisPrompt('prompt-text', clipboard), true);
  assert.equal(written, 'prompt-text');
});

test('copyAnalysisPrompt tolerates rejections and missing clipboards', async () => {
  assert.equal(
    await copyAnalysisPrompt('x', {
      writeText: async () => {
        throw new Error('denied');
      },
    }),
    false
  );
  assert.equal(await copyAnalysisPrompt('x', undefined), false);
  assert.equal(await copyAnalysisPrompt('x', {}), false);
});

test('escapeHtmlText neutralizes HTML-significant characters', () => {
  assert.equal(escapeHtmlText('nimbus.fit'), 'nimbus.fit');
  assert.equal(escapeHtmlText('a<b>&"\'c'), 'a&lt;b&gt;&amp;&quot;&#39;c');
  assert.equal(escapeHtmlText(null), '');
  assert.equal(escapeHtmlText(undefined), '');
  assert.equal(escapeHtmlText(42), '42');
});

test('fitDropzonePrimaryHtml renders the drag invitation while empty', () => {
  const translate = (key) => (key === 'session.fitDragText' ? 'Drag your <strong>.FIT</strong> file here' : key);
  assert.equal(
    fitDropzonePrimaryHtml({ files: [], translate }),
    'Drag your <strong>.FIT</strong> file here'
  );
  assert.equal(fitDropzonePrimaryHtml({ files: null, translate }), translate('session.fitDragText'));
});

test('fitDropzonePrimaryHtml announces the chosen file with an escaped name', () => {
  const translate = (key) => (key === 'session.fitSelected' ? 'File selected: ' : key);
  const files = [{ name: '<img src=x onerror=alert(1)>.fit' }];
  assert.equal(
    fitDropzonePrimaryHtml({ files, translate }),
    'File selected: <strong>&lt;img src=x onerror=alert(1)&gt;.fit</strong>'
  );
});

test('training-result.html ships the expanded feedback grid and generator button', () => {
  const html = readFileSync(join(publicDir, 'training-result.html'), 'utf8');

  assert.match(html, /<link rel="stylesheet" href="shared\/shell.css">/);
  assert.match(html, /<link rel="stylesheet" href="training-result.css">/);
  assert.match(html, /<script src="training-result\.js" type="module"><\/script>/);

  assert.match(html, /<div class="feedback-grid">/);
  assert.match(html, /<select id="smartwatchSelect" class="input-control">/);
  assert.match(html, /<option value="sim" selected data-i18n="session\.smartwatchYes">Yes<\/option>/);
  assert.match(html, /<option value="nao" data-i18n="session\.smartwatchNo">No<\/option>/);
  assert.match(html, /<div class="field fit-field" id="fitField">/);
  assert.match(
    html,
    /<label for="fitFile" class="file-dropzone" id="fitDropzone">/,
    'the FIT input is wrapped in a styled drag-and-drop dropzone'
  );
  assert.match(
    html,
    /<input type="file" id="fitFile" accept="\.fit" style="display: none;">/,
    'the native input stays in the DOM but is visually hidden'
  );
  assert.match(
    html,
    /<span data-i18n-html="session\.fitDragText">Drag your <strong>\.FIT<\/strong> file here<\/span>/,
    'the primary dropzone line ships translated markup'
  );
  assert.match(
    html,
    /<div class="dropzone-text-secondary" data-i18n="session\.fitClickText">or click to select from your computer<\/div>/
  );
  assert.match(
    html,
    /id="smartwatchSelect"[\s\S]*?class="field fit-field" id="fitField"/,
    'the dropzone is laid out after the smartwatch answer'
  );

  for (const id of [
    'feedbackShoe',
    'hrSourceSelect',
    'feedbackWeather',
    'feedbackTerrain',
    'feedbackBreathing',
    'feedbackMuscle',
    'feedbackEnergy',
    'feedbackPain',
    'feedbackRpe',
    'feedbackNotas',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} exists`);
  }

  assert.match(
    html,
    /<select id="feedbackTerrain" class="input-control">/,
    'terrain is a closed dropdown, not a free text input'
  );
  assert.ok(
    !html.includes('id="feedbackTerrain" type="text"') &&
      !/<input[^>]*id="feedbackTerrain"/.test(html),
    'no free-text terrain input remains'
  );
  assert.match(
    html,
    /<select id="feedbackTerrain" class="input-control">\s*\n\s*<option value="">–<\/option>/
  );
  for (const [value, key] of [
    ['asphalt', 'terrain.asphalt'],
    ['trail', 'terrain.trail'],
    ['track', 'terrain.track'],
    ['treadmill', 'terrain.treadmill'],
    ['mixed', 'terrain.mixed'],
  ]) {
    assert.match(html, new RegExp(`<option value="${value}" data-i18n="${key}">`));
  }
  assert.ok(!html.includes('session.terrainPlaceholder'), 'dead placeholder binding removed');

  const CLOSED_FEEDBACK_SELECTS = [
    [
      'feedbackBreathing',
      [
        ['controlled', 'breathing.controlled'],
        ['panting', 'breathing.panting'],
        ['heavy', 'breathing.heavy'],
      ],
    ],
    [
      'feedbackMuscle',
      [
        ['light', 'muscle.light'],
        ['normal', 'muscle.normal'],
        ['heavy', 'muscle.heavy'],
        ['fatigued', 'muscle.fatigued'],
      ],
    ],
    [
      'feedbackEnergy',
      [
        ['surplus', 'energy.surplus'],
        ['limit', 'energy.limit'],
        ['exhausted', 'energy.exhausted'],
      ],
    ],
  ];
  for (const [id, options] of CLOSED_FEEDBACK_SELECTS) {
    assert.match(
      html,
      new RegExp(`<select id="${id}" class="input-control">`),
      `${id} is a closed dropdown, not a free text input`
    );
    assert.ok(
      !html.includes(`id="${id}" type="text"`) && !new RegExp(`<input[^>]*id="${id}"`).test(html),
      `no free-text ${id} input remains`
    );
    assert.match(
      html,
      new RegExp(`<select id="${id}" class="input-control">\\s*\\n\\s*<option value="">–</option>`),
      `${id} starts with an empty default option`
    );
    for (const [value, key] of options) {
      assert.match(html, new RegExp(`<option value="${value}" data-i18n="${key}">`));
    }
  }
  for (const deadKey of [
    'session.breathingPlaceholder',
    'session.musclePlaceholder',
    'session.energyPlaceholder',
    'session.fieldPain',
    'session.painPlaceholder',
  ]) {
    assert.ok(!html.includes(deadKey), `${deadKey} binding removed`);
  }
  assert.ok(
    !/<input[^>]*id="feedbackPain"/.test(html),
    'the free-text pain input became a textarea inside the conditional block'
  );

  assert.match(
    html,
    /<select id="feedbackHasPain" class="input-control">/,
    'pain starts as a yes/no question, not an open text field'
  );
  assert.match(
    html,
    /<option value="no" data-i18n="common\.no">No<\/option>\s*\n\s*<option value="yes" data-i18n="common\.yes">Yes<\/option>/
  );
  assert.match(
    html,
    /<div class="field field-wide pain-field" id="painDescriptionContainer" hidden>/,
    'the pain description ships hidden until pain is reported'
  );
  assert.match(
    html,
    /data-i18n="feedback\.hasPainLabel"/,
    'the yes/no question label is translated'
  );
  assert.match(
    html,
    /data-i18n="feedback\.painDescriptionLabel"/,
    'the description label is translated'
  );
  assert.match(
    html,
    /<textarea id="feedbackPain" rows="3" class="input-control"[\s\S]*?data-i18n-placeholder="feedback\.painPlaceholder"><\/textarea>/
  );

  assert.match(
    html,
    /data-i18n="session\.freeFeedbackLabel">Free feedback<\/label>/,
    'the free feedback label uses its dedicated translation key'
  );
  assert.match(
    html,
    /placeholder="How was the workout\? Sleep, weather, general sensations\.\.\."\s*\n\s*data-i18n-placeholder="session\.freeFeedbackPlaceholder"/,
    'the free feedback textarea ships the restored placeholder'
  );
  assert.ok(!html.includes('session.notesLabel'), 'dead notes label binding removed');
  assert.ok(!html.includes('session.notesPlaceholder'), 'dead notes placeholder binding removed');

  for (const optionKey of ['session.hrSourceStrap', 'session.hrSourceOptical', 'session.hrSourceNone']) {
    assert.match(html, new RegExp(`data-i18n="${optionKey}"`), `${optionKey} translated`);
  }

  assert.match(html, /<div class="form-actions">/);
  assert.match(html, /<button id="generateBtn" class="btn-primary" type="button">/);
  assert.match(
    html,
    /<i data-lucide="sparkles"[^>]*><\/i>\s*<span data-i18n=/,
    'the icon renders directly before the label span'
  );
  assert.match(html, /<i data-lucide="sparkles" aria-hidden="true"><\/i>/);
  assert.match(html, /data-i18n="session\.generatePrompt"/);
  assert.match(html, /<button id="saveBtn" class="btn-secondary" type="button"/);

  for (const legacy of ['id="dropzone"', 'id="fileInput"', 'markdownPreview', 'copyBtn', 'form-state.js']) {
    assert.ok(!html.includes(legacy), `${legacy} is gone from the refactored page`);
  }
});

test('training-result.js wires toggling, saving, generation and i18n refreshes', () => {
  const js = readFileSync(join(publicDir, 'training-result.js'), 'utf8');

  assert.match(js, /import \{ initShell, getShellI18n \} from '\.\/shared\/shell\.js';/);
  assert.match(js, /import \{ fetchTraining, saveTrainingFeedback \} from '\.\/shared\/api\.js';/);

  assert.match(js, /smartwatchSelect\.addEventListener\('change', syncFitFieldVisibility\)/);
  assert.match(js, /fitField\.hidden = !isFitFieldVisible\(smartwatchSelect\.value\);/);

  assert.match(
    js,
    /const fitFileInput = document\.getElementById\('fitFile'\);/,
    'the dropzone wraps the visually hidden native input'
  );
  assert.match(js, /const fitDropzone = document\.getElementById\('fitDropzone'\);/);
  assert.match(js, /fitDropzone\.querySelector\('\.dropzone-text-primary'\)/);
  assert.match(
    js,
    /fitDropzonePrimaryHtml\(\{\s*\n\s*files: fitFileInput\.files,\s*\n\s*translate: t,\s*\n\s*\}\)/,
    'the primary line renders from the shared helper with live translations'
  );
  assert.match(js, /fitDropzonePrimary\.innerHTML = /);
  assert.match(js, /fitFileInput\.addEventListener\('change', renderFitDropzoneState\)/);
  assert.match(
    js,
    /fitDropzone\.addEventListener\('dragover', \(\) => fitDropzone\.classList\.add\('drag-active'\)\)/
  );
  assert.match(
    js,
    /fitDropzone\.addEventListener\('dragleave', \(\) =>\s*\n\s*fitDropzone\.classList\.remove\('drag-active'\)\s*\n\s*\)/
  );
  assert.match(
    js,
    /fitDropzone\.addEventListener\('drop', \(\) => fitDropzone\.classList\.remove\('drag-active'\)\)/,
    'drag highlight clears whether the drop is accepted or not'
  );

  assert.match(
    js,
    /hasPainSelect\.addEventListener\('change', syncPainVisibility\)/,
    'the pain answer drives the description visibility'
  );
  assert.match(js, /const showDescription = hasPainSelect\.value === 'yes';/);
  assert.match(js, /painDescriptionField\.hidden = !showDescription;/);
  assert.match(
    js,
    /if \(!showDescription\) \{\s*\n\s*painInput\.value = '';\s*\n\s*\}/,
    'answering no discards any typed description'
  );

  assert.match(js, /rpeInput\.value = training\.feedback_rpe \?\? '';/);
  assert.match(js, /shoeInput\.value = training\.feedback_shoe \?\? '';/);
  assert.match(js, /weatherInput\.value = training\.feedback_weather \?\? '';/);
  assert.match(js, /terrainInput\.value = training\.feedback_terrain \?\? '';/);
  assert.match(js, /breathingInput\.value = training\.feedback_breathing \?\? '';/);
  assert.match(js, /muscleInput\.value = training\.feedback_muscle \?\? '';/);
  assert.match(js, /energyInput\.value = training\.feedback_energy \?\? '';/);
  assert.match(
    js,
    /training\.feedback_has_pain === 'yes' \|\|\s*\n\s*\(training\.feedback_has_pain === null && Boolean\(training\.feedback_pain\)\)/,
    'saved answers reopen the description; legacy descriptions imply yes'
  );
  assert.match(js, /hasPainSelect\.value = savedHasPain \? 'yes' : 'no';/);
  assert.match(js, /painInput\.value = training\.feedback_pain \?\? '';/);
  assert.match(js, /hrSourceSelect\.value = training\.feedback_hr_source \?\? '';/);
  assert.match(js, /syncFitFieldVisibility\(\);\s*\n\s*syncPainVisibility\(\);\s*\n\s*setStatus\(''\);/);

  assert.match(js, /has_smartwatch: isFitFieldVisible\(smartwatchSelect\.value\),/);
  assert.match(js, /feedback_hr_source: hrValue === '' \? null : hrValue,/);
  assert.match(js, /feedback_terrain: terrainInput\.value === '' \? null : terrainInput\.value,/);
  assert.match(js, /feedback_breathing:\s*\n\s*breathingInput\.value === '' \? null : breathingInput\.value,/);
  assert.match(js, /feedback_muscle: muscleInput\.value === '' \? null : muscleInput\.value,/);
  assert.match(js, /feedback_energy: energyInput\.value === '' \? null : energyInput\.value,/);
  assert.match(js, /const hasPainValue = hasPainSelect\.value;/);
  assert.match(
    js,
    /feedback_has_pain: hasPainValue === 'yes' \? 'yes' : 'no',/,
    'the pain answer persists as a yes/no token'
  );
  assert.match(
    js,
    /feedback_pain: hasPainValue === 'yes' \? painInput\.value : '',/,
    'descriptions are ignored unless pain was reported'
  );
  assert.match(
    js,
    /pain_description: painPromptText\(hasPainValue, painInput\.value, t\),/,
    'the briefing text is derived from the shared pain helper'
  );
  assert.match(js, /const terrainKey = TERRAIN_LABEL_KEYS\[terrainInput\.value\];/);
  assert.match(
    js,
    /const breathingKey = BREATHING_LABEL_KEYS\[breathingInput\.value\];/,
    'breathing tokens resolve through the closed option map'
  );
  assert.match(
    js,
    /const muscleKey = MUSCLE_LABEL_KEYS\[muscleInput\.value\];/,
    'muscle tokens resolve through the closed option map'
  );
  assert.match(
    js,
    /const energyKey = ENERGY_LABEL_KEYS\[energyInput\.value\];/,
    'energy tokens resolve through the closed option map'
  );
  assert.match(js, /terrain_label: terrainKey \? t\(terrainKey\) : '',/);
  assert.match(js, /breathing_label: breathingKey \? t\(breathingKey\) : '',/);
  assert.match(js, /muscle_label: muscleKey \? t\(muscleKey\) : '',/);
  assert.match(js, /energy_label: energyKey \? t\(energyKey\) : '',/);
  assert.match(
    js,
    /TERRENO: form\.terrain_label,/,
    'the prompt shows the localized terrain label, not the stored token'
  );
  assert.match(
    js,
    /RESPIRACAO: form\.breathing_label,/,
    'the prompt shows the localized breathing label, not the stored token'
  );
  assert.match(
    js,
    /SENSACAO_MUSCULAR: form\.muscle_label,/,
    'the prompt shows the localized muscle label, not the stored token'
  );
  assert.match(
    js,
    /ENERGIA_FINAL: form\.energy_label,/,
    'the prompt shows the localized energy label, not the stored token'
  );
  assert.match(
    js,
    /DOR_DESCONFORTO: form\.pain_description,/,
    'the prompt renders the pain answer through its dedicated formatter'
  );
  assert.match(
    js,
    new RegExp(
      [
        'const \\{',
        '\\s*hr_source_label,',
        '\\s*terrain_label,',
        '\\s*breathing_label,',
        '\\s*muscle_label,',
        '\\s*energy_label,',
        '\\s*pain_description,',
        '\\s*language,',
        '\\s*fitAttached,',
        '\\s*\\.\\.\\.payload',
        '\\s*\\} = state;',
      ].join('')
    ),
    'only persistable feedback columns reach the PATCH endpoint'
  );

  assert.match(js, /templateFor\(i18n\.language\)/);
  assert.match(js, /collectPromptValues\(\{ training, form: collectFormState\(\) \}\)/);
  assert.match(js, /await copyAnalysisPrompt\(promptText\)/);
  assert.match(js, /t\('session\.copied'\)/);
  assert.match(js, /setTimeout\(/, 'Copied! feedback restores itself after a moment');

  assert.match(js, /addEventListener\('app:languagechange'/);
  assert.match(
    js,
    /if \(!generateBtn\.disabled\) generateLabel\.textContent = t\('session\.generatePrompt'\);\s*\n\s*renderFitDropzoneState\(\);/,
    'language switches re-render the dropzone with the new locale'
  );
});

test('shared api client exposes the session endpoints', () => {
  const js = readFileSync(join(publicDir, 'shared', 'api.js'), 'utf8');

  assert.match(js, /export async function fetchTraining\(id\) \{/);
  assert.match(js, /response = await fetch\(`\/api\/trainings\/\$\{id\}`/);
  assert.match(
    js,
    /if \(response\.status === 404\) return null;/,
    'a 404 becomes null so the page can show its not-found state'
  );
  assert.match(js, /export function saveTrainingFeedback\(id, fields = \{\}\) \{/);
  assert.match(
    js,
    /return requestJson\(\s*\n\s*`\/api\/trainings\/\$\{id\}`,\s*\n\s*fields,\s*\n\s*'PATCH'\s*\n\s*\);/,
    'the payload passes straight through using DB column names'
  );
});

test('session locale namespace stays in parity across en-US and pt-BR', () => {
  const SESSION_KEYS = [
    'title',
    'loading',
    'plannedHeading',
    'fieldTipo',
    'fieldTreino',
    'fieldDetalhes',
    'fieldFcAlvo',
    'fieldRpe',
    'fieldTenis',
    'feedbackHeading',
    'realizedRpeLabel',
    'freeFeedbackLabel',
    'freeFeedbackPlaceholder',
    'fieldSmartwatch',
    'smartwatchYes',
    'smartwatchNo',
    'fitDragText',
    'fitClickText',
    'fitSelected',
    'fieldShoeUsed',
    'shoeUsedPlaceholder',
    'fieldHrSource',
    'hrSourceStrap',
    'hrSourceOptical',
    'hrSourceNone',
    'fieldWeather',
    'weatherPlaceholder',
    'fieldTerrain',
    'fieldBreathing',
    'fieldMuscle',
    'fieldEnergy',
    'generatePrompt',
    'copied',
    'save',
    'saving',
    'errors.load',
    'errors.notFound',
    'errors.rpe',
    'errors.save',
  ];

  const lookup = (source, key) =>
    key.split('.').reduce((node, part) => (node ? node[part] : undefined), source);

  for (const key of SESSION_KEYS) {
    const english = lookup(en.session, key);
    const portuguese = lookup(pt.session, key);
    assert.equal(typeof english, 'string', `en.session.${key}`);
    assert.equal(typeof portuguese, 'string', `pt.session.${key}`);
  }

  assert.notEqual(en.session.save, pt.session.save);
  assert.notEqual(en.session.smartwatchYes, pt.session.smartwatchYes);
  assert.notEqual(en.session.hrSourceStrap, pt.session.hrSourceStrap);

  const TERRAIN_KEYS = ['asphalt', 'trail', 'track', 'treadmill', 'mixed'];
  for (const key of TERRAIN_KEYS) {
    assert.equal(typeof en.terrain[key], 'string', `en.terrain.${key}`);
    assert.equal(typeof pt.terrain[key], 'string', `pt.terrain.${key}`);
  }
  assert.equal(en.terrain.asphalt, 'Asphalt');
  assert.equal(pt.terrain.asphalt, 'Asfalto');
  assert.equal(en.terrain.trail, 'Trail / Dirt');
  assert.equal(pt.terrain.trail, 'Terra/Trilha');
  assert.equal(en.terrain.track, 'Track');
  assert.equal(pt.terrain.track, 'Pista');
  assert.equal(en.terrain.treadmill, 'Treadmill');
  assert.equal(pt.terrain.treadmill, 'Esteira');
  assert.equal(en.terrain.mixed, 'Mixed');
  assert.equal(pt.terrain.mixed, 'Misto');

  assert.equal(en.session.terrainPlaceholder, undefined);
  assert.equal(pt.session.terrainPlaceholder, undefined);

  for (const deadKey of [
    'breathingPlaceholder',
    'musclePlaceholder',
    'energyPlaceholder',
    'fieldPain',
    'painPlaceholder',
    'notesLabel',
    'notesPlaceholder',
    'fieldFitFile',
  ]) {
    assert.equal(en.session[deadKey], undefined, `en.session.${deadKey} removed`);
    assert.equal(pt.session[deadKey], undefined, `pt.session.${deadKey} removed`);
  }

  assert.equal(en.session.freeFeedbackLabel, 'Free feedback');
  assert.equal(pt.session.freeFeedbackLabel, 'Feedback livre');
  assert.equal(
    en.session.freeFeedbackPlaceholder,
    'How was the workout? Sleep, weather, general sensations...'
  );
  assert.equal(
    pt.session.freeFeedbackPlaceholder,
    'Como foi o treino? Sono, clima, sensações gerais...'
  );

  assert.equal(en.session.fitDragText, 'Drag your <strong>.FIT</strong> file here');
  assert.equal(pt.session.fitDragText, 'Arraste seu arquivo <strong>.FIT</strong> aqui');
  assert.equal(en.session.fitClickText, 'or click to select from your computer');
  assert.equal(pt.session.fitClickText, 'ou clique para selecionar do computador');
  assert.equal(en.session.fitSelected, 'File selected: ');
  assert.equal(pt.session.fitSelected, 'Arquivo selecionado: ');

  const PAIN_I18N = {
    common: {
      yes: ['Yes', 'Sim'],
      no: ['No', 'Não'],
    },
    feedback: {
      hasPainLabel: ['Any pain or discomfort?', 'Houve dor ou desconforto?'],
      painDescriptionLabel: ['Pain description', 'Descrição da dor'],
      painPlaceholder: [
        'e.g.: mild twinge in the right Achilles tendon after km 8...',
        'ex.: pontada leve no tendão de Aquiles direito após o km 8...',
      ],
      noPainReported: ['None / No pain reported', 'Nenhuma / Sem dor relatada'],
      yesWithoutDescription: ['Yes (no additional description)', 'Sim (sem descrição adicional)'],
    },
  };
  for (const [namespace, keys] of Object.entries(PAIN_I18N)) {
    for (const [key, [english, portuguese]] of Object.entries(keys)) {
      assert.equal(en[namespace][key], english, `en.${namespace}.${key}`);
      assert.equal(pt[namespace][key], portuguese, `pt.${namespace}.${key}`);
    }
  }

  const CLOSED_OPTION_NAMESPACES = [
    [
      'breathing',
      { controlled: ['Controlled', 'Controlada'], panting: ['Panting', 'Ofegante'], heavy: ['Very out of breath', 'Muito Ofegante'] },
    ],
    [
      'muscle',
      {
        light: ['Light', 'Leve'],
        normal: ['Normal', 'Normal'],
        heavy: ['Heavy', 'Pesada'],
        fatigued: ['Fatigued', 'Fadigada'],
      },
    ],
    [
      'energy',
      {
        surplus: ['Energy left', 'Sobrava energia'],
        limit: ['On the limit', 'No limite'],
        exhausted: ['Exhausted', 'Esgotado'],
      },
    ],
  ];
  for (const [namespace, options] of CLOSED_OPTION_NAMESPACES) {
    for (const [key, [english, portuguese]] of Object.entries(options)) {
      assert.equal(en[namespace][key], english, `en.${namespace}.${key}`);
      assert.equal(pt[namespace][key], portuguese, `pt.${namespace}.${key}`);
    }
  }

  assert.equal(typeof en.training.title, 'string');
  assert.equal(typeof pt.training.title, 'string');

  assert.equal(en.shell.nav.training, undefined);
  assert.equal(pt.shell.nav.training, undefined);
});

test('training-result.css keeps the earthy premium aesthetic for the session view', () => {
  const css = readFileSync(join(publicDir, 'training-result.css'), 'utf8');

  assert.match(css, /@import url\('\.\/shared\/theme\.css'\);/);
  assert.match(css, /\.planned-grid \{[^}]*display:\s*grid/);
  assert.match(css, /\.status\[data-tone='error'\] \{[^}]*color:\s*var\(--danger\)/);
  assert.match(css, /font-family: 'DM Sans', system-ui, -apple-system, sans-serif;/);

  assert.match(css, /\.feedback-grid \{[^}]*display:\s*grid/);
  assert.match(css, /\.feedback-grid \{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.field-wide \{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(css, /\.fit-field\[hidden\] \{[^}]*display:\s*none/, 'conditional FIT field hides cleanly');
  assert.match(
    css,
    /\.fit-field \{[^}]*grid-column:\s*1 \/ -1/,
    'the FIT dropzone owns a dedicated full-width row below the smartwatch field'
  );
  assert.match(css, /\.fit-field \{[^}]*width:\s*100%/);
  assert.match(css, /\.file-dropzone \{[^}]*border:\s*2px dashed var\(--line-strong\)/, 'the dropzone invites files with a dashed border');
  assert.match(css, /\.file-dropzone \{[^}]*border-radius:\s*16px/, 'the dropzone uses the rounded reference design');
  assert.match(css, /\.file-dropzone \{[^}]*padding:\s*2\.5rem 1\.5rem/, 'generous vertical breathing room');
  assert.match(css, /\.file-dropzone \{[^}]*text-align:\s*center/);
  assert.match(css, /\.file-dropzone \{[^}]*background-color:\s*var\(--card\)/, 'subtle card surface behind the invitation');
  assert.match(css, /\.file-dropzone \{[^}]*cursor:\s*pointer/);
  assert.match(css, /\.file-dropzone \{[^}]*display:\s*flex/);
  assert.match(css, /\.file-dropzone \{[^}]*flex-direction:\s*column/);
  assert.match(css, /\.file-dropzone:hover \{[^}]*border-color:\s*var\(--accent-deep\)/, 'hovering highlights the zone with the deep sage accent');
  assert.match(css, /\.file-dropzone\.drag-active \{[^}]*border-color:\s*var\(--accent-deep\)/, 'dragging over keeps the primary border highlight');
  assert.match(css, /\.dropzone-text-primary \{[^}]*font-weight:\s*600/);
  assert.match(
    css,
    /\.dropzone-text-primary strong \{[^}]*color:\s*var\(--accent-deep\)[^}]*font-weight:\s*700/,
    '.FIT stands out bold in the primary green'
  );
  assert.match(css, /\.dropzone-text-secondary \{[^}]*color:\s*var\(--muted\)/);
  assert.match(css, /\.dropzone-text-secondary \{[^}]*opacity:\s*0\.7/, 'the subtitle stays muted');
  assert.match(css, /\.dropzone-text-secondary \{[^}]*margin-top:\s*0\.25rem/);
  assert.match(css, /\.pain-field\[hidden\] \{[^}]*display:\s*none/, 'the pain description hides until pain is reported');
  assert.match(css, /\.form-actions \{[^}]*display:\s*flex/);
  assert.match(css, /\.btn-secondary \{[^}]*border:\s*1px solid var\(--accent-deep\)/);
  assert.match(css, /\.btn-secondary svg \{[^}]*width:\s*16px/);
  assert.match(
    css,
    /\.btn-primary,\s*\n\s*\.btn-secondary \{[^}]*transition:\s*all 0\.2s ease/,
    'both buttons share one smooth animation curve'
  );
  assert.match(
    css,
    /\.btn-primary,\s*\n\s*\.btn-secondary \{[^}]*display:\s*inline-flex;\s*\n\s*align-items:\s*center;\s*\n\s*justify-content:\s*center/,
    'both buttons center their icon and label with strict flex'
  );
  assert.match(
    css,
    /\.btn-primary:hover:not\(:disabled\),\s*\n\s*\.btn-secondary:hover:not\(:disabled\) \{[^}]*transform:\s*translateY\(-2px\)/,
    'the hover motion is identical for both styles'
  );
  assert.match(
    css,
    /\.btn-secondary:hover:not\(:disabled\) \{[^}]*background-color:\s*rgba\(111,\s*144,\s*112,\s*0\.08\)/,
    'the outline button dims subtly instead of filling solid'
  );
  assert.ok(!css.includes('#3d5a43'), 'the old solid-fill outline hover is gone');
  assert.match(css, /\.btn-secondary \{[^}]*background:\s*transparent/, 'the outline stays surface-colored');
  assert.match(css, /\.input-control:focus \{[^}]*border-color:\s*var\(--accent\)/);
  assert.match(
    css,
    /\.input-control \{[^}]*background:\s*var\(--bg\)/,
    'form controls sit on the earthy surface instead of browser white'
  );
  assert.match(
    css,
    /select\.input-control \{[^}]*-webkit-appearance:\s*none;\s*\n\s*appearance:\s*none/,
    'native select chrome is stripped'
  );
  assert.match(
    css,
    /select\.input-control \{[^}]*background-image:\s*url\("data:image\/svg\+xml[^}]*stroke='%238b8172'/,
    'the dropdown chevron is the shared earthy SVG'
  );
  assert.match(css, /select\.input-control \{[^}]*background-repeat:\s*no-repeat/);
  assert.match(css, /select\.input-control \{[^}]*background-position:\s*right 0\.6rem center/);
  assert.match(css, /select\.input-control \{[^}]*padding-right:\s*1\.9rem/, 'text clears the chevron');

  const responsive = css.slice(css.indexOf('@media (max-width: 560px)'));
  assert.match(responsive, /\.feedback-grid \{\s*grid-template-columns: 1fr;/);
});
