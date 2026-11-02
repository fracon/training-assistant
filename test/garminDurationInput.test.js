'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let parseWorkoutDurationInput;
test('workout duration input uses minutes for bare integers and normalizes min:sec precisely', async () => {
  ({ parseWorkoutDurationInput } = await import('../src/public/shared/duration-input.mjs'));
  for (const [input, seconds, normalized] of [
    ['3', 180, '3:00'], ['3:00', 180, '3:00'], ['0:30', 30, '0:30'],
    ['3:05', 185, '3:05'], ['3:5', 185, '3:05'], ['120:00', 7200, '120:00'],
    [' 3:05 ', 185, '3:05'],
  ]) assert.deepEqual(parseWorkoutDurationInput(input), { seconds, normalized });
});

test('workout duration input refuses empty, zero, negative, invalid seconds, unsupported syntax and values over two hours', async () => {
  ({ parseWorkoutDurationInput } = await import('../src/public/shared/duration-input.mjs'));
  for (const [input, code] of [
    ['', 'duration_required'], ['   ', 'duration_required'], ['0', 'duration_positive'],
    ['0:00', 'duration_positive'], ['-3', 'duration_positive'], ['3:60', 'duration_seconds_range'],
    ['3:123', 'duration_format'], ['3 min', 'duration_format'], ['3.5', 'duration_format'],
    ['120:01', 'duration_too_long'], ['999999999999999999999', 'duration_format'],
  ]) assert.throws(() => parseWorkoutDurationInput(input), { message: code }, JSON.stringify(input));
});
