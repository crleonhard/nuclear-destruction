// The page the "stop these emails" link in a turn email opens: #/unsubscribe/<token>. It works signed in or out.
// Like the sign-in page it asks for one click first, so a mail scanner that merely opens links cannot switch
// someone's emails off.
import { h, mount } from '../dom.js';
import { looksLikeUnsubscribeToken, unsubscribeTurnEmails } from '../auth.js';

const card = (...children) => h('section', { class: 'card narrow' }, h('h1', { tabindex: -1 }, 'Nuclear Destruction'), ...children);

export function unsubscribeView({ api, outlet, params }) {
  let alive = true;
  const token = params?.token;
  if (!looksLikeUnsubscribeToken(token)) {
    mount(outlet, card(h('h2', {}, 'This link cannot be used'),
      h('p', { role: 'alert' }, 'That is not a "stop emails" link from this site. Sign in and turn the emails off on your home page instead.'),
      h('p', {}, h('a', { href: '#/' }, 'Go to the home page'))));
    return { unmount() { alive = false; } };
  }
  const button = h('button', { type: 'button', class: 'primary', onClick: async () => {
    button.disabled = true;
    try {
      await unsubscribeTurnEmails(api, token);
      if (alive) mount(outlet, card(h('h2', {}, 'Turn emails are off'), h('p', {}, 'You will not get any more turn emails. You can turn them back on from your home page.'), h('p', {}, h('a', { href: '#/' }, 'Go to the home page'))));
    } catch (err) {
      if (!alive) return;
      button.disabled = false;
      mount(outlet, card(h('h2', {}, 'Could not stop the emails'), h('p', { role: 'alert' }, err.message), h('p', {}, button)));
    }
  } }, 'Stop turn emails');
  mount(outlet, card(h('h2', {}, 'Stop turn emails?'), h('p', {}, 'Press the button to stop all "your turn" emails from this site. No sign-in is needed.'), h('p', {}, button)));
  button.focus();
  return { unmount() { alive = false; } };
}
