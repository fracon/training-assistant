'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { createPrompts, PromptCancelledError } = require('../scripts/admin-prompts');

function terminalPair() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  output.isTTY = true;
  const outputChunks = [];
  output.on('data', (chunk) => outputChunks.push(chunk));
  return { input, output, outputChunks };
}

function startSecret(options = {}) {
  const pair = terminalPair();
  if (options.raw) pair.input.isRaw = true;
  const originalListeners = new Map(['data', 'end', 'error'].map((event) => [event, pair.input.listenerCount(event)]));
  const rawTransitions = [];
  const setRawMode = pair.input.setRawMode;
  pair.input.setRawMode = (value) => {
    rawTransitions.push(value);
    setRawMode(value);
  };
  const reading = createPrompts(pair.input, pair.output).secret('Password: ');
  return { ...pair, reading, originalListeners, rawTransitions };
}

test('real hidden-password reader consumes arrow-key escapes instead of appending them', async () => {
  const { input, outputChunks, reading } = startSecret();
  input.write('ExamplePass123');
  input.write('\u001b[D');
  input.write('\r');
  assert.equal(await reading, 'ExamplePass123');
  assert.equal(outputChunks.join('').includes('ExamplePass123'), false);
});

test('a standalone Escape between password characters does not consume the next key', async () => {
  const { input, reading } = startSecret();
  input.write('before');
  input.write('\u001b');
  await new Promise((resolve) => setTimeout(resolve, 40));
  input.write('q\r');
  assert.equal(await reading, 'beforeq');
});

test('standalone Escape before, within, and after text is ignored after the short disambiguation window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const scenario of [
    { before: '', after: 'First' },
    { before: 'Mid', after: 'dle' },
    { before: 'Last', after: '' },
  ]) {
    const { input, reading } = startSecret();
    if (scenario.before) input.write(scenario.before);
    input.write('\u001b');
    t.mock.timers.tick(31);
    if (scenario.after) input.write(scenario.after);
    input.write('\r');
    assert.equal(await reading, `${scenario.before}${scenario.after}`);
  }
});

test('split arrow-key sequences arriving before the timeout remain fully consumed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { input, reading } = startSecret();
  input.write('Before');
  input.write('\u001b');
  input.write('[');
  input.write('D');
  t.mock.timers.tick(31);
  input.write('After\r');
  assert.equal(await reading, 'BeforeAfter');
});

test('Enter, Ctrl+C, and EOF settle while Escape is pending and clear prompt state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const ending of ['\r', '\u0003', 'end']) {
    const state = startSecret();
    const listenerCount = state.input.listenerCount('data');
    state.input.write('\u001b');
    if (ending === 'end') state.input.emit('end');
    else state.input.write(ending);
    if (ending === '\r') assert.equal(await state.reading, '');
    else await assert.rejects(state.reading, PromptCancelledError);
    t.mock.timers.tick(31);
    assert.equal(state.input.listenerCount('data'), listenerCount - 1);
    assert.equal(state.input.isRaw, false);
    state.input.emit('data', Buffer.from('late'));
  }
});

test('cancel and reopen leaves no prior timer or data listener affecting the next secret', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { input, output } = terminalPair();
  const prompts = createPrompts(input, output);
  const baseline = input.listenerCount('data');
  const cancelled = prompts.secret('First: ');
  input.write('\u001b');
  input.write('\u0003');
  await assert.rejects(cancelled, PromptCancelledError);
  assert.equal(input.listenerCount('data'), baseline);
  t.mock.timers.tick(31);
  const reopened = prompts.secret('Second: ');
  input.write('IntendedPass123\r');
  assert.equal(await reopened, 'IntendedPass123');
  assert.equal(input.listenerCount('data'), baseline);
});

test('all common navigation and delete escape sequences are consumed, including across chunks', async () => {
  const { input, reading } = startSecret();
  input.write('Keep[123]Text');
  for (const sequence of ['\u001b[A', '\u001b[B', '\u001b[C', '\u001b[D', '\u001b[H', '\u001b[F', '\u001b[3~']) {
    input.write(sequence);
  }
  input.write('\u001b');
  input.write('[');
  input.write('1;5A');
  input.write('\r');
  assert.equal(await reading, 'Keep[123]Text');
});

test('escape sequences following text in the same chunk are consumed and complete SS3 keys are ignored', async () => {
  const { input, reading } = startSecret();
  input.write('Before\u001b[DBetween\u001bOAFinal\r');
  assert.equal(await reading, 'BeforeBetweenFinal');
});

test('OSC, DCS, APC, PM, SOS, control-prefixed, and simple escape sequences are never password text', async () => {
  const { input, reading } = startSecret();
  input.write('secure');
  input.write('\u001b]0;terminal title\u0007');
  input.write('\u001bPdata\u001b\\');
  input.write('\u001b_name\u001b\\');
  input.write('\u001b^message\u001b\\');
  input.write('\u001bXpayload\u001b\\');
  input.write('\u001b\u0001');
  input.write('\u001bc');
  input.write('\t');
  input.write('\r');
  assert.equal(await reading, 'secure');
});

test('enter or cancellation before a pending escape still terminates safely, and incomplete sequences cancel on EOF', async () => {
  const completed = startSecret();
  completed.input.write('safe\r\u001b[D');
  assert.equal(await completed.reading, 'safe');

  for (const sequence of ['\u001b[', '\u001bO', '\u001b]unfinished title']) {
    const state = startSecret();
    state.input.write(sequence);
    state.input.end();
    await assert.rejects(state.reading, PromptCancelledError);
    assert.equal(state.input.isRaw, false);
    assert.equal(state.input.listenerCount('data'), state.originalListeners.get('data'));
  }
});

test('plain typing and bracketed paste retain literal text and consume split paste delimiters', async () => {
  const { input, reading } = startSecret();
  input.write('Plain [text] 123 ');
  input.write('\u001b[200~Pasted [chars] 456\nsecond');
  input.write(' line\u001b[20');
  input.write('1~');
  input.write('\r');
  assert.equal(await reading, 'Plain [text] 123 Pasted [chars] 456\nsecond line');
});

test('UTF-8 decoding and Backspace remove complete Unicode graphemes', async () => {
  const { input, reading } = startSecret();
  input.write(Buffer.from('Run'));
  input.write(Buffer.from([0xf0, 0x9f]));
  input.write(Buffer.from([0x99, 0x82]));
  input.write(Buffer.from('e\u0301\u007fX\b\r'));
  assert.equal(await reading, 'Run🙂');
});

test('raw mode is restored exactly and listeners are removed after success, cancel, EOF, and stream error', async () => {
  for (const { ending, initiallyRaw, expected } of [
    { ending: '\r', initiallyRaw: false, expected: 'ok' },
    { ending: '\u0003', initiallyRaw: true, expected: PromptCancelledError },
    { ending: null, initiallyRaw: false, expected: PromptCancelledError },
    { ending: 'error', initiallyRaw: true, expected: PromptCancelledError },
  ]) {
    const state = startSecret({ raw: initiallyRaw });
    state.input.write('ok');
    if (ending === null) state.input.end();
    else if (ending === 'error') state.input.emit('error', new Error('private failure'));
    else state.input.write(ending);
    if (expected === PromptCancelledError) await assert.rejects(state.reading, PromptCancelledError);
    else assert.equal(await state.reading, expected);
    assert.equal(state.input.isRaw, initiallyRaw);
    assert.deepEqual(state.rawTransitions, [true, initiallyRaw]);
    for (const [event, count] of state.originalListeners) assert.equal(state.input.listenerCount(event), count);
  }
});

test('secret completion is idempotent if a terminal event arrives while listeners are being removed', async () => {
  const state = startSecret();
  const lateDataListener = state.input.listeners('data').at(-1);
  const removeListener = state.input.removeListener.bind(state.input);
  let injected = false;
  state.input.removeListener = (event, listener) => {
    const result = removeListener(event, listener);
    if (event === 'data' && !injected) {
      injected = true;
      state.input.emit('error', new Error('late terminal event'));
    }
    return result;
  };
  state.input.write('stable\r');
  assert.equal(await state.reading, 'stable');
  lateDataListener(Buffer.from('late data\r'));
  assert.equal(state.input.isRaw, false);
});

test('secret prompts never echo text; ordinary question handles answer, Ctrl+C, and EOF', async () => {
  const answer = startSecret();
  answer.input.write('DoNotEchoThis\r');
  assert.equal(await answer.reading, 'DoNotEchoThis');
  assert.equal(answer.outputChunks.join('').includes('DoNotEchoThis'), false);

  for (const ending of ['response\r', '\u0003', null]) {
    const { input, output } = terminalPair();
    const prompts = createPrompts(input, output);
    const question = prompts.question('Input: ');
    if (ending === null) input.end();
    else input.write(ending);
    if (ending === 'response\r') assert.equal(await question, 'response');
    else await assert.rejects(question, PromptCancelledError);
  }
});

test('hidden-password reader exposes interactive-terminal validation', () => {
  const { input, output } = terminalPair();
  input.isTTY = false;
  assert.throws(() => createPrompts(input, output).assertInteractive(), /interactive TTY/);

  const outputNotTty = terminalPair();
  outputNotTty.output.isTTY = false;
  assert.throws(() => createPrompts(outputNotTty.input, outputNotTty.output).assertInteractive(), /interactive TTY/);

  const noRawMode = terminalPair();
  noRawMode.input.setRawMode = undefined;
  assert.throws(() => createPrompts(noRawMode.input, noRawMode.output).assertInteractive(), /interactive TTY/);
});

test('cancellation error has a credential-free message', () => {
  const error = new PromptCancelledError();
  assert.equal(error.name, 'PromptCancelledError');
  assert.doesNotMatch(error.message, /password|secret/i);
});
