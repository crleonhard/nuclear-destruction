import { h, mount } from '../dom.js';
import { signUp, getAuthConfig, requestEmailLink } from '../auth.js';

const RESEND_AFTER_MS = 30_000;

const card = (...children) => h('section', { class: 'card narrow' }, h('h1', { tabindex: -1 }, 'Nuclear Destruction'), ...children);

export function loginView(ctx) {
  const { api, outlet } = ctx;
  let alive = true;
  let timer = null;

  const show = (...children) => { if (alive) mount(outlet, card(...children)); };

  async function load() {
    show(h('p', { class: 'muted' }, 'Loading…'));
    let config;
    try { config = await getAuthConfig(api); } catch (err) {
      show(h('p', { class: 'muted', role: 'alert' }, err.message), h('button', { onClick: load }, 'Try again'));
      return;
    }
    if (!alive) return;
    if (config.emailLogin) askForEmail();
    else if (config.openSignup) nameSignUp();
    else show(h('p', { class: 'muted' }, 'Signing in is not available on this server yet.'));
  }

  // ── The real sign-in: an emailed link ──

  function askForEmail(prefill = '', problem = null) {
    const input = h('input', { id: 'email', type: 'email', required: true, maxlength: 254, autocomplete: 'email', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', placeholder: 'you@example.com', value: prefill });
    const button = h('button', { type: 'submit', class: 'primary' }, 'Email me a sign-in link');
    const form = h('form', {
      onSubmit: async (e) => {
        e.preventDefault();
        const email = input.value.trim();
        if (!email) { ctx.flash('error', 'Enter your email address.'); return; }
        button.disabled = true;
        try {
          await requestEmailLink(api, email);
          linkSent(email);
        } catch (err) {
          button.disabled = false;
          ctx.flash('error', err.message);
        }
      },
    }, h('label', { class: 'field', for: 'email' }, h('span', {}, 'Your email address'), input),
    h('p', { class: 'hint' }, 'No password needed. We email you a link that signs you in.'), button);
    show(h('p', { class: 'muted' }, 'A turn-based strategy game for 3 to 9 players. Sign in or create an account with your email address.'), problem && h('p', { role: 'alert' }, problem), form);
    input.focus();
  }

  function linkSent(email) {
    const again = h('button', { disabled: true, onClick: async () => {
      again.disabled = true;
      try { await requestEmailLink(api, email); ctx.flash('ok', 'Another link is on its way.'); } catch (err) { ctx.flash('error', err.message); }
      startCooldown();
    } }, 'Send another link');
    const startCooldown = () => { again.disabled = true; clearTimeout(timer); timer = setTimeout(() => { again.disabled = false; }, RESEND_AFTER_MS); };
    show(h('h2', {}, 'Check your email'),
      h('p', { role: 'status' }, 'We sent a sign-in link to ', h('strong', {}, email), '. It works once and expires in 15 minutes.'),
      h('p', { class: 'hint' }, 'Nothing there? Look in your spam folder, wait a minute, then ask for another. You can open the link on any device.'),
      h('p', {}, again, ' ', h('button', { class: 'link', onClick: () => { clearTimeout(timer); askForEmail(email); } }, 'Use a different address')));
    startCooldown();
  }

  // ── Development sign-up: a display name is enough (server run with ALLOW_SIGNUP=true) ──

  function nameSignUp() {
    const input = h('input', { id: 'displayName', type: 'text', maxlength: 60, required: true, autocomplete: 'nickname', placeholder: 'e.g. Ada' });
    const button = h('button', { type: 'submit', class: 'primary' }, 'Start playing');
    const form = h('form', {
      onSubmit: async (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) { ctx.flash('error', 'Enter a name to play under.'); return; }
        button.disabled = true;
        try {
          ctx.session.user = await signUp(api, ctx.tokens, name);
          ctx.renderHeader();
          ctx.navigate('/');
        } catch (err) {
          ctx.flash('error', err.status === 404 ? 'Creating accounts is not enabled on this server.' : err.message);
        } finally { button.disabled = false; }
      },
    }, h('label', { class: 'field', for: 'displayName' }, h('span', {}, 'Your name'), input), h('p', { class: 'hint' }, 'Other players will see this name in game lobbies.'), button);
    show(h('p', { class: 'muted' }, 'A turn-based strategy game for 3 to 9 players. Pick a name to get started.'), form);
    input.focus();
  }

  load();
  return { unmount() { alive = false; clearTimeout(timer); } };
}
