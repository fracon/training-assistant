'use strict';

const readline = require('node:readline');
const { StringDecoder } = require('node:string_decoder');

const STANDALONE_ESCAPE_TIMEOUT_MS = 30;

class PromptCancelledError extends Error {
  constructor() {
    super('Interactive operation cancelled.');
    this.name = 'PromptCancelledError';
  }
}

function assertInteractive(input, output) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('This command requires an interactive TTY. Run it with docker exec -it or a local terminal.');
  }
}

function createPrompts(input = process.stdin, output = process.stdout) {
  return {
    assertInteractive: () => assertInteractive(input, output),
    question(prompt) {
      return new Promise((resolve, reject) => {
        const terminal = readline.createInterface({ input, output });
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          terminal.close();
          callback(value);
        };
        terminal.once('SIGINT', () => finish(reject, new PromptCancelledError()));
        terminal.once('close', () => finish(reject, new PromptCancelledError()));
        terminal.question(prompt, (answer) => finish(resolve, answer));
      });
    },
    secret(prompt) {
      return new Promise((resolve, reject) => {
        output.write(prompt);
        const previousRawMode = input.isRaw;
        const decoder = new StringDecoder('utf8');
        const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        const pasteStart = '\u001b[200~';
        const pasteEnd = '\u001b[201~';
        let answer = '';
        let pending = '';
        let inBracketedPaste = false;
        let settled = false;
        let escapeTimer;
        const clearEscapeTimer = () => {
          if (escapeTimer) clearTimeout(escapeTimer);
          escapeTimer = undefined;
        };
        const restore = () => {
          clearEscapeTimer();
          input.removeListener('data', onData);
          input.removeListener('end', onEnd);
          input.removeListener('error', onError);
          input.setRawMode(previousRawMode);
          input.pause();
          output.write('\n');
        };
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          restore();
          callback(value);
        };
        const onEnd = () => finish(reject, new PromptCancelledError());
        const onError = () => finish(reject, new PromptCancelledError());
        const appendPlainText = (text) => {
          for (const character of text) {
            if (character === '\u0003' || character === '\u0004') {
              finish(reject, new PromptCancelledError());
              return false;
            }
            if (character === '\r' || character === '\n') {
              finish(resolve, answer);
              return false;
            }
            if (character === '\u007f' || character === '\b') {
              const parts = Array.from(graphemes.segment(answer), (part) => part.segment);
              parts.pop();
              answer = parts.join('');
            } else if (character >= ' ') answer += character;
          }
          return true;
        };
        const appendPastedText = (text) => { answer += text; };
        const consumeInput = (text) => {
          pending += text;
          while (pending && !settled) {
            if (inBracketedPaste) {
              const end = pending.indexOf(pasteEnd);
              if (end !== -1) {
                appendPastedText(pending.slice(0, end));
                pending = pending.slice(end + pasteEnd.length);
                inBracketedPaste = false;
                continue;
              }
              let overlap = Math.min(pending.length, pasteEnd.length - 1);
              while (overlap > 0 && !pasteEnd.startsWith(pending.slice(-overlap))) overlap -= 1;
              appendPastedText(pending.slice(0, pending.length - overlap));
              pending = pending.slice(pending.length - overlap);
              break;
            }

            const escape = pending.indexOf('\u001b');
            if (escape === -1) {
              appendPlainText(pending);
              pending = '';
              break;
            }
            if (escape > 0) {
              if (!appendPlainText(pending.slice(0, escape))) return;
              pending = pending.slice(escape);
              continue;
            }
            if (pending.length === 1) break;

            const introducer = pending[1];
            if (introducer === '[') {
              let final = -1;
              for (let index = 2; index < pending.length; index += 1) {
                const code = pending.charCodeAt(index);
                if (code >= 0x40 && code <= 0x7e) {
                  final = index;
                  break;
                }
              }
              if (final === -1) break;
              const sequence = pending.slice(0, final + 1);
              pending = pending.slice(final + 1);
              if (sequence === pasteStart) inBracketedPaste = true;
              continue;
            }
            if (introducer === 'O') {
              if (pending.length < 3) break;
              pending = pending.slice(3);
              continue;
            }
            if (introducer === ']' || introducer === 'P' || introducer === '_' || introducer === '^' || introducer === 'X') {
              const terminator = introducer === ']' ? /(?:\u0007|\u001b\\)/ : /\u001b\\/;
              const match = terminator.exec(pending.slice(2));
              if (!match) break;
              pending = pending.slice(2 + match.index + match[0].length);
              continue;
            }
            if (introducer.charCodeAt(0) < 0x20 || introducer.charCodeAt(0) === 0x7f) {
              pending = pending.slice(1);
              continue;
            }
            // Unsupported terminal escape keys are consumed as complete sequences, never password text.
            pending = pending.slice(2);
          }
          // ESC is ambiguous until another byte arrives. Expire a lone ESC quickly so a
          // later ordinary character cannot be mistaken for an Alt/control sequence.
          if (!settled && pending === '\u001b' && !escapeTimer) {
            escapeTimer = setTimeout(() => {
              escapeTimer = undefined;
              pending = '';
            }, STANDALONE_ESCAPE_TIMEOUT_MS);
          }
        };
        const onData = (chunk) => {
          if (settled) return;
          clearEscapeTimer();
          consumeInput(decoder.write(chunk));
        };
        input.setRawMode(true);
        input.resume();
        input.on('data', onData);
        input.once('end', onEnd);
        input.once('error', onError);
      });
    },
  };
}

module.exports = { PromptCancelledError, assertInteractive, createPrompts };
