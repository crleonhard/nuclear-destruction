// A small wrapper over fetch for the game's JSON API. Every failure becomes an ApiError carrying the server's
// standard error list, so views can show exactly what the server said.

export class ApiError extends Error {
  constructor(status, errors) {
    super(errors[0]?.message ?? `Request failed (${status})`);
    this.status = status;
    this.errors = errors;
  }
}

export function createApi({ tokens, fetchImpl = (...args) => globalThis.fetch(...args), onUnauthenticated = () => {} }) {
  async function request(method, path, body) {
    const token = tokens.get();
    let res;
    try {
      res = await fetchImpl(path, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, [{ code: 'NETWORK', field: 'request', message: 'Cannot reach the server. Check your connection and try again.' }]);
    }
    let data = null;
    try { data = await res.json(); } catch { /* an empty or non-JSON body */ }
    if (res.ok) return data ?? {};
    if (res.status === 401 && token) { tokens.clear(); onUnauthenticated(); }
    throw new ApiError(res.status, data?.errors?.length ? data.errors : [{ code: 'HTTP', field: 'request', message: `Request failed (${res.status})` }]);
  }
  return {
    get: (path) => request('GET', path),
    post: (path, body = {}) => request('POST', path, body),
    put: (path, body = {}) => request('PUT', path, body),
    del: (path) => request('DELETE', path),
  };
}

/**
 * Live updates for a game. Events carry no private data (counts and turn numbers only), so the handler should
 * simply refetch. The browser reconnects by itself; a fresh `ready` event after a reconnect means "refetch now".
 * EventSource cannot set headers, so the token travels in the query string.
 */
export function openStream(gameId, token, onEvent, EventSourceImpl = globalThis.EventSource) {
  const source = new EventSourceImpl(`/api/v1/games/${gameId}/stream?token=${encodeURIComponent(token)}`);
  for (const type of ['ready', 'lobby_changed', 'game_started', 'player_submitted', 'turn_resolved', 'game_finished']) {
    source.addEventListener(type, (e) => {
      let data = {};
      try { data = JSON.parse(e.data); } catch { /* ignore a malformed event */ }
      onEvent({ type, ...data });
    });
  }
  return { close: () => source.close() };
}
