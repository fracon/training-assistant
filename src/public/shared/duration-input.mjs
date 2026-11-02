const MAX_DURATION_SECONDS = 2 * 60 * 60;

/** Parse a workout duration: a bare integer is minutes, while m:s is explicit. */
export function parseWorkoutDurationInput(value) {
  const input = String(value ?? '').trim();
  if (!input) throw new Error('duration_required');
  const match = /^(\d+)(?::(\d{1,2}))?$/.exec(input);
  if (!match) throw new Error(input.startsWith('-') ? 'duration_positive' : 'duration_format');
  const minutes = Number(match[1]);
  const seconds = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isSafeInteger(minutes) || !Number.isInteger(seconds)) throw new Error('duration_format');
  if (seconds > 59) throw new Error('duration_seconds_range');
  const total = minutes * 60 + seconds;
  if (total <= 0) throw new Error('duration_positive');
  if (total > MAX_DURATION_SECONDS) throw new Error('duration_too_long');
  return { seconds: total, normalized: `${minutes}:${String(seconds).padStart(2, '0')}` };
}

export const MAX_WORKOUT_DURATION_SECONDS = MAX_DURATION_SECONDS;
