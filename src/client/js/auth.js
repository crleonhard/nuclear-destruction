// The ONLY place that knows how people get an account and where their login token lives.
// Two ways in, depending on what the server offers (see getAuthConfig):
//   - email link (production): ask for a link, open it, and the token comes back. requestEmailLink, completeEmailLink.
//   - display name (development, server run with ALLOW_SIGNUP=true): signUp.
// Everything after sign-in uses the token alone, so nothing else in the client cares which way it was obtained.

const KEY = 'nd.token';

/** Token storage. localStorage can be unavailable (private modes), so every access is guarded. */
export function createTokenStore(storage = globalThis.localStorage) {
  return {
    get() { try { return storage?.getItem(KEY) ?? null; } catch { return null; } },
    set(token) { try { storage?.setItem(KEY, token); } catch { /* the session just will not survive a reload */ } },
    clear() { try { storage?.removeItem(KEY); } catch { /* nothing to clear */ } },
  };
}

/** Creates an account and signs it in. Returns the user. */
export async function signUp(api, tokens, displayName) {
  const { user, token } = await api.post('/api/v1/users', { displayName });
  tokens.set(token);
  return user;
}

export function signOut(tokens) {
  tokens.clear();
}

/** Which sign-in methods the server offers: { emailLogin, openSignup }. */
export const getAuthConfig = (api) => api.get('/api/v1/auth/config');

/** Asks the server to email a sign-in link. The answer is the same for every address, so there is nothing to return. */
export async function requestEmailLink(api, email) {
  await api.post('/api/v1/auth/email-link', { email: String(email).trim() });
}

/** What the sign-in link carries after the "#/verify/": 43 URL-safe characters. Anything else cannot be a link from this server. */
export const looksLikeLinkSecret = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);

/**
 * Exchanges the secret from a sign-in link for a login token and stores it. A first-time address also needs a
 * display name; without one the server answers NAME_REQUIRED (the link stays valid, so call again with a name).
 */
export async function completeEmailLink(api, tokens, secret, displayName = '') {
  const name = displayName.trim();
  const { user, token } = await api.post('/api/v1/auth/verify', { token: secret, ...(name ? { displayName: name } : {}) });
  tokens.set(token);
  return user;
}

export const errorCode = (err) => err?.errors?.[0]?.code ?? null;

// ── turn emails (opt-in) ──

/** What the "stop these emails" link carries after \"#/unsubscribe/\": a user number, a dot and 43 URL-safe characters. */
export const looksLikeUnsubscribeToken = (s) => typeof s === 'string' && /^[1-9][0-9]{0,15}\.[A-Za-z0-9_-]{43}$/.test(s);

/** Switches the caller's turn emails on or off. Resolves to the saved value. */
export async function setTurnEmails(api, enabled) {
  const { turnEmails } = await api.put('/api/v1/me/notifications', { turnEmails: enabled });
  return turnEmails;
}

/** The one-click link from an email. Needs no sign-in. */
export async function unsubscribeTurnEmails(api, token) {
  await api.post('/api/v1/auth/unsubscribe', { token });
}
