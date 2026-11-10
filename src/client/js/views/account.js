// #/account: the name other players see, how you sign in, "sign out everywhere", and deleting the account.
import { h, mount } from '../dom.js';
import { renameMe, signOutEverywhere, deleteMyAccount, signOut, DELETE_WORD } from '../auth.js';
import { plural } from '../format.js';

export async function accountView(ctx) {
  const { api, tokens, session, outlet, flash, renderHeader } = ctx;
  let alive = true;
  const done = { unmount() { alive = false; } };

  let me;
  try { me = await api.get('/api/v1/me'); } catch (err) {
    if (alive) mount(outlet, h('section', { class: 'card narrow' }, h('h1', {}, 'Your account'), h('p', { role: 'alert' }, err.message), h('p', {}, h('a', { href: '#/' }, 'Back to your games'))));
    return done;
  }
  if (!alive) return done;

  // ── name ──
  const nameInput = h('input', { id: 'displayName', type: 'text', maxlength: 60, required: true, autocomplete: 'nickname', value: me.user.displayName ?? '' });
  const saveName = h('button', { type: 'submit', class: 'primary' }, 'Save name');
  const nameForm = h('form', {
    onSubmit: async (e) => {
      e.preventDefault();
      saveName.disabled = true;
      try {
        const user = await renameMe(api, nameInput.value);
        session.user = { ...session.user, displayName: user.displayName };
        nameInput.value = user.displayName;
        renderHeader();
        flash('ok', 'Name changed. Other players see it everywhere now.');
      } catch (err) { flash('error', err.message); } finally { saveName.disabled = false; }
    },
  }, h('label', { class: 'field', for: 'displayName' }, h('span', {}, 'The name other players see'), nameInput),
  h('p', { class: 'hint' }, 'Up to 60 characters. It changes in games that are already running too.'), saveName);

  // ── signing in ──
  const everywhere = h('button', { type: 'button', onClick: async () => {
    everywhere.disabled = true;
    try {
      await signOutEverywhere(api, tokens);
      flash('ok', 'Signed out on every other device. You stay signed in here.');
    } catch (err) { flash('error', err.message); } finally { everywhere.disabled = false; }
  } }, 'Sign out on every device');

  // ── deleting ──
  const confirm = h('input', { id: 'confirm-delete', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: DELETE_WORD });
  const del = h('button', { type: 'button', class: 'danger', disabled: true, onClick: async () => {
    del.disabled = true; confirm.disabled = true;
    try {
      const counts = await deleteMyAccount(api, tokens);
      session.user = null;
      renderHeader();
      if (!alive) return;
      mount(outlet, h('section', { class: 'card narrow' }, h('h1', {}, 'Account deleted'),
        h('p', { role: 'status' }, 'Your account and email address have been erased.',
          counts.gamesHandedToAi ? ` ${plural(counts.gamesHandedToAi, 'game')} that ${counts.gamesHandedToAi === 1 ? 'was' : 'were'} running will carry on with an AI player in your seat.` : ''),
        h('p', {}, h('a', { href: '#/login' }, 'Back to the sign-in page'))));
    } catch (err) { flash('error', err.message); del.disabled = confirm.value !== DELETE_WORD; confirm.disabled = false; }
  } }, 'Delete my account');
  confirm.addEventListener('input', () => { del.disabled = confirm.value !== DELETE_WORD; });

  mount(outlet,
    h('h1', { tabindex: -1 }, 'Your account'),
    h('section', { class: 'card' }, h('h2', {}, 'Name'), nameForm),
    h('section', { class: 'card' }, h('h2', {}, 'Signing in'),
      h('p', {}, me.email ? ['You sign in with ', h('strong', {}, me.email), '. We email you a link each time; there is no password.'] : 'This account has no email address (it was made by name, for development).'),
      h('p', { class: 'hint' }, 'Signed in somewhere you no longer trust, or on a shared computer? This cancels every sign-in, including old ones, and keeps this device signed in.'),
      h('p', {}, everywhere)),
    h('section', { class: 'card' }, h('h2', {}, 'Delete account'),
      h('p', {}, 'This cannot be undone. It erases your email address, your turn-email setting and any sign-in links waiting for your address, and it signs you out everywhere. What happens to your games:'),
      h('ul', {},
        h('li', {}, 'Games still being set up: ones you created are cancelled (for everyone who joined); ones you only joined, you leave.'),
        h('li', {}, 'Games that are running: an AI player takes over your seat, so nobody waits for you.'),
        h('li', {}, 'Finished games keep their results, under the name \u201cDeleted player\u201d.')),
      h('p', { class: 'hint' }, 'Orders and messages you already sent stay part of those games, without your name or address.'),
      h('label', { class: 'field', for: 'confirm-delete' }, h('span', {}, `Type ${DELETE_WORD} to confirm`), confirm),
      h('p', {}, del)),
    h('p', { class: 'hint' }, h('a', { href: '#/privacy' }, 'What this site stores about you')));
  return done;
}
