// Starts the client: wires the API, the session, the page header and the router.
import { createApi } from './api.js';
import { createTokenStore, signOut } from './auth.js';
import { h, mount } from './dom.js';
import { startRouter } from './router.js';
import { loginView } from './views/login.js';
import { verifyView } from './views/verify.js';
import { unsubscribeView } from './views/unsubscribe.js';
import { homeView } from './views/home.js';
import { gameView } from './views/game-page.js';
import { historyView } from './views/history.js';
import { replayView } from './views/replay.js';

const tokens = createTokenStore();
const session = { user: null };
const headerEl = document.getElementById('header');
const flashEl = document.getElementById('flash');
const outlet = document.getElementById('outlet');
let router = null;
let flashTimer = null;

/** kind: 'error' | 'ok' | 'info'; an empty text clears the message. */
function flash(kind, text) {
  clearTimeout(flashTimer);
  mount(flashEl, text ? h('div', { class: `flash ${kind}` }, h('span', {}, text), h('button', { class: 'link', onClick: () => flash('', '') }, 'Dismiss')) : null);
  if (text && kind !== 'error') flashTimer = setTimeout(() => flash('', ''), 6000);
}

function renderHeader() {
  mount(headerEl,
    h('a', { class: 'brand', href: '#/' }, 'NUCLEAR DESTRUCTION'),
    session.user
      ? h('div', { class: 'who' }, h('span', {}, session.user.displayName),
        h('button', { onClick: () => { signOut(tokens); session.user = null; renderHeader(); router.navigate('/login'); } }, 'Sign out'))
      : null);
}

const api = createApi({
  tokens,
  onUnauthenticated: () => {
    session.user = null;
    renderHeader();
    flash('error', 'Your session has ended. Please sign in again.');
    router?.navigate('/login');
  },
});

router = startRouter({
  routes: [
    { pattern: '/login', view: loginView },
    { pattern: '/verify/:token', view: verifyView },
    { pattern: '/verify', view: verifyView },
    { pattern: '/unsubscribe/:token', view: unsubscribeView },
    { pattern: '/unsubscribe', view: unsubscribeView },
    { pattern: '/', view: homeView },
    { pattern: '/games/:id', view: gameView },
    { pattern: '/games/:id/history', view: historyView },
    { pattern: '/games/:id/replay', view: replayView },
  ],
  notFound: async (ctx) => { mount(ctx.outlet, h('section', { class: 'card narrow' }, h('h1', {}, 'Page not found'), h('a', { href: '#/' }, 'Back to your games'))); return {}; },
  guard: (path) => {
    if (path === '/verify' || path.startsWith('/verify/')) return null;   // opened from an email: works signed in or out
    if (path === '/unsubscribe' || path.startsWith('/unsubscribe/')) return null;
    if (!tokens.get() && path !== '/login') return '/login';
    if (tokens.get() && path === '/login') return '/';
    return null;
  },
  ctxFor: (params) => ({ api, tokens, session, outlet, params, flash, renderHeader, navigate: (path) => router.navigate(path), replace: (path) => router.replace(path) }),
});
window.addEventListener('hashchange', () => flash('', ''));

async function boot() {
  if (tokens.get()) {
    try {
      const { user } = await api.get('/api/v1/me');
      session.user = user;
    } catch { /* a 401 already cleared the token and redirected; anything else is retried by the next request */ }
  }
  renderHeader();
  await router.render();
}
boot();
