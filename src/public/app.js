(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const dropzone = $('dropzone');
  const dropTitle = $('dropTitle');
  const dropSub = $('dropSub');
  const fileInput = $('fileInput');
  const statusEl = $('status');
  const rpeRow = $('rpeRow');
  const notesEl = $('notes');
  const generateBtn = $('generateBtn');
  const metaRow = $('metaRow');
  const lapsHead = $('lapsHead');
  const lapsBody = $('lapsBody');
  const resultsFlow = $('resultsFlow');
  const previewEl = $('markdownPreview');
  const copyBtn = $('copyBtn');
  const copyLabel = $('copyLabel');

  const COLUMNS = [
    'Step', 'Lap', 'Time', 'Cumulative', 'Dist (km)', 'Avg Pace', 'Best Pace',
    'Avg HR', 'Max HR', 'Asc (m)', 'Desc (m)', 'Avg Cad', 'Max Cad', 'Stride (m)', 'kcal',
  ];

  let selectedRpe = null;
  let selectedFile = null;
  let markdownText = '';

  COLUMNS.forEach((title) => {
    const th = document.createElement('th');
    th.textContent = title;
    lapsHead.appendChild(th);
  });

  for (let value = 1; value <= 10; value += 1) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `rpe-btn tone-${Math.ceil(value / 2)}`;
    btn.textContent = String(value);
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      selectedRpe = value;
      rpeRow.querySelectorAll('.rpe-btn').forEach((other) => {
        other.classList.toggle('selected', other === btn);
        other.setAttribute('aria-pressed', String(other === btn));
      });
      refreshSubmitState();
    });
    rpeRow.appendChild(btn);
  }

  const setStatus = (message, tone = '') => {
    statusEl.textContent = message;
    statusEl.dataset.tone = tone;
  };

  const fmt = (value) => (value === null || value === undefined ? '-' : value);

  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '-');

  const autoResize = () => {
    notesEl.style.height = 'auto';
    notesEl.style.height = `${notesEl.scrollHeight}px`;
  };
  notesEl.addEventListener('input', () => {
    autoResize();
    refreshSubmitState();
  });

  const refreshSubmitState = () => {
    generateBtn.disabled = !FormState.isSubmittable({
      rpe: selectedRpe,
      notes: notesEl.value,
      file: selectedFile,
    });
  };

  const attachFile = (file) => {
    if (!file) return;
    if (!/\.fit$/i.test(file.name)) {
      setStatus('Selecione um arquivo .FIT válido.', 'error');
      return;
    }
    selectedFile = file;
    dropzone.classList.add('attached');
    dropTitle.textContent = `Pronto: ${file.name}`;
    dropSub.textContent = 'Clique ou arraste outro arquivo para substituir';
    setStatus('');
    refreshSubmitState();
  };

  const handleFiles = (list) => {
    attachFile(list && list[0]);
  };

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => handleFiles(fileInput.files));

  ['dragenter', 'dragover'].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('dragging');
    });
  });

  ['dragleave', 'drop'].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove('dragging');
    });
  });

  dropzone.addEventListener('drop', (event) => handleFiles(event.dataTransfer.files));

  async function submitWorkout() {
    if (generateBtn.disabled || !selectedFile) return;
    generateBtn.disabled = true;
    generateBtn.textContent = 'Processando...';
    resultsFlow.classList.remove('visible');
    copyBtn.classList.remove('visible');
    setStatus(`Processando “${selectedFile.name}”…`);
    const form = new FormData();
    form.append('file', selectedFile, selectedFile.name);
    form.append('rpe', String(selectedRpe));
    form.append('notes', notesEl.value);
    try {
      const response = await fetch('/api/fit/parse', { method: 'POST', body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Falha ao processar o arquivo.');
      render(payload);
      setStatus(`“${payload.fileName}” processado com sucesso.`, 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      generateBtn.textContent = 'Gerar Prompt de Análise';
      refreshSubmitState();
    }
  }

  generateBtn.addEventListener('click', submitWorkout);

  function chip(label, value) {
    const span = document.createElement('span');
    span.className = 'chip';
    const strong = document.createElement('b');
    strong.textContent = `${label}:`;
    span.appendChild(strong);
    span.appendChild(document.createTextNode(String(value)));
    return span;
  }

  function render(payload) {
    metaRow.innerHTML = '';
    [
      ['Esporte', payload.activity.sport ?? '-'],
      ['Início', fmtDate(payload.activity.startTime)],
      ['Fim', fmtDate(payload.activity.endTime)],
      ['Laps', payload.laps.length],
    ].forEach(([label, value]) => metaRow.appendChild(chip(label, value)));

    lapsBody.innerHTML = '';
    payload.laps.forEach((lap) => {
      const tr = document.createElement('tr');
      [
        lap.stepType, lap.lap, lap.durationLabel, lap.cumulativeLabel,
        lap.distanceLabel, lap.avgPaceLabel, lap.bestPaceLabel,
        fmt(lap.avgHeartRate), fmt(lap.maxHeartRate),
        fmt(lap.ascentMeters), fmt(lap.descentMeters),
        fmt(lap.avgCadenceSpm), fmt(lap.maxCadenceSpm),
        fmt(lap.strideMeters), fmt(lap.calories),
      ].forEach((cell) => {
        const td = document.createElement('td');
        td.textContent = String(cell);
        tr.appendChild(td);
      });
      const stepTd = tr.firstChild;
      stepTd.innerHTML = '';
      const badge = document.createElement('span');
      badge.className = `badge-${lap.stepType.toLowerCase()}`;
      badge.textContent = lap.stepType;
      stepTd.appendChild(badge);
      lapsBody.appendChild(tr);
    });

    resultsFlow.classList.add('visible');

    markdownText = payload.markdown;
    previewEl.textContent = markdownText;
    copyBtn.classList.add('visible');
  }

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(markdownText);
    } catch {
      const helper = document.createElement('textarea');
      helper.value = markdownText;
      helper.setAttribute('readonly', '');
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      helper.remove();
    }
    copyBtn.classList.add('copied');
    copyLabel.textContent = 'Prompt copiado!';
    setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyLabel.textContent = 'Copy Prompt to AI Coach';
    }, 1600);
  });
})();
