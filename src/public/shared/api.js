export async function requestJson(url, body, method = 'POST') {
  let response;
  try {
    const options = {
      method,
      headers: { 'content-type': 'application/json' },
    };
    if (method !== 'GET') {
      options.body = JSON.stringify(body);
    }
    response = await fetch(url, options);
  } catch {
    throw new Error('Network unavailable. Please try again.');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Something went wrong. Please try again.');
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      error.codes = payload.errors;
    }
    throw error;
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

export function changePassword(payload) {
  return requestJson('/api/auth/password', payload, 'PUT');
}

export async function fetchCalendarTrainings(from, to) {
  try {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const query = params.toString();
    const response = await fetch(`/api/calendar/trainings${query ? `?${query}` : ''}`, {
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

export async function fetchCycles() {
  try {
    const response = await fetch('/api/cycles', { headers: { accept: 'application/json' } });
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload.cycles) ? payload.cycles : [];
  } catch {
    return [];
  }
}

export async function fetchActiveCycle() {
  try {
    const response = await fetch('/api/cycles/active', { headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload.cycle ?? null;
  } catch {
    return null;
  }
}

export function createCycle(body) {
  return requestJson('/api/cycles', body);
}

export function updateCycle(id, body) {
  return requestJson(`/api/cycles/${id}`, body, 'PUT');
}

export function deleteCycle(id) {
  return requestJson(`/api/cycles/${id}`, null, 'DELETE');
}
