// A minimal hash router: "#/games/12" -> the "/games/:id" view with { id: "12" }.
// Hash routes need no server support, so the server only has to serve index.html and the assets.

export function matchRoute(routes, path) {
  const segs = path.split('/').filter(Boolean);
  for (const route of routes) {
    const parts = route.pattern.split('/').filter(Boolean);
    if (parts.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) {
        try { params[parts[i].slice(1)] = decodeURIComponent(segs[i]); } catch { ok = false; break; }
      } else if (parts[i] !== segs[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}

export const currentPath = (hash = globalThis.location?.hash ?? '') => hash.replace(/^#/, '') || '/';

/**
 * Starts routing. `views` map a pattern to a function (ctx) => { unmount?() }.
 * The previous view is always unmounted before the next one mounts (closing its timers and event streams).
 */
export function startRouter({ routes, notFound, guard, ctxFor, win = globalThis }) {
  let current = null;
  let token = 0; // ignores a view that finishes mounting after the user has already moved on
  async function render() {
    const mine = ++token;
    current?.unmount?.();
    current = null;
    const path = currentPath(win.location.hash);
    const redirect = guard?.(path);
    if (redirect && redirect !== path) { win.location.hash = `#${redirect}`; return; }
    const found = matchRoute(routes, path);
    const view = found ? found.route.view : notFound;
    const result = await view(ctxFor(found?.params ?? {}));
    if (mine !== token) result?.unmount?.(); else current = result;
  }
  win.addEventListener('hashchange', render);
  return {
    render,
    navigate: (path) => { win.location.hash = `#${path}`; },
    /** Like navigate, but the current address is not kept in the back-button history (used so a used sign-in link is not one click away). */
    replace: (path) => { if (typeof win.location.replace === 'function') win.location.replace(`#${path}`); else win.location.hash = `#${path}`; },
  };
}
