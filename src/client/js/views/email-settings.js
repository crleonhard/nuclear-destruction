// The "Email notifications" card on the home page. It shows nothing at all when the server sends no email.
import { h, mount } from '../dom.js';
import { setTurnEmails } from '../auth.js';

/** Fills `holder` with the card once the server has said what is possible. Failures leave the holder empty: this card is optional. */
export async function loadEmailSettings({ api, holder, flash }) {
  let settings;
  try { ({ notifications: settings } = await api.get('/api/v1/me')); } catch { return; }
  if (!settings?.available) return;

  const box = h('input', { id: 'turn-emails', type: 'checkbox', checked: settings.turnEmails, disabled: !settings.canEnable });
  box.addEventListener('change', async () => {
    const wanted = Boolean(box.checked);
    box.disabled = true;
    try {
      box.checked = await setTurnEmails(api, wanted);
      flash('ok', box.checked ? 'Turn emails are on.' : 'Turn emails are off.');
    } catch (err) {
      box.checked = !wanted;                     // show what the server really has
      flash('error', err.message);
    } finally { box.disabled = false; }
  });

  mount(holder, h('section', { class: 'card' },
    h('h2', {}, 'Email notifications'),
    h('label', { class: 'checkline', for: 'turn-emails' }, box, h('span', {}, ' Email me when a turn opens, and once more shortly before the deadline if I have not submitted yet.')),
    h('p', { class: 'hint' }, settings.canEnable
      ? 'Off unless you turn it on. At most two emails per game and turn, each with a link that stops them. The first one may land in your spam folder: mark it as not spam.'
      : 'Turn emails need an account that signed in with an email address.')));
}
