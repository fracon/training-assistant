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
