// The page an emailed sign-in link opens: #/verify/<secret>.
// It asks for one click before using the link. A mail scanner that merely opens links (some run scripts) must not
// be able to use up a link meant for a person, so nothing is sent until the button is pressed.
import { h, mount } from '../dom.js';
import { completeEmailLink, looksLikeLinkSecret, errorCode } from '../auth.js';

const card = (...children) => h('section', { class: 'card narrow' }, h('h1', { tabindex: -1 }, 'Nuclear Destruction'), ...children);

export function verifyView(ctx) {
  const { api, tokens, session, outlet, params } = ctx;
  const secret = params?.token;
  let alive = true;

  const expired = (message) => mount(outlet, card(h('h2', {}, 'This link cannot be used'), h('p', { role: 'alert' }, message),
    h('p', {}, h('button', { class: 'primary', onClick: () => { tokens.clear(); session.user = null; ctx.renderHeader(); ctx.navigate('/login'); } }, 'Get a new link'))));

  if (!looksLikeLinkSecret(secret)) {
    expired(secret ? 'That is not a sign-in link from this site. Ask for a new one.' : 'Open the link from your sign-in email, or ask for a new one.');
    return { unmount() { alive = false; } };
  }

  const nameInput = h('input', { id: 'displayName', type: 'text', maxlength: 60, autocomplete: 'nickname', placeholder: 'e.g. Ada' });
  const button = h('button', { type: 'submit', class: 'primary' }, 'Sign in');
  const form = h('form', {
    onSubmit: async (e) => {
      e.preventDefault();
      button.disabled = true;
      try {
        const user = await completeEmailLink(api, tokens, secret, nameInput.value);
        if (!alive) return;
        session.user = user;
        ctx.renderHeader();
        ctx.replace('/');                     // the used link must not stay one Back click away
      } catch (err) {
        if (!alive) return;
        button.disabled = false;
        const code = errorCode(err);
        if (code === 'NAME_REQUIRED') { ctx.flash('info', err.message); nameInput.focus(); }
        else if (code === 'LINK_INVALID') expired(err.message);
        else ctx.flash('error', err.message);
      }
    },
  },
  h('label', { class: 'field', for: 'displayName' }, h('span', {}, 'Your name (new players only)'), nameInput),
  h('p', { class: 'hint' }, 'First time here? Choose the name other players will see. If you already have an account, leave this empty.'),
  button);

  mount(outlet, card(h('h2', {}, 'Finish signing in'),
    session.user && h('p', { class: 'hint' }, `You are signed in as ${session.user.displayName}. Continuing switches to the account this link belongs to.`),
    form));
  button.focus();
  return { unmount() { alive = false; } };
}
