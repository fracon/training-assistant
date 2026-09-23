'use strict';

const readline = require('node:readline');
const { StringDecoder } = require('node:string_decoder');

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
        let answer = '';
        let settled = false;
        const restore = () => {
          input.removeListener('data', onData);
          input.removeListener('end', onEnd);
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
        const onData = (chunk) => {
          for (const character of decoder.write(chunk)) {
            if (character === '\u0003') return finish(reject, new PromptCancelledError());
            if (character === '\u0004') return finish(reject, new PromptCancelledError());
            if (character === '\r' || character === '\n') return finish(resolve, answer);
            if (character === '\u007f' || character === '\b') answer = answer.slice(0, -1);
            else if (character >= ' ') answer += character;
          }
        };
        input.setRawMode(true);
        input.resume();
        input.on('data', onData);
        input.once('end', onEnd);
      });
    },
  };
}

module.exports = { PromptCancelledError, assertInteractive, createPrompts };
