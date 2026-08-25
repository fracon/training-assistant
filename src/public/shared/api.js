export async function requestJson(url, body, method = 'POST') {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Network unavailable. Please try again.');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Something went wrong. Please try again.');
  }
  return payload;
}

export function signIn(email, password) {
  return requestJson('/api/auth/login', { email, password });
}

export function registerAccount(payload) {
  return requestJson('/api/auth/register', payload);
}

export function updateLanguagePreference(lang) {
  return requestJson('/api/users/me/language', { preferred_lang: lang }, 'PATCH');
}

export function updateCalendarPreference(firstDay) {
  return requestJson(
    '/api/users/me/calendar-preference',
    { first_day_of_week: firstDay },
    'PATCH'
  );
}

export async function fetchCalendarTrainings() {
  try {
    const response = await fetch('/api/calendar/trainings', {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload.trainings) ? payload.trainings : [];
  } catch {
    return [];
  }
}

// Returns the training row, or null when the server answers 404.
export async function fetchTraining(id) {
  let response;
  try {
    response = await fetch(`/api/trainings/${id}`, {
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new Error('Network unavailable. Please try again.');
  }
  const payload = await response.json().catch(() => ({}));
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(payload.error || 'Something went wrong. Please try again.');
  }
  return payload.training ?? null;
}

export function saveTrainingFeedback(id, fields = {}) {
  return requestJson(
    `/api/trainings/${id}`,
    fields,
    'PATCH'
  );
}

export async function importTrainingsFile(file) {
  const form = new FormData();
  form.append('file', file);
  let response;
  try {
    response = await fetch('/api/calendar/import', { method: 'POST', body: form });
  } catch {
    throw Object.assign(new Error('Network unavailable. Please try again.'), {
      rowErrors: null,
    });
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || 'Import failed.'), {
      rowErrors: Array.isArray(payload.errors) ? payload.errors : null,
    });
  }
  return payload;
}

export async function signOut() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    /* network hiccup - the caller still redirects to a gated page */
  }
}

export async function currentUser() {
  try {
    const response = await fetch('/api/me', { headers: { accept: 'application/json' } });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    return payload.user ?? null;
  } catch {
    return null;
  }
}

export async function fetchShoes() {
  try {
    const response = await fetch('/api/shoes', { headers: { accept: 'application/json' } });
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload.shoes) ? payload.shoes : [];
  } catch {
    return [];
  }
}

export function createShoe(body) {
  return requestJson('/api/shoes', body);
}

export function updateShoe(id, body) {
  return requestJson(`/api/shoes/${id}`, body, 'PUT');
}

export function deleteShoe(id) {
  return requestJson(`/api/shoes/${id}`, null, 'DELETE');
}
